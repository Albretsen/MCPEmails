// ---------------------------------------------------------------------------
// Review of the combined read fixes (2026-10-04): clean previews, byte-exact
// IMAP reads, joined bodies.
//
// The byte-exact reader sits under EVERY IMAP operation, so this file goes
// through each kind of consumer of what `readLine` / `readExact` return and
// pins what a client of this server observes. Two questions per consumer:
//
//   * For input that was already read correctly (ASCII, modified UTF-7, raw
//     UTF-8 mailbox names; ASCII and windows-1252 server text), is the string
//     a client receives EXACTLY the one it received before? A folder name is
//     an id a client stores and hands back.
//   * For input that was read wrongly, is it right now, and is nothing a byte
//     string (one character per octet) by the time it reaches a result?
//
// "Before" is modelled by `legacy*` below: the old reader was
// TextDecoder("latin1") (windows-1252). The model was checked against
// origin/main's own imap-client.ts over the same wire bytes when this was
// written; the cases where the result deliberately differs say so.
//
// Bugs this review found, each pinned here, are marked REVIEW FIX.
//
// No real mailbox data: every address is under example.com.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  API_KEY,
  encryptToken,
  executeListInbox,
  executeReadEmail,
  inboxRow,
  INBOX_ID,
  json,
  type ProviderHandler,
  runTool,
} from "./provider-call-harness.ts";
import { summarizeOriginal } from "./forward-relay.ts";
import { ImapClient } from "./imap-client.ts";
import { type FakeMessage, FakeImapServer } from "./imap-fake-server.ts";
import { ScriptedWire, type ScriptedCommand, utf8Wire, wireBytes, wireString } from "./imap-scripted-wire.ts";
import {
  decodeEncodedWords,
  decodeRawHeaderOctets,
  getHeader,
  parseEmail,
  parseEmailJoined,
} from "./mime.ts";
import { draftSendBytes } from "./mime-build.ts";
import { smtpDataPayload } from "./smtp-client.ts";
import { cleanPreviewFromBodyPart, normalizePreview, stripHtmlToText, tidyPreview } from "./text-extract.ts";
import { decodeModifiedUtf7 } from "./utf7.ts";

const CRLF = "\r\n";
const toText = (html: string) => stripHtmlToText(html, { keepLinks: true });

/** Socket read sizes that put a cut at every awkward place: 1 is every boundary there is. */
const READ_SIZES = [undefined, 1, 2, 3, 5, 7, 64];

/** No byte string may reach a result: no C1 control, no U+FFFD. */
function assertIsText(value: string, label: string): void {
  // deno-lint-ignore no-control-regex
  assert(!/[\x80-\x9f�]/.test(value), `${label}: ${JSON.stringify(value)} holds a C1 control or U+FFFD`);
}

/** What the old reader made of these octets. */
function legacyRead(wire: string): string {
  return new TextDecoder("latin1").decode(wireBytes(wire));
}

/** The mailbox name the old client returned for a LIST name token's content. */
function legacyMailboxName(content: string): string {
  let name: string;
  try {
    // deno-lint-ignore no-control-regex
    name = /[^\x00-\x7f]/.test(content)
      ? new TextDecoder("utf-8", { fatal: true }).decode(wireBytes(content))
      : content;
  } catch {
    name = legacyRead(content);
  }
  return decodeModifiedUtf7(name);
}

function client(answer: (command: ScriptedCommand) => string, maxRead?: number): { imap: ImapClient; wire: ScriptedWire } {
  const wire = new ScriptedWire(answer, { maxRead });
  return { imap: wire.client<ImapClient>(ImapClient), wire };
}

// ── 1. mailbox names ────────────────────────────────────────────────────────

interface NameCase {
  label: string;
  /** The name token as the server writes it in a LIST reply. */
  token: string;
  /** The octets between the quotes (or of the atom / literal), escapes undone. */
  content: string;
  /** What `folder_list` returns. */
  expected: string;
  /** False where this change deliberately differs from before. */
  sameAsBefore?: boolean;
}

const NAME_CASES: NameCase[] = [
  { label: "ASCII atom", token: "INBOX", content: "INBOX", expected: "INBOX" },
  { label: "ASCII quoted, with a space", token: '"Sent Items"', content: "Sent Items", expected: "Sent Items" },
  { label: "quote and backslash escapes", token: '"a\\"b\\\\c"', content: 'a"b\\c', expected: 'a"b\\c' },
  { label: "modified UTF-7, quoted", token: '"Entw&APw-rfe"', content: "Entw&APw-rfe", expected: "Entwürfe" },
  { label: "modified UTF-7, atom", token: "&AOU-rhus", content: "&AOU-rhus", expected: "århus" },
  { label: "modified UTF-7, a surrogate pair", token: '"&2D3eAA-"', content: "&2D3eAA-", expected: "😀" },
  { label: "a literal ampersand", token: '"R&-D"', content: "R&-D", expected: "R&D" },
  { label: "raw UTF-8, quoted", token: `"${utf8Wire("Ødegård – arkiv")}"`, content: utf8Wire("Ødegård – arkiv"), expected: "Ødegård – arkiv" },
  { label: "raw UTF-8, atom", token: utf8Wire("Blåbær"), content: utf8Wire("Blåbær"), expected: "Blåbær" },
  { label: "raw UTF-8, CJK with a hierarchy", token: `"${utf8Wire("受信トレイ/重要")}"`, content: utf8Wire("受信トレイ/重要"), expected: "受信トレイ/重要" },
  { label: "raw UTF-8, Arabic", token: `"${utf8Wire("مجلد")}"`, content: utf8Wire("مجلد"), expected: "مجلد" },
  { label: "raw UTF-8, four-octet emoji", token: `"${utf8Wire("📁 Stuff")}"`, content: utf8Wire("📁 Stuff"), expected: "📁 Stuff" },
  { label: "raw UTF-8 ending in octet A0, quoted", token: `"${utf8Wire("Voilà")}"`, content: utf8Wire("Voilà"), expected: "Voilà" },
  // Not UTF-8: single-byte names. Before, these were read as windows-1252, and
  // they still are (REVIEW FIX: the exact reader alone would have turned 0x80
  // into U+0080 and changed the id).
  { label: "raw ISO-8859-1", token: '"Entw\xfcrfe"', content: "Entw\xfcrfe", expected: "Entwürfe" },
  { label: "raw windows-1252, euro sign (0x80)", token: '"Budget \x80 2026"', content: "Budget \x80 2026", expected: "Budget € 2026" },
  { label: "raw windows-1252, curly quotes (0x93 0x94)", token: '"\x93Quoted\x94"', content: "\x93Quoted\x94", expected: "“Quoted”" },
  { label: "an octet windows-1252 leaves undefined (0x81)", token: '"a\x81b"', content: "a\x81b", expected: "a\u0081b" },
  { label: "a literal", token: `{9}${CRLF}Lit "q" x`, content: 'Lit "q" x', expected: 'Lit "q" x' },
  { label: "a literal of raw UTF-8", token: `{${utf8Wire("Ødegård").length}}${CRLF}${utf8Wire("Ødegård")}`, content: utf8Wire("Ødegård"), expected: "Ødegård" },
  // REVIEW FIX. `trim()` on the name stripped U+00A0, which is the octet 0xA0,
  // the last octet of "à". The old client returned "VoilÃ" for this, a name
  // that selects nothing; it is the one case here that differs from before.
  { label: "raw UTF-8 ending in octet A0, atom", token: utf8Wire("Voilà"), content: utf8Wire("Voilà"), expected: "Voilà", sameAsBefore: false },
];

function listReply(cases: NameCase[]): (command: ScriptedCommand) => string {
  return (command) =>
    cases.map((c) => `* LIST (\\HasNoChildren) "/" ${c.token}${CRLF}`).join("") + `${command.tag} OK LIST completed${CRLF}`;
}

Deno.test("folder_list: every mailbox name is the string it was before, however the reply is cut into socket reads", async () => {
  for (const maxRead of READ_SIZES) {
    for (const c of NAME_CASES) {
      const { imap } = client(listReply([c]), maxRead);
      const [listed] = await imap.listMailboxes();
      assertEquals(listed.name, c.expected, `${c.label} (read ${maxRead ?? "all"})`);
      if (c.sameAsBefore !== false) {
        assertEquals(listed.name, legacyMailboxName(c.content), `${c.label}: differs from the old reader`);
      }
    }
  }
});

Deno.test("folder_list: attributes, delimiters and NIL parse from a byte-exact line", async () => {
  const { imap } = client((command) =>
    `* LIST (\\HasChildren \\Noselect) "." "Top"${CRLF}` +
    `* LIST (\\HasNoChildren \\Sent) "." "Top.${utf8Wire("Sendt")}"${CRLF}` +
    `* LIST () NIL Flat${CRLF}` +
    `* LIST (\\Marked) "/" "x (y)"${CRLF}` +
    `${command.tag} OK done${CRLF}`
  );
  const listed = await imap.listMailboxes();
  assertEquals(listed.map((m) => [m.name, m.delimiter, m.flags]), [
    ["Flat", "/", []],
    ["Top", ".", ["\\HasChildren", "\\Noselect"]],
    ["Top.Sendt", ".", ["\\HasNoChildren", "\\Sent"]],
    ["x (y)", "/", ["\\Marked"]],
  ]);
});

Deno.test("a name a client hands back goes to the wire as modified UTF-7, quoted and escaped (CREATE, RENAME, SELECT, STATUS)", async () => {
  const { imap, wire } = client((command) => {
    if (/^STATUS/.test(command.text)) {
      return `* STATUS "${utf8Wire("Ødegård – arkiv")}" (MESSAGES 3 UNSEEN 1 UIDNEXT 9 UIDVALIDITY 2 RECENT 0)${CRLF}${command.tag} OK done${CRLF}`;
    }
    return `${command.tag} OK done${CRLF}`;
  }, 1);
  await imap.createMailbox("Entwürfe");
  await imap.renameMailbox('a"b\\c', "受信トレイ/重要");
  await imap.selectMailbox("📁 Stuff");
  const status = await imap.mailboxStatus("Ødegård – arkiv");
  assertEquals(wire.commands.map((c) => c.text), [
    'CREATE "Entw&APw-rfe"',
    'RENAME "a\\"b\\\\c" "&U9dP4TDIMOwwpA-/&kc2JgQ-"',
    'SELECT "&2D3cwQ- Stuff"',
    'STATUS "&ANg-deg&AOU-rd &IBM- arkiv" (MESSAGES UNSEEN RECENT UIDNEXT UIDVALIDITY)',
  ]);
  // deno-lint-ignore no-control-regex
  assert(wire.written.every((b) => b < 0x80), "no 8-bit octet is written in a mailbox name");
  assertEquals(status, { messages: 3, unseen: 1, recent: 0, uidNext: 9, uidValidity: 2 });
});

// ── 2. the server's own words ───────────────────────────────────────────────

Deno.test("a tagged NO / BAD reason reaches the error as text: UTF-8 decoded, windows-1252 as it always read, ASCII untouched", async () => {
  const reasons: [string, string][] = [
    ["[CANNOT] Mailbox name is not valid", "[CANNOT] Mailbox name is not valid"],
    [utf8Wire("Ugyldig mappenavn – prøv igjen"), "Ugyldig mappenavn – prøv igjen"],
    [utf8Wire("邮箱不存在"), "邮箱不存在"],
    ["Le dossier n'a pas \xe9t\xe9 trouv\xe9 \x96 d\xe9sol\xe9", "Le dossier n'a pas été trouvé – désolé"],
  ];
  for (const maxRead of [undefined, 1]) {
    for (const [wireReason, text] of reasons) {
      const { imap } = client((command) => `${command.tag} NO ${wireReason}${CRLF}`, maxRead);
      const error = await assertRejects(() => imap.createMailbox("x"), Error);
      assertEquals(error.message, `CREATE failed for "x": ${text}`);
      assertIsText(error.message, "error message");
      // REVIEW FIX. Without the decode the UTF-8 reasons were a byte string
      // (and before the exact reader, windows-1252 mojibake).
      // deno-lint-ignore no-control-regex
      if (!/[^\x00-\x7f]/.test(wireReason) || !isUtf8(wireReason)) {
        assertEquals(text, legacyRead(wireReason), "ASCII and windows-1252 reasons read as before");
      }
    }
  }
});

function isUtf8(wire: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(wireBytes(wire));
    return true;
  } catch {
    return false;
  }
}

Deno.test("response codes are found in a decoded tagged line: APPENDUID, COPYUID, BADCHARSET", async () => {
  const { imap } = client((command) => {
    if (/^APPEND/.test(command.text)) return `${command.tag} OK [APPENDUID 38505 3955] ${utf8Wire("lagret – ok")}${CRLF}`;
    if (/^UID COPY/.test(command.text)) return `${command.tag} OK [COPYUID 38505 4,7 101:102] ${utf8Wire("kopiert – ok")}${CRLF}`;
    return `${command.tag} OK done${CRLF}`;
  }, 3);
  assertEquals(await imap.appendWithFlags("Drafts", "Subject: x\r\n\r\ny", ["\\Draft"]), { ok: true, uid: 3955 });
  assertEquals([...await imap.uidCopy([4, 7], "Archive")], [[4, 101], [7, 102]]);
});

// ── 3. SEARCH ───────────────────────────────────────────────────────────────

Deno.test("UID SEARCH: results split over several lines are all read; an ESEARCH line is not mistaken for one", async () => {
  const { imap } = client((command) =>
    `* SEARCH 1 2 3${CRLF}* ESEARCH (TAG "${command.tag}") UID ALL 900:901${CRLF}* SEARCH 40 41${CRLF}* SEARCH${CRLF}${command.tag} OK done${CRLF}`, 2);
  assertEquals(await imap.uidSearch("ALL"), [1, 2, 3, 40, 41]);
});

Deno.test("UID SEARCH with non-ASCII criteria: CHARSET UTF-8, each operand a literal of its UTF-8 octets, counted in octets", async () => {
  const { imap, wire } = client((command) => `* SEARCH 5${CRLF}${command.tag} OK done${CRLF}`);
  assertEquals(await imap.uidSearch('SUBJECT "Ødegård – 😀" UNSEEN FROM "José"'), [5]);
  const [command] = wire.commands;
  const first = new TextEncoder().encode("Ødegård – 😀");
  const second = new TextEncoder().encode("José");
  assertEquals(command.text, `UID SEARCH CHARSET UTF-8 SUBJECT {${first.length}} UNSEEN FROM {${second.length}}`);
  assertEquals(command.literals, [first, second]);
  assert(first.length > "Ødegård – 😀".length, "octets, not the UTF-16 units of the string");
});

// ── 4. ENVELOPE ─────────────────────────────────────────────────────────────

function fetchReply(uid: number, envelope: string, rest = ""): (command: ScriptedCommand) => string {
  return (command) => {
    if (/^SELECT/.test(command.text)) return `* 1 EXISTS${CRLF}${command.tag} OK [READ-WRITE] done${CRLF}`;
    return `* 1 FETCH (UID ${uid} FLAGS (\\Seen \\Flagged) ENVELOPE ${envelope}${rest})${CRLF}${command.tag} OK FETCH completed${CRLF}`;
  };
}

const lit = (octets: string) => `{${octets.length}}${CRLF}${octets}`;

Deno.test("ENVELOPE: quoted strings with escapes, NIL, literals and nested address lists parse, at every read size", async () => {
  const subject = "Faktura – Ødegård’s café €5 😀";
  const envelope = "(" + [
    '"Thu, 01 Oct 2026 10:00:00 +0000"',
    lit(utf8Wire(subject)),
    `(("Jos\xe9 \\"Pepe\\" Garc\xeda" NIL "jose" "example.com")(${lit(utf8Wire("山田 太郎"))} NIL "yamada" "example.com"))`,
    "NIL",
    "NIL",
    '((NIL NIL "owner" "example.com")("=?UTF-8?B?QsOmcg==?=" NIL "baer" "example.com"))',
    "NIL",
    "NIL",
    "NIL",
    '"<m7@example.com>"',
  ].join(" ") + ")";
  for (const maxRead of READ_SIZES) {
    const { imap } = client(fetchReply(7, envelope), maxRead);
    await imap.selectMailbox("INBOX");
    const [summary] = await imap.fetchSummaries([7], { includePreview: false });
    assertEquals(summary.uid, 7);
    assertEquals(summary.flags, ["\\Seen", "\\Flagged"]);
    assertEquals(summary.envelope.subject, subject, `read ${maxRead ?? "all"}`);
    assertEquals(summary.envelope.subject.length, 30, "the emoji is one surrogate pair, not four characters");
    assertEquals(summary.envelope.from, [
      // A raw windows-1252 display name reads as it did before.
      { name: legacyRead('Jos\xe9 "Pepe" Garc\xeda'), email: "jose@example.com" },
      { name: "山田 太郎", email: "yamada@example.com" },
    ]);
    assertEquals(summary.envelope.to, [
      { name: "", email: "owner@example.com" },
      // RFC 2047 is left for the tool layer, as before.
      { name: "=?UTF-8?B?QsOmcg==?=", email: "baer@example.com" },
    ]);
    assertEquals(summary.envelope.messageId, "<m7@example.com>");
    assertEquals(summary.envelope.date, "2026-10-01T10:00:00.000Z");
  }
});

Deno.test("decodeRawHeaderOctets: text is never decoded twice, and a string that is not octets is left alone", () => {
  // Already text (holds a character above U+00FF): untouched.
  for (const text of ["Faktura – Ødegård", "山田", "😀", "“x”", "aĀb"]) {
    assertEquals(decodeRawHeaderOctets(text), text);
  }
  // ASCII: the identical string.
  assertEquals(decodeRawHeaderOctets("Re: plain"), "Re: plain");
  // Decoded Latin-1-range text is stable under a second pass.
  for (const text of ["Ødegård", "José García", "Café", "Blåbær", "naïve façade"]) {
    assertEquals(decodeRawHeaderOctets(decodeRawHeaderOctets(utf8Wire(text))), text);
    assertEquals(decodeRawHeaderOctets(text), text, "single-byte text is not valid UTF-8 and reads as itself");
  }
  // Raw octets, UTF-8 and windows-1252.
  assertEquals(decodeRawHeaderOctets(utf8Wire("Hi 😀 – à")), "Hi 😀 – à");
  assertEquals(decodeRawHeaderOctets("\x93Angebot\x94 \x80 5"), "“Angebot” € 5");
  // REVIEW FIX. A complete value is validated strictly. 0xE9 ("é") is also a
  // UTF-8 lead octet, and a windows-1252 value ENDING in one used to pass as
  // "UTF-8, cut short" and came back as "Caf" + U+FFFD.
  assertEquals(decodeRawHeaderOctets("Caf\xe9"), "Café");
  assertEquals(decodeRawHeaderOctets("R\xe9sum\xe9"), "Résumé");
  assertEquals(decodeRawHeaderOctets("\xc5"), "Å");
});

// ── 5. headers of a read message ────────────────────────────────────────────

function raw(headers: string[], body = "x"): string {
  return [...headers, "", body].join(CRLF);
}

Deno.test("raw 8-bit headers: a value ending in an accented letter survives the header parser's trim (UTF-8 and windows-1252)", () => {
  // REVIEW FIX. `trim()` strips U+00A0 = octet 0xA0, the last octet of "à",
  // "Š" and of "😠": the character was cut in half before it was decoded.
  for (const subject of ["Voilà", "Déjà", "TOMÁŠ", "angry 😠", "ca\u00a0", "中文丠"]) {
    const parsed = parseEmail(raw([`Subject: ${utf8Wire(subject)}`, "Content-Type: text/plain"]));
    // The value comes back whole, a trailing U+00A0 ("ca\u00a0") included.
    assertEquals(getHeader(parsed.headers, "subject"), subject);
    const joined = parseEmailJoined(raw([`Subject: ${utf8Wire(subject)}`, "Content-Type: text/plain"]), toText);
    assertEquals(getHeader(joined.headers, "subject"), subject, "parseEmailJoined decodes headers as parseEmail does");
  }
  assertEquals(getHeader(parseEmail(raw(["Subject: Caf\xe9"])).headers, "subject"), "Café");
  // Folded, with the 8-bit octets on the continuation line.
  const folded = parseEmail(raw([`Subject: Rapport`, ` ${utf8Wire("d'activité – voilà")}`, "From: a@example.com"]));
  assertEquals(getHeader(folded.headers, "subject"), "Rapport d'activité – voilà");
});

Deno.test("RFC 2047: B and Q, many charsets, folded and adjacent words, and a character split across two words", () => {
  const cases: [string, string][] = [
    ["=?UTF-8?B?QsOmcg==?= report", "Bær report"],
    ["=?utf-8?q?Bl=C3=A5b=C3=A6r_=E2=80=93_ja?=", "Blåbær – ja"],
    ["=?ISO-8859-1?Q?Caf=E9?= =?ISO-8859-1?Q?_au_lait?=", "Café au lait"],
    ["=?windows-1252?Q?=93quoted=94_=80?=", "“quoted” €"],
    ["=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=", "こんにちは"],
    ["=?GB2312?B?xOO6ww==?=", "你好"],
    ["=?GBK?B?xOO6ww==?= =?koi8-r?Q?=F0=D2=C9=D7=C5=D4?=", "你好Привет"],
    ["=?Shift_JIS?B?k/qWe4zq?=", "日本語"],
    ["=?EUC-KR?B?vsiz58fPvLy/5A==?=", "안녕하세요"],
    ["=?UTF-8?B?8J+YgA==?= done", "😀 done"],
    // Folded between two encoded-words: the fold is not text.
    ["=?UTF-8?B?Q2hlY2sgb3V0IHRoZSBw?=\r\n =?UTF-8?B?b3N0?=", "Check out the post"],
    // Whitespace between an encoded-word and plain text IS text.
    ["Re: =?UTF-8?Q?=C3=98deg=C3=A5rd?= og co", "Re: Ødegård og co"],
    // An unknown charset label, and one with an RFC 2231 language suffix.
    ["=?x-unknown?Q?Bl=C3=A5?=", "Blå"],
    ["=?utf-8*en?Q?Bl=C3=A5?=", "Blå"],
    // Not base64 at all: the word's text is kept rather than thrown.
    ["=?UTF-8?B?***?=", "***"],
    ["no encoded words here = ?", "no encoded words here = ?"],
  ];
  for (const [input, expected] of cases) assertEquals(decodeEncodedWords(input), expected, input);

  // REVIEW FIX. Senders split a multi-byte character across two adjacent
  // encoded-words (RFC 2047 forbids it; long UTF-8 and GBK subjects do it).
  // Decoded one word at a time each half became U+FFFD.
  const euro = wireString(new TextEncoder().encode("Pris: 5 € netto"));
  const cut = euro.indexOf("\xe2") + 1; // inside the three-octet euro sign
  const split = `=?UTF-8?B?${btoa(euro.slice(0, cut))}?=\r\n =?UTF-8?B?${btoa(euro.slice(cut))}?=`;
  assertEquals(decodeEncodedWords(split), "Pris: 5 € netto");
  assertEquals(decodeEncodedWords("=?UTF-8?Q?Bl=C3?= =?UTF-8?Q?=A5b=C3=A6r?="), "Blåbær");
  assertEquals(decodeEncodedWords("=?GBK?B?xOO6?= =?GBK?B?ww==?="), "你好");
  // Different charsets are still decoded apart.
  assertEquals(decodeEncodedWords("=?ISO-8859-1?Q?=E9?= =?UTF-8?Q?=C3=A9?="), "éé");
  // An invalid sequence stays U+FFFD and nothing throws.
  assertEquals(decodeEncodedWords("=?UTF-8?Q?a=FFb?="), "a�b");
});

// ── 6. bodies ───────────────────────────────────────────────────────────────

const qp = (octets: string) => octets.replace(/[^\x20-\x3c\x3e-\x7e]/g, (c) => "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
const b64 = (octets: string) => btoa(octets).replace(/(.{76})/g, `$1${CRLF}`);
const bytesOf = (...values: number[]) => wireString(Uint8Array.from(values));

interface BodyCase {
  charset: string;
  octets: string;
  text: string;
}

const BODY_CASES: BodyCase[] = [
  { charset: "utf-8", octets: utf8Wire("Ødegård – “hei” € 日本語 😀 à"), text: "Ødegård – “hei” € 日本語 😀 à" },
  { charset: "iso-8859-1", octets: "Bl\xe5b\xe6r p\xe5 tur", text: "Blåbær på tur" },
  { charset: "iso-8859-2", octets: bytesOf(0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6, 0x20, 0x67, 0xea, 0xb6, 0x6c, 0xb1), text: "Zażółć gęślą" },
  { charset: "iso-8859-15", octets: "5 \xa4", text: "5 €" },
  { charset: "windows-1252", octets: "\x93\x805 \x96 ok\x94", text: "“€5 – ok”" },
  { charset: "windows-1251", octets: bytesOf(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2), text: "Привет" },
  { charset: "koi8-r", octets: bytesOf(0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4), text: "Привет" },
  { charset: "shift_jis", octets: bytesOf(0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd), text: "こんにちは" },
  { charset: "euc-kr", octets: bytesOf(0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4), text: "안녕하세요" },
  { charset: "gbk", octets: bytesOf(0xc4, 0xe3, 0xba, 0xc3), text: "你好" },
  { charset: "iso-2022-jp", octets: bytesOf(0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28, 0x42), text: "こんにちは" },
];

function bodyMessage(c: BodyCase, encoding: string): string {
  const body = encoding === "quoted-printable" ? qp(c.octets) : encoding === "base64" ? b64(c.octets) : c.octets;
  return raw([
    "From: sender@example.com",
    "Subject: body",
    `Content-Type: text/plain; charset=${c.charset}`,
    `Content-Transfer-Encoding: ${encoding}`,
  ], body);
}

function fetchRawReply(message: string): (command: ScriptedCommand) => string {
  return (command) => {
    if (/^SELECT/.test(command.text)) return `* 1 EXISTS${CRLF}${command.tag} OK [READ-WRITE] done${CRLF}`;
    return `* 1 FETCH (UID 5 FLAGS (\\Seen) BODY[] ${lit(message)})${CRLF}${command.tag} OK done${CRLF}`;
  };
}

Deno.test("bodies: every charset under 7bit / 8bit / binary / quoted-printable / base64 reads back exactly, the socket cut anywhere", async () => {
  // The fixtures are honest: each octet string really is the text in that charset.
  for (const c of BODY_CASES) assertEquals(new TextDecoder(c.charset).decode(wireBytes(c.octets)), c.text, c.charset);

  for (const c of BODY_CASES) {
    for (const encoding of ["8bit", "binary", "quoted-printable", "base64", "7bit"]) {
      // "7bit" with 8-bit octets is a lie senders tell; it reads as 8bit does.
      const message = bodyMessage(c, encoding);
      for (const maxRead of [undefined, 1, 3, 7]) {
        const { imap } = client(fetchRawReply(message), maxRead);
        await imap.selectMailbox("INBOX");
        const fetched = await imap.fetchMessageRaw(5);
        assert(fetched);
        assertEquals(fetched.raw, message, `${c.charset} ${encoding}: the raw message is the wire octets`);
        assertEquals(parseEmail(fetched.raw).text, c.text, `${c.charset} ${encoding} (read ${maxRead ?? "all"})`);
        assertEquals(parseEmailJoined(fetched.raw, toText).text, c.text, "one decode path: the joined parser agrees");
      }
    }
  }
});

Deno.test("bodies: a message that says nothing usable about its charset is UTF-8 when valid, windows-1252 otherwise, to the last octet", () => {
  // REVIEW FIX. A whole body is validated strictly; see the header test above.
  for (const label of ["", "; charset=us-ascii", "; charset=x-unknown"]) {
    const of = (octets: string) => parseEmail(raw([`Content-Type: text/plain${label}`, "Content-Transfer-Encoding: 8bit"], octets)).text;
    assertEquals(of("Caf\xe9"), "Café", `"${label}"`);
    assertEquals(of("Merci, Jos\xe9"), "Merci, José");
    assertEquals(of(utf8Wire("Café – voilà")), "Café – voilà");
  }
  // The same, inside a multipart, where the part's trailing CRLF is not part of it.
  const mixed = raw(['Content-Type: multipart/mixed; boundary="b"'], [
    "--b",
    "Content-Type: text/plain",
    "Content-Transfer-Encoding: 8bit",
    "",
    "Merci, Jos\xe9",
    "--b--",
    "",
  ].join(CRLF));
  assertEquals(parseEmail(mixed).text, "Merci, José");
  assertEquals(parseEmailJoined(mixed, toText).text, "Merci, José");
});

Deno.test("joined read: the header block of an inline forwarded message decodes raw 8-bit headers", () => {
  // REVIEW FIX (found combining the three changes): parseEmailJoined returned
  // its headers, and an embedded message's, as byte strings.
  const embedded = [
    `From: ${utf8Wire("Ødegård AS")} <post@example.com>`,
    "To: Jos\xe9 <jose@example.com>",
    `Subject: ${utf8Wire("Faktura – voilà")}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    utf8Wire("Beløp: 5 €"),
  ].join(CRLF);
  const message = raw([`Subject: ${utf8Wire("VS: Faktura – voilà")}`, 'Content-Type: multipart/mixed; boundary="b"'], [
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Se under.",
    "--b",
    "Content-Type: message/rfc822",
    "Content-Disposition: inline",
    "",
    embedded,
    "--b--",
    "",
  ].join(CRLF));
  const joined = parseEmailJoined(message, toText);
  assertEquals(getHeader(joined.headers, "subject"), "VS: Faktura – voilà");
  assertEquals(joined.text, [
    "Se under.",
    "",
    "---------- Forwarded message ----------",
    "From: Ødegård AS <post@example.com>",
    "Subject: Faktura – voilà",
    "To: José <jose@example.com>",
    "",
    "Beløp: 5 €",
  ].join("\n"));
  assertIsText(joined.text!, "joined body");
});

// ── 7. attachments ──────────────────────────────────────────────────────────

Deno.test("attachments: 8bit, binary and base64 parts keep every octet; names in every written form are text", async () => {
  const all = wireString(Uint8Array.from({ length: 256 }, (_, i) => i)).replace(/[\r\n]/g, "");
  const body = [
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--b",
    `Content-Type: application/octet-stream; name="eight.bin"`,
    "Content-Transfer-Encoding: 8bit",
    "Content-Disposition: attachment",
    "",
    all,
    "--b",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: binary",
    `Content-Disposition: attachment; filename="${utf8Wire("Ødegård – voilà")}"`,
    "",
    all,
    "--b",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=UTF-8''%E2%82%AC%20rates%20%C3%A0.pdf",
    "",
    b64(all),
    "--b",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment;",
    " filename*0*=iso-8859-1'en'R%E9sum%E9%20;",
    ' filename*1="final.pdf"',
    "",
    b64("%PDF-2"),
    "--b",
    "Content-Type: application/pdf; name=\"=?UTF-8?B?QsOmcg==?= =?UTF-8?B?LnBkZg==?=\"",
    "Content-Transfer-Encoding: base64",
    "",
    b64("%PDF-3"),
    "--b",
    "Content-Type: text/csv",
    `Content-Disposition: attachment; filename=Caf\xe9`,
    "",
    "a,b",
    "--b",
    "Content-Type: text/csv",
    "Content-Disposition: attachment; filename*=UTF-8''new.csv; filename=\"old.csv\"",
    "",
    "c,d",
    "--b--",
    "",
  ].join(CRLF);
  const message = raw(["Subject: files", 'Content-Type: multipart/mixed; boundary="b"'], body);
  for (const maxRead of [undefined, 1, 5]) {
    const { imap } = client(fetchRawReply(message), maxRead);
    await imap.selectMailbox("INBOX");
    const fetched = await imap.fetchMessageRaw(5);
    const parsed = parseEmail(fetched!.raw);
    assertEquals(parsed.attachments.map((a) => a.filename), [
      "eight.bin",
      "Ødegård – voilà",
      // REVIEW FIX. RFC 2231: these two were listed as "UTF-8''%E2%82%AC..."
      // and "iso-8859-1'en'R%E9sum%E9%20".
      "€ rates à.pdf",
      "Résumé final.pdf",
      "Bær.pdf",
      "Café",
      "new.csv",
    ]);
    assertEquals(parsed.attachments[0].content, wireBytes(all), "8bit: all 254 octets");
    assertEquals(parsed.attachments[1].content, wireBytes(all), "binary");
    assertEquals(parsed.attachments[2].content, wireBytes(all), "base64");
    for (const a of parsed.attachments) assertIsText(a.filename, "filename");
    // Same list, same order, from the parser `email_read` uses: indices are stable.
    assertEquals(parseEmailJoined(fetched!.raw, toText).attachments, parsed.attachments);
  }
});

// ── 8. writes ───────────────────────────────────────────────────────────────

Deno.test("APPEND: bytes go out octet for octet with an octet count; a string is encoded as UTF-8 text", async () => {
  const everyOctet = Uint8Array.from({ length: 256 }, (_, i) => i);
  const { imap, wire } = client((command) => `${command.tag} OK [APPENDUID 1 9] done${CRLF}`);
  assertEquals(await imap.append("Sent", everyOctet), true);
  assertEquals(await imap.appendWithFlags("Drafts", "Subject: Ødegård\r\n\r\nx", ["\\Draft", "\\Seen"]), { ok: true, uid: 9 });
  assertEquals(wire.commands[0].text, 'APPEND "Sent" (\\Seen) {256}');
  assertEquals(wire.commands[0].literals, [everyOctet]);
  const text = new TextEncoder().encode("Subject: Ødegård\r\n\r\nx");
  assertEquals(wire.commands[1].text, `APPEND "Drafts" (\\Draft \\Seen) {${text.length}}`);
  assertEquals(wire.commands[1].literals, [text]);
});

Deno.test("draft_send (imap): an 8bit draft another client saved is sent, and filed in Sent, with its own octets", async () => {
  // REVIEW FIX of a known bug. The raw draft was passed on as a STRING, which
  // SMTP and APPEND UTF-8-encode: every 8-bit octet went out as two.
  const body = utf8Wire("Hei Ødegård – “takk” €5");
  const draft = raw([
    "From: owner@example.com",
    "To: kari@example.com",
    "Bcc: hidden@example.com,",
    " second@example.com",
    `Subject: ${utf8Wire("Blåbær")}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ], body + CRLF + ".leading dot" + CRLF);

  // Read it the way imapSendDraft does.
  const { imap } = client(fetchRawReply(draft), 3);
  await imap.selectMailbox("Drafts");
  const stored = (await imap.fetchMessageRaw(5))!.raw;

  const sent = draftSendBytes(stored);
  const expected = draft.replace(`Bcc: hidden@example.com,${CRLF} second@example.com${CRLF}`, "");
  assertEquals(wireString(sent), expected, "the draft's octets, minus the Bcc header");
  assert(!wireString(sent).toLowerCase().includes("bcc"));

  // SMTP DATA: the same octets, dot-stuffed and terminated, nothing doubled.
  assertEquals(wireString(smtpDataPayload(sent)), expected.replace(`${CRLF}.leading`, `${CRLF}..leading`) + `${CRLF}.${CRLF}`);
  assertEquals(new TextDecoder().decode(sent).includes("Hei Ødegård – “takk” €5"), true);
  // What used to go out: the string, UTF-8-encoded a second time.
  const before = smtpDataPayload(stored);
  assert(before.length > smtpDataPayload(sent).length + 10 && !new TextDecoder().decode(before).includes("Ødegård"));

  // The Sent copy is appended from the same bytes.
  const sentBox = client((command) => `${command.tag} OK done${CRLF}`);
  await sentBox.imap.append("Sent", sent);
  assertEquals(sentBox.wire.commands[0].literals, [wireBytes(expected)]);

  // A 7-bit draft (everything this server composes itself) is unchanged.
  const ascii = raw(["To: kari@example.com", "Bcc: x@example.com", "Subject: plain"], "body");
  assertEquals(draftSendBytes(ascii), new TextEncoder().encode(ascii.replace(`Bcc: x@example.com${CRLF}`, "")));

  // And the handler uses it for both the transmission and the Sent copy.
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = index.indexOf("async function imapSendDraft(");
  const handler = index.slice(start, index.indexOf("\n}\n", start));
  assert(handler.includes("const sentMime = draftSendBytes(rawMime);"));
  assert(handler.includes("await imapSmtpSend(inbox, sentMime, recipients);"));
  assert(handler.includes("await appendToSentFolder(inbox, sentMime);"));
});

Deno.test("forward relay: the forwarded-message block decodes a raw 8-bit original header", () => {
  // REVIEW FIX. The note quoted raw header octets one character each.
  const block = [
    `From: ${utf8Wire("Ødegård AS")} <post@example.com>`,
    "To: Jos\xe9 <jose@example.com>",
    "Date: Thu, 01 Oct 2026 10:00:00 +0000",
    `Subject: ${utf8Wire("Faktura – voilà")}`,
  ].join(CRLF);
  assertEquals(summarizeOriginal(block), {
    from: "Ødegård AS <post@example.com>",
    to: "José <jose@example.com>",
    date: "Thu, 01 Oct 2026 10:00:00 +0000",
    subject: "Faktura – voilà",
  });
});

// ── 9. previews ─────────────────────────────────────────────────────────────

const HTML_PART = { type: "text", subtype: "html", charset: "utf-8", encoding: "7bit" };
const PLAIN_PART = { type: "text", subtype: "plain", charset: "utf-8", encoding: "7bit" };

Deno.test("preview (imap): entities are decoded exactly once, in the part and again nowhere", () => {
  // REVIEW FIX. A message that SHOWS the text "&lt;b&gt;" writes it as
  // "&amp;lt;b&amp;gt;". The part was decoded, then decoded again by
  // normalizePreview (twice: in text-extract.ts and in index.ts) into "<b>".
  const html = "<p>Write &amp;lt;b&amp;gt; for bold &amp;amp; &lt;i&gt; for italics.&nbsp;&shy;Done&#33;</p>";
  const preview = cleanPreviewFromBodyPart(html, HTML_PART);
  assertEquals(preview, "Write &lt;b&gt; for bold &amp; <i> for italics. Done!");
  // What index.ts does to an IMAP row: a tidy, which changes nothing.
  assertEquals(tidyPreview(preview), preview);
  // What it used to do.
  assertEquals(normalizePreview(preview), "Write <b> for bold & <i> for italics. Done!");

  // Plain text is decoded once too (senders put &nbsp; in text/plain parts).
  assertEquals(cleanPreviewFromBodyPart("Tom &amp; Jerry&nbsp;&amp;amp; co", PLAIN_PART), "Tom & Jerry &amp; co");

  // A nested multipart (part one of a mixed message is an alternative).
  const nested = [
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<div>Use &amp;lt;br&amp;gt; here</div>",
    "--alt--",
    "",
  ].join(CRLF);
  assertEquals(cleanPreviewFromBodyPart(nested, null), "Use &lt;br&gt; here");

  const index = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assert(!index.includes("normalizePreview(s.preview)"), "an IMAP row is not entity-decoded a second time");
});

Deno.test("preview: the 200-character cap never ends on half a surrogate pair", () => {
  // REVIEW FIX. `slice(0, 200)` counts UTF-16 units.
  const text = "a".repeat(199) + "😀 tail";
  for (const preview of [tidyPreview(text), normalizePreview(text), cleanPreviewFromBodyPart(utf8Wire(text), { ...PLAIN_PART, encoding: "8bit" })]) {
    assertEquals(preview, "a".repeat(199));
    assert(!/[\ud800-\udfff]/.test(preview.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), "no lone surrogate");
  }
  const whole = "a".repeat(198) + "😀 tail";
  assertEquals(tidyPreview(whole), "a".repeat(198) + "😀");
  assertEquals(JSON.parse(JSON.stringify({ p: tidyPreview(text) })).p, "a".repeat(199));
});

Deno.test("preview: visible text anywhere in the fetched 2 KB is found; a prefix that is all style previews as empty", () => {
  const css = "<html><head><style>" + ".a{color:red;margin:0 auto}".repeat(70);
  assert(css.length > 1800 && css.length < 2000);
  // The style block closes late in the prefix: the text after it is the preview.
  const late = (css + "</style></head><body><p>Hello Kari, your invoice is ready.</p>").slice(0, 2048);
  assertEquals(cleanPreviewFromBodyPart(late, HTML_PART), "Hello Kari, your invoice is ready.");
  // Hidden preheader text between two style blocks is text too.
  const between = ("<style>.a{}</style><div>Preheader line</div><style>" + ".b{color:blue}".repeat(200)).slice(0, 2048);
  assertEquals(cleanPreviewFromBodyPart(between, HTML_PART), "Preheader line");
  // Nothing visible in the fetched octets: "" (never CSS). The fetch is not enlarged.
  const allStyle = (css + ".b{color:blue}".repeat(60)).slice(0, 2048);
  assertEquals(cleanPreviewFromBodyPart(allStyle, HTML_PART), "");
});

Deno.test("preview: short single-byte text under a wrong or missing charset keeps its accented letters", () => {
  // REVIEW FIX. "A stray invalid octet or two is dropped" ate the é of "Café".
  assertEquals(cleanPreviewFromBodyPart("Caf\xe9 ol\xe9 ", { ...PLAIN_PART, encoding: "8bit" }), "Café olé");
  // Ending in the accented letter: a whole part (BODYSTRUCTURE gives its size)
  // is single-byte text; the same octets as a cut PREFIX stay UTF-8, the
  // unfinished sequence withheld.
  assertEquals(cleanPreviewFromBodyPart("Caf\xe9", { ...PLAIN_PART, charset: null, encoding: "8bit", size: 4 }), "Café");
  assertEquals(cleanPreviewFromBodyPart("Caf\xe9", { ...PLAIN_PART, encoding: "8bit", size: 4 }), "Café");
  assertEquals(cleanPreviewFromBodyPart("Caf\xe9", { ...PLAIN_PART, encoding: "8bit", size: 4000 }), "Caf");
  assertEquals(cleanPreviewFromBodyPart(utf8Wire("Blåbær").slice(0, -2), { ...PLAIN_PART, encoding: "8bit", size: 4000 }), "Blåb");
  assertEquals(cleanPreviewFromBodyPart("\x93Hei\x94", { ...PLAIN_PART, charset: "us-ascii", encoding: "8bit" }), "“Hei”");
  // Real UTF-8 with one stray octet is still UTF-8, the stray dropped.
  assertEquals(cleanPreviewFromBodyPart(utf8Wire("Blåbær") + "\xff" + utf8Wire(" – ja"), { ...PLAIN_PART, encoding: "8bit" }), "Blåbær – ja");
});

// ── 10. through the tools ───────────────────────────────────────────────────

interface ToolOutcome {
  result: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
}

const noHttp: ProviderHandler = (call) => json({ error: `unexpected ${call.url}` }, 500);

async function withImap<T>(messages: FakeMessage[], body: () => Promise<T>): Promise<T> {
  const holder = ImapClient as unknown as { connect: (cfg: unknown) => Promise<ImapClient> };
  const realConnect = holder.connect;
  holder.connect = () => Promise.resolve(new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }] }).client());
  try {
    const inbox = await inboxRow("gmail", {
      provider: "imap",
      email_address: "owner@example.com",
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_security: "tls",
      imap_username: "owner@example.com",
      imap_password: await encryptToken("app-password-invented"),
    });
    return (await runTool(inbox, noHttp, body)).value;
  } finally {
    holder.connect = realConnect;
  }
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

Deno.test("email_read and email_list (imap): a message written in raw 8-bit headers and an 8bit body returns text in every field", async () => {
  const message: FakeMessage = {
    uid: 3,
    flags: [],
    raw: raw([
      "Date: Thu, 01 Oct 2026 10:00:00 +0000",
      `From: ${utf8Wire("Ødegård Bjørn")} <bjorn@example.com>`,
      `To: ${utf8Wire("山田 太郎")} <yamada@example.com>`,
      // A different header, in a different encoding (windows-1252).
      'Cc: "Jos\xe9 Garc\xeda" <jose@example.com>',
      `Subject: ${utf8Wire("Faktura – voilà 😀 à")}`,
      "Message-ID: <m3@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
    ], [
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      utf8Wire("Hei – “takk” for sist. Use &amp;lt;b&amp;gt; 😀"),
      "--b",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf",
      "",
      btoa("%PDF-invented"),
      "--b--",
      "",
    ].join(CRLF)),
  };

  const readOutcome = await withImap([message], () =>
    executeReadEmail({ inbox_id: INBOX_ID, message_id: "INBOX:3" }, API_KEY) as Promise<ToolOutcome>);
  const read = readOutcome.result.structuredContent!;
  assertEquals(read.subject, "Faktura – voilà 😀 à");
  assertEquals(read.from, { name: "Ødegård Bjørn", email: "bjorn@example.com" });
  assertEquals(read.to, [{ name: "山田 太郎", email: "yamada@example.com" }]);
  assertEquals(read.cc, [{ name: "José García", email: "jose@example.com" }]);
  assertEquals(read.body_text, "Hei – “takk” for sist. Use &amp;lt;b&amp;gt; 😀", "a plain-text BODY is never entity-decoded");
  assertEquals((read.attachments as { filename: string }[]).map((a) => a.filename), ["€ rates.pdf"]);
  for (const s of strings(read)) assertIsText(s, "email_read");
  for (const s of strings(JSON.parse(readOutcome.result.content[0].text))) assertIsText(s, "email_read text content");

  const listOutcome = await withImap([message], () =>
    executeListInbox({ inbox_id: INBOX_ID, folder: "INBOX", limit: 10 }, API_KEY) as Promise<ToolOutcome>);
  const [row] = listOutcome.result.structuredContent!.messages as Record<string, unknown>[];
  assertEquals(row.subject, read.subject, "the list row and the read agree on the subject");
  assertEquals(row.from, read.from);
  assertEquals(row.preview, "Hei – “takk” for sist. Use &lt;b&gt; 😀", "decoded once");
  for (const s of strings(listOutcome.result.structuredContent)) assertIsText(s, "email_list");
});
