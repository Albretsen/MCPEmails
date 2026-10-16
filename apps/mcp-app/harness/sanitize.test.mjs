#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The card's layer-1 deny-list pre-pass: same output as the old regex chain,
// in linear time.
//
//   node harness/sanitize.test.mjs
//
// Until 2026-10-16 `stripOnce` in src/sanitize.ts was a chain of global regexes
// that are quadratic on hostile mail (64K spaces took 3.9 s, 64 KB of `<svg`
// 1.7 s, on every render of a reply that quotes such a message). It is now a
// set of indexOf scanners. Layer 2 (DOMParser + allow-list) consumes layer 1's
// output, so the card shows exactly what it did before if and only if layer 1
// returns exactly the same string. That is what this suite pins:
//
//   1. corpus:  realistic mail (apps/web/src/lib/email-html-corpus.mjs) and the
//               sanitizer attack corpus give byte-identical layer-1 output;
//   2. oracle:  the old regex chain, kept verbatim below, and the new scanners
//               agree on tens of thousands of random markup soups;
//   3. timing:  512 KB (the card's input cap) of each pathological shape runs
//               to the 10-pass fixpoint well inside the budget.
//
// DOM-free: layer 1 is a pure string function.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EMAIL_HTML_CORPUS } from "../../web/src/lib/email-html-corpus.mjs";
import { ALL_PAYLOADS } from "../../web/src/lib/sanitizer-payloads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/sanitize.bundle.mjs");

// ---- the pre-2026-10-16 layer 1, verbatim. The oracle. Do not "fix" it. ----

const LEGACY_BLOCK_TAGS = [
  "script", "style", "link", "meta", "iframe", "object", "embed", "base", "form",
  "noscript", "svg", "math",
];

function legacyStripOnce(html) {
  let result = html;
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of LEGACY_BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"), "");
    result = result.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  }
  result = result.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  result = result.replace(
    /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    "",
  );
  result = result.replace(/<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi, "");
  return result;
}

function legacyDenyListPass(dirty) {
  let clean = dirty;
  for (let i = 0; i < 10; i++) {
    const next = legacyStripOnce(clean);
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

// ---- tiny runner, in the style of the other harness suites -----------------

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
  checks += 1;
  if (actual !== wanted) {
    failures.push(`${label}\n        got  ${JSON.stringify(actual).slice(0, 300)}\n        want ${JSON.stringify(wanted).slice(0, 300)}`);
  }
}

/** mulberry32: small, seeded, reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  "<", ">", "/", "/>", "<!--", "-->", "--", "<svg", "<SVG", "</svg>", "</SVG>", "</svg >", "<svgx",
  "<script", "</script>", "<scr", "ipt>", "<style", "</style>", "<math", "</math>", "<form", "</form>",
  "<meta", "<link", "<base", "<iframe", "</iframe>", "<object", "<embed", "<noscript", "</noscript>",
  "<input", "<button", "</button>", "<textarea", "</textarea>", "<select", "</select>", " ", "  ", "\t",
  "\n", " ", " ", "　", "﻿", "on", "ON", "onclick", "onerror", "on1", "onx", "=", " = ",
  '"', "'", "x", "y z", "href", "HREF", "src", "javascript:", "JavaScript:", "alert(1)", "<a", "<b>",
  "</b>", "<p>", "text", "ſ", "K", "İ",
];

const PHRASES = [
  "<svg onload=alert(1)>", "<svg/>", "<svg><g/></svg>", "<SVG/onload=x>", "<script>x</script>",
  "<scr<script>ipt>alert(1)</script>", "<style>p{}</style>", "<!-- c -->", "<!--", "-->",
  '<img src=x onerror="alert(1)">', "<img src=x onerror='a'>", "<img src=x onerror=a>",
  ' onclick="', " onclick='", " onmouseover = 'x' ", '<a href="javascript:alert(1)">x</a>',
  "<a href='JavaScript:void(0)'>y</a>", "<a href=javascript:x>z</a>", ' href="javascript:',
  " src=javascript:", '<a href="https://e.com">ok</a>', "<input value=1>", "<button>Go</button>",
  "<textarea>t</textarea>", "<select><option>1</option></select>", "<form action=x>", "</form>",
  "<iframe src=x></iframe>", "<meta http-equiv=refresh>", "<p>", "</p>", "text", " ", "\n", "<", ">",
  '"', "'", "=", "<math><mi>x</mi></math>", "<noscript><p>n</p></noscript>", "<base href=x>",
];

function soup(pieces, rnd, maxPieces) {
  const count = 1 + Math.floor(rnd() * maxPieces);
  let html = "";
  for (let i = 0; i < count; i++) html += pieces[Math.floor(rnd() * pieces.length)];
  return html;
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    stdin: {
      contents: 'export { denyListPass, EMAIL_HTML_MAX_LENGTH } from "./src/sanitize";\n',
      resolveDir: appRoot,
      sourcefile: "sanitize-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: OUT,
  });
  const { denyListPass, EMAIL_HTML_MAX_LENGTH } = await import(pathToFileURL(OUT).href);

  // 1. Corpus: realistic mail and the attack payloads.
  const corpus = [...EMAIL_HTML_CORPUS, ...ALL_PAYLOADS];
  for (const [name, html] of corpus) {
    expect(`corpus: ${name}`, denyListPass(html), legacyDenyListPass(html));
  }
  console.log(`ok    corpus: ${corpus.length} entries byte-identical to the old regex chain`);

  // 2. Oracle fuzz.
  let changed = 0;
  for (const [label, pieces, seed, rounds, max] of [
    ["atoms", ATOMS, 20261016, 15000, 30],
    ["phrases", PHRASES, 4242, 15000, 12],
  ]) {
    const rnd = prng(seed);
    for (let round = 0; round < rounds; round++) {
      const html = soup(pieces, rnd, max);
      const wanted = legacyDenyListPass(html);
      if (wanted !== html) changed += 1;
      expect(`oracle/${label}: ${JSON.stringify(html)}`, denyListPass(html), wanted);
    }
  }
  // Guard against a generator that never makes the deny-list do anything.
  checks += 1;
  if (changed < 10000) failures.push(`oracle: only ${changed} soups were changed by the deny-list`);
  console.log(`ok    oracle: 30000 random soups (${changed} rewritten) agree with the old regex chain`);

  // 3. Timing at the card's own input cap. The old chain took seconds on 64 KB
  //    of these; the budget is generous so a slow CI runner cannot flake it.
  const fill = (unit) => unit.repeat(Math.ceil(EMAIL_HTML_MAX_LENGTH / unit.length)).slice(0, EMAIL_HTML_MAX_LENGTH);
  const shapes = [
    ["spaces", fill(" ")],
    ["<svg", fill("<svg")],
    ["<!--", fill("<!--")],
    ["<input", fill("<input")],
    ["<script", fill("<script")],
    ['<svg x="', fill('<svg x="')],
    [" onx=", fill(" onx=")],
    [' onclick="', fill(' onclick="')],
    [' href="javascript:', fill(' href="javascript:')],
    ["<scr<script>ipt>", fill("<scr<script>ipt>")],
    ["space-on-letters", fill(" on" + "a".repeat(200))],
  ];
  const BUDGET_MS = 3000;
  for (const [name, html] of shapes) {
    const started = performance.now();
    denyListPass(html);
    const elapsed = performance.now() - started;
    checks += 1;
    if (elapsed >= BUDGET_MS) failures.push(`timing: 512 KB of ${name} took ${elapsed.toFixed(0)} ms`);
    console.log(`${elapsed < BUDGET_MS ? "ok  " : "FAIL"}  timing: 512 KB of ${JSON.stringify(name)} in ${elapsed.toFixed(0)} ms`);
  }
  // Same shapes, small enough for the old chain: still the same output.
  for (const [name, html] of shapes) {
    const small = html.slice(0, 2000);
    expect(`timing shape at 2 KB: ${name}`, denyListPass(small), legacyDenyListPass(small));
  }

  for (const failure of failures.slice(0, 20)) console.log(`FAIL  ${failure}`);
  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
