// ---------------------------------------------------------------------------
// Node-side tests for the allow-list HTML sanitizer.
//
// The Deno twin (supabase/functions/mcp-server/html-sanitizer.test.ts) asserts
// the same properties against the same corpus. This suite additionally writes a
// snapshot of every output so the parity check in that suite can compare the
// two runtimes byte for byte. Hand-ported twins drift, and reading them side
// by side is not evidence that they still agree.
//
// Run: node --test apps/web/src/lib/htmlSanitizer.test.mjs
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_HTML_POLICY,
  sanitizeHtml,
  SIGNATURE_HTML_POLICY,
} from "./htmlSanitizer.js";
import {
  ALL_PAYLOADS,
  BYPASS_PAYLOADS,
  EXTERNAL_SRC_PAYLOADS,
} from "./htmlSanitizer.payloads.mjs";

const email = (html) => sanitizeHtml(html, EMAIL_HTML_POLICY);
const signature = (html) => sanitizeHtml(html, SIGNATURE_HTML_POLICY);

/**
 * A result is inert if nothing in it can execute or fetch.
 *
 * Note what is deliberately NOT asserted: the absence of the substring
 * "alert(". Payload text that survives as ESCAPED TEXT is a pass, not a fail.
 * `<scr<script>ipt>alert(1)</script>` correctly returns the text
 * `ipt&gt;alert(1)`, which renders as characters and executes nothing.
 * Grepping output for scary words is the same shape-matching that made the
 * deny-list look correct.
 */
function assertInert(out, label, policy = EMAIL_HTML_POLICY) {
  assert.equal(/\son[a-z]+\s*=/i.test(out), false, `${label}: handler: ${out}`);
  assert.equal(/javascript\s*:/i.test(out), false, `${label}: js scheme: ${out}`);
  assert.equal(/<script/i.test(out), false, `${label}: <script: ${out}`);
  assert.equal(/\ssrcset\s*=/i.test(out), false, `${label}: srcset: ${out}`);

  if (policy.styleProps === null) {
    // Email drops style entirely.
    assert.equal(/\sstyle\s*=/i.test(out), false, `${label}: style=: ${out}`);
  } else {
    // Signature KEEPS style, so assert the filter instead of the absence: every
    // surviving declaration must be an allow-listed property with a value that
    // cannot fetch or execute.
    for (const m of out.matchAll(/\sstyle="([^"]*)"/g)) {
      for (const decl of m[1].split(";")) {
        if (!decl.trim()) continue;
        const prop = decl.split(":")[0].trim();
        assert.ok(
          policy.styleProps.test(prop),
          `${label}: style property "${prop}" is not allow-listed: ${out}`,
        );
      }
      assert.equal(
        /url\s*\(|expression\s*\(|javascript:|@import/i.test(m[1]),
        false,
        `${label}: style value can fetch or execute: ${out}`,
      );
    }
  }

  for (const m of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
    assert.equal(
      policy.allowedTags.has(m[1].toLowerCase()),
      true,
      `${label}: non-allow-listed tag <${m[1]}> survived: ${out}`,
    );
  }
}

// ---- 1. the confirmed bypasses --------------------------------------------

for (const [name, payload] of BYPASS_PAYLOADS) {
  test(`bypass closed (email): ${name}`, () => {
    assertInert(email(payload), name);
  });
  test(`bypass closed (signature): ${name}`, () => {
    assertInert(signature(payload), name, SIGNATURE_HTML_POLICY);
  });
}

test("the strip-and-rescan splice leaves no tag at all", () => {
  assert.equal(email("<scr<script>ipt>alert(1)</script>").includes("<"), false);
});

test("a dropped href leaves the link text readable", () => {
  const out = email('<a href=" javascript:alert(1)">click</a>');
  assert.match(out, /click/);
  assert.equal(/href/i.test(out), false);
});

// ---- 2. email policy: no external src, ever -------------------------------

for (const [name, payload] of EXTERNAL_SRC_PAYLOADS) {
  test(`email keeps no external src: ${name}`, () => {
    const out = email(payload);
    assert.equal(/evil\.tld/i.test(out), false, `host survived: ${out}`);
    assert.equal(/src\s*=/i.test(out), false, `src survived: ${out}`);
  });
}

test("email keeps cid: images, the bytes are already in the message", () => {
  const out = email('<img src="cid:logo@example" alt="Logo">');
  assert.match(out, /src="cid:logo@example"/);
  assert.match(out, /alt="Logo"/);
});

test("email keeps inline base64 raster data: images", () => {
  assert.match(
    email('<img src="data:image/png;base64,iVBORw0KGgo=">'),
    /data:image\/png;base64,/,
  );
});

test("email drops data:image/svg+xml: SVG is a document, not a raster", () => {
  const out = email('<img src="data:image/svg+xml,<svg onload=alert(1)>">');
  assert.equal(/svg/i.test(out), false, `svg data URI survived: ${out}`);
  assertInert(out, "svg data URI");
});

// ---- 3. the one deliberate policy difference ------------------------------

test("email DROPS the very https logo the signature KEEPS", () => {
  const input = '<img src="https://cdn.example.com/logo.png" alt="Acme">';
  assert.match(signature(input), /src="https:\/\/cdn\.example\.com\/logo\.png"/);
  assert.equal(email(input).includes("cdn.example.com"), false);
  // The alt text survives either way, so a reader still knows an image was there.
  assert.match(email(input), /alt="Acme"/);
});

test("signature still drops non-https image sources", () => {
  for (const bad of [
    '<img src="http://cdn.example.com/logo.png">',
    '<img src="ftp://cdn.example.com/logo.png">',
    '<img src="data:image/png;base64,AAAA">',
  ]) {
    assert.equal(/src\s*=/i.test(signature(bad)), false, signature(bad));
  }
});

// ---- 4. general allow-list properties -------------------------------------

test("dangerous elements are dropped with their content, text after survives", () => {
  for (const [payload, banned] of [
    ["<script>alert(1)</script>after", "alert"],
    ["<style>body{background:url(javascript:alert(1))}</style>after", "alert"],
    ['<iframe src="https://evil.tld"></iframe>after', "evil.tld"],
    ['<form action="https://evil.tld"><input name=a></form>after', "evil.tld"],
    ["<svg><script>alert(1)</script></svg>after", "alert"],
    ["<textarea><img src=x onerror=alert(1)></textarea>after", "alert"],
    ["<title><img src=x onerror=alert(1)></title>after", "alert"],
  ]) {
    const out = email(payload);
    assert.equal(out.toLowerCase().includes(banned), false, `${banned}: ${out}`);
    assert.match(out, /after/, `content after the drop was swallowed: ${out}`);
  }
});

test("unknown elements unwrap: text survives, semantics do not", () => {
  const out = email("<marquee>scrolling <custom-el>text</custom-el></marquee>");
  assert.match(out, /scrolling /);
  assert.match(out, /text/);
  assert.equal(out.includes("<marquee"), false);
  assert.equal(out.includes("<custom-el"), false);
});

test("safe hrefs survive and carry rel", () => {
  const out = email('<a href="https://example.com/x?a=1&amp;b=2">link</a>');
  assert.match(out, /href="https:\/\/example\.com\/x\?a=1&amp;b=2"/);
  assert.match(out, /rel="noopener noreferrer nofollow"/);
});

test("output is well-formed and idempotent", () => {
  const once = email("<div><p>one<p>two<div><span>three</div>");
  assert.equal(email(once), once);
  assert.equal(
    (once.match(/<div>/g) ?? []).length,
    (once.match(/<\/div>/g) ?? []).length,
  );
});

test("text is escaped and entities round-trip to the same rendering", () => {
  assert.equal(email("5 < 6 & 7 > 3"), "5 &lt; 6 &amp; 7 &gt; 3");
  assert.equal(email("&zzz;"), "&amp;zzz;");
  assert.equal(email("A&amp;B"), "A&amp;B");
});

test("style, class, id and data-* never survive", () => {
  assert.equal(
    email('<p style="color:red" class="x" id="y" data-z="1">text</p>'),
    "<p>text</p>",
  );
});

test("pathological nesting terminates and stays bounded", () => {
  const deep = "<div>".repeat(5000) + "boom" + "</div>".repeat(5000);
  const out = email(deep);
  assert.match(out, /boom/);
  assert.ok(out.length < deep.length);
});

test("empty and non-string inputs are handled", () => {
  assert.equal(email(""), "");
  assert.equal(email(null), "");
  assert.equal(email(undefined), "");
  assert.equal(email(12345), "");
});

// ---- 5. the whole corpus is inert -----------------------------------------

test("no payload in the shared corpus produces anything executable", () => {
  // Cheap, but it is the property that matters, applied to every input we have
  // rather than to the handful each named test happens to cover.
  for (const [name, payload] of ALL_PAYLOADS) {
    assertInert(email(payload), `email/${name}`);
    assertInert(signature(payload), `signature/${name}`, SIGNATURE_HTML_POLICY);
  }
});

test("every payload is idempotent under both policies", () => {
  // Not cosmetic. The send path can sanitize a body that was already sanitized
  // on read, and the signature pass runs on rows the tool-side pass already
  // cleaned. A sanitizer whose output is not a fixpoint means the second pass
  // changes bytes nobody asked it to change, which is exactly how the
  // `</td><tr>` -> `</td></tr><tr>` drift on live PayPal and AdMob mail was
  // caught.
  for (const [name, payload] of ALL_PAYLOADS) {
    const e1 = email(payload);
    assert.equal(email(e1), e1, `email/${name} not idempotent: ${e1}`);
    const s1 = signature(payload);
    assert.equal(signature(s1), s1, `signature/${name} not idempotent: ${s1}`);
  }
});

test("no payload leaves an unbalanced tag", () => {
  for (const [name, payload] of ALL_PAYLOADS) {
    const out = email(payload);
    const opens = [...out.matchAll(/<([a-z0-9]+)(?=[\s>])/g)].map((m) => m[1]);
    const closes = [...out.matchAll(/<\/([a-z0-9]+)>/g)].map((m) => m[1]);
    for (const tag of new Set(closes)) {
      assert.ok(
        opens.filter((t) => t === tag).length >=
          closes.filter((t) => t === tag).length,
        `${name}: more </${tag}> than <${tag}>: ${out}`,
      );
    }
  }
});

// The cross-runtime parity comparison lives in the Deno suite
// (supabase/functions/mcp-server/html-sanitizer.test.ts), which imports THIS
// module directly and diffs its output against the edge twin's on the same
// corpus. Doing it there keeps it in one place and in one process, with no
// snapshot file and no dependency on which test runner went first.
