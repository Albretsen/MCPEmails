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
  preferredBodyText,
  previewFromBodyPartSource,
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

Deno.test("a snippet truncated mid-tag does not leak the tag fragment", () => {
  // IMAP returns a partial body, so the snippet can stop inside a tag. <[^>]+>
  // needs a closing > and cannot match that.
  assertEquals(
    normalizeSnippetPreview("<p>Review them below:</p><table class"),
    "Review them below:",
    "the dangling fragment must go",
  );
  // Known limitation, asserted so it is a decision and not a surprise: a bare
  // `<` in prose is swallowed along with everything up to the next `>`, because
  // <[^>]+> cannot tell prose from markup. It predates this module and fixing
  // it needs a real parser, which a 200-character triage line does not justify.
  assertEquals(
    normalizeSnippetPreview("<div>Total: 4 < 5 items</div>"),
    "Total: 4",
    "documents the bare-< limitation rather than pretending it is handled",
  );
});

// ── Which body actually reaches the model ───────────────────────────────────

Deno.test("an empty text/plain part falls back to the HTML", () => {
  // Observed on real mail: Intercom and most ticketing systems send a
  // multipart/alternative whose text part is "". `??` kept that empty string,
  // so body_text arrived blank next to a full body_html and the agent had to
  // re-read with include_html to find any content at all.
  assertEquals(
    preferredBodyText("", "<p>Ticket #123 received.</p>"),
    "Ticket #123 received.",
    "empty text part must not win over real HTML",
  );
});

Deno.test("a whitespace-only text part also falls back", () => {
  assertEquals(
    preferredBodyText("\r\n  \r\n", "<p>Real content.</p>"),
    "Real content.",
    "whitespace carries no more information than absence",
  );
});

Deno.test("a real text part is preferred over the HTML", () => {
  assertEquals(
    preferredBodyText("The sender's own plain text.", "<p>Converted.</p>"),
    "The sender's own plain text.",
    "never second-guess a sender who supplied plain text",
  );
});

Deno.test("null text with HTML converts, and null both stays null", () => {
  assertEquals(preferredBodyText(null, "<p>Hi.</p>"), "Hi.", "null falls back too");
  assertEquals(preferredBodyText(null, null), null, "nothing in, nothing out");
});

Deno.test("HTML that converts to nothing does not mask the original", () => {
  // A tracking-pixel-only body converts to "". Returning that is correct, but
  // it must not be mistaken for a successful conversion of real content.
  assertEquals(preferredBodyText("", '<img src="p.gif">'), "", "stays empty, not null");
});

Deno.test("a table-built body does not arrive as runs of blank lines", () => {
  // Every layout cell contributes its own line break. Real mail measured about
  // half its body as "\r\n \r\n" runs carrying nothing.
  const html = "<table><tr><td>Ticket 42</td></tr>\r\n<tr><td>  </td></tr>\r\n" +
    "<tr><td>  </td></tr>\r\n<tr><td>Submitted</td></tr></table>";
  const out = stripHtmlToText(html);
  assert(!/\n\s*\n\s*\n/.test(out), `blank-line run survived: ${JSON.stringify(out)}`);
  assert(out.includes("Ticket 42") && out.includes("Submitted"), `content lost: ${out}`);
});

Deno.test("CRLF is normalised so line rules can see boundaries", () => {
  assertEquals(stripHtmlToText("<p>a</p>\r\n\r\n\r\n<p>b</p>").includes("\r"), false, "no CR survives");
});

// ── F-03: the preview that was raw MIME ─────────────────────────────────────
//
// Every fixture below is the source of ONE fetched body part, exactly as
// `BODY.PEEK[1]<0.2048>` hands it over: the bytes of part one, with none of the
// headers that declare what part one is. The boundary and the message text are
// lifted from the 2026-09-20 functional run that found the bug, where
// `[MCPE-TEST-20260920-1501] F3 attach` previewed as its own MIME framing while
// `email_read action:"read"` returned the body perfectly.

const ALT_BOUNDARY = "mcpe_alt_08cb43e0fcbb4d2187a8ae7132385ee7";
const F3_TEXT =
  "F3 attachment fixture. Sentinel: F3-BODY-MARKER-CCC333. Two attachments.";

/** UTF-8 to base64, wrapped at 76 columns, exactly as mime-build.ts writes it. */
function b64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

function part(contentType: string, body: string): string[] {
  return [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", "", body, ""];
}

/** The multipart/alternative that mime-build.ts nests inside multipart/mixed. */
function nestedAlternative(text: string, html: string, boundary = ALT_BOUNDARY): string {
  return [
    `--${boundary}`,
    ...part("text/plain; charset=UTF-8", b64Lines(text)),
    `--${boundary}`,
    ...part("text/html; charset=UTF-8", b64Lines(html)),
    `--${boundary}--`,
  ].join("\r\n");
}

/** The properties that make a preview a preview rather than a dump of the wire. */
function assertNoMimeLeak(preview: string): void {
  assert(!preview.includes("mcpe_"), `boundary leaked: ${preview}`);
  assert(!/--[A-Za-z0-9_]{8,}/.test(preview), `delimiter leaked: ${preview}`);
  assert(
    !/content-(type|transfer-encoding|disposition)/i.test(preview),
    `header line leaked: ${preview}`,
  );
  assert(!/[A-Za-z0-9+/]{40,}/.test(preview), `base64 run leaked: ${preview}`);
}

Deno.test("a multipart/alternative fetched as part one previews as its text", () => {
  const preview = previewFromBodyPartSource(
    nestedAlternative(F3_TEXT, "<p>F3 attachment fixture.</p>"),
  );
  assertEquals(preview, F3_TEXT, "the decoded text/plain part, and nothing else");
  assertNoMimeLeak(preview);
});

Deno.test("the 2KB cut through a base64 part does not spill the alphabet", () => {
  // The real fetch is <0.2048>, which lands mid-quantum in the middle of the
  // first part. `atob` throws on that, and the old fallback handed the base64
  // back as if it were prose.
  const long = `${F3_TEXT} ` + "Body line for the truncation fixture. ".repeat(60);
  const truncated = nestedAlternative(long, "<p>ignored</p>").slice(0, 2048);
  const preview = previewFromBodyPartSource(truncated);
  assert(preview.startsWith(F3_TEXT), `lost the start of the body: ${preview}`);
  assertNoMimeLeak(preview);
});

Deno.test("the descent is not depth-limited", () => {
  // multipart/related wrapping the alternative: two levels below the part that
  // was actually fetched. A generator that only looks one level down is a
  // generator that breaks again the next time a sender nests deeper.
  const inner = nestedAlternative(F3_TEXT, "<p>F3 attachment fixture.</p>");
  const source = [
    "--mcpe_rel_1111",
    `Content-Type: multipart/alternative; boundary="${ALT_BOUNDARY}"`,
    "",
    inner,
    "",
    "--mcpe_rel_1111--",
  ].join("\r\n");
  const preview = previewFromBodyPartSource(source);
  assertEquals(preview, F3_TEXT, "two levels of nesting is still the same answer");
  assertNoMimeLeak(preview);
});

Deno.test("an HTML-only nested part falls back to the stripped HTML", () => {
  const source = [
    `--${ALT_BOUNDARY}`,
    ...part("text/html; charset=UTF-8", b64Lines("<p>Invoice&nbsp;42 is ready.</p>")),
    `--${ALT_BOUNDARY}--`,
  ].join("\r\n");
  const preview = previewFromBodyPartSource(source);
  assertEquals(preview, "Invoice 42 is ready.", "the HTML part, converted to text");
  assertNoMimeLeak(preview);
});

Deno.test("the HTML fallback does not spend the preview budget on link targets", () => {
  // body_text keeps the URLs on purpose; a 200-character triage line cannot
  // afford one, let alone the four a marketing template carries.
  const html = '<p>Your invoice is <a href="https://billing.example.com/i/42?t=abcdef">ready</a>.</p>';
  const source = [
    `--${ALT_BOUNDARY}`,
    ...part("text/html; charset=UTF-8", b64Lines(html)),
    `--${ALT_BOUNDARY}--`,
  ].join("\r\n");
  assertEquals(
    previewFromBodyPartSource(source),
    "Your invoice is ready.",
    "the text, without the target",
  );
});

Deno.test("a nested part carrying no text at all previews as empty, not as bytes", () => {
  const source = [
    `--${ALT_BOUNDARY}`,
    "Content-Type: image/png; name=\"logo.png\"",
    "Content-Disposition: attachment; filename=\"logo.png\"",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines("x".repeat(400)),
    "",
    `--${ALT_BOUNDARY}--`,
  ].join("\r\n");
  assertEquals(previewFromBodyPartSource(source), "", "no text in, nothing out");
});

Deno.test("a leaf base64 text part still previews (the case that always worked)", () => {
  assertEquals(
    previewFromBodyPartSource(b64Lines(F3_TEXT)),
    F3_TEXT,
    "the leaf path this fix must not regress",
  );
});

Deno.test("a leaf quoted-printable part still decodes", () => {
  assertEquals(
    previewFromBodyPartSource("Karin p=C3=A5 Teknikkdeler sendte deg en=\r\n faktura."),
    "Karin på Teknikkdeler sendte deg en faktura.",
    "soft line break joined, =XX decoded",
  );
});

Deno.test("a plain body whose line starts with -- is not mistaken for a multipart", () => {
  // The signature separator is RFC 3676's, not a boundary. The guard is that a
  // delimiter must be followed by something shaped like a MIME header field.
  const body = "Thanks, that works for me.\r\n\r\n-- \r\nKarin\r\nTeknikkdeler AS";
  const preview = previewFromBodyPartSource(body);
  assert(preview.startsWith("Thanks, that works for me."), `body mangled: ${preview}`);
  assert(preview.includes("Karin"), `signature dropped: ${preview}`);
});
