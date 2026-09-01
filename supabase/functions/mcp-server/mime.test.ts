// ---------------------------------------------------------------------------
// RFC 2047 header decoding.
// ---------------------------------------------------------------------------
import { assertEquals } from "jsr:@std/assert@1";
import { decodeEncodedWords } from "./mime.ts";

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
