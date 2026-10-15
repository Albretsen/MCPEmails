// ---------------------------------------------------------------------------
// 8-bit IMAP bodies are decoded from bytes, not from a windows-1252 string.
//
// The IMAP client used to turn everything it read into a string with
// TextDecoder("latin1"). Under the WHATWG encoding standard that label is
// windows-1252, which maps 27 of the octets 0x80-0x9F to code points above
// U+00FF. mime.ts then took the octets back with `charCodeAt(i) & 0xff`, so
// 0x80 became 0xAC, 0x99 became 0x22, and so on. Any part sent
// `Content-Transfer-Encoding: 8bit` (or `binary`) with such an octet in it was
// corrupted: for UTF-8 that is every character with a continuation byte in
// 0x80-0x9F ("’", "–", "€", "Ø", most CJK), for windows-1252 it is the curly
// quotes, dashes and the euro sign themselves.
//
// Held here, each through the same path `email_read` takes on IMAP (a fake
// server, `fetchMessageRaw`, `parseEmail`):
//   1. 8bit UTF-8, windows-1252 and ISO-8859-1 bodies read back exactly.
//   2. A multi-byte character split across socket reads, and a literal larger
//      than the streaming threshold, read back exactly.
//   3. An 8bit / binary attachment keeps every octet.
//   4. A part with no (or a useless) charset is UTF-8 when it is valid UTF-8
//      and windows-1252 otherwise.
//   5. Raw 8-bit header values (top-level headers and ENVELOPE) are decoded the
//      same way, so the exact read does not surface C1 controls in a subject.
//   6. 7bit, quoted-printable and base64 messages reach the parser as the very
//      string the old reader produced, and decode to what they always did.
//
// No real mailbox data: every address is under example.com.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { bytesToByteString } from "./byte-string.ts";
import { ImapClient, singleByteTextToBytes } from "./imap-client.ts";
import { FakeImapServer, type FakeMessage } from "./imap-fake-server.ts";
import { parseEmail, parseMultipartBodySource } from "./mime.ts";

const CRLF = "\r\n";
const utf8 = new TextEncoder();

/** One character per octet, written the slow obvious way so it can be trusted. */
function byteString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function octetsOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    assert(text.charCodeAt(i) <= 0xff, "fixture is not a byte string");
    out[i] = text.charCodeAt(i);
  }
  return out;
}

/** What the reader used to hand the parser for these octets. */
function legacyRead(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

interface PartSpec {
  contentType: string;
  encoding?: string;
  /** The part body as it goes on the wire, one character per octet. */
  wireBody: string;
  subject?: string;
}

function message(uid: number, spec: PartSpec): FakeMessage {
  const head = [
    "Date: Thu, 01 Oct 2026 10:00:00 +0000",
    'From: "Sender" <sender@example.com>',
    "To: <owner@example.com>",
    `Subject: ${spec.subject ?? "Eight bit"}`,
    `Message-ID: <m${uid}@example.com>`,
    "MIME-Version: 1.0",
    `Content-Type: ${spec.contentType}`,
  ];
  if (spec.encoding) head.push(`Content-Transfer-Encoding: ${spec.encoding}`);
  return { uid, flags: [], raw: [...head, "", spec.wireBody].join(CRLF) };
}

/**
 * A client on a fake server. `maxRead` caps how many octets one socket read
 * returns, which is how a multi-byte character ends up split across reads.
 */
function clientFor(messages: FakeMessage[], maxRead?: number): ImapClient {
  const server = new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }] });
  if (maxRead === undefined) return server.client();
  const conn = server.conn();
  const throttled = {
    write: (p: Uint8Array) => conn.write(p),
    read: (p: Uint8Array) => conn.read(p.subarray(0, maxRead)),
    close: () => conn.close(),
  };
  const ctor = ImapClient as unknown as { new (conn: unknown): ImapClient };
  return new ctor(throttled);
}

async function rawOf(msg: FakeMessage, maxRead?: number): Promise<string> {
  const client = clientFor([msg], maxRead);
  await client.selectMailbox("INBOX");
  const fetched = await client.fetchMessageRaw(msg.uid);
  assert(fetched, "the message is on the server");
  return fetched.raw;
}

/** The `email_read` body path on IMAP: fetch the raw message, parse it. */
async function read(msg: FakeMessage, maxRead?: number) {
  return parseEmail(await rawOf(msg, maxRead));
}

// Every character below has at least one UTF-8 octet in 0x80-0x9F, except the
// controls: "é" (C3 A9) and "å" (C3 A5), which the old path got right and
// which are here to show a mixed body.
const UTF8_TEXT = [
  "Café – “smart” ‘quotes’ don’t cost €5…",
  "Blåbærsyltetøy, Ødegård, Ærlig, Århus, œuvre™",
  "日本語のテキスト、你好世界、한국어",
  "Ελληνικά, Русский, עברית, العربية",
  "emoji 😀 👍🏽",
].join(CRLF);

// ── 8bit UTF-8 ─────────────────────────────────────────────────────────────

Deno.test("8bit UTF-8 text/plain is read back exactly", async () => {
  const body = byteString(utf8.encode(UTF8_TEXT));
  // The fixture really does carry the octets this is about.
  assert(/[\x80-\x9f]/.test(body), "fixture has octets in 0x80-0x9F");
  const parsed = await read(message(1, {
    contentType: "text/plain; charset=utf-8",
    encoding: "8bit",
    wireBody: body,
  }));
  assertEquals(parsed.text, UTF8_TEXT);
});

Deno.test("binary UTF-8 text/html is read back exactly", async () => {
  const html = `<p>${UTF8_TEXT.replaceAll(CRLF, "<br>")}</p>`;
  const parsed = await read(message(2, {
    contentType: 'text/html; charset="UTF-8"',
    encoding: "binary",
    wireBody: byteString(utf8.encode(html)),
  }));
  assertEquals(parsed.html, html);
});

Deno.test("an 8bit multipart/alternative keeps both parts and an 8bit attachment keeps every octet", async () => {
  const allOctets = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256)
    // No CR/LF inside: the part is delimited by lines.
    .map((b) => (b === 0x0d || b === 0x0a ? 0x20 : b));
  const html = `<p>${UTF8_TEXT}</p>`;
  const body = [
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    byteString(utf8.encode(UTF8_TEXT)),
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    byteString(utf8.encode(html)),
    "--inner--",
    "--outer",
    'Content-Type: application/octet-stream; name="octets.bin"',
    "Content-Transfer-Encoding: binary",
    'Content-Disposition: attachment; filename="octets.bin"',
    "",
    byteString(allOctets),
    "--outer",
    'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
    "Content-Transfer-Encoding: 8bit",
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    byteString(utf8.encode("Ødegård’s notes – €5")),
    "--outer--",
    "",
  ].join(CRLF);
  const parsed = await read(message(3, {
    contentType: 'multipart/mixed; boundary="outer"',
    wireBody: body,
  }));
  assertEquals(parsed.text, UTF8_TEXT);
  assertEquals(parsed.html, html);
  assertEquals(parsed.attachments.map((a) => a.filename), ["octets.bin", "notes.txt"]);
  assertEquals(parsed.attachments[0].content, allOctets);
  // What attachment text extraction decodes.
  assertEquals(new TextDecoder().decode(parsed.attachments[1].content), "Ødegård’s notes – €5");
});

// ── 8bit single-byte charsets ──────────────────────────────────────────────

Deno.test("8bit windows-1252 with octets 0x80-0x9F is read back exactly", async () => {
  // “Quoted” ‘single’ – dash — em … € 5 ™ and café
  const bytes = Uint8Array.from([
    0x93, 0x51, 0x75, 0x6f, 0x74, 0x65, 0x64, 0x94, 0x20, // “Quoted”
    0x91, 0x73, 0x69, 0x6e, 0x67, 0x6c, 0x65, 0x92, 0x20, // ‘single’
    0x96, 0x20, 0x97, 0x20, 0x85, 0x20, // – — …
    0x80, 0x35, 0x20, 0x99, 0x20, // €5 ™
    0x63, 0x61, 0x66, 0xe9, // café
  ]);
  for (const charset of ["windows-1252", "Windows-1252", "cp1252"]) {
    const parsed = await read(message(4, {
      contentType: `text/plain; charset=${charset}`,
      encoding: "8bit",
      wireBody: byteString(bytes),
    }));
    assertEquals(parsed.text, "“Quoted” ‘single’ – — … €5 ™ café", charset);
  }
});

Deno.test("every windows-1252 octet 0x80-0xFF decodes as windows-1252 says", async () => {
  const bytes = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
  const parsed = await read(message(5, {
    contentType: "text/plain; charset=windows-1252",
    encoding: "8bit",
    wireBody: byteString(bytes),
  }));
  assertEquals(parsed.text, new TextDecoder("windows-1252").decode(bytes));
});

Deno.test("8bit ISO-8859-1 is read back exactly", async () => {
  // "Blåbærsyltetøy på Ærø: naïve façade, 10 °C ±½"
  const text = "Blåbærsyltetøy på Ærø: naïve façade, 10 °C ±½";
  const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  assert(bytes.every((b, i) => b === text.charCodeAt(i)), "fixture is Latin-1");
  for (const charset of ["iso-8859-1", "ISO-8859-1", "latin1"]) {
    const parsed = await read(message(6, {
      contentType: `text/plain; charset=${charset}`,
      encoding: "8bit",
      wireBody: byteString(bytes),
    }));
    assertEquals(parsed.text, text, charset);
  }
});

Deno.test("8bit ISO-8859-15 and KOI8-R decode with their own tables", async () => {
  // ISO-8859-15: 0xA4 is the euro sign (it is the currency sign in 8859-1).
  const latin9 = await read(message(7, {
    contentType: "text/plain; charset=iso-8859-15",
    encoding: "8bit",
    wireBody: byteString(Uint8Array.from([0xa4, 0x35, 0x20, 0xbd])),
  }));
  assertEquals(latin9.text, "€5 œ");
  // KOI8-R "Привет": every octet is above 0x7F.
  const koi = await read(message(8, {
    contentType: "text/plain; charset=koi8-r",
    encoding: "8bit",
    wireBody: byteString(Uint8Array.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4])),
  }));
  assertEquals(koi.text, "Привет");
});

// ── split reads and large literals ─────────────────────────────────────────

Deno.test("a multi-byte character split across socket reads is read back exactly", async () => {
  const msg = message(9, {
    contentType: "text/plain; charset=utf-8",
    encoding: "8bit",
    wireBody: byteString(utf8.encode(UTF8_TEXT)),
  });
  // 1 splits every character; 2, 3 and 7 walk the cut through every position
  // of the two-, three- and four-byte sequences.
  for (const maxRead of [1, 2, 3, 5, 7, 64]) {
    const parsed = await read(msg, maxRead);
    assertEquals(parsed.text, UTF8_TEXT, `socket reads of at most ${maxRead} octets`);
  }
});

Deno.test("an 8bit literal larger than the streaming threshold is read back exactly, in split reads too", async () => {
  // ~200 KB: over the 64 KB threshold, so the literal takes the dedicated
  // buffer path, and over one decode chunk many times.
  const text = (UTF8_TEXT + CRLF).repeat(1000);
  const msg = message(10, {
    contentType: "text/plain; charset=utf-8",
    encoding: "8bit",
    wireBody: byteString(utf8.encode(text)),
  });
  assert(msg.raw.length > 128 * 1024);
  assertEquals((await read(msg)).text, text);
  // 4099 is prime: the read boundary lands at a different offset of the
  // 8192-octet decode chunk, and of the characters, every time.
  assertEquals((await read(msg, 4099)).text, text);
});

Deno.test("the raw message is the wire octets, one character each", async () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    .map((b) => (b === 0x0d || b === 0x0a ? 0x20 : b));
  const msg = message(11, {
    contentType: "application/octet-stream",
    encoding: "binary",
    wireBody: byteString(all).repeat(3),
  });
  const raw = await rawOf(msg);
  assertEquals(raw, msg.raw);
  // What email_original and the draft recipient rewrite turn back into bytes.
  assertEquals(singleByteTextToBytes(raw), octetsOf(msg.raw));
});

// ── charset defaults ───────────────────────────────────────────────────────

Deno.test("a part with no charset is UTF-8 when it is valid UTF-8", async () => {
  for (const contentType of ["text/plain", "text/plain; charset=us-ascii", "text/plain; charset=x-unknown"]) {
    const parsed = await read(message(12, {
      contentType,
      encoding: "8bit",
      wireBody: byteString(utf8.encode(UTF8_TEXT)),
    }));
    assertEquals(parsed.text, UTF8_TEXT, contentType);
  }
});

Deno.test("a part with no charset that is not valid UTF-8 is windows-1252", async () => {
  // "It’s 5 € – café" in windows-1252.
  const bytes = Uint8Array.from([
    0x49, 0x74, 0x92, 0x73, 0x20, 0x35, 0x20, 0x80, 0x20, 0x96, 0x20, 0x63, 0x61, 0x66, 0xe9,
  ]);
  for (const contentType of ["text/plain", "text/plain; charset=us-ascii", "text/plain; charset=x-unknown"]) {
    const parsed = await read(message(13, { contentType, encoding: "8bit", wireBody: byteString(bytes) }));
    assertEquals(parsed.text, "It’s 5 € – café", contentType);
  }
});

Deno.test("a declared charset is respected even when the octets would also be valid UTF-8", async () => {
  // C3 A9 is "é" in UTF-8 and "Ã©" in ISO-8859-1. The sender said 8859-1.
  const parsed = await read(message(14, {
    contentType: "text/plain; charset=iso-8859-1",
    encoding: "8bit",
    wireBody: byteString(Uint8Array.from([0xc3, 0xa9])),
  }));
  assertEquals(parsed.text, "Ã©");
});

Deno.test("a UTF-8 part cut in the middle of a character stays UTF-8, on the preview path only", () => {
  // The preview path parses a 2 KB prefix of a part: the last character can
  // be half there. That is not "invalid UTF-8", and must not flip the whole
  // text to windows-1252.
  const whole = utf8.encode("Blåbær – Ødegård");
  const part = ["Content-Type: text/plain", "Content-Transfer-Encoding: 8bit", "", byteString(whole.subarray(0, whole.length - 3))]
    .join(CRLF);
  const prefix = ["--b", part].join(CRLF);
  const text = parseMultipartBodySource(prefix)?.text ?? "";
  assert(text.startsWith("Blåbær – Ødeg"), text);
  // A COMPLETE message gets no such leniency (review of the combined change):
  // windows-1252 text ending in "é" (0xE9, also a UTF-8 lead octet) is not
  // "UTF-8, cut short". See imap-read-review.test.ts.
  assertEquals(parseEmail(["Content-Type: text/plain", "", "Caf\xe9"].join(CRLF)).text, "Café");
});

// ── raw 8-bit header values ────────────────────────────────────────────────

Deno.test("a raw UTF-8 subject is decoded, in the message headers and in the ENVELOPE", async () => {
  const subject = "Faktura – Ødegård’s café €5";
  const msg = message(15, {
    contentType: "text/plain; charset=utf-8",
    encoding: "8bit",
    wireBody: "x",
    subject: byteString(utf8.encode(subject)),
  });
  const parsed = await read(msg);
  assertEquals(parsed.headers.get("subject"), [subject]);

  const client = clientFor([msg]);
  await client.selectMailbox("INBOX");
  const [summary] = await client.fetchSummaries([15]);
  assertEquals(summary.envelope.subject, subject);
});

Deno.test("a raw windows-1252 subject reads as it always did", async () => {
  // "It’s here": 0x92 is the octet the old reader happened to map correctly.
  const bytes = Uint8Array.from([0x49, 0x74, 0x92, 0x73, 0x20, 0x68, 0x65, 0x72, 0x65, 0x20, 0xe9]);
  const msg = message(16, {
    contentType: "text/plain; charset=windows-1252",
    encoding: "8bit",
    wireBody: "x",
    subject: byteString(bytes),
  });
  const parsed = await read(msg);
  assertEquals(parsed.headers.get("subject"), ["It’s here é"]);
  assertEquals(parsed.headers.get("subject"), [legacyRead(bytes)]);

  const client = clientFor([msg]);
  await client.selectMailbox("INBOX");
  const [summary] = await client.fetchSummaries([16]);
  assertEquals(summary.envelope.subject, "It’s here é");
});

Deno.test("an 8bit attachment filename is decoded, and an 8-bit boundary still splits", async () => {
  const name = byteString(utf8.encode("Ødegård – tilbud.txt"));
  const boundary = byteString(utf8.encode("grense–1"));
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    byteString(utf8.encode("Se vedlegg – Ødegård")),
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8; name="${name}"`,
    "Content-Transfer-Encoding: 8bit",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    "tilbud",
    `--${boundary}--`,
    "",
  ].join(CRLF);
  const parsed = await read(message(17, {
    contentType: `multipart/mixed; boundary="${boundary}"`,
    wireBody: body,
  }));
  assertEquals(parsed.text, "Se vedlegg – Ødegård");
  assertEquals(parsed.attachments.map((a) => a.filename), ["Ødegård – tilbud.txt"]);
});

// ── regressions: what was right stays byte-identical ───────────────────────

const SEVEN_BIT = "Plain ASCII body.\r\nSecond line with = signs, tabs\tand dots.\r\n.\r\n-- \r\nSignature";

const QP_UTF8 = [
  "Caf=C3=A9 =E2=80=93 =E2=80=9Csmart=E2=80=9D don=E2=80=99t cost =E2=82=AC5, soft =",
  "break, bl=C3=A5b=C3=A6r =3D equals",
].join(CRLF);

const QP_LATIN1 = "Bl=E5b=E6rsyltet=F8y p=E5 =C6r=F8, =A35";

const QP_CP1252 = "=93Quoted=94 =96 =805 =85";

function base64Wire(bytes: Uint8Array): string {
  const b64 = btoa(byteString(bytes));
  return (b64.match(/.{1,76}/g) ?? []).join(CRLF);
}

const REGRESSIONS: Array<{ name: string; spec: PartSpec; text?: string; html?: string }> = [
  {
    name: "7bit ASCII, no encoding header",
    spec: { contentType: "text/plain; charset=us-ascii", wireBody: SEVEN_BIT },
    text: SEVEN_BIT,
  },
  {
    name: "7bit ASCII, no charset at all",
    spec: { contentType: "text/plain", encoding: "7bit", wireBody: SEVEN_BIT },
    text: SEVEN_BIT,
  },
  {
    name: "quoted-printable UTF-8",
    spec: { contentType: "text/plain; charset=utf-8", encoding: "quoted-printable", wireBody: QP_UTF8 },
    text: "Café – “smart” don’t cost €5, soft break, blåbær = equals",
  },
  {
    name: "quoted-printable ISO-8859-1",
    spec: { contentType: "text/plain; charset=iso-8859-1", encoding: "quoted-printable", wireBody: QP_LATIN1 },
    text: "Blåbærsyltetøy på Ærø, £5",
  },
  {
    name: "quoted-printable windows-1252",
    spec: { contentType: "text/plain; charset=windows-1252", encoding: "Quoted-Printable", wireBody: QP_CP1252 },
    text: "“Quoted” – €5 …",
  },
  {
    name: "base64 UTF-8 text",
    spec: {
      contentType: "text/plain; charset=utf-8",
      encoding: "base64",
      wireBody: base64Wire(utf8.encode(UTF8_TEXT)),
    },
    text: UTF8_TEXT,
  },
  {
    name: "base64 UTF-8 html",
    spec: {
      contentType: "text/html; charset=utf-8",
      encoding: "BASE64",
      wireBody: base64Wire(utf8.encode(`<p>${UTF8_TEXT}</p>`)),
    },
    html: `<p>${UTF8_TEXT}</p>`,
  },
  {
    name: "base64 windows-1252 text",
    spec: {
      contentType: "text/plain; charset=windows-1252",
      encoding: "base64",
      wireBody: base64Wire(Uint8Array.from([0x93, 0x68, 0x69, 0x94, 0x20, 0x80, 0x35])),
    },
    text: "“hi” €5",
  },
];

for (const [index, c] of REGRESSIONS.entries()) {
  Deno.test(`unchanged: ${c.name}`, async () => {
    const msg = message(100 + index, c.spec);
    const raw = await rawOf(msg);
    // The parser is handed the very string the old reader produced, so nothing
    // downstream of the read can have changed for this message.
    assertEquals(raw, legacyRead(octetsOf(msg.raw)));
    const parsed = parseEmail(raw);
    assertEquals(parsed.text, c.text ?? null);
    assertEquals(parsed.html, c.html ?? null);
    // And the same through split reads and the large-literal path's sibling.
    assertEquals(parseEmail(await rawOf(msg, 3)).text, c.text ?? null);
  });
}

Deno.test("unchanged: a base64 attachment and a quoted-printable attachment keep their octets", async () => {
  const octets = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
  const body = [
    "--outer",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Two files, caf=C3=A9.",
    "--outer",
    'Content-Type: application/octet-stream; name="octets.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="octets.bin"',
    "",
    base64Wire(octets),
    "--outer",
    'Content-Type: text/csv; name="=?UTF-8?B?w5hkZWfDpXJkLmNzdg==?="',
    "Content-Transfer-Encoding: quoted-printable",
    'Content-Disposition: attachment; filename="table.csv"',
    "",
    "name;amount=0A=C3=98degaard;=E2=82=AC5=80",
    "--outer--",
    "",
  ].join(CRLF);
  const msg = message(200, { contentType: 'multipart/mixed; boundary="outer"', wireBody: body });
  const raw = await rawOf(msg);
  assertEquals(raw, legacyRead(octetsOf(msg.raw)));
  const parsed = parseEmail(raw);
  assertEquals(parsed.text, "Two files, café.");
  assertEquals(parsed.attachments.map((a) => a.filename), ["octets.bin", "Ødegård.csv"]);
  assertEquals(parsed.attachments[0].content, octets);
  assertEquals(
    parsed.attachments[1].content,
    Uint8Array.from([...utf8.encode("name;amount\nØdegaard;€5"), 0x80]),
  );
});

// ── the helper ─────────────────────────────────────────────────────────────

Deno.test("bytesToByteString keeps all 256 octet values, below and above one chunk", () => {
  const small = Uint8Array.from({ length: 256 }, (_, i) => i);
  const large = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 8)) % 256);
  for (const bytes of [new Uint8Array(0), small, large, large.subarray(5, 8192 + 5), large.subarray(1, 8194)]) {
    const text = bytesToByteString(bytes);
    assertEquals(text.length, bytes.length);
    assertEquals(octetsOf(text), bytes);
    assertEquals(text, byteString(bytes));
  }
  // The decoder this replaces does not: that is the bug.
  assertNotEquals(legacyRead(small), byteString(small));
});

Deno.test("bytesToByteString is exact for each octet 0x80-0x9F alone in a large ASCII buffer", () => {
  // The large-input fast path keeps a windows-1252 decode only when it proves
  // exact. The five octets windows-1252 leaves undefined (0x81, 0x8D, 0x8F,
  // 0x90, 0x9D) decode to themselves; the other 27 must fall to the slow path.
  const ascii = utf8.encode("The quick brown fox jumps over the lazy dog.\r\n".repeat(400));
  assert(ascii.length > 8192 * 2);
  for (let octet = 0x80; octet <= 0xff; octet++) {
    for (const at of [0, 8191, 8192, ascii.length - 1]) {
      const bytes = ascii.slice();
      bytes[at] = octet;
      const text = bytesToByteString(bytes);
      assertEquals(text.charCodeAt(at), octet, `octet 0x${octet.toString(16)} at ${at}`);
      assertEquals(text.length, bytes.length);
    }
  }
});

Deno.test("bytesToByteString on 7-bit input is the string the old decoder produced", () => {
  const ascii = utf8.encode("Subject: hello\r\n\r\nSGVsbG8gd29ybGQ=\r\n".repeat(3000));
  assertEquals(bytesToByteString(ascii), legacyRead(ascii));
  assertEquals(bytesToByteString(ascii.subarray(0, 100)), legacyRead(ascii.subarray(0, 100)));
});
