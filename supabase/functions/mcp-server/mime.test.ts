// ---------------------------------------------------------------------------
// RFC 2047 header decoding, and parsing a part body that arrived without its
// own headers (the fetched-snippet case behind F-03, 2026-09-20).
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  decodeEncodedWords,
  multipartBoundaryOfSource,
  parseMultipartBodySource,
} from "./mime.ts";

Deno.test("decodeEncodedWords joins adjacent encoded-words without the folding space", () => {
  // Verbatim from a Facebook notification in production (message INBOX:83034),
  // whose Subject is folded across four continuation lines. Read back through
  // the old decoder this came out as "Check out the p ost Torstein Va tna
  // Bjørnbakk s hared": the split points are encoded-word boundaries, not
  // spaces in the text.
  const folded =
    "=?UTF-8?B?Q2hlY2sgb3V0IHRoZSBw?=\r\n" +
    " =?UTF-8?B?b3N0IFRvcnN0ZWluIFZh?=\r\n" +
    " =?UTF-8?B?dG5hIEJqw7hybmJha2sgcw==?=\r\n" +
    " =?UTF-8?B?aGFyZWQ=?=";
  assertEquals(
    decodeEncodedWords(folded),
    "Check out the post Torstein Vatna Bjørnbakk shared",
  );

  // Already unfolded to single spaces, which is what a header parser that
  // collapses continuation lines hands over.
  assertEquals(
    decodeEncodedWords("=?UTF-8?B?Q2hlY2sgb3V0IHRoZSBw?= =?UTF-8?B?b3N0IQ==?="),
    "Check out the post!",
  );

  // Whitespace that is NOT between two encoded-words is real text and stays.
  assertEquals(
    decodeEncodedWords("=?UTF-8?Q?Hei?= there =?UTF-8?Q?Asgeir?="),
    "Hei there Asgeir",
  );
  assertEquals(decodeEncodedWords("plain subject"), "plain subject");
});

// ── Part bodies fetched without their headers ───────────────────────────────

const ALT = "mcpe_alt_08cb43e0fcbb4d2187a8ae7132385ee7";

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

Deno.test("a multipart body states its own boundary on its first line", () => {
  const source = [
    `--${ALT}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Hei.",
    `--${ALT}--`,
  ].join("\r\n");
  assertEquals(multipartBoundaryOfSource(source), ALT);
});

Deno.test("prose is not a multipart just because a line starts with --", () => {
  // The delimiter has to be followed by something shaped like a header field,
  // or every plain-text signature separator becomes a boundary.
  assertEquals(multipartBoundaryOfSource("Takk!\r\n\r\n-- \r\nKarin"), null);
  assertEquals(multipartBoundaryOfSource("--not-a-boundary\r\njust text\r\n"), null);
  assertEquals(multipartBoundaryOfSource("no dashes here at all"), null);
});

Deno.test("a headerless multipart body still yields its text and HTML", () => {
  const source = [
    `--${ALT}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64("Sentinel: F3-BODY-MARKER-CCC333."),
    `--${ALT}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64("<p>Sentinel.</p>"),
    `--${ALT}--`,
  ].join("\r\n");
  const parsed = parseMultipartBodySource(source);
  assert(parsed !== null, "the source is a multipart body");
  assertEquals(parsed.text, "Sentinel: F3-BODY-MARKER-CCC333.");
  assertEquals(parsed.html, "<p>Sentinel.</p>");
  assertEquals(parsed.headers.size, 0, "headers were never fetched; none are invented");
});

Deno.test("base64 cut mid-quantum decodes to what arrived, not to its alphabet", () => {
  const full = b64("Sentinel: F3-BODY-MARKER-CCC333, and then some more text.");
  const source = [
    `--${ALT}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    full.slice(0, full.length - 7), // leaves a partial quantum, as <0.2048> does
  ].join("\r\n");
  const parsed = parseMultipartBodySource(source);
  assert(parsed !== null, "the source is a multipart body");
  assert(
    parsed.text?.startsWith("Sentinel: F3-BODY-MARKER-CCC333"),
    `truncated base64 did not decode: ${JSON.stringify(parsed.text)}`,
  );
  assert(!parsed.text?.includes(full.slice(0, 16)), "the base64 itself leaked through");
});
