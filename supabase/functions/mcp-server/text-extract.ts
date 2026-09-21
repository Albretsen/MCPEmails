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

import { parseMultipartBodySource } from "./mime.ts";
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
  return normalizePreview(
    snippet
      .replace(/<[^>]+>/g, " ")
      // An IMAP snippet is a partial body fetch, so it can stop in the middle
      // of a tag. The rule above needs a closing `>` and cannot match that, so
      // without this a preview ends in a literal `<table class`. It only became
      // visible once entity decoding freed enough of the 200-character budget
      // to reach the end of the snippet.
      .replace(/<[^>]*$/, " "),
  );
}

/**
 * The preview for one fetched IMAP body part, from its raw source.
 *
 * ── Why this is here, and why it is the ONLY preview generator ──────────────
 *
 * A live test against a real Gmail-over-IMAP mailbox on 2026-09-20 (F-03) found
 * `email_read action:"list"` and `action:"search"` shipping this as a preview:
 *
 *   --mcpe_alt_08cb43e0… Content-Type: text/plain; charset=UTF-8
 *   Content-Transfer-Encoding: base64 RjMgYXR0YWNobWVudCBmaXh0dXJlLiBTZW50…
 *
 * `action:"read"` on the same message returned a perfectly decoded body, which
 * is the whole diagnosis: the read path parses MIME and the preview path did
 * not. The listing asks for `BODY.PEEK[1]<0.2048>` and assumed part one is a
 * leaf text part. For mail this server itself composes with inline attachments
 * — `multipart/mixed` wrapping a `multipart/alternative`, exactly what
 * mime-build.ts emits — part one is the nested multipart, so its "body" is a
 * boundary line, four header lines and base64. The old generator stringified
 * that as prose. The field an agent reads FIRST to decide what to open was
 * useless for precisely the mail that has attachments, and it spent the model's
 * context on MIME framing.
 *
 * Two code paths for one question is what let them diverge, so there is now one
 * here and the IMAP client calls it. The descent below is mime.ts's own — the
 * parser the working `read` path uses — not a second one written for previews.
 *
 * The contract, in order:
 *   1. a multipart source (any nesting depth) is parsed and reduced to its
 *      decoded text/plain, falling back to its decoded text/html stripped to
 *      text. If neither yields anything — a 2KB snippet can stop before any
 *      content — the preview is EMPTY. It is never the source.
 *   2. a leaf source is decoded from base64 or quoted-printable and cleaned.
 *   3. either way boundaries, header lines and base64 never reach a caller.
 */
export function previewFromBodyPartSource(source: string): string {
  const nested = parseMultipartBodySource(source);
  if (nested) {
    const text = preferredBodyText(nested.text, nested.html, { keepLinks: false });
    if (!text) return "";
    // A 2KB fetch can cut a multi-byte character in half; the decoder emits
    // U+FFFD for the remainder. Drop a trailing run of them so a short preview
    // does not end in replacement characters.
    return normalizePreview(text.replace(/�+$/, ""));
  }
  return leafSnippetPreview(source);
}

/**
 * Preview for a LEAF part fetched as a snippet: decode base64 or soft
 * quoted-printable, then clean. Returns "" for binary/undecodable content.
 *
 * The transfer encoding has to be guessed because a part body carries no
 * headers of its own (BODYSTRUCTURE knows, but the snippet does not), hence the
 * ratio test rather than a declared value.
 */
function leafSnippetPreview(snippet: string): string {
  // Base64 path: many providers (e.g. Fastmail) transfer-encode text parts as
  // base64, wrapped at ~76 chars with CRLF. After whitespace-stripping, such a
  // snippet is essentially the base64 alphabet only. Detect via ratio so prose
  // (with spaces/punctuation) is not misclassified, then decode.
  const stripped = snippet.replace(/\s+/g, "");
  if (stripped.length >= 32) {
    const b64Chars = (stripped.match(/[A-Za-z0-9+/=]/g) ?? []).length;
    if (b64Chars / stripped.length >= 0.95) {
      // Partial fetch (<0.2048>) may cut mid-quantum; trim to a multiple of 4.
      const b64 = stripped.slice(0, stripped.length - (stripped.length % 4));
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        const text = normalizeSnippetPreview(decoded);
        // If it still looks binary (lots of control / U+FFFD replacement chars), drop it.
        // deno-lint-ignore no-control-regex -- the control characters ARE the test.
        const bad = (text.match(/[\x00-\x08\x0E-\x1F�]/g) ?? []).length;
        if (text && bad / text.length < 0.1) return text;
        return "";
      } catch {
        // Fall through to the plain/QP text path below.
      }
    }
  }

  // Plain / quoted-printable path: decode soft line breaks + =XX hex escapes.
  const latin1 = snippet
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // `=XX` yields BYTES, and a UTF-8 part spends two or three of them per
  // non-ASCII character, so stopping at the latin1 string above previewed
  // "Karin på" as "Karin pÃ¥" — mojibake in the one field a triage pass reads.
  // The base64 branch a few lines up has always decoded UTF-8; these are two
  // branches of one function and they disagreed. Charset is not knowable from a
  // part body (its headers were not fetched), so: decode as UTF-8, and keep the
  // latin1 reading only when the result is full of replacement characters,
  // which is what a genuinely latin1 part looks like. A snippet cut mid-
  // character contributes at most one, and the tail trim below removes it.
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(
    Uint8Array.from(latin1, (c) => c.charCodeAt(0) & 0xff),
  ).replace(/�+$/, "");
  const replacements = (utf8.match(/�/g) ?? []).length;
  return normalizeSnippetPreview(replacements > 2 ? latin1 : utf8);
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
    // CRLF first, or none of the rules below see a line boundary at all. A
    // table-built email (which is most marketing and every ticketing system)
    // otherwise arrives as long runs of "\r\n \r\n \r\n": one blank line per
    // layout cell, measured at roughly half the body on real mail.
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    // A line holding only a space is a blank line. Trim it before collapsing,
    // or the run-of-blank-lines rule below never matches.
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Choose the plain-text body, preferring the sender's own text/plain part but
 * falling back to the HTML when that part is present and EMPTY.
 *
 * `??` was the bug: it only falls back on null/undefined, and a large family of
 * senders (Intercom, Zendesk and most ticketing systems) ship a
 * multipart/alternative whose text/plain part is an empty string. Those arrived
 * with body_text: "" next to a full body_html, so an agent reading body_text
 * saw nothing at all and had to re-read the message with include_html to
 * discover there was content, at roughly 4x the tokens. Observed on real mail.
 *
 * Whitespace-only counts as empty for the same reason: a part containing one
 * \r\n carries no more information than an absent one.
 *
 * `keepLinks` defaults to true because `body_text` is the caller this was
 * written for, and an agent asked to find a link needs the URLs. The preview
 * generator passes false: a 200-character triage line would spend its entire
 * budget on one tracking URL. The CHOICE between the two parts is the same
 * either way, which is why it stays one function.
 */
export function preferredBodyText(
  text: string | null | undefined,
  html: string | null | undefined,
  options?: { keepLinks?: boolean },
): string | null {
  if (typeof text === "string" && text.trim() !== "") return text;
  if (typeof html === "string" && html !== "") {
    const converted = stripHtmlToText(html, { keepLinks: options?.keepLinks !== false });
    if (converted.trim() !== "") return converted;
  }
  return text ?? null;
}

