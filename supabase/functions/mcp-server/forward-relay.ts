// ---------------------------------------------------------------------------
// forward-relay.ts — a forward that carries the original message byte for byte.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Until 2026-09-17 email_forward re-read the original through the parsed read
// path and quoted `body_text` under a "---------- Forwarded message ----------"
// block. That threw away the original's HTML (a marketing email arrived as
// bare text with naked URLs), every inline `cid:` image (re-attached as a loose
// file, its Content-ID gone), and the MIME tree itself. A customer on Yahoo
// verified the received MIME on 2026-09-17: source `text/plain` + `text/html`,
// forward `text/plain` only. Nothing about that was Yahoo's doing; the same
// flattening ran on every provider.
//
// This module does what a mail client does when it forwards: the outgoing
// message is `multipart/mixed` whose first part is the note and the header
// block we author, and whose second part is the ORIGINAL BODY, verbatim, under
// the original's own `Content-*` headers. Its multipart/alternative,
// multipart/related, Content-IDs, transfer encodings and attachments all ride
// through untouched, because the bytes are never decoded. `as_attachment`
// instead wraps the whole original (headers included, so DKIM and the original
// Message-ID survive) as a `message/rfc822` part.
//
// Everything here is bytes in, bytes out. Header text is inspected through a
// single-byte view (one char per octet), never re-encoded, so the only bytes
// this module ever authors are ASCII: our headers, our base64 intro, and the
// boundary lines. An 8-bit original stays 8-bit; smtp-client negotiates
// 8BITMIME for it and the Gmail/Graph raw endpoints take octets as they are.
//
// Pure: no network, no database, no Deno.env. forward-relay.test.ts pins the
// byte identity that is the whole point.
// ---------------------------------------------------------------------------

import { decodeEncodedWords, parseContentType, parseHeaders } from "./mime.ts";
import { encodeMimeHeaderValue, encodeTextAsBase64Lines } from "./mime-build.ts";

/**
 * Ceiling on the original a forward will carry.
 *
 * Matches the single-file download and email_original ceilings so the three
 * numbers a caller can meet never disagree. Above this the forward is refused
 * with `original_too_large` before a byte of it is buffered (readOriginalMessage
 * decides from the declared size), never truncated and never sent without part
 * of itself. The number is set by the 256 MB isolate, not by any provider:
 * Gmail, Yahoo and Outlook all stop at 25 MB per message anyway.
 */
export const FORWARD_RELAY_MAX_BYTES = 25 * 1024 * 1024;

const ASCII = new TextEncoder();
const CRLF = "\r\n";
const CR = 0x0d;
const LF = 0x0a;

// ── byte helpers ─────────────────────────────────────────────────────────────

/** First index of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const first = needle[0];
  const last = hay.length - needle.length;
  outer:
  for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * One character per octet, exactly. Not TextDecoder("latin1"): under the
 * WHATWG encoding standard that label is windows-1252, which maps 0x80-0x9F to
 * other code points and would make the round trip lossy.
 */
export function bytesToSingleByteString(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** True when any octet is above 0x7F, i.e. the message needs 8BITMIME. */
export function hasEightBitBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return true;
  return false;
}

/**
 * CRLF-normalise a raw message ONLY when it carries a bare LF.
 *
 * IMAP, Gmail's `format=raw` and Graph's `$value` all hand back CRLF, so the
 * common case returns the same array untouched. A bare LF is not content in
 * MIME (canonical form is CRLF) but it IS a hazard on SMTP DATA, where a bare
 * LF followed by "." can terminate the transfer early, so the rare non-compliant
 * source is repaired rather than relayed as-is.
 */
export function normalizeCrlf(raw: Uint8Array): Uint8Array {
  let bare = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === LF && (i === 0 || raw[i - 1] !== CR)) {
      bare = true;
      break;
    }
  }
  if (!bare) return raw;
  const out = new Uint8Array(raw.length * 2);
  let o = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === LF && (i === 0 || raw[i - 1] !== CR)) out[o++] = CR;
    out[o++] = b;
  }
  return out.subarray(0, o);
}

// ── splitting a raw message ─────────────────────────────────────────────────

export interface RawMessageParts {
  /** The header block as a single-byte string, without the blank separator. */
  headerBlock: string;
  /** Everything after the blank line, untouched. Empty when there is no body. */
  body: Uint8Array;
}

/**
 * Split a raw RFC 5322 message (or a body part) at its first blank line.
 * A part with no headers at all begins with the blank line itself.
 */
export function splitRawMessage(raw: Uint8Array): RawMessageParts {
  if (raw[0] === CR && raw[1] === LF) return { headerBlock: "", body: raw.subarray(2) };
  if (raw[0] === LF) return { headerBlock: "", body: raw.subarray(1) };
  let idx = indexOfBytes(raw, ASCII.encode("\r\n\r\n"));
  let sep = 4;
  if (idx === -1) {
    idx = indexOfBytes(raw, ASCII.encode("\n\n"));
    sep = 2;
  }
  if (idx === -1) {
    return { headerBlock: bytesToSingleByteString(raw), body: new Uint8Array(0) };
  }
  return {
    headerBlock: bytesToSingleByteString(raw.subarray(0, idx)),
    body: raw.subarray(idx + sep),
  };
}

// ── header handling ──────────────────────────────────────────────────────────

/**
 * The original's `Content-*` header lines, folding preserved, as they must
 * appear on the part that carries the original body. Line endings are
 * normalised to CRLF; nothing else is touched. Any other header (From, DKIM,
 * Received...) has no meaning on a body part and is left out; the summary
 * block we author carries the four a reader wants.
 */
export function contentHeaderLines(headerBlock: string): string[] {
  const lines = headerBlock.split(/\r\n|\n/);
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (keeping && kept.length) kept[kept.length - 1] += CRLF + line;
      continue;
    }
    keeping = /^content-[a-z0-9-]*[ \t]*:/i.test(line);
    if (keeping) kept.push(line);
  }
  return kept;
}

export interface OriginalSummary {
  from: string;
  to: string;
  date: string;
  subject: string;
}

/** The four lines of the forwarded-message block, RFC 2047 decoded. */
export function summarizeOriginal(headerBlock: string): OriginalSummary {
  const headers = parseHeaders(headerBlock);
  const first = (name: string) => {
    const v = headers.get(name);
    return v && v.length ? v[0] : "";
  };
  return {
    from: decodeEncodedWords(first("from")),
    to: decodeEncodedWords(first("to")),
    date: first("date"),
    subject: decodeEncodedWords(first("subject")),
  };
}

// ── leaving attachments behind, when asked ──────────────────────────────────

/**
 * Whether a body part is an attachment in the sense `include_attachments:
 * false` means: a file the sender attached, as opposed to the body itself or a
 * picture the body embeds.
 *
 *   * `Content-Disposition: attachment`         -> attachment
 *   * has a Content-ID (a `cid:` image)          -> body, keep
 *   * `Content-Disposition: inline`              -> body, keep
 *   * multipart, text or message container      -> body, keep
 *   * otherwise, named (name= / filename=)      -> attachment
 *   * otherwise                                  -> body, keep
 */
export function isAttachmentPart(partHeaderBlock: string): boolean {
  const headers = parseHeaders(partHeaderBlock);
  const disposition = headers.get("content-disposition")?.[0] ?? "";
  if (/^\s*attachment/i.test(disposition)) return true;
  if (headers.has("content-id")) return false;
  if (/^\s*inline/i.test(disposition)) return false;
  const ct = parseContentType(headers.get("content-type")?.[0] ?? null);
  if (
    ct.mediaType.startsWith("multipart/") || ct.mediaType.startsWith("text/") ||
    ct.mediaType.startsWith("message/")
  ) return false;
  return !!ct.params["name"] || /filename\*?=/i.test(disposition);
}

interface MultipartLayout {
  /** Byte offsets of each delimiter line's start, in order. */
  delimiters: number[];
  /** Offset of the closing delimiter line, or -1 when the body has none. */
  closing: number;
}

/** Locate `--boundary` lines at line starts. Closing delimiter is `--boundary--`. */
function layoutMultipart(body: Uint8Array, boundary: string): MultipartLayout {
  const delim = ASCII.encode("--" + boundary);
  const delimiters: number[] = [];
  let closing = -1;
  let at = 0;
  while (true) {
    const idx = indexOfBytes(body, delim, at);
    if (idx === -1) break;
    at = idx + delim.length;
    if (idx !== 0 && body[idx - 1] !== LF) continue;
    const after = body.subarray(idx + delim.length, idx + delim.length + 2);
    if (after[0] === 0x2d && after[1] === 0x2d) {
      closing = idx;
      break;
    }
    // A boundary that merely prefixes a longer one is not this boundary.
    if (after.length && after[0] !== CR && after[0] !== LF && after[0] !== 0x20 && after[0] !== 0x09) {
      continue;
    }
    delimiters.push(idx);
  }
  return { delimiters, closing };
}

/** Start of the part's own bytes: the byte after the delimiter line's CRLF. */
function partContentStart(body: Uint8Array, delimiterAt: number): number {
  let i = delimiterAt;
  while (i < body.length && body[i] !== LF) i++;
  return Math.min(i + 1, body.length);
}

/**
 * Drop the attachment parts of a multipart body, keeping every other byte
 * where it was. Non-multipart bodies come back untouched.
 *
 * Kept parts are copied as the exact byte ranges they occupied (delimiter
 * line, part, and the CRLF that leads into the next delimiter), so nothing a
 * client will render is re-serialised. Nested `multipart/mixed` children are
 * treated the same way; other containers (alternative, related, signed) are
 * left whole, because pulling a piece out of them changes what they mean.
 */
export function stripAttachmentParts(
  contentHeaders: readonly string[],
  body: Uint8Array,
): { body: Uint8Array; dropped: number } {
  const headers = parseHeaders(contentHeaders.join(CRLF));
  const ct = parseContentType(headers.get("content-type")?.[0] ?? null);
  if (!ct.mediaType.startsWith("multipart/") || !ct.params["boundary"]) {
    return { body, dropped: 0 };
  }
  const boundary = ct.params["boundary"];
  const { delimiters, closing } = layoutMultipart(body, boundary);
  if (delimiters.length === 0) return { body, dropped: 0 };

  const chunks: Uint8Array[] = [body.subarray(0, delimiters[0])];
  let dropped = 0;
  let keptAny = false;
  for (let i = 0; i < delimiters.length; i++) {
    const start = delimiters[i];
    const end = i + 1 < delimiters.length
      ? delimiters[i + 1]
      : closing !== -1
      ? closing
      : body.length;
    const contentStart = partContentStart(body, start);
    // The part proper excludes the CRLF that belongs to the next delimiter.
    let contentEnd = end;
    if (contentEnd >= 2 && body[contentEnd - 2] === CR && body[contentEnd - 1] === LF) contentEnd -= 2;
    else if (contentEnd >= 1 && body[contentEnd - 1] === LF) contentEnd -= 1;
    const part = body.subarray(contentStart, Math.max(contentStart, contentEnd));
    const { headerBlock: partHeaders, body: partBody } = splitRawMessage(part);

    if (isAttachmentPart(partHeaders)) {
      dropped++;
      continue;
    }
    const partCt = parseContentType(parseHeaders(partHeaders).get("content-type")?.[0] ?? null);
    if (partCt.mediaType === "multipart/mixed" && partCt.params["boundary"]) {
      const inner = stripAttachmentParts(contentHeaderLines(partHeaders), partBody);
      if (inner.dropped > 0) {
        dropped += inner.dropped;
        chunks.push(body.subarray(start, contentStart));
        chunks.push(ASCII.encode(partHeaders.replace(/\r?\n/g, CRLF) + CRLF + CRLF));
        chunks.push(inner.body);
        chunks.push(ASCII.encode(CRLF));
        keptAny = true;
        continue;
      }
    }
    chunks.push(body.subarray(start, end));
    keptAny = true;
  }
  if (dropped === 0) return { body, dropped: 0 };
  if (!keptAny) {
    // A multipart with no parts is not a message. Leave an empty text part so
    // the container stays well-formed; the intro part above it says the rest.
    chunks.push(ASCII.encode(`--${boundary}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}${CRLF}${CRLF}`));
  }
  chunks.push(closing !== -1 ? body.subarray(closing) : ASCII.encode(`--${boundary}--${CRLF}`));
  return { body: concatBytes(chunks), dropped };
}

// ── the intro part ───────────────────────────────────────────────────────────

const FORWARDED_RULE = "---------- Forwarded message ----------";

/** The plain-text forwarded-message block, as every mail client writes it. */
export function forwardedBlockText(summary: OriginalSummary): string {
  return [
    FORWARDED_RULE,
    `From: ${summary.from}`,
    `Date: ${summary.date}`,
    `Subject: ${summary.subject}`,
    `To: ${summary.to}`,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The same block for the HTML alternative of the intro, when the caller sent html_body. */
export function forwardedBlockHtml(summary: OriginalSummary): string {
  return `<div class="mcpemails-forwarded">${escapeHtml(FORWARDED_RULE)}<br>` +
    `From: ${escapeHtml(summary.from)}<br>` +
    `Date: ${escapeHtml(summary.date)}<br>` +
    `Subject: ${escapeHtml(summary.subject)}<br>` +
    `To: ${escapeHtml(summary.to)}</div>`;
}

/** Intro text part: the caller's note (already signed) above the block. */
export function composeIntroText(note: string | undefined, summary: OriginalSummary): string {
  const block = forwardedBlockText(summary);
  return note ? `${note}\n\n${block}\n` : `${block}\n`;
}

/** Intro HTML part: only built when the caller supplied html_body. */
export function composeIntroHtml(noteHtml: string, summary: OriginalSummary): string {
  return `${noteHtml}<br><br>${forwardedBlockHtml(summary)}`;
}

// ── the outgoing message ─────────────────────────────────────────────────────

export interface RelayForwardInput {
  /** Formatted sender mailbox, e.g. `Name <a@b>`. */
  from: string;
  to: string[];
  cc?: string[];
  /** Written as a header only with `includeBccHeader` (see mime-build.ts). */
  bcc?: string[];
  includeBccHeader?: boolean;
  subject: string;
  /** UUID without brackets; becomes `<uuid@mcpemails.com>`. */
  messageId: string;
  /** Complete text of the intro part. */
  introText: string;
  /** Complete HTML of the intro part, when the caller sent html_body. */
  introHtml?: string;
  /** The original message, raw. CRLF-normalised here if it is not already. */
  original: Uint8Array;
  includeAttachments: boolean;
  /** Wrap the whole original as message/rfc822 instead of relaying its body inline. */
  asAttachment: boolean;
}

export interface RelayForwardResult {
  bytes: Uint8Array;
  /** Attachment parts left behind because include_attachments was false. */
  droppedAttachments: number;
  eightBit: boolean;
}

/** A boundary that provably never occurs inside the bytes it will delimit. */
function freshBoundary(prefix: string, mustNotContain: readonly Uint8Array[]): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
    const probe = ASCII.encode("--" + candidate);
    if (mustNotContain.every((bytes) => indexOfBytes(bytes, probe) === -1)) return candidate;
  }
  throw new Error("could not choose a MIME boundary");
}

/** Filename for the message/rfc822 part: the subject, made safe, or a default. */
export function attachmentFilenameFor(subject: string): string {
  const base = subject.replace(/^\s*(fwd?|fw)\s*:\s*/i, "").trim()
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F"\\/:*?<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "Forwarded message"}.eml`;
}

/**
 * Build the outgoing forward. The bytes returned are the exact octets to hand
 * to SMTP DATA (before dot-stuffing), to Gmail's raw upload, or to Graph's
 * MIME send.
 */
export function buildRelayForwardMime(input: RelayForwardInput): RelayForwardResult {
  const original = normalizeCrlf(input.original);
  const { headerBlock, body } = splitRawMessage(original);

  const outer = freshBoundary("mcpe_", [original]);
  const head: string[] = [];
  head.push(`From: ${input.from}`);
  head.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) head.push(`Cc: ${input.cc.join(", ")}`);
  if (input.includeBccHeader && input.bcc?.length) head.push(`Bcc: ${input.bcc.join(", ")}`);
  head.push(`Subject: ${encodeMimeHeaderValue(input.subject)}`);
  head.push(`Date: ${new Date().toUTCString()}`);
  head.push(`Message-ID: <${input.messageId}@mcpemails.com>`);
  head.push("MIME-Version: 1.0");
  head.push(`Content-Type: multipart/mixed; boundary="${outer}"`);
  head.push("");

  // ── part 1: the note and the forwarded-message block ────────────────────
  head.push(`--${outer}`);
  if (input.introHtml) {
    const alt = freshBoundary("mcpe_alt_", [original]);
    head.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    head.push("");
    head.push(`--${alt}`);
    head.push("Content-Type: text/plain; charset=UTF-8");
    head.push("Content-Transfer-Encoding: base64");
    head.push("");
    head.push(encodeTextAsBase64Lines(input.introText));
    head.push("");
    head.push(`--${alt}`);
    head.push("Content-Type: text/html; charset=UTF-8");
    head.push("Content-Transfer-Encoding: base64");
    head.push("");
    head.push(encodeTextAsBase64Lines(input.introHtml));
    head.push("");
    head.push(`--${alt}--`);
  } else {
    head.push("Content-Type: text/plain; charset=UTF-8");
    head.push("Content-Transfer-Encoding: base64");
    head.push("");
    head.push(encodeTextAsBase64Lines(input.introText));
  }
  head.push("");
  head.push(`--${outer}`);

  // ── part 2: the original ────────────────────────────────────────────────
  let payload: Uint8Array;
  let droppedAttachments = 0;
  if (input.asAttachment) {
    const filename = encodeMimeHeaderValue(attachmentFilenameFor(input.subject));
    head.push(`Content-Type: message/rfc822; name="${filename}"`);
    head.push(`Content-Disposition: attachment; filename="${filename}"`);
    head.push(`Content-Transfer-Encoding: ${hasEightBitBytes(original) ? "8bit" : "7bit"}`);
    head.push("");
    payload = original;
  } else {
    const contentHeaders = contentHeaderLines(headerBlock);
    if (input.includeAttachments) {
      payload = body;
    } else {
      const stripped = stripAttachmentParts(contentHeaders, body);
      payload = stripped.body;
      droppedAttachments = stripped.dropped;
    }
    for (const line of contentHeaders) head.push(line);
    head.push("");
  }

  const bytes = concatBytes([
    ASCII.encode(head.join(CRLF) + CRLF),
    payload,
    ASCII.encode(`${CRLF}--${outer}--${CRLF}`),
  ]);
  return { bytes, droppedAttachments, eightBit: hasEightBitBytes(bytes) };
}
