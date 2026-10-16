// ---------------------------------------------------------------------------
// The allow-list sanitizer: same output as before, in linear time (Deno twin).
//
// Until 2026-10-16 every dropped element (`<svg>`, `<style>`, `<audio>`, ...)
// lower-cased the WHOLE source again, so 5 MB of `<svg></svg>` cost ~10^12
// character operations on an email_read with include_html. The source is now
// lower-cased once (ASCII only, so offsets stay valid), a skipped element's
// tag names are read no further than needed, and sanitizeEmailHtml stops
// tokenizing once its output passes the length it will keep anyway.
//
// The Node twin is held to the same goldens in
// apps/web/src/lib/sanitizeSignatureHtml.test.mjs.
//
// Run: deno test --allow-read supabase/functions/mcp-server/signature-sanitizer-linear.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  EMAIL_HTML_MAX_LENGTH,
  sanitizeEmailHtml,
  sanitizeSignatureHtmlSafe,
} from "./signature-sanitizer.ts";
import golden from "../../../apps/web/src/lib/email-html-corpus.golden.json" with { type: "json" };
import { EMAIL_HTML_CORPUS } from "../../../apps/web/src/lib/email-html-corpus.mjs";
import { ALL_PAYLOADS } from "../../../apps/web/src/lib/sanitizer-payloads.mjs";

const GOLDEN = golden as Record<string, { email: string; signature: string }>;
const INPUTS: Array<[string, string]> = [
  ...(EMAIL_HTML_CORPUS as Array<[string, string]>),
  ...(ALL_PAYLOADS as Array<[string, string]>).map(
    ([name, html], i): [string, string] => [`payload ${i}: ${name}`, html],
  ),
];

Deno.test("golden: every input has a captured expectation", () => {
  assertEquals(INPUTS.length, Object.keys(GOLDEN).length);
});

Deno.test("golden: sanitizeEmailHtml output is byte-identical to the pre-change code", () => {
  for (const [name, html] of INPUTS) assertEquals(sanitizeEmailHtml(html), GOLDEN[name].email, name);
});

Deno.test("golden: signature output is byte-identical to the pre-change code", () => {
  for (const [name, html] of INPUTS) {
    assertEquals(sanitizeSignatureHtmlSafe(html), GOLDEN[name].signature, name);
  }
});

Deno.test("early stop: a body far past the cap truncates exactly as a full run would", () => {
  // Built so the cut lands mid-stream with dropped elements on both sides of it.
  const unit = "<p>Row <b>bold</b> &amp; text</p><style>.x{}</style><svg><g/></svg>";
  const html = unit.repeat(Math.ceil((3 * EMAIL_HTML_MAX_LENGTH) / unit.length));
  const out = sanitizeEmailHtml(html);
  assert(out.length <= EMAIL_HTML_MAX_LENGTH + 1, `output ${out.length}`);
  assert(out.length > EMAIL_HTML_MAX_LENGTH - unit.length, `output ${out.length}`);
  assertEquals(out.endsWith(">"), true);
  // Whatever follows the point where the cap is reached cannot matter: a
  // shorter input that still overflows the cap gives the identical result.
  assertEquals(sanitizeEmailHtml(html.slice(0, Math.floor(2.5 * EMAIL_HTML_MAX_LENGTH))), out);
  assertEquals(sanitizeEmailHtml(html + "<p>tail that is never reached</p>"), out);
});

Deno.test("U+0130 before a dropped element no longer shifts the end-tag search", () => {
  // `"İ".toLowerCase()` is two code units. The old whole-source toLowerCase put
  // every later offset one place off, so the text after the element vanished.
  assertEquals(sanitizeEmailHtml("İstanbul<style>a{}</style>after"), "İstanbulafter");
  assertEquals(sanitizeEmailHtml("İ<svg><g></g></svg>after"), "İafter");
  assertEquals(sanitizeSignatureHtmlSafe("İ<title>t</title><b>x</b>"), "İ<b>x</b>");
});

Deno.test("dropped elements still close case-insensitively", () => {
  assertEquals(sanitizeEmailHtml("a<STYLE>x</sTyLe >b"), "ab");
  assertEquals(sanitizeEmailHtml("a<Svg><SVG></svg>still dropped</SVG>b"), "ab");
  assertEquals(sanitizeEmailHtml("a<script>if (a < b) {}</SCRIPT>b"), "ab");
  // A longer name sharing the prefix is NOT the closer.
  assertEquals(sanitizeEmailHtml("a<svg></svgx>hidden</svg>b"), "ab");
  assertStringIncludes(sanitizeEmailHtml("<p>a<svg><<<<</svg>b</p>"), "b");
});

const MB5 = 5 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(MB5 / unit.length)).slice(0, MB5);

const ADVERSARIAL: Array<[string, string]> = [
  ["5 MB of <svg></svg>", fill("<svg></svg>")],
  ["5 MB of <style></style>", fill("<style></style>")],
  ["5 MB of <audio></audio>", fill("<audio></audio>")],
  ["<svg> then 5 MB of <", "<svg>" + fill("<")],
  ["<svg> then 5 MB of <a", "<svg>" + fill("<a")],
  ["5 MB of <svg>", fill("<svg>")],
  ["<style> then 5 MB of </stylex", "<style>" + fill("</stylex")],
  ["5 MB of <!--", fill("<!--")],
  ["5 MB of <", fill("<")],
  ["5 MB of <a<a", fill("<a<a")],
];

for (const [name, html] of ADVERSARIAL) {
  Deno.test(`adversarial: ${name} sanitizes well under 1 s`, () => {
    let started = performance.now();
    sanitizeEmailHtml(html);
    let elapsed = performance.now() - started;
    assert(elapsed < 1000, `email: ${name} took ${elapsed.toFixed(0)} ms`);
    started = performance.now();
    sanitizeSignatureHtmlSafe(html);
    elapsed = performance.now() - started;
    assert(elapsed < 1000, `signature: ${name} took ${elapsed.toFixed(0)} ms`);
  });
}
