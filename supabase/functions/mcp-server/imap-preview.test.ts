// ---------------------------------------------------------------------------
// `preview` on list and search rows: clean text, for every caller.
//
// The documented contract is "First <=200 characters of the plain-text body,
// whitespace-normalised". Until 2026-10-04 an MCP row broke it three ways:
//
//   * an HTML-only message previewed as the contents of its `<style>` block,
//     because the 2 KB prefix the listing fetches is usually CSS and the
//     generator had no idea the part was HTML;
//   * the prefix cuts a UTF-8 sequence, a quoted-printable `=XX` or a base64
//     quantum, and the pieces shipped as U+FFFD or a dangling `=C`;
//   * the declared charset was ignored (UTF-8 was assumed), and 8bit octets in
//     0x80-0x9F were damaged on the way in, so `Ødegård` arrived as mojibake.
//
// Everything in the first half goes through the real wire path: a message on
// the scripted IMAP server, the FETCH the listing really sends, the parser in
// imap-client.ts. The second half is the provider-independent cleaning that
// Gmail's `snippet` and Graph's `bodyPreview` go through as well.
//
// Every fixture is invented; every address is under example.com.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeImapServer, type FakeMessage, fakeMessageWithAttachment, fakeTextMessage } from "./imap-fake-server.ts";
import { cleanPreviewFromBodyPart, normalizePreview } from "./text-extract.ts";

const CRLF = "\r\n";

/** One character per octet, as the fake server stores a message. */
function octets(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

function base64(text: string): string {
  return (btoa(text).match(/.{1,76}/g) ?? []).join(CRLF);
}

function quotedPrintable(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code > 0x7e || ch === "=" ? `=${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
  }
  // Soft-wrapped at 72 like a real encoder (never inside an escape).
  return (out.match(/(?:=[0-9A-F]{2}|[^=]){1,24}/g) ?? []).join(`=${CRLF}`);
}

function message(uid: number, headers: string[], body: string): FakeMessage {
  return {
    uid,
    flags: [],
    raw: [
      "Date: 01 Sep 2026 10:00:00 +0000",
      'From: "Sender" <sender@example.com>',
      "To: <owner@example.com>",
      `Subject: Fixture ${uid}`,
      `Message-ID: <fixture${uid}@example.com>`,
      ...headers,
      "",
      body,
    ].join(CRLF),
  };
}

/** The previews a listing of these messages carries, by uid, plus the commands sent. */
async function previews(messages: FakeMessage[]): Promise<{ byUid: Map<number, string>; commands: string[] }> {
  const server = new FakeImapServer({ mailboxes: [{ name: "INBOX", messages }] });
  const client = server.client();
  await client.selectMailbox("INBOX");
  const summaries = await client.fetchSummaries(messages.map((m) => m.uid));
  return { byUid: new Map(summaries.map((s) => [s.uid, s.preview])), commands: server.commands };
}

async function previewOf(headers: string[], body: string): Promise<string> {
  return (await previews([message(1, headers, body)])).byUid.get(1) ?? "(no row)";
}

/** What a preview may never contain, whatever the message. */
function assertClean(preview: string, label: string): void {
  assert(!preview.includes("\ufffd"), `${label}: replacement character in ${JSON.stringify(preview)}`);
  assert(!/[{};]\s*[.#@a-z-]+\s*[{:]/i.test(preview), `${label}: CSS in ${JSON.stringify(preview)}`);
  assert(!/<\/?[a-z][^>]*>?/i.test(preview), `${label}: markup in ${JSON.stringify(preview)}`);
  assert(!/Ã.|â€/.test(preview), `${label}: mojibake in ${JSON.stringify(preview)}`);
  assert(!/[\u00ad\u034f\u200b-\u200f\ufeff]/.test(preview), `${label}: invisible characters in ${JSON.stringify(preview)}`);
  // (The cap is applied after the trim, so a preview cut at 200 may end in one space. Unchanged.)
  assert(!/\s{2,}|^\s|[\r\n\t]/.test(preview), `${label}: whitespace not normalised in ${JSON.stringify(preview)}`);
  assert(preview.length <= 200, `${label}: ${preview.length} characters`);
}

const NORDIC = "Blåbærsyltetøy – Ødegård “quoted” ";

// ── HTML ─────────────────────────────────────────────────────────────────────

Deno.test("preview (imap): an HTML-only message with a large <style> block previews as its text", async () => {
  const rule = ".wrapper{margin:0;padding:0;} @media (max-width:600px){.col > td{display:block !important;}} ";
  const head = `<!DOCTYPE html><html><head><title>Newsletter</title><style type="text/css">${rule.repeat(12)}</style></head>`;
  assert(head.length < 2048, "the fixture's style block closes inside the fetched prefix");
  const preview = await previewOf(
    ["Content-Type: text/html; charset=utf-8"],
    `${head}<body><table><tr><td><p>Your order has shipped.</p><p>It arrives Thursday.</p></td></tr></table></body></html>`,
  );
  assertEquals(preview, "Your order has shipped. It arrives Thursday.");
  assertClean(preview, "closed style");
});

Deno.test("preview (imap): a <style> block longer than the fetched prefix previews as nothing, never as CSS", async () => {
  const rule = ".wrapper{margin:0;padding:0;} .x{color:#333;font-family:Arial,sans-serif;} ";
  const preview = await previewOf(
    ["Content-Type: text/html; charset=utf-8"],
    `<html><head><style>${rule.repeat(60)}</style></head><body><p>Visible, but past the first 2 KB.</p></body></html>`,
  );
  // Honest emptiness: the text is beyond what the listing fetches, and the
  // listing does not fetch more to find it.
  assertEquals(preview, "");
});

Deno.test("preview (imap): script, comments and a tag or entity cut by the fetch never leak", async () => {
  const body = "<html><body><!--[if mso]><xml><o:Size>96</o:Size></xml><![endif]--><script>var a={b:1};</script>" +
    "<p>Tom &amp; Jerry &lt;live&gt;</p>" + "<p>Filler sentence number one.</p>".repeat(70);
  const preview = await previewOf(["Content-Type: text/html; charset=utf-8"], body);
  assert(preview.startsWith("Tom & Jerry <live> Filler sentence number one."), preview);
  assert(!preview.includes("var a") && !preview.includes("96"), preview);
  assertEquals(preview.length, 200);
  assertEquals(cleanPreviewFromBodyPart("<p>Shown</p><a href=\"https://example.com/very", {
    type: "text",
    subtype: "html",
    charset: "utf-8",
    encoding: "7bit",
  }), "Shown");
});

Deno.test("preview (imap): preheader padding is dropped, in every form senders write it", async () => {
  const html = (padding: string) =>
    `<html><body><div style="display:none">Your receipt from Example.${padding}</div><p>Thanks for your order.</p></body></html>`;
  const expected = "Your receipt from Example. Thanks for your order.";
  const forms: Record<string, string> = {
    "entity zwnj + nbsp": "&zwnj;&nbsp;".repeat(120),
    "numeric CGJ + zwnj + nbsp": "&#847;&zwnj;&nbsp;".repeat(90),
    "hex entities": "&#x200C;&#xA0;&#x200B;&#xFEFF;".repeat(60),
    "soft hyphens": "&shy;&nbsp;".repeat(120),
    "raw characters": octets("\u034f \u200c\u00a0\u200b\u200d\u200e\u200f\ufeff\u00ad".repeat(40)),
  };
  for (const [label, padding] of Object.entries(forms)) {
    const preview = await previewOf(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit"], html(padding));
    assertEquals(preview, expected, label);
    assertClean(preview, label);
  }
});

Deno.test("preview: padding that LEADS the text does not spend the budget, and real words are never judged", () => {
  const padded = "\u200c\u00a0".repeat(300) + "View in browser | Unsubscribe. Hello Kari, your invoice is ready.";
  // No boilerplate heuristics: everything visible stays, in order.
  assertEquals(normalizePreview(padded), "View in browser | Unsubscribe. Hello Kari, your invoice is ready.");
  assertEquals(normalizePreview("co\u00adoperate"), "cooperate", "a soft hyphen is invisible wherever it sits");
});

// ── Cuts ─────────────────────────────────────────────────────────────────────

Deno.test("preview (imap): quoted-printable UTF-8 cut mid-token by the 2 KB fetch", async () => {
  const text = NORDIC.repeat(80);
  const encoded = quotedPrintable(octets(text));
  // The cut really does land inside an escape or a soft break for some offset;
  // every offset is tried so the fixture cannot dodge it by luck.
  let sawCutToken = false;
  for (let pad = 0; pad < 12; pad++) {
    const body = "x".repeat(pad) + encoded;
    if (/=[0-9A-F]?$|=\r$/.test(body.slice(0, 2048))) sawCutToken = true;
    const part = { type: "text", subtype: "plain", charset: "utf-8", encoding: "quoted-printable" };
    const whole = cleanPreviewFromBodyPart(body.slice(0, 2048), part);
    assertClean(whole, `qp pad ${pad}`);
  }
  assert(sawCutToken, "at least one offset cut a token");
  const preview = await previewOf(
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
    encoded,
  );
  assertEquals(preview, text.replace(/\s+/g, " ").slice(0, 200));

  // A short part whose tail IS the cut: nothing after it to hide behind.
  const short = "Bl=C3=A5b=C3=A6r og fl=C3=B8te";
  for (let cut = 1; cut <= short.length; cut++) {
    const p = cleanPreviewFromBodyPart(short.slice(0, cut), { type: "text", subtype: "plain", charset: "utf-8", encoding: "quoted-printable" });
    assert("Blåbær og fløte".startsWith(p), `cut at ${cut}: ${JSON.stringify(p)}`);
  }
});

Deno.test("preview (imap): base64 cut mid-quantum and mid-character", async () => {
  const text = NORDIC.repeat(80);
  const preview = await previewOf(
    ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"],
    base64(octets(text)),
  );
  assertEquals(preview, text.replace(/\s+/g, " ").slice(0, 200));

  const short = btoa(octets("Blåbær og fløte"));
  for (let cut = 1; cut <= short.length; cut++) {
    const p = cleanPreviewFromBodyPart(short.slice(0, cut), { type: "text", subtype: "plain", charset: "utf-8", encoding: "base64" });
    assert("Blåbær og fløte".startsWith(p), `cut at ${cut}: ${JSON.stringify(p)}`);
  }
});

Deno.test("preview (imap): 8bit UTF-8 cut mid-sequence, at every offset", async () => {
  // Short enough that the cut is INSIDE the preview: 2048 octets of 3-byte
  // characters is under 200 of them only when padded, so cut by hand too.
  const source = octets("日本語のメールです。" + "€".repeat(700));
  const preview = await previewOf(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"], source);
  assertClean(preview, "8bit utf-8");
  assert(preview.startsWith("日本語のメールです。€€€"), preview);

  const wire = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
  const bytes = new TextEncoder().encode("Ødegård – “hei” 日本語 €5");
  for (let cut = 1; cut <= bytes.length; cut++) {
    const p = cleanPreviewFromBodyPart(wire(bytes.subarray(0, cut)), { type: "text", subtype: "plain", charset: "utf-8", encoding: "8bit" });
    assert(!p.includes("\ufffd"), `cut at ${cut}`);
    assert("Ødegård – “hei” 日本語 €5".startsWith(p), `cut at ${cut}: ${JSON.stringify(p)}`);
  }
});

// ── Charsets ─────────────────────────────────────────────────────────────────

Deno.test("preview (imap): windows-1252 and ISO-8859-1 parts decode by their declared charset", async () => {
  // "Blåbær – “smart” €5": 0x96 (dash), 0x93/0x94 (quotes) and 0x80 (euro) exist only in windows-1252.
  const cp1252 = String.fromCharCode(0x42, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x20, 0x96, 0x20, 0x93, 0x73, 0x6d, 0x61, 0x72, 0x74, 0x94, 0x20, 0x80, 0x35);
  assertEquals(
    await previewOf(["Content-Type: text/plain; charset=windows-1252", "Content-Transfer-Encoding: 8bit"], cp1252),
    "Blåbær – “smart” €5",
  );
  assertEquals(
    await previewOf(["Content-Type: text/plain; charset=windows-1252", "Content-Transfer-Encoding: quoted-printable"], "Bl=E5b=E6r =96 =93smart=94 =805"),
    "Blåbær – “smart” €5",
  );
  const latin1 = String.fromCharCode(0x46, 0x72, 0x61, 0x6e, 0xe7, 0x61, 0x69, 0x73, 0x20, 0x62, 0x6c, 0xe5, 0x62, 0xe6, 0x72, 0x20, 0xfc, 0x62, 0x65, 0x72);
  assertEquals(
    await previewOf(["Content-Type: text/plain; charset=ISO-8859-1", "Content-Transfer-Encoding: 8bit"], latin1),
    "Français blåbær über",
  );
  assertEquals(
    await previewOf(["Content-Type: text/html; charset=iso-8859-1", "Content-Transfer-Encoding: base64"], base64(`<p>${latin1}</p>`)),
    "Français blåbær über",
  );
  // A wrong label (says UTF-8, is latin1) reads as single-byte text, not as U+FFFD.
  const mislabelled = await previewOf(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"], latin1);
  assertClean(mislabelled, "mislabelled");
});

// ── Shapes ───────────────────────────────────────────────────────────────────

Deno.test("preview (imap): a plain-text message is its own text, whitespace-normalised and capped at 200", async () => {
  assertEquals(await previewOf(["Content-Type: text/plain; charset=utf-8"], "Hi Kari,\r\n\r\n  Lunch on Friday?\t Let me know.\r\n\r\n-- \r\nOla"), "Hi Kari, Lunch on Friday? Let me know. -- Ola");
  assertEquals(
    await previewOf(["Content-Type: text/plain; charset=us-ascii"], "See <https://example.com/x?a=1&b=2> or write <a@b.example>. 2 < 3, a=b, 100% {sure}; ok"),
    "See <https://example.com/x?a=1&b=2> or write <a@b.example>. 2 < 3, a=b, 100% {sure}; ok",
    "angle brackets, braces and an equals sign in prose are text",
  );
  const long = "word ".repeat(100);
  assertEquals(await previewOf(["Content-Type: text/plain"], long), long.slice(0, 200));
  // No Content-Type at all is text/plain; us-ascii.
  assertEquals(await previewOf([], "Bare message."), "Bare message.");
});

Deno.test("preview (imap): multipart/alternative previews its text/plain part, not the HTML", async () => {
  const preview = await previewOf(['Content-Type: multipart/alternative; boundary="alt1"'], [
    "--alt1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "The plain part, p=C3=A5 norsk.",
    "--alt1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><style>.a{color:red;}</style></head><body><p>The HTML part.</p></body></html>",
    "--alt1--",
    "",
  ].join(CRLF));
  assertEquals(preview, "The plain part, på norsk.");
});

Deno.test("preview (imap): mixed wrapping alternative (mail with attachments) descends to the text, cut or not", async () => {
  const nested = (plain: string, encoding: string) => message(1, ['Content-Type: multipart/mixed; boundary="mix1"'], [
    "--mix1",
    'Content-Type: multipart/alternative; boundary="alt2"',
    "",
    "--alt2",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    "",
    plain,
    "--alt2",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML twin.</p>",
    "--alt2--",
    "",
    "--mix1",
    'Content-Type: application/pdf; name="a.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="a.pdf"',
    "",
    "JVBERi0xLjQK",
    "--mix1--",
    "",
  ].join(CRLF));
  const text = NORDIC.repeat(80);
  for (const [encoding, body] of [["quoted-printable", quotedPrintable(octets(text))], ["base64", base64(octets(text))], ["8bit", octets(text)]]) {
    const preview = (await previews([nested(body, encoding)])).byUid.get(1)!;
    assertEquals(preview, text.replace(/\s+/g, " ").slice(0, 200), encoding);
  }
  // Short and cut inside the escape: the tail is dropped, not shipped as "=C".
  for (const cutAt of ["p=C3=A5 nors", "p=C3=A5", "p=C3=A", "p=C3=", "p=C3", "p=C", "p="]) {
    const source = ["--alt2", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", `Hei ${cutAt}`].join(CRLF);
    const p = cleanPreviewFromBodyPart(source, null);
    assert("Hei på nors".startsWith(p) && p.startsWith("Hei"), `${cutAt}: ${JSON.stringify(p)}`);
  }
});

Deno.test("preview (imap): an empty body previews as the empty string", async () => {
  assertEquals(await previewOf(["Content-Type: text/plain; charset=utf-8"], ""), "");
  assertEquals(await previewOf(["Content-Type: text/html; charset=utf-8"], "<html><head></head><body>\r\n &nbsp; </body></html>"), "");
});

Deno.test("preview (imap): an attachment-only message previews as the empty string, never as base64", async () => {
  const pdf = base64("%PDF-1.4\n" + "binary-ish content ".repeat(200));
  assertEquals(
    await previewOf(['Content-Type: application/pdf; name="invoice.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="invoice.pdf"'], pdf),
    "",
  );
  // multipart/mixed whose only part is the attachment.
  assertEquals(
    await previewOf(['Content-Type: multipart/mixed; boundary="only"'], [
      "--only",
      'Content-Type: image/png; name="scan.png"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="scan.png"',
      "",
      pdf,
      "--only--",
      "",
    ].join(CRLF)),
    "",
  );
});

Deno.test("preview (imap): a part nothing described still does not preview as its encoding", () => {
  // No BODYSTRUCTURE in the reply. The FETCH always asks for one, so this is a
  // server misbehaving; the preview degrades to a guess, not to the alphabet.
  assertEquals(cleanPreviewFromBodyPart(base64(octets("Blåbær og fløte, sendt som base64 uten beskrivelse.")), null), "Blåbær og fløte, sendt som base64 uten beskrivelse.");
  assertEquals(cleanPreviewFromBodyPart("Karin p=C3=A5 Teknikkdeler sendte deg en=\r\n faktura.", null), "Karin på Teknikkdeler sendte deg en faktura.");
  assertEquals(cleanPreviewFromBodyPart("Reset: https://example.com/r?token=AB12CD&id=3D", null), "Reset: https://example.com/r?token=AB12CD&id=3D", "a query string is not quoted-printable");
});

// ── The hot path is the same size ────────────────────────────────────────────

Deno.test("preview (imap): the listing sends the FETCH it always sent, once, and nothing else", async () => {
  const messages = [
    fakeTextMessage(1),
    fakeMessageWithAttachment(2),
    message(3, ["Content-Type: text/html; charset=utf-8"], "<style>.a{b:c;}</style><p>Three.</p>"),
  ];
  const { byUid, commands } = await previews(messages);
  assertEquals(commands, ["SELECT \"INBOX\"", "UID FETCH 1,2,3 (UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[1]<0.2048>)"]);
  assertEquals([byUid.get(1), byUid.get(2), byUid.get(3)], ["Body of message 1.", "See the attached file 2.", "Three."]);
});

// ── Gmail `snippet` and Graph `bodyPreview` ──────────────────────────────────

Deno.test("preview (gmail): a snippet's entities are decoded and its padding dropped", () => {
  // Gmail returns `snippet` HTML-escaped, and keeps the sender's preheader
  // padding in it verbatim.
  assertEquals(
    normalizePreview("Don&#39;t miss &quot;Q3&quot; &amp; more &lt;now&gt; \u034f \u200c \u034f \u200c \u034f \u200c \u00a0\u00a0 \ufeff"),
    "Don't miss \"Q3\" & more <now>",
  );
  assertEquals(normalizePreview(""), "");
});

Deno.test("preview (outlook): a bodyPreview's line breaks and padding are normalised", () => {
  // Graph returns `bodyPreview` as text (up to 255 characters) with CRLFs and
  // whatever invisible characters the body began with.
  const bodyPreview = "\u200b\u200b\u200b\r\nHi Kari,\r\n\r\nYour invoice is ready.\u00a0\u00a0\r\n" + "x".repeat(260);
  const preview = normalizePreview(bodyPreview);
  assert(preview.startsWith("Hi Kari, Your invoice is ready. xxx"), preview);
  assertEquals(preview.length, 200);
});

Deno.test("preview: index.ts cleans every provider's preview, and decodes entities only where the provider has not", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const sites = index.split("\n").filter((line) => /^\s+preview: .*,$/.test(line) && !line.includes("=>") && !line.includes("{"));
  assertEquals(sites.map((line) => line.trim()).sort(), [
    'preview: normalizePreview(msg.bodyPreview ?? ""),',
    'preview: normalizePreview(msg.bodyPreview ?? ""),',
    'preview: normalizePreview(msg.snippet ?? ""),',
    'preview: normalizePreview(msg.snippet ?? ""),',
    // IMAP: `cleanPreviewFromBodyPart` already decoded the entities, once.
    // A second decode here is what turned `&amp;lt;` into `<`.
    "preview: tidyPreview(s.preview),",
    "preview: tidyPreview(s.preview),",
  ], "list and search, for Gmail, Graph and IMAP: a new preview site must be cleaned too");
});
