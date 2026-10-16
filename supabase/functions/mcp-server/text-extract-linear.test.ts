// ---------------------------------------------------------------------------
// stripHtmlToText: same output as before, in linear time.
//
// Until 2026-10-16 stripHtmlToText was a chain of global lazy regexes run over
// the whole HTML body of an inbound email. An opener with no closer made each
// of them scan to the end of the input from every opener, so a few MB of
// `<!--`, `<a href=x>` or `<` failed every email_read, reply and forward that
// touched the message (40 KB of `<a href="` alone ran for minutes). It is now a
// set of indexOf scanners. This suite proves three things:
//
//   1. Golden: on a corpus of realistic mail (and the sanitizer attack corpus)
//      the output is byte-identical to what the old code produced. The
//      expected values in text-extract.golden.json were captured from the
//      regex chain BEFORE the rewrite, not from the code under test.
//   2. Oracle: the old regex chain is kept verbatim below, and both are run on
//      tens of thousands of random markup soups built to hit every edge
//      (unterminated openers, `<>`, quoted `>` inside href, `\s` beyond ASCII,
//      non-ASCII case folding). Any difference fails.
//   3. Adversarial: 5 MB of each pathological shape completes well under 1 s.
//
// Run: deno test --allow-read supabase/functions/mcp-server/text-extract-linear.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeHtmlEntities, preferredBodyText, stripHtmlToText } from "./text-extract.ts";
import { stripZeroWidthText } from "./text-safety.ts";
import golden from "./text-extract.golden.json" with { type: "json" };
import { EMAIL_HTML_CORPUS } from "../../../apps/web/src/lib/email-html-corpus.mjs";
import { ALL_PAYLOADS } from "../../../apps/web/src/lib/sanitizer-payloads.mjs";

// ---------------------------------------------------------------------------
// The pre-2026-10-16 implementation, verbatim. The oracle. Do not "fix" it.
// ---------------------------------------------------------------------------

const LEGACY_ANCHOR_WITH_HREF =
  /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

function legacyInlineAnchorTarget(
  _match: string,
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  unquoted: string | undefined,
  inner: string,
): string {
  const url = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
  const shown = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!shown) return " ";
  if (!url || /^(?:#|javascript:|data:)/i.test(url)) return inner;
  const bare = url
    .replace(/^mailto:/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "");
  if (!bare || shown.toLowerCase().includes(bare.toLowerCase())) return inner;
  return `${inner} (${url})`;
}

function legacyStripHtmlToText(html: string, options?: { keepLinks?: boolean }): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  if (options?.keepLinks) out = out.replace(LEGACY_ANCHOR_WITH_HREF, legacyInlineAnchorTarget);
  return stripZeroWidthText(
    decodeHtmlEntities(
      out
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 1. Golden output on realistic mail
// ---------------------------------------------------------------------------

const GOLDEN = golden as Record<string, { plain: string; links: string }>;

const GOLDEN_INPUTS: Array<[string, string]> = [
  ...(EMAIL_HTML_CORPUS as Array<[string, string]>),
  ...(ALL_PAYLOADS as Array<[string, string]>).map(
    ([name, html], i): [string, string] => [`payload ${i}: ${name}`, html],
  ),
];

Deno.test("golden: every corpus entry has a captured expectation", () => {
  assertEquals(GOLDEN_INPUTS.length, Object.keys(GOLDEN).length);
  for (const [name] of GOLDEN_INPUTS) assert(name in GOLDEN, `no golden for ${name}`);
});

Deno.test("golden: realistic mail converts byte-for-byte as before (keepLinks off)", () => {
  for (const [name, html] of GOLDEN_INPUTS) {
    assertEquals(stripHtmlToText(html), GOLDEN[name].plain, name);
  }
});

Deno.test("golden: realistic mail converts byte-for-byte as before (keepLinks on)", () => {
  for (const [name, html] of GOLDEN_INPUTS) {
    assertEquals(stripHtmlToText(html, { keepLinks: true }), GOLDEN[name].links, name);
  }
});

Deno.test("golden: preferredBodyText on an HTML-only message is unchanged", () => {
  for (const [name, html] of EMAIL_HTML_CORPUS as Array<[string, string]>) {
    const expected = GOLDEN[name].links.trim() !== "" ? GOLDEN[name].links : null;
    assertEquals(preferredBodyText(null, html), expected, name);
    assertEquals(preferredBodyText("", html), expected ?? "", name);
  }
});

Deno.test("golden: a few outputs pinned literally, so the golden file cannot drift silently", () => {
  const links = (name: string) => {
    const html = (EMAIL_HTML_CORPUS as Array<[string, string]>).find(([n]) => n === name)![1];
    return stripHtmlToText(html, { keepLinks: true });
  };
  const gmail = links("Gmail reply with quoted original");
  assertEquals(
    gmail,
    "Sounds good, Thursday at 3pm works for me.\n\nI'll book the room.\n\n" +
      "On Tue, Oct 14, 2026 at 9:12 AM Jordan Lee <jordan@example.net> wrote:\n\n" +
      "Hi,\n\nCan we move the review to Thursday? The deck is here: " +
      "https://docs.example.net/d/1AbC/edit?usp=sharing\n\nThanks,\nJordan",
  );
  const quirks = links("links: quoting styles, spacing, nested markup and duplicates");
  assert(quirks.includes("Read the user guide (https://example.com/Guide)."), quirks);
  assert(quirks.includes("Single: Start (https://example.com/s?a=1&b=2)"), quirks);
  assert(quirks.includes("Shown already: example.com/docs\n"), quirks);
  assert(quirks.includes("Broken closer: bold (https://example.com/b)after"), quirks);
});

// ---------------------------------------------------------------------------
// 2. Differential fuzz against the old regex chain
// ---------------------------------------------------------------------------

/** mulberry32: small, seeded, reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Character-level pieces: every opener, closer and near miss on its own. */
const ATOMS = [
  "<", ">", "<a", "<A", "<a ", "<ab", "<a ", " href", "\thref", "HREF", "href", "=", " = ",
  '"', "'", "x", "/", "</a", "</A", "</a >", "</a>", "</a >", "</ab>", "<!--", "-->", "--",
  "-", "!", "<style", "<STYLE", "</style", "</style>", "</style \n>", "<styles", "<script",
  "</script>", "</SCRIPT  >", "<br>", "<br/>", "<br />", "</p>", "</div>", "&amp;", "&nbsp;", "&lt;",
  "&#60;", "\r\n", "\n", " ", "  ", "\t", "https://e.com/", "e.com", "mailto:", "javascript:", "#",
  "data:", "//", "///", "​", " ", "　", "﻿", "a", "b", "_", "1", "<b>", "</b>",
  "<img src=x>", "ſ", "K", "İ", "<p>", "日本",
];

/** Whole constructs, so anchors actually match (and nearly match) often. */
const PHRASES = [
  '<a href="https://e.com/x">', "<a href='https://e.com/y'>", "<A HREF=https://e.com/z/>",
  '<a class=b href = "mailto:m@e.com">', "<a href=", " href=", ' href="', "' href='",
  '<a title=">" href="u">', '<a href="#t">', '<a href="javascript:x">', "<a\thref=e.com>", "<a>",
  "<ab href=x>", "</a>", "</A >", "</a\n>", "</a", "link", "e.com/x", "https://e.com/x", "<b>",
  "</b>", "<", ">", '"', "'", " ", "\n", "<!-- c -->", "<!--", "-->", "<style>s{}</style>",
  "<style>", "</style>", "<script>x</script>", "<br>", "</p>", "</div>", "&amp;", "&nbsp;", "///",
  " ", " ", "<img src=x>", "text", "日本",
];

function fuzz(pieces: string[], seed: number, rounds: number, maxPieces: number) {
  const rnd = prng(seed);
  let linked = 0;
  for (let round = 0; round < rounds; round++) {
    const count = 1 + Math.floor(rnd() * maxPieces);
    let html = "";
    for (let i = 0; i < count; i++) html += pieces[Math.floor(rnd() * pieces.length)];
    const plain = legacyStripHtmlToText(html);
    const links = legacyStripHtmlToText(html, { keepLinks: true });
    if (links !== plain) linked += 1;
    assertEquals(stripHtmlToText(html), plain, `keepLinks off: ${JSON.stringify(html)}`);
    assertEquals(stripHtmlToText(html, { keepLinks: true }), links, `keepLinks on: ${JSON.stringify(html)}`);
  }
  return linked;
}

Deno.test("oracle: character-level soups match the old regex chain exactly", () => {
  fuzz(ATOMS, 20261016, 20000, 30);
});

Deno.test("oracle: anchor-heavy soups match the old regex chain exactly", () => {
  const linked = fuzz(PHRASES, 4242, 20000, 14);
  // Guard against a generator that never exercises the anchor rule at all.
  assert(linked > 1000, `only ${linked} soups produced an inlined link`);
});

// ---------------------------------------------------------------------------
// 3. Adversarial input is linear
// ---------------------------------------------------------------------------

const MB5 = 5 * 1024 * 1024;
const fill = (unit: string, size = MB5) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const ADVERSARIAL: Array<[string, string]> = [
  ["5 MB of <!--", fill("<!--")],
  ["5 MB of <a href=x>", fill("<a href=x>")],
  ['5 MB of <a href="x">', fill('<a href="x">')],
  ['5 MB of <a href="', fill('<a href="')],
  ["5 MB of <", fill("<")],
  ["5 MB of <svg></svg>", fill("<svg></svg>")],
  ["5 MB of <style>", fill("<style>")],
  ["5 MB of <script>", fill("<script>")],
  ["5 MB of <a with no >", fill("<a ")],
  ["one tag, 5 MB of hrefs", "<a " + fill(" href=x")],
  ["one anchor around 5 MB of <", '<a href="https://e.com/x">' + fill("<") + "</a>"],
  ["one href of 5 MB of slashes", '<a href="https://e.com' + fill("/", MB5 - 64) + 'x">text</a>'],
  ["5 MB of near-miss </a", fill("</a ")],
  ["5 MB of near-miss </style", "<style>" + fill("</style ")],
  ["5 MB of <br and spaces", fill("<br    ")],
];

for (const [name, html] of ADVERSARIAL) {
  Deno.test(`adversarial: ${name} completes well under 1 s`, () => {
    for (const keepLinks of [false, true]) {
      const started = performance.now();
      stripHtmlToText(html, { keepLinks });
      const elapsed = performance.now() - started;
      assert(elapsed < 1000, `${name} (keepLinks ${keepLinks}) took ${elapsed.toFixed(0)} ms`);
    }
  });
}

Deno.test("adversarial: the shapes still convert as the old code would, at a size it can finish", () => {
  // The old chain is quadratic (or worse) on these, so compare on a slice it
  // can finish quickly. Same function, same rules: only the cost differs.
  for (const [name, html] of ADVERSARIAL) {
    const small = html.length > 3000 ? html.slice(0, 1500) + html.slice(-1500) : html;
    for (const keepLinks of [false, true]) {
      assertEquals(
        stripHtmlToText(small, { keepLinks }),
        legacyStripHtmlToText(small, { keepLinks }),
        `${name} keepLinks ${keepLinks}`,
      );
    }
  }
});
