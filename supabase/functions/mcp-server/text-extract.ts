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
 * Invisible in a rendered message and absent from `stripInvisibleText`'s class,
 * which is a mirrored anti-spoofing contract (text-safety.ts) and is not widened
 * here: the soft hyphen (U+00AD, also written `&shy;`) and the combining
 * grapheme joiner (U+034F). Both are what a preheader is padded with:
 * `&#847;&zwnj;&nbsp;` repeated a hundred times is the commonest form.
 */
const PREVIEW_ONLY_INVISIBLE = /[\u00ad\u034f]/g;

/**
 * Clean one summary preview: decode entities, drop invisible characters,
 * collapse whitespace, cap at 200 characters. Every provider's preview ends
 * here: Gmail's `snippet` (which arrives entity-encoded), Graph's
 * `bodyPreview`, and the text decoded from an IMAP part.
 *
 * The invisible strip has to happen before the cap, or the cap just preserves
 * 200 characters of padding. The full invisible class is right here (bidi marks
 * included): a preview is a line that gets scanned, not prose that gets read.
 *
 * Nothing here judges MEANING. Padding goes because it is invisible, not
 * because it is boilerplate; "View in browser" is text and stays.
 */
export function normalizePreview(text: string): string {
  return tidyPreview(decodeHtmlEntities(text.replace(/&shy;/gi, "")));
}

/**
 * {@link normalizePreview} without the entity decode: drop invisible
 * characters, collapse whitespace, cap. For text whose entities have ALREADY
 * been decoded, which is every IMAP preview by the time index.ts builds the
 * row (`cleanPreviewFromBodyPart` decodes exactly once). Decoding again there
 * turned a message that shows the text `&lt;b&gt;` (written `&amp;lt;b&amp;gt;`
 * in its HTML) into `<b>`. Idempotent, so running it on a finished preview is
 * free.
 *
 * The cap never ends on half a surrogate pair: `slice` counts UTF-16 code
 * units, and a preview whose 200th unit is the first half of an emoji would
 * put a lone surrogate into the JSON result.
 */
export function tidyPreview(text: string): string {
  const tidy = stripInvisibleText(text)
    .replace(PREVIEW_ONLY_INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (tidy.length <= PREVIEW_MAX_CHARS) return tidy;
  const last = tidy.charCodeAt(PREVIEW_MAX_CHARS - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? PREVIEW_MAX_CHARS - 1 : PREVIEW_MAX_CHARS;
  return tidy.slice(0, cut);
}

// ---------------------------------------------------------------------------
// stripHtmlToText, in linear time.
//
// Until 2026-10-16 this was a chain of global lazy regexes (`<!--[\s\S]*?-->`,
// `<style\b[\s\S]*?<\/style\s*>`, the anchor rule, `<[^>]+>`) run over the
// whole body of someone else's email. Each of them, given an opener with no
// closer, scans to the end of the input from EVERY opener: 5 MB of `<!--`,
// `<a href=x>` or `<` cost hundreds of billions of steps, and one such message
// failed every email_read, reply and forward that touched it.
//
// The scanners below reproduce each of those regexes EXACTLY (same matches,
// same replacements, same left-to-right, non-overlapping semantics as
// `String.replace` with a /g regex), but find every closer with one forward
// `indexOf` and never rescan a region. The legacy regex chain is kept verbatim
// in text-extract.test.ts as an oracle and the two are fuzzed against each
// other, and text-extract.golden.json holds the old output on realistic mail.
//
// Two regex facts the scanners depend on:
//   - `/i` without `/u` folds ASCII letters only, so the ASCII-only lower-casing
//     in `asciiLower` (which also keeps every offset) is the same comparison.
//   - `\s` is the ECMAScript WhiteSpace + LineTerminator set (`isJsSpace`), not
//     the HTML one, and `\b` is ASCII `[A-Za-z0-9_]` (`isAsciiWordChar`).
// ---------------------------------------------------------------------------

/** Lower-case A-Z only. Same length as the input, so offsets carry over. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Exactly the characters JS `\s` matches. */
function isJsSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 ||
    code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 ||
    code === 0xfeff;
}

/** Exactly the characters `\b` treats as word characters (no `/u`). */
function isAsciiWordChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

/**
 * `value.replace(/<!--[\s\S]*?-->/g, " ")`. A comment with no `-->` after it
 * stays, and so does every later one: there is no `-->` left to close them.
 */
function replaceComments(value: string): string {
  let open = value.indexOf("<!--");
  if (open === -1) return value;
  const parts: string[] = [];
  let pos = 0;
  while (open !== -1) {
    const close = value.indexOf("-->", open + 4);
    if (close === -1) break;
    parts.push(value.slice(pos, open), " ");
    pos = close + 3;
    open = value.indexOf("<!--", pos);
  }
  parts.push(value.slice(pos));
  return parts.join("");
}

/**
 * Start offsets and end offsets (just past `>`) of every `</name\s*>` in
 * `lower`, in order. One forward pass: each whitespace run is read once.
 */
function closingTags(lower: string, name: string): { starts: number[]; ends: number[] } {
  const needle = `</${name}`;
  const starts: number[] = [];
  const ends: number[] = [];
  let at = lower.indexOf(needle);
  while (at !== -1) {
    let k = at + needle.length;
    while (k < lower.length && isJsSpace(lower.charCodeAt(k))) k += 1;
    if (lower.charCodeAt(k) === 0x3e /* > */) {
      starts.push(at);
      ends.push(k + 1);
      // Nothing between `at` and `k` can start another `</name`.
      at = lower.indexOf(needle, k + 1);
    } else {
      at = lower.indexOf(needle, at + 1);
    }
  }
  return { starts, ends };
}

/** Index of the first entry of the sorted `list` that is >= `from`, or list.length. */
function firstAtOrAfter(list: ArrayLike<number>, from: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `value.replace(/<name\b[\s\S]*?<\/name\s*>/gi, "")` for `style` and
 * `script`: an element and its content, up to the FIRST closer. An opener with
 * no closer after it is left alone (the tag strip removes just the tag later),
 * exactly as the regex left it.
 */
function removeElementBlocks(value: string, name: string): string {
  const lower = asciiLower(value);
  const opener = `<${name}`;
  let open = lower.indexOf(opener);
  if (open === -1) return value;
  const closers = closingTags(lower, name);
  const parts: string[] = [];
  let pos = 0;
  let next = 0;
  while (open !== -1) {
    const after = open + opener.length;
    if (after < value.length && isAsciiWordChar(value.charCodeAt(after))) {
      open = lower.indexOf(opener, open + 1);
      continue;
    }
    while (next < closers.starts.length && closers.starts[next] < after) next += 1;
    // No closer left: no later opener can close either.
    if (next === closers.starts.length) break;
    parts.push(value.slice(pos, open));
    pos = closers.ends[next];
    open = lower.indexOf(opener, pos);
  }
  if (pos === 0) return value;
  parts.push(value.slice(pos));
  return parts.join("");
}

/**
 * `value.replace(/<[^>]+>/g, replacement)`: from a `<` to the next `>`, as long
 * as at least one character sits between them (`<>` is text). A `<` with no
 * `>` after it is text, and so is every later one.
 */
function replaceTags(value: string, replacement: string): string {
  let lt = value.indexOf("<");
  if (lt === -1) return value;
  const parts: string[] = [];
  let pos = 0;
  while (lt !== -1) {
    const gt = value.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      lt = value.indexOf("<", gt);
      continue;
    }
    parts.push(value.slice(pos, lt), replacement);
    pos = gt + 1;
    lt = value.indexOf("<", pos);
  }
  parts.push(value.slice(pos));
  return parts.join("");
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
function inlineAnchorTarget(
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  unquoted: string | undefined,
  inner: string,
): string {
  const url = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
  const shown = replaceTags(inner, " ").replace(/\s+/g, " ").trim();
  if (!shown) return " ";
  if (!url || /^(?:#|javascript:|data:)/i.test(url)) return inner;
  let bare = url
    .replace(/^mailto:/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // `.replace(/\/+$/, "")`, without the regex: `\/+$` backtracks through every
  // run of slashes that is not at the end, which is quadratic on a long one.
  let end = bare.length;
  while (end > 0 && bare.charCodeAt(end - 1) === 0x2f /* / */) end -= 1;
  bare = bare.slice(0, end);
  if (!bare || shown.toLowerCase().includes(bare.toLowerCase())) return inner;
  return `${inner} (${url})`;
}

/** One `\shref\s*=\s*value[^>]*>` that has a `</a\s*>` somewhere after it. */
interface HrefCandidate {
  /** Offset of the `\s` before `href`. */
  at: number;
  doubleQuoted?: string;
  singleQuoted?: string;
  unquoted?: string;
  /** Just past the `>` that ends the opening tag. */
  innerStart: number;
  innerEnd: number;
  /** Just past the closer's `>`. */
  end: number;
}

/**
 * `value.replace(ANCHOR_WITH_HREF, inlineAnchorTarget)` with the regex the
 * old code used:
 *
 *   /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
 *
 * How the regex resolves a match at an opener `<a` at `i`: the lazy `[^>]*?`
 * tries each `\shref` position `p` in order, from `i + 2` up to (not past) the
 * first `>` after `i + 2`. Whether `p` then succeeds, and what it captures,
 * depends on `p` alone: its value (quoted: to the next same quote, which may
 * cross a `>`; unquoted: the longest run of `[^\s"'>]`), the first `>` after
 * the value, and the first `</a\s*>` after that. So every candidate is
 * resolved ONCE up front, the successful ones are kept in order, and each
 * opener takes the first successful candidate in its window.
 */
function inlineAnchors(value: string): string {
  const lower = asciiLower(value);
  if (lower.indexOf("<a") === -1) return value;
  const n = value.length;

  const closers = closingTags(lower, "a");
  if (closers.starts.length === 0) return value;

  const gts: number[] = [];
  for (let at = value.indexOf(">"); at !== -1; at = value.indexOf(">", at + 1)) gts.push(at);

  // Every `\shref\s*=\s*value[^>]*>` followed somewhere by `</a\s*>`.
  const candidates: HrefCandidate[] = [];
  for (let h = lower.indexOf("href", 1); h !== -1; h = lower.indexOf("href", h + 1)) {
    const at = h - 1;
    if (!isJsSpace(value.charCodeAt(at))) continue;
    let k = h + 4;
    while (k < n && isJsSpace(value.charCodeAt(k))) k += 1;
    if (value.charCodeAt(k) !== 0x3d /* = */) continue;
    k += 1;
    while (k < n && isJsSpace(value.charCodeAt(k))) k += 1;
    if (k >= n) continue;
    const quote = value[k];
    let valueEnd: number;
    const candidate: HrefCandidate = { at, innerStart: 0, innerEnd: 0, end: 0 };
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, k + 1);
      if (close === -1) continue;
      const captured = value.slice(k + 1, close);
      if (quote === '"') candidate.doubleQuoted = captured;
      else candidate.singleQuoted = captured;
      valueEnd = close + 1;
    } else {
      let e = k;
      while (e < n) {
        const c = value.charCodeAt(e);
        if (isJsSpace(c) || c === 0x22 || c === 0x27 || c === 0x3e) break;
        e += 1;
      }
      if (e === k) continue;
      candidate.unquoted = value.slice(k, e);
      valueEnd = e;
    }
    const g = firstAtOrAfter(gts, valueEnd);
    if (g === gts.length) continue;
    const c = firstAtOrAfter(closers.starts, gts[g] + 1);
    if (c === closers.starts.length) continue;
    candidate.innerStart = gts[g] + 1;
    candidate.innerEnd = closers.starts[c];
    candidate.end = closers.ends[c];
    candidates.push(candidate);
  }
  if (candidates.length === 0) return value;

  const parts: string[] = [];
  let pos = 0;
  let next = 0;
  let open = lower.indexOf("<a");
  while (open !== -1) {
    if (open + 2 < n && isAsciiWordChar(value.charCodeAt(open + 2))) {
      open = lower.indexOf("<a", open + 1);
      continue;
    }
    while (next < candidates.length && candidates[next].at < open + 2) next += 1;
    if (next === candidates.length) break;
    const g = firstAtOrAfter(gts, open + 2);
    const limit = g === gts.length ? n : gts[g];
    const hit = candidates[next];
    if (hit.at >= limit) {
      open = lower.indexOf("<a", open + 1);
      continue;
    }
    parts.push(
      value.slice(pos, open),
      inlineAnchorTarget(
        hit.doubleQuoted,
        hit.singleQuoted,
        hit.unquoted,
        value.slice(hit.innerStart, hit.innerEnd),
      ),
    );
    pos = hit.end;
    open = lower.indexOf("<a", pos);
  }
  if (pos === 0) return value;
  parts.push(value.slice(pos));
  return parts.join("");
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
 *
 * Linear in the input, whatever the input (see the block comment above): no
 * step rescans what an earlier opener already scanned. No size cap, because
 * none is needed for time and any cap would cut real long mail.
 */
export function stripHtmlToText(
  html: string,
  options?: { keepLinks?: boolean },
): string {
  // Comments first. The generic tag strip below cannot remove a comment that
  // contains a `>`, and Office conditional comments and media queries both
  // do. Lazy, so a downlevel-revealed `<!--[if !mso]><!-->` only loses its
  // marker and keeps the content that follows it.
  let out = removeElementBlocks(removeElementBlocks(replaceComments(html), "style"), "script");
  if (options?.keepLinks) out = inlineAnchors(out);
  return stripZeroWidthText(
    decodeHtmlEntities(
      replaceTags(
        out
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<\/div>/gi, "\n"),
        "",
      ),
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
 * written for, and an agent asked to find a link needs the URLs.
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

// ---------------------------------------------------------------------------
// The IMAP preview: `cleanPreviewFromBodyPart`, the ONLY generator.
//
// A listing asks for `BODY.PEEK[1]<0.2048>` and BODYSTRUCTURE in one FETCH. The
// first is a prefix of part one's bytes; the second states what part one is:
// its media type, its charset and its transfer encoding. The preview is decoded
// from what was stated, and is written for a source that stops wherever the
// partial fetch stopped:
//
//   * `<style>`, `<script>`, `<head>`, `<title>` and comments go WITH their
//     content, closed or not. A 2 KB prefix of an HTML-only message is very
//     often an unterminated `<style>` block, which a closed-tag rule cannot
//     match, so the CSS used to ship as the preview.
//   * Octets are taken exactly. The IMAP reader hands over a byte string (one
//     character per octet) since 2026-10-04. It used to decode through
//     TextDecoder("latin1"), which is windows-1252: an 8bit UTF-8 "Ø" (C3 98)
//     read as "Ã" + U+02DC, and `charCodeAt & 0xff` then turned 0x98 into 0xDC.
//     That, not the cut at 2 KB, was the usual source of U+FFFD in a preview.
//     `sourceOctets` still accepts a string read the old way.
//   * Entities are decoded exactly once (`finishPreview`), and index.ts does
//     not decode an IMAP row again.
//   * The declared charset decodes the octets, as a STREAM, so a multi-byte
//     character cut by the fetch is held back instead of becoming U+FFFD.
//   * A quoted-printable escape or soft break cut in half is dropped, and
//     base64 is trimmed to a whole quantum.
//   * A part that is not text (an attachment-only message) previews as "".
//   * When part one is itself a multipart (mail with attachments: mixed
//     wrapping alternative), its source carries each child's own headers and
//     mime.ts, the parser the `read` path uses, descends through it. Boundary
//     lines, part headers and base64 never reach a caller (F-03, 2026-09-20).
//   * Nothing returned ever contains U+FFFD.
//
// History: until 2026-10-04 MCP traffic went through a second generator
// (`previewFromBodyPartSource`, which comments elsewhere still name) that
// had no BODYSTRUCTURE and GUESSED all three facts (base64 by a character
// ratio, charset as "UTF-8, else latin1", HTML not at all), while this one ran
// for client-api only behind a first-party flag. Two generators for one field
// is how `list` came to ship CSS while the web client did not; there is one.
// ---------------------------------------------------------------------------

/** What BODYSTRUCTURE says about the part a preview was fetched from. */
export interface PreviewPartInfo {
  /** Lower-cased media type and subtype, e.g. "text", "html". */
  type: string;
  subtype: string;
  /** Declared charset, or null. */
  charset: string | null;
  /** Lower-cased Content-Transfer-Encoding, or null. */
  encoding: string | null;
  /**
   * The part's size in octets as BODYSTRUCTURE states it, when known. A source
   * at least this long is the WHOLE part, not a prefix the fetch cut, and its
   * last octets are then judged as they stand (see `decodeCharsetTolerant`).
   */
  size?: number | null;
}

/** windows-1252 code points for 0x80-0x9F, inverted: see `singleByteTextToBytes` in imap-client.ts. */
const CP1252_TO_OCTET: Map<number, number> = (() => {
  const bytes = new Uint8Array(0x20);
  for (let i = 0; i < 0x20; i++) bytes[i] = 0x80 + i;
  const chars = new TextDecoder("latin1").decode(bytes);
  const map = new Map<number, number>();
  for (let i = 0; i < chars.length; i++) map.set(chars.charCodeAt(i), 0x80 + i);
  return map;
})();

/** The octets a single-byte socket read produced. A character no such read yields becomes "?". */
function sourceOctets(source: string): Uint8Array {
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    out[i] = code <= 0xff ? code : CP1252_TO_OCTET.get(code) ?? 0x3f;
  }
  return out;
}

function octetString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** Undo a transfer encoding on a source that may stop anywhere. */
function decodeTransferTolerant(octets: Uint8Array, encoding: string | null): Uint8Array | null {
  if (encoding === "base64") {
    const clean = octetString(octets).replace(/[^A-Za-z0-9+/]/g, "");
    const whole = clean.slice(0, clean.length - (clean.length % 4));
    try {
      const bin = atob(whole);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  if (encoding === "quoted-printable") {
    const text = octetString(octets)
      // A soft break or an escape the fetch cut in half.
      .replace(/=(?:\r|[0-9A-Fa-f])?$/, "")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }
  return octets;
}

const REPLACEMENT = /�/g;

function countReplacements(text: string): number {
  return (text.match(REPLACEMENT) ?? []).length;
}

/**
 * Octets to text by the declared charset. Streamed, so an incomplete trailing
 * sequence is withheld; an unknown or wrong label falls back to UTF-8 and then
 * to windows-1252, whichever reads cleanly.
 *
 * `complete` says the octets are the whole part, not a prefix. It matters for
 * one case only: octets that are ASCII plus a few invalid or unfinished UTF-8
 * sequences and NOT ONE valid multi-byte character. That is single-byte text
 * under a wrong or missing label ("Café olé" in windows-1252), not UTF-8 with a
 * stray octet, and dropping the "strays" ate every accented letter of a short
 * message. An unfinished sequence at the very end counts as such an octet only
 * when the source is complete; in a prefix it is where the fetch stopped.
 */
function decodeCharsetTolerant(bytes: Uint8Array, charset: string | null, complete = false): string {
  const stream = (label: string): { text: string; cut: boolean } | null => {
    try {
      const decoder = new TextDecoder(label, { fatal: false });
      const text = decoder.decode(bytes, { stream: true });
      // Flushing yields U+FFFD exactly when a sequence was left unfinished.
      return { text, cut: decoder.decode() !== "" };
    } catch {
      return null;
    }
  };
  const label = (charset ?? "").trim().toLowerCase();
  const utf8Label = label === "utf-8" || label === "utf8";
  const declared = label && label !== "us-ascii" && label !== "ascii" && !utf8Label ? stream(label)?.text ?? null : null;
  if (declared !== null && countReplacements(declared) === 0) return declared;
  const utf8 = stream("utf-8") ?? { text: "", cut: false };
  // deno-lint-ignore no-control-regex
  const hasMultiByte = /[^\x00-\x7f\ufffd]/.test(utf8.text);
  if (!hasMultiByte && (countReplacements(utf8.text) > 0 || (utf8.cut && complete))) {
    return stream("windows-1252")?.text ?? "";
  }
  if (countReplacements(utf8.text) === 0) return utf8.text;
  // Not what it said it was, and not UTF-8. A stray invalid octet or two is
  // dropped; anything worse is read as single-byte text, which has no invalid
  // sequences at all.
  if (declared !== null && countReplacements(declared) <= 2) return declared.replace(REPLACEMENT, "");
  if (countReplacements(utf8.text) <= 2) return utf8.text.replace(REPLACEMENT, "");
  return stream("windows-1252")?.text ?? "";
}

/**
 * `<name` of an element whose CONTENT is not message text, tested AT a `<`
 * (sticky). `\b` keeps `<styles>` and `<header>` ordinary tags.
 */
const NON_TEXT_OPEN = /<(style|script|head|title|noscript|template|svg|xml)\b/iy;

/** `</name   >` for each of them, searched from wherever its opening tag ended. */
const NON_TEXT_CLOSE: Record<string, RegExp> = Object.fromEntries(
  ["style", "script", "head", "title", "noscript", "template", "svg", "xml"]
    .map((name) => [name, new RegExp(`<\\/${name}\\s*>`, "gi")]),
);

/**
 * Tags that sit INSIDE a line of text, tested AT a `<` (sticky). They vanish;
 * every other tag becomes a space, because a tag nobody listed is far more
 * often a cell or a block (`<td>A</td><td>B</td>`) than something in the
 * middle of a word. Without this list `<a href="…">ready</a>.` previews as
 * "ready ." and `<b>M</b>CP` as "M CP".
 */
const INLINE_OPEN =
  /<\/?(?:a|abbr|b|big|code|em|font|i|label|mark|s|small|span|strike|strong|sub|sup|tt|u|wbr)\b/iy;

/** {@link decodeHtmlEntities}, with `&shy;` (invisible, and not in its table) decoding to nothing. */
function decodePreviewEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (match, body: string) => {
    if (body.charCodeAt(0) === 0x23 /* # */) return numericEntityToText(body) ?? match;
    const name = body.toLowerCase();
    return name === "shy" ? "" : NAMED_ENTITIES[name] ?? match;
  });
}

/**
 * HTML, possibly cut off anywhere, to the text a reader would see first.
 *
 * ONE pass over the source, left to right, and nothing that was removed is
 * ever looked at again. That is the whole point: this used to be a chain of
 * `replace` calls (comments, then `<style>`-like elements, then tags), and a
 * chain can build markup out of what an earlier link left behind
 * (`<scr<script>ipt>`: removing the inner tag leaves an outer one). Here every
 * `<` opens exactly one construct, which is consumed to its end or to the end
 * of the source, so no `<` from the source reaches the output at all. The only
 * `<` a preview can hold is one the sender wrote as `&lt;`, decoded once at
 * the very end, and nothing parses the result again.
 *
 *   <!-- ... -->            dropped, closed or not                  -> " "
 *   <style|script|head|title|noscript|template|svg|xml ...> ... </same>
 *                           dropped WITH its content, closed or not -> " "
 *   an inline tag           (INLINE_ELEMENTS)                       -> ""
 *   any other <...>         closed, or cut by the fetch             -> " "
 *
 * It is on the list hot path (25 rows of up to 8 KB each), so it jumps with
 * `indexOf` and copies whole text runs; see the benchmark in
 * text-extract.test.ts.
 */
export function htmlPreviewText(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    if (lt > i) out += html.slice(i, lt);

    if (html.charCodeAt(lt + 1) === 0x21 /* ! */ && html.startsWith("--", lt + 2)) {
      const end = html.indexOf("-->", lt + 4);
      out += " ";
      if (end === -1) break;
      i = end + 3;
      continue;
    }

    // Only s, h, t, n and x start a non-text element's name: most tags skip the regex.
    const first = html.charCodeAt(lt + 1) | 0x20;
    let element: RegExpExecArray | null = null;
    if (first === 0x73 || first === 0x68 || first === 0x74 || first === 0x6e || first === 0x78) {
      NON_TEXT_OPEN.lastIndex = lt;
      element = NON_TEXT_OPEN.exec(html);
    }
    if (element !== null) {
      // Its content is not text. Closed, or running to the end of what was fetched.
      const close = NON_TEXT_CLOSE[element[1].toLowerCase()];
      close.lastIndex = lt + element[0].length;
      const found = close.exec(html);
      out += " ";
      if (found === null) break;
      i = found.index + found[0].length;
      continue;
    }

    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      // A tag the fetch cut in half.
      out += " ";
      break;
    }
    INLINE_OPEN.lastIndex = lt;
    if (!INLINE_OPEN.test(html)) out += " ";
    i = gt + 1;
  }
  return decodePreviewEntities(out)
    // An entity the fetch cut in half.
    .replace(/&#?[a-zA-Z0-9]{0,31}$/, "");
}

const HTML_TAG = /<\/?(?:html|head|body|div|p|br|table|tr|td|span|a|font|center|meta|style|img|b|strong|h[1-6])\b[^<>]*>/gi;

/**
 * Markup under a text/plain label (some senders do this): a document start,
 * or at least two real HTML tags. `<https://example.com>` and `<a@b.example>`
 * in ordinary plain text are neither.
 */
function looksLikeHtml(text: string): boolean {
  if (/^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<table[\s>]|<div[\s>])/i.test(text)) return true;
  return (text.match(HTML_TAG) ?? []).length >= 2;
}

/**
 * The last step for text taken from a part. Entities are decoded exactly ONCE
 * on the way to a preview: by `htmlPreviewText` when the source was markup
 * (`decoded`), here when it was plain text (senders do put `&nbsp;` in a
 * text/plain part). Never twice.
 */
function finishPreview(text: string, decoded: boolean): string {
  const clean = text.replace(REPLACEMENT, "");
  return decoded ? tidyPreview(clean) : normalizePreview(clean);
}

/** Text as it was decoded from a part, reduced to its visible text when it is markup. */
function previewOfText(text: string, html: boolean): string {
  return html || looksLikeHtml(text) ? finishPreview(htmlPreviewText(text), true) : finishPreview(text, false);
}

/** A quoted-printable soft break or escape that the partial fetch cut in half. */
const CUT_QP_TAIL = /=(?:\r|[0-9A-Fa-f])?$/;

/**
 * The transfer encoding of a leaf source nothing described. Only reached when
 * a server answered without a usable BODYSTRUCTURE, which the FETCH always
 * asks for; it keeps that case from previewing as the base64 alphabet.
 *
 * Base64 by ratio: wrapped base64 is the alphabet and line breaks and nothing
 * else, and prose (spaces, punctuation) is not. Quoted-printable only on its
 * unmistakable marks, a soft line break or two escapes in a row (one non-ASCII
 * UTF-8 character): a lone `=3D`-shaped run can be a URL's query string.
 */
function guessTransferEncoding(source: string): string | null {
  const lines = source.trim().split(/\r?\n/);
  const joined = lines.join("");
  if (joined.length >= 32 && !/[^A-Za-z0-9+/=]/.test(joined)) return "base64";
  if (/=\r?\n/.test(source) || /=[0-9A-Fa-f]{2}=[0-9A-Fa-f]{2}/.test(source)) return "quoted-printable";
  return null;
}

/**
 * The preview for one fetched IMAP body part, given what BODYSTRUCTURE says
 * the part is. `part` is null when part one is itself a multipart (its source
 * then carries each child's own headers, and those are read instead) or when
 * there was no BODYSTRUCTURE to read.
 *
 * The contract every caller gets: the first 200 characters or fewer of the
 * message's plain text (the text/plain part when there is one, otherwise the
 * HTML reduced to its visible text), entities decoded, invisible characters
 * removed, whitespace collapsed to single spaces. "" when there is no text.
 */
export function cleanPreviewFromBodyPart(source: string, part: PreviewPartInfo | null): string {
  const octets = sourceOctets(source);
  if (part === null || part.type === "multipart") {
    // mime.ts decodes each child whole; it has no notion of a source that
    // stops mid-escape, so the cut tail is removed before it sees it.
    const wire = octetString(octets);
    const nested = parseMultipartBodySource(wire.replace(CUT_QP_TAIL, ""));
    if (!nested) {
      if (part !== null) return "";
      // Not a multipart after all: a leaf nothing described.
      return leafPreview(octets, { type: "text", subtype: "plain", charset: null, encoding: guessTransferEncoding(wire) });
    }
    if (typeof nested.text === "string" && nested.text.trim() !== "") return previewOfText(nested.text, false);
    if (typeof nested.html === "string" && nested.html !== "") return previewOfText(nested.html, true);
    return "";
  }
  // An image, a PDF, a calendar file: nothing to preview.
  if (part.type !== "text") return "";
  return leafPreview(octets, part);
}

function leafPreview(octets: Uint8Array, part: PreviewPartInfo): string {
  const bytes = decodeTransferTolerant(octets, part.encoding);
  if (bytes === null) return "";
  const complete = typeof part.size === "number" && octets.length >= part.size;
  return previewOfText(decodeCharsetTolerant(bytes, part.charset, complete), part.subtype === "html");
}

