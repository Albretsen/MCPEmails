// Attachments are decoded only when `content` is read (mime.ts attachmentPart).
// The size reported before decoding must equal the decoded length, for every
// body shape decodeContent sees: wrapped lines, missing or stray padding,
// garbage between lines, a cut-off tail.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { base64DecodedLength, parseEmail, parseEmailJoined } from "./mime.ts";

function message(attachmentBody: string, cte = "base64"): string {
  return [
    "From: a@example.com",
    "Subject: x",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "hello",
    "--B",
    "Content-Type: application/octet-stream; name=f.bin",
    "Content-Disposition: attachment; filename=f.bin",
    `Content-Transfer-Encoding: ${cte}`,
    "",
    attachmentBody,
    "--B--",
    "",
  ].join("\r\n");
}

function wrap(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

Deno.test("size equals the decoded bytes for every length, and content decodes on read", () => {
  for (let n = 0; n < 40; n++) {
    const bytes = randomBytes(n);
    const [a] = parseEmail(message(wrap(toBase64(bytes)))).attachments;
    assertEquals(a.size, n);
    assertEquals(a.content, bytes);
    assertEquals(a.content.length, a.size);
  }
});

Deno.test("odd bodies: size always matches what content decodes to", () => {
  const bodies = [
    "",
    "QUJD",
    "QUJ",          // partial quantum, dropped
    "QQ==",
    "QQ",           // unpadded
    "QQ==QQ==",     // `=` mid-stream: atob throws, raw octets fallback
    "Q===",
    "QUJD\r\n  QUJD\r\n\tQUI=",
    "QUJD*&^%QUJD", // garbage between quanta
    "QUJDQ=",       // stray `=` in the dropped tail
    "====",
    "=".repeat(20),
  ];
  for (const body of bodies) {
    for (const parse of [parseEmail, (raw: string) => parseEmailJoined(raw, (h) => h)]) {
      const [a] = parse(message(body)).attachments;
      assertEquals(a.size, a.content.length, `body ${JSON.stringify(body)}`);
    }
  }
});

Deno.test("non-base64 attachments are unchanged", () => {
  const [a] = parseEmail(message("plain bytes here", "7bit")).attachments;
  assertEquals(a.size, 16);
  assertEquals(new TextDecoder().decode(a.content), "plain bytes here");
});

Deno.test("spreading an attachment still carries its bytes", () => {
  const bytes = randomBytes(300);
  const [a] = parseEmail(message(wrap(toBase64(bytes)))).attachments;
  const copy = { ...a };
  assertEquals(copy.content, bytes);
  assertEquals(Object.keys(a).sort(), ["content", "filename", "mimeType", "size"]);
});

Deno.test("base64DecodedLength refuses what atob would refuse", () => {
  assertEquals(base64DecodedLength("QQ==QQ=="), null);
  assertEquals(base64DecodedLength("Q==="), null);
  assertEquals(base64DecodedLength("QUI="), 2);
  assertEquals(base64DecodedLength(""), 0);
});

Deno.test("parsing a 20 MB attachment does not decode it", () => {
  const bytes = randomBytes(20 * 1024 * 1024);
  const raw = message(wrap(toBase64(bytes)));
  const before = Deno.memoryUsage().heapUsed + Deno.memoryUsage().external;
  const parsed = parseEmail(raw);
  const after = Deno.memoryUsage().heapUsed + Deno.memoryUsage().external;
  assertEquals(parsed.attachments[0].size, bytes.length);
  // Decoding would allocate at least the 20 MB byte array plus a 27 MB
  // cleaned copy. Leave generous room for unrelated allocation.
  assert(after - before < 8 * 1024 * 1024, `parse grew the heap by ${after - before} bytes`);
});
