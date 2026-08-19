// ---------------------------------------------------------------------------
// Turning untrusted mail into the text we actually ship.
//
// Two fields come out of this module: `preview` on every email summary, and
// `body_text` on every read. Both were leaking, and both leaks cost tokens for
// content that carries no information at all:
//
//   - Zero-width padding. Senders fill the hidden preheader div with hundreds
//     of U+200C so their mail client shows one tidy line. JS `\s` stops at
//     U+200A, so the old `text.replace(/\s+/g, " ")` left every one of them in
//     place and `.slice(0, 200)` then spent the whole preview budget on them.
//   - Undecoded entities. `&nbsp;` shipped verbatim: six bytes for one space,
//     eight of them in a single observed production preview.
//   - HTML comments. There was no comment rule at all, so a conditional comment
//     leaked `Normal0` and `96` out of the Office `<xml>` block, and any
//     comment holding a `>` (a media query with a child selector, which is
//     every responsive template) leaked raw CSS, because `<[^>]+>` cannot see
//     past the `>` inside it.
//   - Link targets. `<[^>]+>` deleted the whole anchor, so `body_text` from an
//     HTML-only message contained the link text and not one URL. "Send me that
//     link" forced a second read with `include_html: true`, at 3.7x the cost.
//
// It lives in its own module rather than inside index.ts for two reasons: the
// IMAP client needs the same preview cleaning (that path had drifted and lost
// the normalisation entirely), and none of this is testable from index.ts,
// whose top level starts a server.
//
// Order is the load-bearing part of everything below. Comments before tags,
// tags before entity decoding, decoding before whitespace collapsing, and the
// length cap last. Decoding before the tag strip would let `&lt;script&gt;`
// turn back into markup; decoding after the collapse would leave the spaces
// `&nbsp;` produces uncollapsed; capping before the strip would cap a string
// made of padding.
// ---------------------------------------------------------------------------

import { stripInvisibleText, stripZeroWidthText } from "./text-safety.ts";

/**
 * Preview budget, unchanged. It is a triage line, not a body: 200 characters of
 * real text is already generous, and it used to be 200 characters of nothing.
 */
const PREVIEW_MAX_CHARS = 200;

/**
 * The entities that actually turn up in mail, decoded to their text.
 *
 * `nbsp` decodes to an ordinary space rather than U+00A0 on purpose: plain text
 * has no line-breaking to protect, and the ordinary space is one byte instead
 * of two and collapses with its neighbours.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  // Beyond the required six: the handful that email templates emit constantly
  // and that otherwise reach the model as literal "&middot;" noise.
  bull: "\u2022",
  copy: "\u00a9",
  deg: "\u00b0",
  euro: "\u20ac",
  hellip: "\u2026",
  ldquo: "\u201c",
  lsquo: "\u2018",
  mdash: "\u2014",
  middot: "\u00b7",
  ndash: "\u2013",
  pound: "\u00a3",
  rdquo: "\u201d",
  reg: "\u00ae",
  rsquo: "\u2019",
  trade: "\u2122",
  // Entity-encoded padding. Decoding these is what lets the invisible-character
  // strip below see them at all.
  zwj: "\u200d",
  zwnj: "\u200c",
};

/** Named, decimal or hexadecimal reference. Bounded so a stray `&` is cheap. */
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** A numeric reference, or null when it does not name a character we will emit. */
function numericEntityToText(body: string): string | null {
  const hex = body[1] === "x" || body[1] === "X";
  const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isFinite(cp) || cp > 0x10ffff) return null;
  // Lone surrogates would produce an unpaired code unit that JSON.stringify
  // cannot represent losslessly.
  if (cp >= 0xd800 && cp <= 0xdfff) return null;
  // Control characters: drop rather than decode. `&#0;` in a body is either a
  // mistake or an attempt to smuggle a NUL through a text field.
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return "";
  return String.fromCodePoint(cp);
}

/**
 * Decode HTML entities to text.
 *
 * One pass, deliberately. `String.replace` does not rescan what it inserted, so
 * `&amp;lt;` decodes to the literal text `&lt;` and stops there. Nothing
 * downstream re-parses the result as HTML, so a decoded `<` is a character and
 * never a tag. Unknown entities are left exactly as they were, since guessing
 * is worse than showing the model what the sender wrote.
 */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (match, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) {
      return numericEntityToText(body) ?? match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Clean one summary preview: decode entities, drop invisible characters,
 * collapse whitespace, cap at 200 characters.
 *
 * The invisible strip has to happen before the cap, or the cap just preserves
 * 200 characters of padding. The full invisible class is right here (bidi marks
 * included): a preview is a line that gets scanned, not prose that gets read.
 */
export function normalizePreview(text: string): string {
  return stripInvisibleText(decodeHtmlEntities(text))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_MAX_CHARS);
}

/**
 * `normalizePreview` for a preview taken from a raw body snippet, which may
 * still hold markup. Tags go first so a decoded `<` cannot become one.
 */
export function normalizeSnippetPreview(snippet: string): string {
  return normalizePreview(snippet.replace(/<[^>]+>/g, " "));
}

/**
 * `<a href="U">T</a>` to `T (U)`, run before the tag strip so the target
 * survives at all.
 *
 * Conservative on purpose, because the point is to spend fewer tokens, not
 * more: an anchor whose text already shows the URL keeps just the text, and an
 * anchor with no text at all (a logo, a 1x1 tracking pixel) is dropped whole
 * rather than leaving a naked tracking URL behind. Emitted in parentheses
 * rather than angle brackets because the tag strip that runs next would eat
 * anything between `<` and `>`.
 */
const ANCHOR_WITH_HREF =
  /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

function inlineAnchorTarget(
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

/**
 * Convert an HTML body to readable plain text: drop comments, `<style>` and
 * `<script>` blocks and all tags, keep link targets, decode entities, drop
 * zero-width padding, and collapse whitespace. Used as the `body_text` fallback
 * for HTML-only messages so an agent reading `body_text` always gets the
 * content (e.g. OTP codes) without needing `include_html`.
 *
 * `keepLinks` is opt-in because this function serves two different audiences.
 * A `body_text` the model reads wants the URLs. The quoted original inside an
 * outgoing reply is read by a person, and inlining every target there would
 * change what we put in someone else's mailbox, so those call sites leave it
 * off and get only the cleanup.
 *
 * Bodies keep their bidi marks: `stripZeroWidthText`, not the full class, or we
 * would silently corrupt Hebrew, Arabic, Persian and Urdu prose.
 */
export function stripHtmlToText(
  html: string,
  options?: { keepLinks?: boolean },
): string {
  let out = html
    // Comments first. The generic tag strip below cannot remove a comment that
    // contains a `>`, and Office conditional comments and media queries both
    // do. Lazy, so a downlevel-revealed `<!--[if !mso]><!-->` only loses its
    // marker and keeps the content that follows it.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  if (options?.keepLinks) out = out.replace(ANCHOR_WITH_HREF, inlineAnchorTarget);
  return stripZeroWidthText(
    decodeHtmlEntities(
      out
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
