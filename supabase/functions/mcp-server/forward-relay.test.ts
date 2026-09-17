// ---------------------------------------------------------------------------
// forward-relay.ts: a forward carries the original byte for byte.
//
// The 2026-09-17 report, from a Yahoo inbox: an HTML marketing email forwarded
// with email_compose action:forward arrived as `Content-Type: text/plain`
// only, layout, images, buttons and links gone. The source had text/plain AND
// text/html. Every test below feeds that kind of message through the relay and
// checks the octets that come out, because "renders the same" is not something
// a unit test can see and "is the same bytes" is.
//
// Run: deno test supabase/functions/mcp-server/forward-relay.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  attachmentFilenameFor,
  buildRelayForwardMime,
  bytesToSingleByteString,
  composeIntroHtml,
  composeIntroText,
  contentHeaderLines,
  indexOfBytes,
  isAttachmentPart,
  normalizeCrlf,
  splitRawMessage,
  stripAttachmentParts,
  summarizeOriginal,
} from "./forward-relay.ts";
import { decodeEncodedWords, parseEmail } from "./mime.ts";
import { messageHasEightBit, smtpDataPayload } from "./smtp-client.ts";
import { singleByteTextToBytes } from "./imap-client.ts";

const ASCII = new TextEncoder();
const CRLF = "\r\n";

/** Octets from a string where every char is one byte (test fixtures only). */
function octets(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 bytes of a JS string, as a single-byte fixture string. */
function utf8(s: string): string {
  return bytesToSingleByteString(ASCII.encode(s));
}

// The HTML alternative is sent 8bit and carries "–" (E2 80 93): the 0x80
// continuation byte is exactly the octet a windows-1252 round trip corrupts.
const HTML = `<html><body><h1>Big sale ${utf8("–")} today</h1><img src="cid:logo@brand"><a href="https://brand.example/buy">Buy now</a></body></html>`;

/** A marketing email as the wire carries it: mixed > related > alternative, cid image, PDF. */
const MARKETING = [
  "Return-Path: <bounce@brand.example>",
  "DKIM-Signature: v=1; a=rsa-sha256; d=brand.example; s=x; bh=abc; b=def",
  "From: =?UTF-8?B?QnLDpG5kIE5ld3M=?= <news@brand.example>",
  "To: hayder@yahoo.example",
  "Subject: =?UTF-8?Q?Big_sale_=E2=80=93_today?=",
  "Date: Wed, 17 Sep 2026 10:00:00 +0000",
  "Message-ID: <abc123@brand.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed;',
  '\tboundary="mixed1"',
  "",
  "--mixed1",
  'Content-Type: multipart/related; boundary="rel1"; type="multipart/alternative"',
  "",
  "--rel1",
  'Content-Type: multipart/alternative; boundary="alt1"',
  "",
  "--alt1",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Big sale =E2=80=93 today",
  ".dot-led line inside the original",
  "--alt1",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  HTML,
  "--alt1--",
  "",
  "--rel1",
  'Content-Type: image/png; name="logo.png"',
  "Content-ID: <logo@brand>",
  'Content-Disposition: inline; filename="logo.png"',
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "--rel1--",
  "",
  "--mixed1",
  'Content-Type: application/pdf; name="terms.pdf"',
  'Content-Disposition: attachment; filename="terms.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQKJcOkw7zDtsOfCg==",
  "--mixed1--",
  "",
].join(CRLF);

const ORIGINAL = octets(MARKETING);

function relay(overrides: Partial<Parameters<typeof buildRelayForwardMime>[0]> = {}) {
  return buildRelayForwardMime({
    from: "MCP Emails <hello@mcpemails.com>",
    to: ["archive@example.com"],
    subject: "Fwd: Big sale – today",
    messageId: "test-relay-1",
    introText: "FYI\n\n---------- Forwarded message ----------\nFrom: x\n",
    original: ORIGINAL,
    includeAttachments: true,
    asAttachment: false,
    ...overrides,
  });
}

/** The outer boundary of a message our builder wrote. */
function outerBoundary(bytes: Uint8Array): string {
  const head = bytesToSingleByteString(bytes.subarray(0, 2000));
  const m = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(head);
  assert(m, "outer multipart/mixed header present");
  return m[1];
}

/** Bytes of the N-th part (0-based) of the outer multipart, headers included. */
function outerPart(bytes: Uint8Array, n: number): Uint8Array {
  const b = outerBoundary(bytes);
  const delim = ASCII.encode(`${CRLF}--${b}`);
  const firstDelim = indexOfBytes(bytes, ASCII.encode(`--${b}${CRLF}`));
  let start = firstDelim + b.length + 4;
  for (let i = 0; i < n; i++) {
    const next = indexOfBytes(bytes, delim, start);
    start = next + delim.length + 2;
  }
  const end = indexOfBytes(bytes, delim, start);
  return bytes.subarray(start, end);
}

// ── the whole point: the original's body is relayed untouched ───────────────

Deno.test("the original body arrives byte for byte under its own Content-* headers", () => {
  const { bytes, eightBit, droppedAttachments } = relay();
  const { body: originalBody } = splitRawMessage(ORIGINAL);

  const part = outerPart(bytes, 1);
  const { headerBlock, body } = splitRawMessage(part);

  assertEquals(headerBlock, `Content-Type: multipart/mixed;${CRLF}\tboundary="mixed1"`, "folded Content-Type copied as-is");
  assertEquals(body, originalBody, "every octet of the original body, in order");
  assertEquals(droppedAttachments, 0);
  assert(eightBit, "the 8bit HTML makes the outgoing message 8-bit too");
});

Deno.test("nothing from the original's other headers leaks onto the part", () => {
  const part = outerPart(relay().bytes, 1);
  const { headerBlock } = splitRawMessage(part);
  for (const name of ["DKIM-Signature", "Return-Path", "From:", "To:", "Message-ID"]) {
    assert(!headerBlock.includes(name), `${name} is not a body-part header`);
  }
});

Deno.test("a standard parser sees the HTML, the cid image and the PDF in the forward", () => {
  const parsed = parseEmail(bytesToSingleByteString(relay().bytes));
  assertEquals(parsed.html, new TextDecoder().decode(octets(HTML)), "the HTML alternative is intact");
  assertStringIncludes(parsed.html!, 'src="cid:logo@brand"');
  assertStringIncludes(parsed.html!, 'href="https://brand.example/buy"');
  assertEquals(parsed.attachments.map((a) => a.filename).sort(), ["logo.png", "terms.pdf"]);
});

Deno.test("the outer message is what a mail client would build: mixed, intro first, original second", () => {
  const { bytes } = relay();
  const head = bytesToSingleByteString(bytes.subarray(0, 600));
  assertStringIncludes(head, "From: MCP Emails <hello@mcpemails.com>\r\n");
  assertStringIncludes(head, "To: archive@example.com\r\n");
  assertStringIncludes(head, "Subject: =?UTF-8?B?");
  assertStringIncludes(head, "Message-ID: <test-relay-1@mcpemails.com>\r\n");
  assertStringIncludes(head, "MIME-Version: 1.0\r\n");

  const intro = outerPart(bytes, 0);
  const { headerBlock, body } = splitRawMessage(intro);
  assertEquals(headerBlock, "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64");
  const decoded = atob(bytesToSingleByteString(body).replace(/\r\n/g, ""));
  assertEquals(decoded, "FYI\n\n---------- Forwarded message ----------\nFrom: x\n");

  const b = outerBoundary(bytes);
  assert(bytesToSingleByteString(bytes).endsWith(`${CRLF}--${b}--${CRLF}`), "closing delimiter");
  assertEquals(indexOfBytes(ORIGINAL, ASCII.encode(`--${b}`)), -1, "the boundary does not occur in the original");
});

Deno.test("with html_body the intro is multipart/alternative and the original still follows it", () => {
  const { bytes } = relay({ introHtml: "<p>FYI</p>" });
  const intro = outerPart(bytes, 0);
  const { headerBlock } = splitRawMessage(intro);
  assertStringIncludes(headerBlock, "Content-Type: multipart/alternative; boundary=");
  assertStringIncludes(bytesToSingleByteString(intro), "Content-Type: text/html; charset=UTF-8");
  const { body } = splitRawMessage(outerPart(bytes, 1));
  assertEquals(body, splitRawMessage(ORIGINAL).body);
});

// ── include_attachments: false ──────────────────────────────────────────────

Deno.test("include_attachments: false drops the attached PDF and keeps the cid image", () => {
  const { bytes, droppedAttachments } = relay({ includeAttachments: false });
  assertEquals(droppedAttachments, 1);
  const parsed = parseEmail(bytesToSingleByteString(bytes));
  assertEquals(parsed.attachments.map((a) => a.filename), ["logo.png"], "the inline image is part of the body");
  assertEquals(parsed.html, new TextDecoder().decode(octets(HTML)), "the HTML is still exact");

  // The related container was copied as the byte range it occupied.
  const { body } = splitRawMessage(outerPart(bytes, 1));
  const originalBody = splitRawMessage(ORIGINAL).body;
  const relStart = indexOfBytes(originalBody, ASCII.encode("--mixed1\r\n"));
  const relEnd = indexOfBytes(originalBody, ASCII.encode("\r\n--mixed1\r\n"), relStart + 1);
  assertEquals(
    body.subarray(relStart, relEnd),
    originalBody.subarray(relStart, relEnd),
    "the kept part is the exact bytes it was",
  );
  assertEquals(indexOfBytes(body, ASCII.encode("terms.pdf")), -1);
  assert(bytesToSingleByteString(body).endsWith("--mixed1--\r\n"), "the closing delimiter and epilogue survive");
});

Deno.test("a non-multipart original is never rewritten by the attachment filter", () => {
  const body = octets("just text\r\n");
  const out = stripAttachmentParts(["Content-Type: text/plain"], body);
  assertEquals(out.dropped, 0);
  assert(out.body === body, "same array, not a copy");
});

Deno.test("isAttachmentPart draws the line where a mail client does", () => {
  assert(isAttachmentPart('Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="a.pdf"'));
  assert(isAttachmentPart('Content-Type: application/pdf; name="a.pdf"'), "named, undisposed, not text: attached");
  assert(!isAttachmentPart('Content-Type: image/png; name="logo.png"\r\nContent-ID: <x@y>'), "a cid image is body");
  assert(!isAttachmentPart('Content-Type: image/png\r\nContent-Disposition: inline'), "inline is body");
  assert(!isAttachmentPart('Content-Type: text/plain; name="notes.txt"'), "text stays");
  assert(!isAttachmentPart('Content-Type: multipart/alternative; boundary="b"'));
  assert(!isAttachmentPart("Content-Type: text/html"));
});

// ── as_attachment ───────────────────────────────────────────────────────────

Deno.test("as_attachment wraps the entire original, headers and all, as message/rfc822", () => {
  const { bytes } = relay({ asAttachment: true });
  const part = outerPart(bytes, 1);
  const { headerBlock, body } = splitRawMessage(part);
  const name = /Content-Type: message\/rfc822; name="([^"]+)"/.exec(headerBlock)?.[1] ?? "";
  assertEquals(decodeEncodedWords(name), "Big sale – today.eml", "the subject names the .eml");
  assertStringIncludes(headerBlock, `Content-Disposition: attachment; filename="${name}"`);
  assertStringIncludes(headerBlock, "Content-Transfer-Encoding: 8bit");
  assertEquals(body, ORIGINAL, "DKIM, Message-ID, everything: the original message itself");
});

Deno.test("attachmentFilenameFor makes a safe .eml name from the subject", () => {
  assertEquals(attachmentFilenameFor("Fwd: Re: Q3/Q4 report: final?"), "Re Q3 Q4 report final.eml");
  assertEquals(attachmentFilenameFor("   "), "Forwarded message.eml");
  assertEquals(attachmentFilenameFor("FW: " + "x".repeat(200)).length, 84);
});

// ── header handling ─────────────────────────────────────────────────────────

Deno.test("summarizeOriginal decodes encoded words for the forwarded block", () => {
  const { headerBlock } = splitRawMessage(ORIGINAL);
  const summary = summarizeOriginal(headerBlock);
  assertEquals(summary.from, "Bränd News <news@brand.example>");
  assertEquals(summary.subject, "Big sale – today");
  assertEquals(summary.to, "hayder@yahoo.example");
  assertEquals(summary.date, "Wed, 17 Sep 2026 10:00:00 +0000");
});

Deno.test("composeIntroText and composeIntroHtml write the block clients expect", () => {
  const summary = { from: "A <a@x>", to: "b@y", date: "D", subject: "S & <T>" };
  assertEquals(
    composeIntroText("note", summary),
    "note\n\n---------- Forwarded message ----------\nFrom: A <a@x>\nDate: D\nSubject: S & <T>\nTo: b@y\n",
  );
  assertEquals(composeIntroText(undefined, summary).startsWith("---------- Forwarded"), true);
  const html = composeIntroHtml("<p>note</p>", summary);
  assertStringIncludes(html, "<p>note</p><br><br>");
  assertStringIncludes(html, "From: A &lt;a@x&gt;<br>");
  assertStringIncludes(html, "Subject: S &amp; &lt;T&gt;<br>");
});

Deno.test("contentHeaderLines keeps only Content-* lines, folding intact", () => {
  const lines = contentHeaderLines(
    "From: a\r\nContent-Type: multipart/mixed;\r\n boundary=x\r\nX-Mailer: y\r\n  folded-continuation\r\nContent-Transfer-Encoding: 7bit\r\n",
  );
  assertEquals(lines, ["Content-Type: multipart/mixed;\r\n boundary=x", "Content-Transfer-Encoding: 7bit"]);
});

Deno.test("a text-only original with no Content-Type header relays as a bare part", () => {
  const original = octets("From: a@x\r\nSubject: hi\r\n\r\nhello\r\n");
  const { bytes } = relay({ original });
  const part = outerPart(bytes, 1);
  const { headerBlock, body } = splitRawMessage(part);
  assertEquals(headerBlock, "", "no Content-* headers to copy, so none written");
  assertEquals(bytesToSingleByteString(body), "hello\r\n");
});

// ── line endings and 8-bit safety ───────────────────────────────────────────

Deno.test("normalizeCrlf leaves a CRLF message alone and repairs a bare-LF one", () => {
  assert(normalizeCrlf(ORIGINAL) === ORIGINAL, "same array back");
  const fixed = normalizeCrlf(octets("a\nb\r\nc\n"));
  assertEquals(bytesToSingleByteString(fixed), "a\r\nb\r\nc\r\n");
});

Deno.test("smtpDataPayload on bytes dot-stuffs, normalises and keeps 8-bit octets", () => {
  const payload = smtpDataPayload(octets("a\n.hidden\r\nb" + utf8("–")));
  assertEquals(bytesToSingleByteString(payload), "a\r\n..hidden\r\nb" + utf8("–") + "\r\n.\r\n");
  assert(messageHasEightBit(payload));
  assert(!messageHasEightBit(octets("plain")));
});

Deno.test("the dot-led line inside the original is stuffed on the wire and only there", () => {
  const { bytes } = relay();
  const payload = bytesToSingleByteString(smtpDataPayload(bytes));
  assertStringIncludes(payload, "\r\n..dot-led line inside the original\r\n");
  assertEquals(payload.split("..dot-led").length, 2, "stuffed exactly once");
});

Deno.test("singleByteTextToBytes is the exact inverse of the IMAP literal decode", () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const asRead = new TextDecoder("latin1").decode(all);
  assertNotEquals(asRead.charCodeAt(0x85), 0x85, "the decoder really does remap 0x80-0x9F");
  assertEquals(singleByteTextToBytes(asRead), all, "and every octet comes back");
});
