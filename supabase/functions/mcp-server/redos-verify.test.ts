// ---------------------------------------------------------------------------
// Independent verification of the 2026-10-16 ReDoS fix (u10).
//
// Shapes the fix's own suites do not cover, each of which was quadratic on
// origin/main (measured at 64 KB: `<svg>` + `<<<<` took 18 s in
// sanitizeEmailHtml and 2.8 s in stripHtmlToText), plus the U+0130 offset bug:
// `"İ".toLowerCase()` is two code units, so the old whole-source
// lower-casing shifted every later offset and a single dotted capital I made
// the sanitizer drop the rest of the body.
//
// Budgets are deliberately loose (1 MB, 3 s): a quadratic path at 1 MB runs
// for minutes to hours, so the test still discriminates, and a slow shared CI
// runner does not flake.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { stripHtmlToText } from "./text-extract.ts";
import { sanitizeEmailHtml, sanitizeSignatureHtmlSafe } from "./signature-sanitizer.ts";
import { sanitizeEmailHtml as nodeSanitizeEmailHtml } from "../../../apps/web/src/lib/sanitizeSignatureHtmlServer.js";

const MB = 1024 * 1024;
const fill = (unit: string, size = MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const BUDGET_MS = 3000;

const SHAPES: Array<[string, string]> = [
  ["<svg> then 1 MB of <<<<", "<svg>" + fill("<<<<")],
  ["<svg> then 1 MB of </svg with no >", "<svg>" + fill("</svg ")],
  ["1 MB of <![CDATA[", fill("<![CDATA[")],
  ["1 MB of <!--[if mso]>", fill("<!--[if mso]>")],
  ["1 MB of upper-case <A HREF=X>", fill("<A HREF=X>")],
  ["1 MB of <a\\thref=\"u\" then one >", fill('<a\thref="u"') + ">t</a>"],
  ["1 MB of \\r\\n and spaces", fill("\r\n \t")],
  ["1 MB of <style></style>", fill("<style></style>")],
];

for (const [name, html] of SHAPES) {
  Deno.test(`verify: ${name} stays linear in every entry point`, () => {
    const runs: Array<[string, () => unknown]> = [
      ["stripHtmlToText", () => stripHtmlToText(html)],
      ["stripHtmlToText keepLinks", () => stripHtmlToText(html, { keepLinks: true })],
      ["sanitizeEmailHtml", () => sanitizeEmailHtml(html)],
      ["sanitizeEmailHtml (Node twin)", () => nodeSanitizeEmailHtml(html)],
      ["sanitizeSignatureHtmlSafe", () => sanitizeSignatureHtmlSafe(html)],
    ];
    for (const [fn, run] of runs) {
      const started = performance.now();
      run();
      const elapsed = performance.now() - started;
      assert(elapsed < BUDGET_MS, `${fn}: ${name} took ${elapsed.toFixed(0)} ms`);
    }
  });
}

Deno.test("verify: U+0130 before dropped elements no longer swallows the rest of the body", () => {
  const html = "İ<svg>a</svg>b İ<style>x</style>c <title>t</title>d";
  // origin/main returned just "İ" here: everything after it was lost.
  assertEquals(sanitizeEmailHtml(html), "İb İc d");
  assertEquals(nodeSanitizeEmailHtml(html), "İb İc d");
});

Deno.test("verify: U+0130 cannot smuggle a dropped element's content out", () => {
  for (const html of [
    "İİİ<svg><script>alert(1)</script></svg>ok",
    "İ<STYLE>body{}</STYLE>ok<SCRİPT>x</SCRİPT>",
    "İİ<textarea></textarea><img src=x onerror=alert(1)>ok",
  ]) {
    for (const out of [sanitizeEmailHtml(html), nodeSanitizeEmailHtml(html)]) {
      assert(!/<script|onerror|<svg|<style|body\{\}|alert\(1\)<\/script/i.test(out), `${JSON.stringify(html)} -> ${out}`);
      assert(out.includes("ok"), `${JSON.stringify(html)} lost its text: ${out}`);
    }
  }
});
