// ---------------------------------------------------------------------------
// Signature sanitizer suite (Node)
//
// Run with: npm run test:sanitizer
//
// Two modules are under test and both matter:
//   - ./sanitizeSignatureHtmlServer.js is the dependency-free ALLOW-LIST
//     sanitizer the PATCH route runs. It is the one that decides what gets
//     STORED, so it is the one the attack corpus is aimed at.
//   - ./sanitizeSignatureHtml.js is the DOMPurify wrapper. Under Node there is
//     no window, so it delegates to the server module — which is exactly the
//     SSR path that must never drag jsdom in (ERR_REQUIRE_ESM, the incident
//     that 500'd every signature save in production).
//
// The corpus below is duplicated, deliberately, in
// supabase/functions/mcp-server/signature-sanitizer.test.ts so the Deno twin is
// held to the same bar. If you add a payload here, add it there.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeSignatureHtml } from './sanitizeSignatureHtml.js';
import {
  sanitizeSignatureHtml as sanitizeServer,
  SIGNATURE_HTML_MAX_LENGTH,
} from './sanitizeSignatureHtmlServer.js';

// ---------------------------------------------------------------------------
// Shared expectations
// ---------------------------------------------------------------------------

/**
 * Everything that must never appear in sanitizer output, whatever went in.
 * Asserting on the OUTPUT rather than on "did it strip the thing I expected"
 * is the point: a deny-list passes the second kind of test right up until
 * someone finds the quirk it forgot.
 */
function residue(html) {
  const lower = html.toLowerCase();
  const found = [];
  if (/\son[a-z]+\s*=/.test(lower)) found.push('event handler attribute');
  if (lower.includes('javascript:')) found.push('javascript: scheme');
  if (lower.includes('vbscript:')) found.push('vbscript: scheme');
  if (lower.includes('data:')) found.push('data: scheme');
  if (lower.includes('<script')) found.push('<script');
  if (lower.includes('<iframe')) found.push('<iframe');
  if (lower.includes('<svg')) found.push('<svg');
  if (lower.includes('<object')) found.push('<object');
  if (lower.includes('<form')) found.push('<form');
  if (lower.includes('<style')) found.push('<style');
  if (lower.includes('<base')) found.push('<base');
  if (lower.includes('<meta')) found.push('<meta');
  if (lower.includes('<textarea')) found.push('<textarea');
  if (lower.includes('expression(')) found.push('expression(');
  if (/url\s*\(/.test(lower)) found.push('css url(');
  if (lower.includes('srcdoc')) found.push('srcdoc');
  if (lower.includes('formaction')) found.push('formaction');
  if (lower.includes('xlink:href')) found.push('xlink:href');
  return found;
}

const NUL = "\u0000";

/**
 * The four payloads that were VERIFIED to survive the old regex deny-list,
 * plus the nested-tag evasion the edge copy's single pass let through, plus
 * the neighbouring tricks each of them belongs to. Each entry is
 * [label, payload].
 */
const ATTACKS = [
  // --- the four confirmed bypasses of the old deny-list ---------------------
  // 1. The on*= regex required \s+ before the handler. A closing quote ends the
  //    previous attribute just as well as a space does.
  ['bypass 1: quote, not space, before handler', '<img/src="https://a/b"onerror=alert(1)>'],
  // 2. Leading whitespace inside the quoted value; browsers trim before navigating.
  ['bypass 2: leading space in quoted href', '<a href=" javascript:alert(1)">x</a>'],
  // 3. Browsers decode entities in attribute values; the regex read raw bytes.
  ['bypass 3: hex entity in scheme', '<a href="jav&#x61;script:alert(1)">x</a>'],
  // 4. Style-based scheme, not covered by the deny-list at all.
  ['bypass 4: css url() scheme', '<div style="background:url(javascript:alert(1))">x</div>'],
  // 5. Nested-tag evasion: only survived the edge copy, which ran one pass.
  ['nested tag evasion', '<scr<script>ipt>alert(1)</script>'],

  // --- the same tricks, one turn further ------------------------------------
  ['double nested tag evasion', '<scr<scr<script>ipt>ipt>alert(1)</script>'],
  ['classic script block', '<p>hi<script>alert(1)</script></p>'],
  ['unclosed script runs to EOF', '<script>alert(1)'],
  ['script hidden in a tag name', '<div <script>alert(1)</script>>x</div>'],
  ['svg onload', '<svg/onload=alert(1)>'],
  ['uppercase tag and handler', '<IMG SRC="https://a/b" ONERROR="alert(1)">'],
  ['named entity colon', '<a href="javascript&colon;alert(1)">x</a>'],
  ['entity we do not decode', '<a href="javascript&NotARealEntity;alert(1)">x</a>'],
  ['tab inside the scheme', '<a href="java\tscript:alert(1)">x</a>'],
  ['newline inside the scheme', '<a href="java\nscript:alert(1)">x</a>'],
  ['null byte inside the scheme', `<a href="java${NUL}script:alert(1)">x</a>`],
  ['decimal entity in scheme', '<a href="&#106;avascript:alert(1)">x</a>'],
  ['decimal entity, no semicolon', '<a href="&#106avascript:alert(1)">x</a>'],
  ['mixed case scheme', '<a href="JaVaScRiPt:alert(1)">x</a>'],
  ['vbscript scheme', '<a href="vbscript:msgbox(1)">x</a>'],
  ['duplicate href, poison second', '<a href="https://ok.example" href="javascript:alert(1)">x</a>'],
  ['data: image source', '<img src="data:text/html,<script>alert(1)</script>">'],
  ['plaintext http image', '<img src="http://insecure.example/logo.png">'],
  ['style expression()', '<div style="width:expression(alert(1))">x</div>'],
  ['style behavior', '<div style="behavior:url(#default#time2)">x</div>'],
  ['style -moz-binding', '<div style="-moz-binding:url(https://evil.example/x.xml)">x</div>'],
  ['style css escape', '<div style="background:\\75 rl(javascript:alert(1))">x</div>'],
  ['style entity-encoded url', '<div style="background:&#117;rl(javascript:alert(1))">x</div>'],
  ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['form and button handler', '<form action="https://evil.example"><button onclick="alert(1)">go</button></form>'],
  ['object data scheme', '<object data="javascript:alert(1)"></object>'],
  ['comment smuggling', '<!--<a href="javascript:alert(1)">--><b>ok</b>'],
  ['bogus comment', '<!<a href="javascript:alert(1)">'],
  ['textarea smuggling', '<textarea><img src=x onerror=alert(1)></textarea>'],
  ['noscript smuggling', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['base tag', '<base href="https://evil.example/"><a href="https://ok.example">x</a>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['xlink:href', '<a xlink:href="javascript:alert(1)">x</a>'],
  ['formaction', '<button formaction="javascript:alert(1)">x</button>'],
  ['autofocus onfocus', '<p onfocus=alert(1) autofocus tabindex=1>x</p>'],
  ['backtick quoted src', '<img src=`https://a/b` onerror=alert(1)>'],
  ['unquoted handler', '<div onmouseover=alert(1)>x</div>'],
  ['plaintext swallows the rest', '<plaintext><img src=x onerror=alert(1)>'],
  ['deep nesting', `${'<div>'.repeat(300)}deep${'</div>'.repeat(300)}`],
];

/**
 * Legitimate signatures. Each entry is [label, payload, fragments that MUST
 * survive]. A sanitizer that breaks these is not shippable however safe it is.
 */
const LEGIT = [
  [
    'bold, italic, link',
    '<p><strong>Jane Doe</strong> &mdash; <em>Head of Support</em><br><a href="https://mcpemails.com" target="_blank">mcpemails.com</a></p>',
    ['<strong>Jane Doe</strong>', '<em>Head of Support</em>', '<br>', 'href="https://mcpemails.com"', 'rel="noopener noreferrer"', '&mdash;'],
  ],
  [
    'mailto link',
    '<p>Email <a href="mailto:jane@example.com">jane@example.com</a></p>',
    ['href="mailto:jane@example.com"', 'jane@example.com</a>'],
  ],
  [
    'table',
    '<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td style="padding: 4px; color: #333">Jane</td></tr></tbody></table>',
    ['<table>', '<thead>', '<th>Name</th>', '<tbody>', 'padding: 4px', 'color: #333', 'Jane'],
  ],
  [
    'https hosted logo',
    '<p><img src="https://cdn.example.com/logo.png" alt="Acme" width="120" height="40"></p>',
    ['<img src="https://cdn.example.com/logo.png"', 'alt="Acme"', 'width="120"', 'height="40"'],
  ],
  [
    'font colour',
    '<font color="#ff6600" size="3">Acme Corp</font>',
    ['<font color="#ff6600">', 'Acme Corp'],
  ],
  [
    'multi-paragraph signature',
    '<p>Jane Doe</p><p>Acme Corp</p><blockquote>We ship on Fridays.</blockquote><hr><ul><li>One</li><li>Two</li></ul>',
    ['<p>Jane Doe</p>', '<p>Acme Corp</p>', '<blockquote>We ship on Fridays.</blockquote>', '<hr>', '<li>One</li>', '<li>Two</li>'],
  ],
  [
    'url with query string',
    '<a href="https://example.com/x?a=1&amp;b=2">link</a>',
    ['href="https://example.com/x?a=1&amp;b=2"'],
  ],
  [
    'entities in text are left alone',
    '<p>Jane&nbsp;Doe &copy; 2026 &amp; friends</p>',
    ['&nbsp;', '&copy;', '&amp;'],
  ],
  [
    'angle brackets in prose',
    '<p>a &lt; b and 3 > 2</p>',
    ['a &lt; b', '3 &gt; 2'],
  ],
  [
    'alignment and fonts',
    '<div align="center" style="text-align: center; font-family: Arial, sans-serif">Acme</div>',
    ['align="center"', 'text-align: center', 'font-family: Arial, sans-serif'],
  ],
  [
    'rgb() colour',
    '<span style="color: rgb(12, 34, 56)">x</span>',
    ['color: rgb(12, 34, 56)'],
  ],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('shared signature sanitizer imports and runs without jsdom during SSR', () => {
  const clean = sanitizeSignatureHtml(
    '<p onclick="alert(1)">Hello<script>alert(1)</script><a href="javascript:alert(1)">link</a></p>',
  );

  assert.equal(clean.includes('<script'), false);
  assert.equal(clean.includes('onclick'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.match(clean, /Hello/);
});

test('every attack payload is neutralised', () => {
  for (const [label, payload] of ATTACKS) {
    const clean = sanitizeServer(payload);
    assert.deepEqual(
      residue(clean),
      [],
      `${label}: executable residue survived\n  in:  ${payload}\n  out: ${clean}`,
    );
  }
});

test('the four confirmed deny-list bypasses are dead', () => {
  // Spelled out one by one, with the exact expectations, so a regression names
  // itself instead of showing up as "one of 40 payloads failed".
  assert.equal(sanitizeServer('<img/src="https://a/b"onerror=alert(1)>'), '<img src="https://a/b">');
  assert.equal(sanitizeServer('<a href=" javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeServer('<a href="jav&#x61;script:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeServer('<div style="background:url(javascript:alert(1))">x</div>'), '<div>x</div>');
});

test('nested-tag evasion cannot reassemble a script element', () => {
  // In the spec's tag-name state `<` is an ordinary name character, so this is
  // ONE unknown tag named `scr<script` — exactly what a browser sees. The
  // allow-list drops it and the tail is escaped as text.
  const clean = sanitizeServer('<scr<script>ipt>alert(1)</script>');
  assert.equal(clean.toLowerCase().includes('<script'), false);
  assert.equal(clean.includes('<'), false);
  assert.match(clean, /ipt&gt;alert\(1\)/);
});

test('legitimate signatures are not broken', () => {
  for (const [label, payload, fragments] of LEGIT) {
    const clean = sanitizeServer(payload);
    for (const fragment of fragments) {
      assert.ok(
        clean.includes(fragment),
        `${label}: expected ${JSON.stringify(fragment)} to survive\n  in:  ${payload}\n  out: ${clean}`,
      );
    }
    assert.deepEqual(residue(clean), [], `${label}: clean input produced residue: ${clean}`);
  }
});

test('an img without a usable https source is removed entirely', () => {
  assert.equal(sanitizeServer('<p><img src="http://x/y.png"></p>'), '<p></p>');
  assert.equal(sanitizeServer('<p><img></p>'), '<p></p>');
  assert.equal(
    sanitizeServer('<p><img src="https://x/y.png"></p>'),
    '<p><img src="https://x/y.png"></p>',
  );
});

test('output is idempotent — sanitizing twice changes nothing', () => {
  // The edge function re-sanitizes stored HTML at send time, so a second pass
  // over our own output must be a no-op or signatures would erode on every send.
  for (const [, payload] of [...ATTACKS, ...LEGIT.map(([l, p]) => [l, p])]) {
    const once = sanitizeServer(payload);
    assert.equal(sanitizeServer(once), once, `not idempotent for: ${payload}`);
  }
});

test('empty string round-trips without throwing', () => {
  // The PATCH route relies on this: `signature_html: ''` is a deliberate clear.
  assert.equal(sanitizeServer(''), '');
  assert.equal(sanitizeSignatureHtml(''), '');
});

test('non-string input throws', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.throws(
      () => sanitizeServer(value),
      /input must be a string/,
      `expected a throw for ${JSON.stringify(value)}`,
    );
  }
});

test('oversize output throws rather than storing truncated markup', () => {
  // Truncating HTML mid-tag would store broken markup, so the contract is a
  // throw; the PATCH route turns it into a 400 "Signature is too large."
  const huge = `<p>${'a'.repeat(SIGNATURE_HTML_MAX_LENGTH + 1)}</p>`;
  assert.throws(() => sanitizeServer(huge), /exceeds 102400 limit/);

  // Just under the limit is fine.
  const fine = `<p>${'a'.repeat(SIGNATURE_HTML_MAX_LENGTH - 100)}</p>`;
  assert.equal(sanitizeServer(fine).length, SIGNATURE_HTML_MAX_LENGTH - 93);
});
