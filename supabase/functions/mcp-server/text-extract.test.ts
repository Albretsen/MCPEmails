// ---------------------------------------------------------------------------
// What we ship as `preview` and `body_text`.
//
// Every payload below is the shape of real mail, not an illustration. The
// zero-width runs are what a marketing preheader actually contains, the
// conditional comment is what Word pastes into an Office-authored template,
// and the entity soup is copied from a production preview.
//
// These are cost assertions as much as correctness ones: each case used to
// spend the whole 200-character preview budget, or a few hundred body bytes,
// on content carrying no information at all.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  decodeHtmlEntities,
  normalizePreview,
  normalizeSnippetPreview,
  stripHtmlToText,
} from "./text-extract.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// ── The headline bug ────────────────────────────────────────────────────────

Deno.test("preview of pure zero-width padding collapses to empty", () => {
  // A preheader padded so the sender's mail client shows one tidy line. The old
  // /\s+/ never matched these, so `.slice(0, 200)` returned 200 characters of
  // nothing and that was the entire preview.
  const padded = "‌".repeat(400);
  assertEquals(normalizePreview(padded), "", "padding must not survive");
});

Deno.test("padding before real text does not consume the budget", () => {
  const padded = "‌​".repeat(300) + "Your receipt is attached.";
  assertEquals(
    normalizePreview(padded),
    "Your receipt is attached.",
    "the real sentence must survive the cap",
  );
});

Deno.test("every zero-width and bidi character in the class is stripped", () => {
  for (const ch of ["​", "‌", "‍", "‎", "‏"]) {
    const cp = ch.codePointAt(0)!.toString(16);
    assertEquals(
      normalizePreview(`a${ch}b`),
      "ab",
      `U+${cp.toUpperCase()} must be stripped from a preview`,
    );
  }
});

Deno.test("the 200 character cap is enforced after cleaning, not before", () => {
  const out = normalizePreview("‌".repeat(500) + "x".repeat(500));
  assertEquals(out.length, 200, "cap still applies");
  assertEquals(out, "x".repeat(200), "and applies to real text");
});

// ── Entities ────────────────────────────────────────────────────────────────

Deno.test("nbsp decodes to a collapsible space", () => {
  // Observed verbatim in production: six bytes on the wire for one space.
  assertEquals(
    normalizePreview("quarantined&nbsp;by&nbsp;your&nbsp;administrator"),
    "quarantined by your administrator",
    "&nbsp; must decode",
  );
});

Deno.test("numeric entities decode, decimal and hex", () => {
  assertEquals(decodeHtmlEntities("caf&#233;"), "café", "decimal");
  assertEquals(decodeHtmlEntities("caf&#xe9;"), "café", "hex");
});

Deno.test("decoding does not reintroduce markup", () => {
  // One pass only: &amp;lt; must decode to the literal text &lt; and stop.
  assertEquals(decodeHtmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;", "no rescan");
});

Deno.test("unknown entities are left alone rather than guessed", () => {
  assertEquals(decodeHtmlEntities("A&notarealentity;B"), "A&notarealentity;B", "left as written");
});

Deno.test("entity-encoded padding is decoded then stripped", () => {
  assertEquals(normalizePreview("&zwnj;&zwnj;Sale ends today"), "Sale ends today", "decode then strip");
});

// ── HTML to text ────────────────────────────────────────────────────────────

Deno.test("Office conditional comments do not leak their contents", () => {
  const html = `<html><!--[if gte mso 9]><xml><w:WordDocument>` +
    `<w:View>Normal</w:View><w:Zoom>96</w:Zoom></w:WordDocument></xml><![endif]-->` +
    `<body><p>Meeting moved to 3pm.</p></body></html>`;
  const out = stripHtmlToText(html);
  assert(!out.includes("Normal"), `Word view setting leaked: ${out}`);
  assert(!out.includes("96"), `Word zoom setting leaked: ${out}`);
  assertEquals(out, "Meeting moved to 3pm.", "and the real sentence survives");
});

Deno.test("a comment containing > does not leak raw CSS", () => {
  // The old <[^>]+> could not see past the > inside the media query, so every
  // responsive template leaked its stylesheet into body_text.
  const html = `<!--[if !mso]><!--><style>@media (max-width:600px){` +
    `.wrap > .col{width:100%!important}}</style><!--<![endif]-->` +
    `<div>Your code is 481920.</div>`;
  const out = stripHtmlToText(html);
  assert(!out.includes("max-width"), `CSS leaked: ${out}`);
  assert(!out.includes("!important"), `CSS leaked: ${out}`);
  assert(out.includes("481920"), `the OTP must survive: ${out}`);
});

Deno.test("style and script blocks are dropped with their contents", () => {
  const html = `<style>body{color:red}</style><script>var x=1;</script><p>Hi.</p>`;
  assertEquals(stripHtmlToText(html), "Hi.", "only the prose remains");
});

Deno.test("link targets survive when asked for", () => {
  const html = `<p>See <a href="https://example.com/invoice/42">the invoice</a>.</p>`;
  const out = stripHtmlToText(html, { keepLinks: true });
  assert(
    out.includes("https://example.com/invoice/42"),
    `the URL must survive so the model need not re-read with include_html: ${out}`,
  );
});

Deno.test("a link is not duplicated when the text already shows it", () => {
  const html = `<a href="https://example.com/x">https://example.com/x</a>`;
  const out = stripHtmlToText(html, { keepLinks: true });
  assertEquals(out, "https://example.com/x", "shown once, not twice");
});

Deno.test("an empty anchor leaves no naked tracking URL", () => {
  const html = `<p>Hello.</p><a href="https://track.example.com/o/aaaa/bbbb/cccc"><img src="p.gif"></a>`;
  const out = stripHtmlToText(html, { keepLinks: true });
  assert(!out.includes("track.example.com"), `tracking pixel URL leaked: ${out}`);
  assertEquals(out.trim(), "Hello.", "only the prose remains");
});

Deno.test("bodies keep their bidi marks", () => {
  // Removing these from prose silently corrupts Hebrew, Arabic, Persian and
  // Urdu. Previews are a scanned line and drop them; bodies are not.
  const out = stripHtmlToText("<p>‏שלום‎</p>");
  assert(out.includes("‏"), "RLM must survive in a body");
  assert(out.includes("‎"), "LRM must survive in a body");
});

Deno.test("bodies still lose zero-width padding", () => {
  const out = stripHtmlToText("<p>" + "‌".repeat(200) + "Real text.</p>");
  assertEquals(out, "Real text.", "padding is never meaningful");
});

// ── The IMAP snippet path ───────────────────────────────────────────────────

Deno.test("snippet previews strip tags before decoding", () => {
  // Tags first, or a decoded < could become one.
  assertEquals(
    normalizeSnippetPreview("<div>Hi &amp; welcome</div>"),
    "Hi & welcome",
    "tags out, entity decoded",
  );
  assertEquals(
    normalizeSnippetPreview("<p>a</p>&lt;script&gt;"),
    "a <script>",
    "a decoded angle bracket stays text",
  );
});

Deno.test("snippet previews clean padding before the cap", () => {
  // This is the ordering bug in the IMAP client: capping at 200 first meant a
  // padded preheader reached the caller as 200 characters that cleaned to
  // nothing, so the preview was empty rather than merely wasteful.
  const snippet = "<div>" + "‌".repeat(500) + "Invoice 8842 is ready.</div>";
  assertEquals(
    normalizeSnippetPreview(snippet),
    "Invoice 8842 is ready.",
    "the sentence must survive the cap",
  );
});
