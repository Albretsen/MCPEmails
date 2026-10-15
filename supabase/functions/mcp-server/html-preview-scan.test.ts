// ---------------------------------------------------------------------------
// `htmlPreviewText`: the single-pass scanner behind every IMAP HTML preview.
//
// It replaced a chain of `replace` calls (CodeQL
// js/incomplete-multi-character-sanitization, 2026-10-04): removing one piece
// of markup could leave another one behind (`<scr<script>ipt>`). A preview is
// shown as TEXT, never as HTML, but it must still be clean, and "clean" has to
// hold for a source cut anywhere by the 2 KB partial fetch.
//
// Three things are pinned here:
//   1. adversarial input: nested, overlapping and unterminated markup never
//      leaves a `<` from the source in the output;
//   2. ordinary mail: pinned outputs (the values the chain produced too);
//   3. cost: 25 rows (printed), since it is on the list path.
//
// Run: deno test supabase/functions/mcp-server/html-preview-scan.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanPreviewFromBodyPart, decodeHtmlEntities, htmlPreviewText } from "./text-extract.ts";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

// ── 1. adversarial ──────────────────────────────────────────────────────────

Deno.test("html preview: removing markup never builds markup (nested, overlapping, unterminated)", () => {
  const cases: Array<[source: string, expected: string]> = [
    // The CodeQL shape: an inner tag whose removal would leave an outer one.
    ["<scr<script>ipt>alert(1)</scr</script>ipt>", "ipt>alert(1) ipt>"],
    ["<<script>script>alert(1)<</script>/script>", "script>alert(1) /script>"],
    ["<scr<!-- x -->ipt>alert(1)</script>", "ipt>alert(1)"],
    ["<sty<style>le>p{color:red}</style>visible", "le>p{color:red} visible"],
    // A non-text element inside a non-text element: the content is still gone.
    ["<script><script>a()</script>b()</script>after", "b() after"],
    ["<style>a{}<style>b{}</style>shown", "shown"],
    ["<head><title>T</title><style>x{}</style></head>Body", "Body"],
    // Closing tags written to dodge a literal match.
    ["<script>a()</script >b", "b"],
    ["<SCRIPT>a()</ScRiPt\n>b", "b"],
    ["<script>a()</script\t\n >b", "b"],
    // Unterminated: everything from the opening to the end of the source goes.
    ["before<script>var a = '<b>x</b>';", "before"],
    ["before<style>p { color: red }", "before"],
    ["before<!-- never closed <b>x</b>", "before"],
    ["before<div class=\"never closed", "before"],
    ["before<", "before"],
    ["before<!-", "before"],
    ["before</", "before"],
    // A comment that holds a tag, and a tag that holds a comment opener.
    ["a<!-- <script>x()</script> -->b", "a b"],
    ["a<!--><script>x()</script>-->b", "a b"],
    ["a<div title=\"<!--\">b</div>c<!-- d -->e", "a b c e"],
    // Angle brackets that are not tags are consumed like the chain consumed them.
    ["1 < 2 and 3 > 2", "1 2"],
    // A name that only STARTS like a non-text element is an ordinary tag.
    ["<styles>kept</styles><header>kept too</header><scripted>and this</scripted>", "kept kept too and this"],
    // An inline tag vanishes, a block tag is a space.
    ["<b>M</b>CP <td>A</td><td>B</td>", "MCP A B"],
  ];
  for (const [source, expected] of cases) {
    const out = htmlPreviewText(source);
    assert(!out.includes("<"), `a "<" from the source reached the output: ${JSON.stringify(source)} -> ${JSON.stringify(out)}`);
    assertEquals(squash(out), expected, source);
    // Running it again finds nothing left to remove: one pass was complete.
    assertEquals(squash(htmlPreviewText(out)), squash(out), `not stable: ${source}`);
  }
});

Deno.test("html preview: every prefix of a hostile document is clean (the fetch can stop anywhere)", () => {
  const doc = '<html><head><title>T</title><style>p{color:red}</style></head><body><!--[if mso]><xml><o:x>1</o:x></xml><![endif]-->' +
    '<scr<script>ipt>shown(1)</scr</script>ipt><p>Hello <b>Kari</b>, &lt;3 &amp; <a href="https://example.com/?a=1&b=2">read</a>.</p>' +
    '<script>document.write("<img src=x onerror=alert(1)>")</script><svg><script>x()</script></svg>Bye &nbsp;now</body></html>';
  for (let cut = 0; cut <= doc.length; cut++) {
    const out = htmlPreviewText(doc.slice(0, cut));
    // The only "<" a preview may hold is one the sender wrote as an entity.
    assert(!out.replace(/<(?:3|$)/, "").includes("<"), `cut at ${cut}: ${JSON.stringify(out)}`);
    assert(!/alert|color:red|onerror|document\.write|x\(\)/.test(out), `cut at ${cut}: ${JSON.stringify(out)}`);
    assert(!/&(?:#?[a-zA-Z0-9]*)$/.test(out), `cut at ${cut} left half an entity: ${JSON.stringify(out)}`);
  }
  assertEquals(squash(htmlPreviewText(doc)), "ipt>shown(1) ipt> Hello Kari, <3 & read. Bye now");
});

Deno.test("html preview: an entity is decoded once, after the scan, and is never markup", () => {
  assertEquals(squash(htmlPreviewText("&lt;script&gt;alert(1)&lt;/script&gt; ok")), "<script>alert(1)</script> ok");
  assertEquals(squash(htmlPreviewText("&amp;lt;b&amp;gt;")), "&lt;b&gt;");
  // `&shy;` is invisible; one spelled across a removed tag is not rebuilt into text either.
  assertEquals(htmlPreviewText("co&shy;operate"), "cooperate");
  assertEquals(htmlPreviewText("co&s<b></b>hy;operate"), "cooperate");
  assertEquals(htmlPreviewText("co&amp;shy;operate"), "co&shy;operate");
  // Through the whole generator: text, with no tag and no replacement character.
  const part = { type: "text", subtype: "html", charset: "utf-8", encoding: "7bit" };
  assertEquals(cleanPreviewFromBodyPart("<p>Hi <scr<script>ipt>x</script></p><style>a{}", part), "Hi ipt>x");
});

// ── 2. ordinary mail: pinned outputs ───────────────────────────────────────
// These are the values the replace chain produced too (checked when the scanner
// was introduced, PR #70); the chain itself is gone, so they are pinned here.

const ORDINARY: Array<[source: string, expected: string]> = [
  ["<html><head><meta charset=\"utf-8\"><title>Invoice</title><style>body{margin:0}@media (max-width:600px){.a>.b{display:none}}</style></head><body><table><tr><td>Hello Kari,</td><td>your invoice is ready.</td></tr></table></body></html>", "      Hello Kari,  your invoice is ready.     "],
  ["<!DOCTYPE html><html><body><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]--><div style=\"display:none\">Preheader &zwnj;&nbsp;&zwnj;&nbsp;</div><p>Hei <strong>Ødegård</strong> – “velkommen”&hellip;</p></body></html>", "     Preheader ‌ ‌   Hei Ødegård – “velkommen”…   "],
  ["<div>Line one<br>Line two<br/>Line <i>three</i></div><p>Tom &amp; Jerry &lt;tom@example.com&gt;</p>", " Line one Line two Line three  Tom & Jerry <tom@example.com> "],
  ["<p>See <a href=\"https://example.com/a?b=1&amp;c=2\">the report</a>. Thanks,<br>Maya</p><img src=\"https://example.com/p.gif\" width=\"1\" height=\"1\">", " See the report. Thanks, Maya  "],
  ["<table><tr><td><font face=\"Arial\"><span style=\"color:#333\">Your code is <b>482913</b></span></font></td></tr></table><script type=\"application/ld+json\">{\"@type\":\"EmailMessage\"}</script>", "   Your code is 482913    "],
  ["Plain words with no markup at all, &copy; 2026 Example AS.", "Plain words with no markup at all, © 2026 Example AS."],
  ["<body><style>p{}</style><p>Cut in the mid", "   Cut in the mid"],
  ["<body><p>Cut inside a tag <a href=\"https://example.com/very/long", "  Cut inside a tag  "],
  ["<body><p>Cut inside an entity &nbs", "  Cut inside an entity "],
  ["<head><style>.x{color:red}", " "],
  ["", ""],
];

Deno.test("html preview: ordinary mail gives the pinned text, and no cut of it leaves markup", () => {
  for (const [source, expected] of ORDINARY) {
    assertEquals(htmlPreviewText(source), expected, source.slice(0, 60));
    for (let cut = 0; cut < source.length; cut += 7) {
      const out = htmlPreviewText(source.slice(0, cut));
      // The only "<" a preview may hold is one the sender wrote as an entity.
      if (!source.includes("&lt;")) assert(!out.includes("<"), `${source.slice(0, 40)} @${cut}: ${JSON.stringify(out)}`);
    }
  }
});

// ── 3. cost ─────────────────────────────────────────────────────────────────

/** One page of 25 rows: 2 KB HTML prefixes shaped like real templates. */
function page(): string[] {
  const rows: string[] = [];
  for (let i = 0; i < 25; i++) {
    const css = `.c${i}{color:#${(i * 41).toString(16).padStart(3, "0")};margin:0 auto}@media (max-width:600px){.a>.b{display:none}}`.repeat(4 + (i % 5));
    const cells = Array.from({ length: 12 }, (_, c) => `<tr><td class="c${c}"><span style="font-size:14px">Row ${i} cell ${c} &amp; more</span></td><td><a href="https://example.com/${i}/${c}">link</a></td></tr>`).join("");
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Message ${i}</title><style>${css}</style></head><body><!--[if mso]><xml><o:x>96</o:x></xml><![endif]--><table>${cells}</table></body></html>`;
    rows.push(doc.slice(0, 2048));
  }
  return rows;
}

Deno.test("html preview: 25 rows stay cheap (printed)", () => {
  const rows = page();
  for (let i = 0; i < 200; i++) for (const row of rows) htmlPreviewText(row);
  let best = Infinity;
  for (let run = 0; run < 7; run++) {
    const started = performance.now();
    for (let i = 0; i < 400; i++) for (const row of rows) htmlPreviewText(row);
    best = Math.min(best, (performance.now() - started) / 400);
  }
  console.log(`html preview, 25 rows of 2 KB: ${(best * 1000).toFixed(1)} µs per page`);
  // Generous on purpose (shared CI runners): a page is a fraction of a millisecond.
  assert(best < 2, `scanner ${best} ms per page`);
});
