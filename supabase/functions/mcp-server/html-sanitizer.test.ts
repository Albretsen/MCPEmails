// ---------------------------------------------------------------------------
// These tests exist because the previous sanitizer passed its own tests.
//
// The old `sanitizeEmailHtml` was a regex deny-list, and every rule in it was
// written in response to a payload someone had already thought of. It looked
// correct and it was not: the seven payloads in BYPASSES below all survived it
// verbatim, in production, on a string that is returned as `body_html` to the
// model and to any other consumer of email_read.
//
// So the suite is organised around the failure, not the feature:
//
//   1. BYPASSES: the exact payloads that defeated the deny-list. These are
//      regression locks. If one of them ever renders again, the construction
//      has regressed to a deny-list somewhere.
//   2. Email src policy: the thing the email policy exists for: NO external
//      image source survives, under any spelling.
//   3. Signature src policy: the one deliberate difference, asserted in both
//      directions so a future "simplification" cannot quietly merge them.
//   4. Structure and fidelity: the sanitizer has to leave real mail readable,
//      or it will be turned off.
//
// Run: deno test supabase/functions/mcp-server/html-sanitizer.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  EMAIL_HTML_POLICY,
  type SanitizePolicy,
  sanitizeHtml,
  SIGNATURE_HTML_POLICY,
} from "./html-sanitizer.ts";

const email = (html: string) => sanitizeHtml(html, EMAIL_HTML_POLICY);
const signature = (html: string) => sanitizeHtml(html, SIGNATURE_HTML_POLICY);

/**
 * A result is "inert" if nothing in it can execute or fetch. Checked as
 * properties of the output string rather than as an exact match, because the
 * exact serialisation is allowed to change and the safety property is not.
 *
 * Note what is deliberately NOT asserted: the absence of the substring
 * "alert(". Payload text that survives as ESCAPED TEXT is a pass, not a fail.
 * `<scr<script>ipt>alert(1)</script>` correctly comes back as the text
 * `ipt&gt;alert(1)`, which renders as characters and executes nothing. Grepping
 * the output for scary words is exactly the kind of shape-matching that made
 * the deny-list look correct; the property that matters is that no tag,
 * handler, or scheme survives.
 */
function assertInert(
  out: string,
  label: string,
  policy: SanitizePolicy = EMAIL_HTML_POLICY,
) {
  assert(!/\son[a-z]+\s*=/i.test(out), `${label}: event handler survived: ${out}`);
  assert(!/javascript\s*:/i.test(out), `${label}: javascript: survived: ${out}`);
  assert(!/<script/i.test(out), `${label}: <script survived: ${out}`);
  assert(!/\ssrcset\s*=/i.test(out), `${label}: srcset survived: ${out}`);

  if (policy.styleProps === null) {
    assert(!/\sstyle\s*=/i.test(out), `${label}: style= survived: ${out}`);
  } else {
    // Signature KEEPS style, so assert the FILTER rather than the absence.
    for (const m of out.matchAll(/\sstyle="([^"]*)"/g)) {
      for (const decl of m[1].split(";")) {
        if (!decl.trim()) continue;
        const prop = decl.split(":")[0].trim();
        assert(
          policy.styleProps.test(prop),
          `${label}: style property "${prop}" not allow-listed: ${out}`,
        );
      }
      assert(
        !/url\s*\(|expression\s*\(|javascript:|@import/i.test(m[1]),
        `${label}: style value can fetch or execute: ${out}`,
      );
    }
  }

  // Any `<` still in the output must open an allow-listed element, never a
  // reconstructed tag. Unescaped `<` followed by anything else is a failure.
  for (const m of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
    assert(
      policy.allowedTags.has(m[1].toLowerCase()),
      `${label}: non-allow-listed tag <${m[1]}> survived: ${out}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. The confirmed bypasses of the old deny-list.
// ---------------------------------------------------------------------------

/**
 * Each entry is a payload that the regex deny-list returned UNCHANGED, with the
 * reason its rules missed it. Kept verbatim so the next reader can see what a
 * deny-list is actually up against.
 */
const BYPASSES: Array<[name: string, payload: string, why: string]> = [
  [
    "handler separated by a quote, not whitespace",
    '<img/src="https://a/b"onerror=alert(1)>',
    "the /\\s+on[a-z]+=/ rule required whitespace before the handler; a browser " +
      "ends the previous attribute at the closing quote, so it saw onerror",
  ],
  [
    "leading space inside the quoted scheme",
    '<a href=" javascript:alert(1)">click</a>',
    'the rule matched the literal "javascript: with no room for a space',
  ],
  [
    "entity-encoded scheme",
    '<a href="jav&#x61;script:alert(1)">click</a>',
    "the browser decodes &#x61; to 'a' before parsing the URL; the regex " +
      "compared the raw undecoded text",
  ],
  [
    "scheme smuggled through style",
    '<div style="background:url(javascript:alert(1))">x</div>',
    "style was never inspected at all",
  ],
  [
    "single-pass strip-and-rescan",
    "<scr<script>ipt>alert(1)</script>",
    "removing the inner <script> splices the outer halves into a live <script>; " +
      "one pass turns the payload INTO the attack",
  ],
  [
    "unquoted external src",
    "<img src=https://evil.tld/pixel.gif>",
    "the src rule only matched quoted values, so every unquoted tracking pixel " +
      'walked straight through the "no external src" policy',
  ],
  [
    "srcset as a second image channel",
    '<img srcset="https://evil.tld/p.gif 1x" alt="x">',
    "srcset was never considered, so the src policy could be sidestepped by " +
      "using the other attribute that loads an image",
  ],
];

for (const [name, payload, why] of BYPASSES) {
  Deno.test(`bypass is closed (email): ${name}`, () => {
    const out = email(payload);
    assertInert(out, `${name}: ${why}`);
  });

  Deno.test(`bypass is closed (signature): ${name}`, () => {
    const out = signature(payload);
    assertInert(out, `${name}: ${why}`, SIGNATURE_HTML_POLICY);
  });
}

Deno.test("bypass: the nested-script splice leaves no tag at all", () => {
  const out = email("<scr<script>ipt>alert(1)</script>");
  // `scr` is an unknown element, so it unwraps; `<script` becomes an attribute
  // name that is not on the allow-list; the raw-text run is dropped whole.
  // What is left is the stray text after the tag, escaped.
  assertEquals(out.includes("<"), false);
});

Deno.test("bypass: href survives as text but loses the payload", () => {
  const out = email('<a href=" javascript:alert(1)">click</a>');
  // The link text is still readable, dropping the attribute, not the element,
  // is what keeps a sanitizer from mangling legitimate mail.
  assertStringIncludes(out, "click");
  assertEquals(/href/i.test(out), false);
});

// ---------------------------------------------------------------------------
// 2. Email policy: NO external image source, under any spelling.
// ---------------------------------------------------------------------------

/**
 * The email policy's whole reason to differ from the signature policy. A remote
 * image in a stranger's mail is a read receipt: it fires on render and tells the
 * sender the address is live, when it was opened, and from which IP.
 *
 * Every spelling here is a real evasion, not a hypothetical: unquoted values,
 * single quotes, uppercase attribute names, whitespace around `=`, a scheme
 * broken up by a tab, a protocol-relative URL, and the entity trick.
 */
const EXTERNAL_SRC_SPELLINGS: Array<[string, string]> = [
  ["double-quoted https", '<img src="https://evil.tld/p.gif">'],
  ["single-quoted https", "<img src='https://evil.tld/p.gif'>"],
  ["unquoted https", "<img src=https://evil.tld/p.gif>"],
  ["unquoted http", "<img src=http://evil.tld/p.gif>"],
  ["uppercase attribute", '<IMG SRC="https://evil.tld/p.gif">'],
  ["whitespace around equals", '<img src = "https://evil.tld/p.gif">'],
  ["protocol-relative", '<img src="//evil.tld/p.gif">'],
  ["ftp", '<img src="ftp://evil.tld/p.gif">'],
  ["tab inside the scheme", '<img src="ht\ttps://evil.tld/p.gif">'],
  ["entity-encoded scheme", '<img src="htt&#x70;s://evil.tld/p.gif">'],
  ["srcset instead of src", '<img srcset="https://evil.tld/p.gif 2x">'],
  ["slash-separated attribute", '<img/src="https://evil.tld/p.gif">'],
  ["svg data URI", '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'],
];

for (const [name, payload] of EXTERNAL_SRC_SPELLINGS) {
  Deno.test(`email keeps no external src: ${name}`, () => {
    const out = email(payload);
    assertEquals(
      /evil\.tld/i.test(out),
      false,
      `external host survived in: ${out}`,
    );
    assertEquals(/src\s*=/i.test(out), false, `a src survived in: ${out}`);
  });
}

Deno.test("email keeps cid: images, the bytes are already in the message", () => {
  const out = email('<img src="cid:logo@example" alt="Logo">');
  assertStringIncludes(out, 'src="cid:logo@example"');
  assertStringIncludes(out, 'alt="Logo"');
});

Deno.test("email keeps inline base64 raster data: images", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const out = email(`<img src="${png}">`);
  assertStringIncludes(out, "data:image/png;base64,");
});

Deno.test("email drops data:image/svg+xml: SVG is a document, not a raster", () => {
  // The one image media type that can carry script. It is excluded from the
  // email src allow-list on purpose; this test is what says so out loud.
  const out = email('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  assertEquals(/svg/i.test(out), false, `svg data URI survived: ${out}`);
  assertInert(out, "svg data URI");
});

// ---------------------------------------------------------------------------
// 3. Signature policy: the one deliberate difference.
// ---------------------------------------------------------------------------

Deno.test("signature KEEPS https logos, the whole point of a rich signature", () => {
  const out = signature('<img src="https://cdn.example.com/logo.png" alt="Acme">');
  assertStringIncludes(out, 'src="https://cdn.example.com/logo.png"');
});

Deno.test("email DROPS the very https logo the signature keeps", () => {
  // Same input, two policies, opposite outcomes. This pair is the parameter.
  const input = '<img src="https://cdn.example.com/logo.png" alt="Acme">';
  assertStringIncludes(signature(input), "https://cdn.example.com/logo.png");
  assertEquals(email(input).includes("cdn.example.com"), false);
  // The alt text survives either way, so the reader still knows an image was there.
  assertStringIncludes(email(input), 'alt="Acme"');
});

Deno.test("signature still drops non-https image sources", () => {
  for (
    const bad of [
      '<img src="http://cdn.example.com/logo.png">',
      '<img src="ftp://cdn.example.com/logo.png">',
      '<img src="data:image/png;base64,AAAA">',
    ]
  ) {
    assertEquals(
      /src\s*=/i.test(signature(bad)),
      false,
      `non-https src survived: ${signature(bad)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The general allow-list properties.
// ---------------------------------------------------------------------------

Deno.test("every event handler is dropped, however it is spelled", () => {
  const payloads = [
    '<p onclick="alert(1)">x</p>',
    "<p ONCLICK=alert(1)>x</p>",
    "<p onclick = alert(1)>x</p>",
    "<p\nonmouseover=alert(1)>x</p>",
    '<p onfocus="alert(1)" autofocus>x</p>',
    "<img src=x onerror=alert(1)>",
    '<body onload="alert(1)">x</body>',
  ];
  for (const p of payloads) {
    assertInert(email(p), p);
  }
});

Deno.test("dangerous elements are dropped with their content", () => {
  for (
    const [payload, mustNotContain] of [
      ["<script>alert(1)</script>after", "alert"],
      ["<style>body{background:url(javascript:alert(1))}</style>after", "alert"],
      ['<iframe src="https://evil.tld"></iframe>after', "evil.tld"],
      ['<object data="https://evil.tld"></object>after', "evil.tld"],
      ['<form action="https://evil.tld"><input name=a></form>after', "evil.tld"],
      ["<svg><script>alert(1)</script></svg>after", "alert"],
      ["<noscript><img src=https://evil.tld/p.gif></noscript>after", "evil.tld"],
      ["<textarea><img src=x onerror=alert(1)></textarea>after", "alert"],
      ["<title><img src=x onerror=alert(1)></title>after", "alert"],
    ] as Array<[string, string]>
  ) {
    const out = email(payload);
    assertEquals(
      out.toLowerCase().includes(mustNotContain),
      false,
      `${mustNotContain} survived ${payload}: ${out}`,
    );
    // The text AFTER the dropped element must still be there: dropping a
    // subtree must not swallow the rest of the message.
    assertStringIncludes(out, "after");
  }
});

Deno.test("unknown elements unwrap: text survives, semantics do not", () => {
  const out = email("<marquee>scrolling <custom-el>text</custom-el></marquee>");
  assertStringIncludes(out, "scrolling ");
  assertStringIncludes(out, "text");
  assertEquals(out.includes("<marquee"), false);
  assertEquals(out.includes("<custom-el"), false);
});

Deno.test("comments are dropped, including conditional-comment payloads", () => {
  const out = email("a<!--[if IE]><script>alert(1)</script><![endif]-->b");
  assertEquals(out, "ab");
});

Deno.test("safe hrefs survive and carry rel", () => {
  const out = email('<a href="https://example.com/x?a=1&amp;b=2">link</a>');
  assertStringIncludes(out, 'href="https://example.com/x?a=1&amp;b=2"');
  assertStringIncludes(out, 'rel="noopener noreferrer nofollow"');
  assertStringIncludes(out, ">link</a>");
});

Deno.test("mailto survives; other schemes do not", () => {
  assertStringIncludes(email('<a href="mailto:a@b.com">m</a>'), "mailto:a@b.com");
  for (
    const bad of [
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a href="file:///etc/passwd">x</a>',
      '<a href="jAvAsCrIpT:alert(1)">x</a>',
      '<a href="java\u0000script:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
    ]
  ) {
    const out = email(bad);
    assertEquals(/href/i.test(out), false, `href survived: ${out}`);
    assertInert(out, bad);
  }
});

Deno.test("output is well-formed and idempotent", () => {
  // The output is rebuilt from a stack, not copied, so unclosed input comes back
  // closed and a second pass changes nothing. Idempotence matters because the
  // send path can sanitize a string that was already sanitized on read.
  const messy = "<div><p>one<p>two<div><span>three</div>";
  const once = email(messy);
  assertEquals(email(once), once);
  assertEquals((once.match(/<div>/g) ?? []).length, (once.match(/<\/div>/g) ?? []).length);
  assertEquals((once.match(/<p>/g) ?? []).length, (once.match(/<\/p>/g) ?? []).length);
});

Deno.test("an unterminated attribute quote cannot leak the rest of the document", () => {
  // A browser swallows everything after an unclosed quote into the value. If we
  // instead resynced at the next `>`, the swallowed markup would come back to
  // life as tags, which is how `<a href="x onmouseover=alert(1) y">` used to
  // round-trip through the deny-list with the handler still attached.
  const out = email('<a href="x onmouseover=alert(1)>hello');
  assertInert(out, "unterminated quote");
});

Deno.test("real-world mail keeps its structure", () => {
  const out = email(
    '<div dir="ltr"><p>Hi <strong>Asgeir</strong>,</p>' +
      '<p>See the <a href="https://example.com/report">report</a>.</p>' +
      "<table><tbody><tr><td colspan=\"2\">Q3</td><td>42</td></tr></tbody></table>" +
      "<blockquote>Previous message</blockquote></div>",
  );
  assertStringIncludes(out, '<div dir="ltr">');
  assertStringIncludes(out, "<strong>Asgeir</strong>");
  assertStringIncludes(out, 'href="https://example.com/report"');
  assertStringIncludes(out, '<td colspan="2">Q3</td>');
  assertStringIncludes(out, "<blockquote>Previous message</blockquote>");
});

Deno.test("text is escaped, and entities round-trip to the same rendering", () => {
  assertEquals(email("5 < 6 & 7 > 3"), "5 &lt; 6 &amp; 7 &gt; 3");
  // A named entity this file does not decode is re-emitted as `&amp;zzz;`,
  // which renders identically to the `&zzz;` the source had.
  assertEquals(email("&zzz;"), "&amp;zzz;");
  assertEquals(email("caf&eacute;"), "caf&amp;eacute;");
  assertEquals(email("A&amp;B"), "A&amp;B");
});

Deno.test("style and class never survive, on any element", () => {
  const out = email('<p style="color:red" class="x" id="y" data-z="1">text</p>');
  assertEquals(out, "<p>text</p>");
});

Deno.test("pathological nesting terminates and stays bounded", () => {
  const deep = "<div>".repeat(5000) + "boom" + "</div>".repeat(5000);
  const out = email(deep);
  assertStringIncludes(out, "boom");
  assert(out.length < deep.length, "output should not exceed pathological input");
});

Deno.test("empty and non-string inputs are handled", () => {
  assertEquals(email(""), "");
  assertEquals(email(null as unknown as string), "");
  assertEquals(email(undefined as unknown as string), "");
});

// ---------------------------------------------------------------------------
// 5. Cross-runtime parity with the Node twin.
// ---------------------------------------------------------------------------
//
// The Node twin at apps/web/src/lib/htmlSanitizer.js is a hand port, and hand
// ports drift. Reading the two files side by side is not evidence that they
// still agree; running the same bytes through both and diffing is.
//
// Deno imports the twin directly here: it is plain ESM with no Node built-ins,
// and this is a test file, so nothing about the deployed edge bundle changes.
// Both halves import the same corpus, so adding a payload in one place extends
// the parity check automatically.

import {
  EMAIL_HTML_POLICY as NODE_EMAIL_POLICY,
  sanitizeHtml as nodeSanitizeHtml,
  SIGNATURE_HTML_POLICY as NODE_SIGNATURE_POLICY,
} from "../../../apps/web/src/lib/htmlSanitizer.js";
import { ALL_PAYLOADS } from "../../../apps/web/src/lib/htmlSanitizer.payloads.mjs";

Deno.test("Deno and Node twins agree byte-for-byte on the whole corpus", () => {
  const mismatches: string[] = [];
  for (const [name, payload] of ALL_PAYLOADS as Array<[string, string]>) {
    const denoEmail = email(payload);
    const nodeEmail = nodeSanitizeHtml(payload, NODE_EMAIL_POLICY);
    if (denoEmail !== nodeEmail) {
      mismatches.push(
        `email/${name}\n  deno: ${JSON.stringify(denoEmail)}\n  node: ${
          JSON.stringify(nodeEmail)
        }`,
      );
    }
    const denoSig = signature(payload);
    const nodeSig = nodeSanitizeHtml(payload, NODE_SIGNATURE_POLICY);
    if (denoSig !== nodeSig) {
      mismatches.push(
        `signature/${name}\n  deno: ${JSON.stringify(denoSig)}\n  node: ${
          JSON.stringify(nodeSig)
        }`,
      );
    }
  }
  assertEquals(
    mismatches.length,
    0,
    `the twins have drifted:\n${mismatches.join("\n")}`,
  );
});

Deno.test("every payload is idempotent under both policies", () => {
  // The send path can sanitize a body that was already sanitized on read, and
  // the signature pass runs on rows the tool-side pass already cleaned. Output
  // that is not a fixpoint means the second pass changes bytes nobody asked it
  // to change.
  for (const [name, payload] of ALL_PAYLOADS as Array<[string, string]>) {
    const e1 = email(payload);
    assertEquals(email(e1), e1, `email/${name} not idempotent`);
    const s1 = signature(payload);
    assertEquals(signature(s1), s1, `signature/${name} not idempotent`);
  }
});

Deno.test("email is never more permissive than signature", () => {
  // Signature is the permissive one, by design: its author is the account owner
  // and its content is the user's own formatting. Email is a stranger's. If a
  // change ever lets an email body do something a signature cannot, that is
  // backwards and someone should have to notice.
  for (const tag of EMAIL_HTML_POLICY.allowedTags) {
    assert(
      SIGNATURE_HTML_POLICY.allowedTags.has(tag),
      `email allows <${tag}> but signature does not`,
    );
  }
  for (const attr of EMAIL_HTML_POLICY.globalAttrs) {
    assert(
      SIGNATURE_HTML_POLICY.globalAttrs.has(attr),
      `email allows [${attr}] but signature does not`,
    );
  }
  assertEquals(
    EMAIL_HTML_POLICY.hrefSchemes.source,
    SIGNATURE_HTML_POLICY.hrefSchemes.source,
  );
  // The two documented differences, asserted so neither can be quietly merged.
  assert(
    EMAIL_HTML_POLICY.srcSchemes.source !==
      SIGNATURE_HTML_POLICY.srcSchemes.source,
    "src policies must differ: email takes no external image, signature takes https logos",
  );
  assertEquals(EMAIL_HTML_POLICY.styleProps, null);
  assert(
    SIGNATURE_HTML_POLICY.styleProps !== null,
    "signature must keep filtered inline style; the editor emits all formatting that way",
  );
});
