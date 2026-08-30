// ---------------------------------------------------------------------------
// signature-sanitizer suite (Deno)
//
// Run with:  deno test --allow-read supabase/functions/mcp-server/signature-sanitizer.test.ts
//
// The corpus below is the SAME corpus as
// apps/web/src/lib/sanitizeSignatureHtml.test.mjs, on purpose. Two runtimes
// hold two copies of this sanitizer, so a payload that is blocked on one and
// not the other is exactly the bug the twin arrangement can produce. If you add
// a payload there, add it here.
//
// The last test is the drift check, and like text-safety.test.ts it reads the
// filesystem, so the suite must be run with --allow-read. Without the flag that
// test FAILS rather than skipping, which is deliberate: a drift check that
// quietly does not run reads as green while the two copies diverge.
// ---------------------------------------------------------------------------

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  sanitizeSignatureHtml,
  sanitizeSignatureHtmlSafe,
  SIGNATURE_HTML_MAX_LENGTH,
} from "./signature-sanitizer.ts";

/** Everything that must never appear in sanitizer output, whatever went in. */
function residue(html: string): string[] {
  const lower = html.toLowerCase();
  const found: string[] = [];
  if (/\son[a-z]+\s*=/.test(lower)) found.push("event handler attribute");
  if (lower.includes("javascript:")) found.push("javascript: scheme");
  if (lower.includes("vbscript:")) found.push("vbscript: scheme");
  if (lower.includes("data:")) found.push("data: scheme");
  if (lower.includes("<script")) found.push("<script");
  if (lower.includes("<iframe")) found.push("<iframe");
  if (lower.includes("<svg")) found.push("<svg");
  if (lower.includes("<object")) found.push("<object");
  if (lower.includes("<form")) found.push("<form");
  if (lower.includes("<style")) found.push("<style");
  if (lower.includes("<base")) found.push("<base");
  if (lower.includes("<meta")) found.push("<meta");
  if (lower.includes("<textarea")) found.push("<textarea");
  if (lower.includes("expression(")) found.push("expression(");
  if (/url\s*\(/.test(lower)) found.push("css url(");
  if (lower.includes("srcdoc")) found.push("srcdoc");
  if (lower.includes("formaction")) found.push("formaction");
  if (lower.includes("xlink:href")) found.push("xlink:href");
  return found;
}

const NUL = "\u0000";

const ATTACKS: Array<[string, string]> = [
  // --- the four confirmed bypasses of the old deny-list ---------------------
  ["bypass 1: quote, not space, before handler", '<img/src="https://a/b"onerror=alert(1)>'],
  ["bypass 2: leading space in quoted href", '<a href=" javascript:alert(1)">x</a>'],
  ["bypass 3: hex entity in scheme", '<a href="jav&#x61;script:alert(1)">x</a>'],
  ["bypass 4: css url() scheme", '<div style="background:url(javascript:alert(1))">x</div>'],
  // 5. The one that ONLY this copy let through, because it ran a single pass.
  ["nested tag evasion", "<scr<script>ipt>alert(1)</script>"],

  // --- the same tricks, one turn further ------------------------------------
  ["double nested tag evasion", "<scr<scr<script>ipt>ipt>alert(1)</script>"],
  ["classic script block", "<p>hi<script>alert(1)</script></p>"],
  ["unclosed script runs to EOF", "<script>alert(1)"],
  ["script hidden in a tag name", "<div <script>alert(1)</script>>x</div>"],
  ["svg onload", "<svg/onload=alert(1)>"],
  ["uppercase tag and handler", '<IMG SRC="https://a/b" ONERROR="alert(1)">'],
  ["named entity colon", '<a href="javascript&colon;alert(1)">x</a>'],
  ["entity we do not decode", '<a href="javascript&NotARealEntity;alert(1)">x</a>'],
  ["tab inside the scheme", '<a href="java\tscript:alert(1)">x</a>'],
  ["newline inside the scheme", '<a href="java\nscript:alert(1)">x</a>'],
  ["null byte inside the scheme", `<a href="java${NUL}script:alert(1)">x</a>`],
  ["decimal entity in scheme", '<a href="&#106;avascript:alert(1)">x</a>'],
  ["decimal entity, no semicolon", '<a href="&#106avascript:alert(1)">x</a>'],
  ["mixed case scheme", '<a href="JaVaScRiPt:alert(1)">x</a>'],
  ["vbscript scheme", '<a href="vbscript:msgbox(1)">x</a>'],
  ["duplicate href, poison second", '<a href="https://ok.example" href="javascript:alert(1)">x</a>'],
  ["data: image source", '<img src="data:text/html,<script>alert(1)</script>">'],
  ["plaintext http image", '<img src="http://insecure.example/logo.png">'],
  ["style expression()", '<div style="width:expression(alert(1))">x</div>'],
  ["style behavior", '<div style="behavior:url(#default#time2)">x</div>'],
  ["style -moz-binding", '<div style="-moz-binding:url(https://evil.example/x.xml)">x</div>'],
  ["style css escape", '<div style="background:\\75 rl(javascript:alert(1))">x</div>'],
  ["style entity-encoded url", '<div style="background:&#117;rl(javascript:alert(1))">x</div>'],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["form and button handler", '<form action="https://evil.example"><button onclick="alert(1)">go</button></form>'],
  ["object data scheme", '<object data="javascript:alert(1)"></object>'],
  ["comment smuggling", '<!--<a href="javascript:alert(1)">--><b>ok</b>'],
  ["bogus comment", '<!<a href="javascript:alert(1)">'],
  ["textarea smuggling", "<textarea><img src=x onerror=alert(1)></textarea>"],
  ["noscript smuggling", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ["base tag", '<base href="https://evil.example/"><a href="https://ok.example">x</a>'],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ["xlink:href", '<a xlink:href="javascript:alert(1)">x</a>'],
  ["formaction", '<button formaction="javascript:alert(1)">x</button>'],
  ["autofocus onfocus", "<p onfocus=alert(1) autofocus tabindex=1>x</p>"],
  ["backtick quoted src", "<img src=`https://a/b` onerror=alert(1)>"],
  ["unquoted handler", "<div onmouseover=alert(1)>x</div>"],
  ["plaintext swallows the rest", "<plaintext><img src=x onerror=alert(1)>"],
  ["deep nesting", `${"<div>".repeat(300)}deep${"</div>".repeat(300)}`],
];

const LEGIT: Array<[string, string, string[]]> = [
  [
    "bold, italic, link",
    '<p><strong>Jane Doe</strong> &mdash; <em>Head of Support</em><br><a href="https://mcpemails.com" target="_blank">mcpemails.com</a></p>',
    ["<strong>Jane Doe</strong>", "<em>Head of Support</em>", "<br>", 'href="https://mcpemails.com"', 'rel="noopener noreferrer"', "&mdash;"],
  ],
  [
    "mailto link",
    '<p>Email <a href="mailto:jane@example.com">jane@example.com</a></p>',
    ['href="mailto:jane@example.com"', "jane@example.com</a>"],
  ],
  [
    "table",
    '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td style="padding: 4px; color: #333">Jane</td></tr></tbody></table>',
    ["<table>", "<thead>", "<th>Name</th>", "<tbody>", "padding: 4px", "color: #333", "Jane"],
  ],
  [
    "https hosted logo",
    '<p><img src="https://cdn.example.com/logo.png" alt="Acme" width="120" height="40"></p>',
    ['<img src="https://cdn.example.com/logo.png"', 'alt="Acme"', 'width="120"', 'height="40"'],
  ],
  [
    "font colour",
    '<font color="#ff6600" size="3">Acme Corp</font>',
    ['<font color="#ff6600">', "Acme Corp"],
  ],
  [
    "multi-paragraph signature",
    "<p>Jane Doe</p><p>Acme Corp</p><blockquote>We ship on Fridays.</blockquote><hr><ul><li>One</li><li>Two</li></ul>",
    ["<p>Jane Doe</p>", "<p>Acme Corp</p>", "<blockquote>We ship on Fridays.</blockquote>", "<hr>", "<li>One</li>", "<li>Two</li>"],
  ],
  [
    "url with query string",
    '<a href="https://example.com/x?a=1&amp;b=2">link</a>',
    ['href="https://example.com/x?a=1&amp;b=2"'],
  ],
  [
    "entities in text are left alone",
    "<p>Jane&nbsp;Doe &copy; 2026 &amp; friends</p>",
    ["&nbsp;", "&copy;", "&amp;"],
  ],
  [
    "angle brackets in prose",
    "<p>a &lt; b and 3 > 2</p>",
    ["a &lt; b", "3 &gt; 2"],
  ],
  [
    "alignment and fonts",
    '<div align="center" style="text-align: center; font-family: Arial, sans-serif">Acme</div>',
    ['align="center"', "text-align: center", "font-family: Arial, sans-serif"],
  ],
  [
    "rgb() colour",
    '<span style="color: rgb(12, 34, 56)">x</span>',
    ["color: rgb(12, 34, 56)"],
  ],
];

Deno.test("every attack payload is neutralised", () => {
  for (const [label, payload] of ATTACKS) {
    const clean = sanitizeSignatureHtml(payload);
    assertEquals(
      residue(clean),
      [],
      `${label}: executable residue survived\n  in:  ${payload}\n  out: ${clean}`,
    );
  }
});

Deno.test("the four confirmed deny-list bypasses are dead", () => {
  assertEquals(sanitizeSignatureHtml('<img/src="https://a/b"onerror=alert(1)>'), '<img src="https://a/b">');
  assertEquals(sanitizeSignatureHtml('<a href=" javascript:alert(1)">x</a>'), "<a>x</a>");
  assertEquals(sanitizeSignatureHtml('<a href="jav&#x61;script:alert(1)">x</a>'), "<a>x</a>");
  assertEquals(sanitizeSignatureHtml('<div style="background:url(javascript:alert(1))">x</div>'), "<div>x</div>");
});

Deno.test("nested-tag evasion cannot reassemble a script element", () => {
  // The bug this file exists to close: the old single-pass regex stripped the
  // inner <script> and glued `<scr` to `ipt>`.
  const clean = sanitizeSignatureHtml("<scr<script>ipt>alert(1)</script>");
  assertEquals(clean.toLowerCase().includes("<script"), false);
  assertEquals(clean.includes("<"), false);
  assert(/ipt&gt;alert\(1\)/.test(clean), `unexpected output: ${clean}`);
});

Deno.test("legitimate signatures are not broken", () => {
  for (const [label, payload, fragments] of LEGIT) {
    const clean = sanitizeSignatureHtml(payload);
    for (const fragment of fragments) {
      assert(
        clean.includes(fragment),
        `${label}: expected ${JSON.stringify(fragment)} to survive\n  in:  ${payload}\n  out: ${clean}`,
      );
    }
    assertEquals(residue(clean), [], `${label}: clean input produced residue: ${clean}`);
  }
});

Deno.test("an img without a usable https source is removed entirely", () => {
  assertEquals(sanitizeSignatureHtml('<p><img src="http://x/y.png"></p>'), "<p></p>");
  assertEquals(sanitizeSignatureHtml("<p><img></p>"), "<p></p>");
  assertEquals(
    sanitizeSignatureHtml('<p><img src="https://x/y.png"></p>'),
    '<p><img src="https://x/y.png"></p>',
  );
});

Deno.test("output is idempotent — sanitizing twice changes nothing", () => {
  // The send path re-sanitizes stored HTML on every send. If a second pass
  // changed anything, signatures would erode message by message.
  for (const [, payload] of ATTACKS) {
    const once = sanitizeSignatureHtml(payload);
    assertEquals(sanitizeSignatureHtml(once), once, `not idempotent for: ${payload}`);
  }
  for (const [, payload] of LEGIT) {
    const once = sanitizeSignatureHtml(payload);
    assertEquals(sanitizeSignatureHtml(once), once, `not idempotent for: ${payload}`);
  }
});

Deno.test("empty string round-trips without throwing", () => {
  assertEquals(sanitizeSignatureHtml(""), "");
  assertEquals(sanitizeSignatureHtmlSafe(""), "");
});

Deno.test("oversize output throws, and the send-path variant does not", () => {
  const huge = `<p>${"a".repeat(SIGNATURE_HTML_MAX_LENGTH + 1)}</p>`;
  assertThrows(() => sanitizeSignatureHtml(huge), Error, "exceeds 102400 limit");
  // The send path must never fail a whole message over a signature.
  assertEquals(sanitizeSignatureHtmlSafe(huge), "");
});

// ---------------------------------------------------------------------------
// Drift check — reads the filesystem, needs --allow-read.
// ---------------------------------------------------------------------------

Deno.test("the two copies of the policy agree", async () => {
  // This module and the web app (apps/web/src/lib/sanitizeSignatureHtmlServer.js)
  // each hold their own copy because they run in two different runtimes. If the
  // policy tables drift, a payload blocked on one surface is still live on the
  // other, which is precisely the class of bug this change exists to close.
  // Compare the source text of the tables that ARE the policy. Both policies
  // are covered: the email tables live in the same two files and drift the same
  // way, and email is the half where a missed table means a tracking pixel
  // loads rather than a signature looking wrong.
  const CONTRACT = [
    `const SIGNATURE_ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "a",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "img", "table", "thead",
  "tbody", "tr", "td", "th", "blockquote", "hr", "font",
]);`,
    `const SIGNATURE_ALLOWED_ATTR = new Set([
  "href", "target", "rel", "src", "alt", "width", "height", "style",
  "align", "color",
]);`,
    `const EMAIL_ALLOWED_TAGS = new Set([
  ...SIGNATURE_ALLOWED_TAGS,
  "h5", "h6", "pre", "code", "kbd", "samp", "dl", "dt", "dd", "caption",
  "tfoot", "small", "sub", "sup", "abbr", "cite", "q", "del", "ins", "mark",
  "figure", "figcaption", "time", "dfn",
]);`,
    `const EMAIL_ALLOWED_ATTR = new Set([
  "href", "src", "alt", "width", "height", "colspan", "rowspan",
  "dir", "lang", "title",
]);`,
    `const EMAIL_SRC = /^(?:cid:|data:image\\/(?:png|gif|jpeg|jpg|webp|bmp);`,
    `const SAFE_HREF = /^(?:https?:|mailto:)/;`,
    `const VOID_TAGS = new Set(["br", "img", "hr"]);`,
    `const DROP_CONTENT_TAGS = new Set([
  "annotation-xml", "audio", "colgroup", "desc", "foreignobject", "head",
  "iframe", "math", "mi", "mn", "mo", "ms", "mtext", "noembed", "noframes",
  "noscript", "plaintext", "script", "style", "svg", "template", "textarea",
  "title", "video", "xmp",
]);`,
    `const RAW_TEXT_TAGS = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed",
  "noframes", "noscript", "plaintext",
]);`,
    `const ALLOWED_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);`,
    `const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-decoration", "text-decoration-color",
  "text-decoration-line", "text-transform", "text-indent",
  "vertical-align", "white-space", "direction",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-radius",
  "border-collapse", "border-spacing",
  "width", "height", "max-width", "min-width", "max-height", "min-height",
  "display", "float", "clear", "outline",
  "list-style", "list-style-type", "list-style-position",
  "table-layout", "caption-side", "empty-cells",
]);`,
    `const ALLOWED_CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc"]);`,
    `const SAFE_STYLE_VALUE = /^[a-zA-Z0-9\\s#%.,()/'"+!_-]*$/;`,
    `const RESIDUAL_ENTITY = /&#?[a-zA-Z0-9]{1,32};/;`,
    `const URL_CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/g;`,
    `const ENTITY_PATTERN =
  /&(#[xX][0-9a-fA-F]{1,6};?|#[0-9]{1,7};?|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;`,
    `const MAX_DEPTH = 64;`,
  ];

  const here = new URL(".", import.meta.url).pathname;
  const files = [
    `${here}signature-sanitizer.ts`,
    `${here}../../../apps/web/src/lib/sanitizeSignatureHtmlServer.js`,
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const snippet of CONTRACT) {
      assert(
        source.includes(snippet),
        `${file} does not contain this policy block verbatim — the copies have drifted:\n${snippet}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// EMAIL POLICY
//
// Everything above covers the signature policy. This section covers the other
// half: the same tokenizer, driven by EMAIL_POLICY, over email bodies.
//
// The payloads come from apps/web/src/lib/sanitizer-payloads.mjs, which is
// shared with the Node suite so both runtimes are held to the same corpus.
// Several of them are shapes lifted from REAL mail in a live inbox, and they
// are here because the hand-written payloads all passed while the real ones did
// not: bulk mailers leave <td>/<tr> unclosed and quote almost no attribute, and
// that combination found a genuine auto-close bug.
// ---------------------------------------------------------------------------

import {
  EMAIL_POLICY,
  sanitizeEmailHtml,
  SIGNATURE_POLICY,
} from "./signature-sanitizer.ts";
import {
  ALL_PAYLOADS,
  EXTERNAL_SRC_PAYLOADS,
} from "../../../apps/web/src/lib/sanitizer-payloads.mjs";

for (const [name, payload] of EXTERNAL_SRC_PAYLOADS as Array<[string, string]>) {
  Deno.test(`email keeps no external src: ${name}`, () => {
    const out = sanitizeEmailHtml(payload);
    assertEquals(/evil\.tld/i.test(out), false, `external host survived: ${out}`);
    assertEquals(/src\s*=/i.test(out), false, `a src survived: ${out}`);
  });
}

Deno.test("email keeps cid: images, the bytes are already in the message", () => {
  const out = sanitizeEmailHtml('<img src="cid:logo@example" alt="Logo">');
  assertStringIncludes(out, 'src="cid:logo@example"');
  assertStringIncludes(out, 'alt="Logo"');
});

Deno.test("email keeps inline base64 raster data: images", () => {
  const out = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
  assertStringIncludes(out, "data:image/png;base64,");
});

Deno.test("email drops data:image/svg+xml: SVG is a document, not a raster", () => {
  const out = sanitizeEmailHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  assertEquals(/svg/i.test(out), false, `svg data URI survived: ${out}`);
});

Deno.test("email keeps the img when it strips the src, so alt survives", () => {
  // requireImgSrc is false for email precisely so this does not vanish: the alt
  // text is often the only description of the image the reader ever gets.
  const out = sanitizeEmailHtml('<img src="https://evil.tld/p.gif" alt="Q3 chart">');
  assertStringIncludes(out, 'alt="Q3 chart"');
  assertEquals(out.includes("evil.tld"), false);
});

Deno.test("email DROPS the very https logo the signature KEEPS", () => {
  // The one input that shows the policy is the only thing that differs.
  const input = '<img src="https://cdn.example.com/logo.png" alt="Acme">';
  assertStringIncludes(sanitizeSignatureHtml(input), "https://cdn.example.com/logo.png");
  assertEquals(sanitizeEmailHtml(input).includes("cdn.example.com"), false);
});

Deno.test("email drops inline style; signature keeps it filtered", () => {
  const input = '<p style="color:#333;position:fixed">x</p>';
  assertEquals(/style/i.test(sanitizeEmailHtml(input)), false);
  const sig = sanitizeSignatureHtml(input);
  assertStringIncludes(sig, "color: #333");
  // position is not on the allow-list in either policy.
  assertEquals(/position/i.test(sig), false);
});

Deno.test("every payload is idempotent under both policies", () => {
  // The send path re-sanitizes HTML that was already sanitized, so output that
  // is not a fixpoint means the second pass changes bytes nobody asked it to.
  // This is the assertion that caught the auto-close bug.
  for (const [name, payload] of ALL_PAYLOADS as Array<[string, string]>) {
    const e1 = sanitizeEmailHtml(payload);
    assertEquals(sanitizeEmailHtml(e1), e1, `email/${name} not idempotent: ${e1}`);
    const s1 = sanitizeSignatureHtmlSafe(payload);
    assertEquals(sanitizeSignatureHtmlSafe(s1), s1, `signature/${name} not idempotent: ${s1}`);
  }
});

Deno.test("a row opened over an unclosed cell closes both", () => {
  // The exact shape that broke idempotence, kept as its own named regression.
  assertEquals(
    sanitizeEmailHtml("<table><tbody><tr><td>A<tr><td>B</table>"),
    "<table><tbody><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>",
  );
});

Deno.test("no payload in the shared corpus produces anything executable", () => {
  for (const [name, payload] of ALL_PAYLOADS as Array<[string, string]>) {
    for (const out of [sanitizeEmailHtml(payload), sanitizeSignatureHtmlSafe(payload)]) {
      assertEquals(/\son[a-z]+\s*=/i.test(out), false, `${name}: handler: ${out}`);
      assertEquals(/javascript\s*:/i.test(out), false, `${name}: js scheme: ${out}`);
      assertEquals(/<script/i.test(out), false, `${name}: <script: ${out}`);
      assertEquals(/\ssrcset\s*=/i.test(out), false, `${name}: srcset: ${out}`);
    }
  }
});

Deno.test("email is never more permissive than signature on URLs", () => {
  assertEquals(EMAIL_POLICY.allowedStyleProps, null);
  assertEquals(SIGNATURE_POLICY.allowedStyleProps === null, false);
  for (const probe of ["https://x.test/a.png", "http://x.test/a.png"]) {
    assertEquals(EMAIL_POLICY.isAllowedSrc(probe), false, probe);
  }
  assertEquals(SIGNATURE_POLICY.isAllowedSrc("https://x.test/a.png"), true);
});
