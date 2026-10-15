/**
 * mime.ts — minimal RFC 5322 / MIME parser for the MCP edge function (Deno).
 *
 * IMAP returns raw RFC 822 bytes; unlike Gmail/Outlook/JMAP there is no
 * structured JSON. This parser extracts headers, the plain-text and HTML
 * bodies, and attachment metadata from a raw message.
 *
 * Input is a BYTE STRING: one character per octet, `charCodeAt(i)` is octet i
 * for all 256 values. That is what `atob` returns and what the IMAP client
 * reads (byte-string.ts). It is NOT what TextDecoder("latin1") returns: that
 * label is windows-1252, which moves 0x80-0x9F above U+00FF, and a string
 * built that way loses those octets here. Each leaf part goes back to bytes
 * per its transfer encoding (8bit and binary included) and is decoded to text
 * exactly once, with the charset the part declares.
 */

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  size: number;
  /** Decoded binary content. */
  content: Uint8Array;
}

export interface ParsedEmail {
  /** Lowercased header name → list of raw values (RFC 2047 not yet decoded). */
  headers: Map<string, string[]>;
  text: string | null;
  html: string | null;
  attachments: MimeAttachment[];
}

/** Get the first value of a header (case-insensitive), or null. */
export function getHeader(headers: Map<string, string[]>, name: string): string | null {
  const v = headers.get(name.toLowerCase());
  return v && v.length > 0 ? v[0] : null;
}

/** Get all values of a header (case-insensitive). */
export function getHeaderAll(headers: Map<string, string[]>, name: string): string[] {
  return headers.get(name.toLowerCase()) ?? [];
}

/** Parse a raw RFC 822 message (a byte string) into structured parts. */
export function parseEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const result: ParsedEmail = { headers, text: null, html: null, attachments: [] };
  parsePart(headers, body, result);
  // After the walk, not before: the walk matches the boundary parameter against
  // the body octet for octet, so it has to see the header as it arrived.
  decodeRawHeaderValues(headers);
  return result;
}

/** Raw 8-bit header values to text, in place (see {@link decodeRawHeaderOctets}). */
function decodeRawHeaderValues(headers: Map<string, string[]>): void {
  for (const values of headers.values()) {
    for (let i = 0; i < values.length; i++) values[i] = decodeRawHeaderOctets(values[i]);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function splitHeadersBody(raw: string): { headerBlock: string; body: string } {
  let idx = raw.indexOf("\r\n\r\n");
  let sep = 4;
  if (idx === -1) {
    idx = raw.indexOf("\n\n");
    sep = 2;
  }
  if (idx === -1) return { headerBlock: raw, body: "" };
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + sep) };
}

/**
 * `String.prototype.trim` for a byte string: ASCII whitespace only.
 *
 * `trim()` also removes U+00A0, and in a byte string U+00A0 is the octet 0xA0,
 * which is the LAST octet of "à" (C3 A0), "Š", a third of CJK and of every
 * emoji ending in A0. Trimming a raw UTF-8 header value that ends in one cut
 * the character in half: "Subject: Voilà" read back as "Voil" + U+FFFD.
 */
function trimAscii(value: string): string {
  return value.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
}

export function parseHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  // Unfold: lines beginning with whitespace continue the previous header.
  const lines = block.split(/\r\n|\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + trimAscii(line);
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = trimAscii(line.slice(0, colon)).toLowerCase();
    const value = trimAscii(line.slice(colon + 1));
    const existing = headers.get(key);
    if (existing) existing.push(value);
    else headers.set(key, [value]);
  }
  return headers;
}

export interface ContentType {
  mediaType: string;
  params: Record<string, string>;
}

export function parseContentType(value: string | null): ContentType {
  if (!value) return { mediaType: "text/plain", params: {} };
  const parts = value.split(";");
  const mediaType = trimAscii(parts[0]).toLowerCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    const k = trimAscii(parts[i].slice(0, eq)).toLowerCase();
    let v = trimAscii(parts[i].slice(eq + 1));
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { mediaType, params };
}

function parsePart(
  headers: Map<string, string[]>,
  body: string,
  out: ParsedEmail,
  cutTail = false,
): void {
  const ct = parseContentType(getHeader(headers, "content-type"));
  const cte = (getHeader(headers, "content-transfer-encoding") ?? "7bit").toLowerCase();
  const disposition = getHeader(headers, "content-disposition") ?? "";
  const isAttachment = /attachment/i.test(disposition) ||
    (!!ct.params["name"] || /filename=/i.test(disposition));

  if (ct.mediaType.startsWith("multipart/")) {
    const boundary = ct.params["boundary"];
    if (!boundary) return;
    parseMultipartInto(body, boundary, out, cutTail);
    return;
  }

  // Leaf part.
  const bytes = decodeContent(body, cte);

  if (isAttachment) {
    out.attachments.push({
      filename: attachmentFilename(ct, disposition),
      mimeType: ct.mediaType,
      size: bytes.length,
      content: bytes,
    });
    return;
  }

  // No charset parameter is passed on as "": `decodeCharset` then looks at the
  // octets instead of assuming.
  const charset = ct.params["charset"] ?? "";
  if (ct.mediaType === "text/plain" && out.text === null) {
    out.text = decodeCharset(bytes, charset, cutTail);
  } else if (ct.mediaType === "text/html" && out.html === null) {
    out.html = decodeCharset(bytes, charset, cutTail);
  } else if (ct.mediaType.startsWith("text/") && out.text === null) {
    out.text = decodeCharset(bytes, charset, cutTail);
  }
}

// ---------------------------------------------------------------------------
// The displayed body: what `email_read` and client-api's read return
// (2026-10-04; first built for client-api alone, behind a first-party flag).
//
// `parsePart` keeps the FIRST text/plain and the FIRST text/html it meets and
// drops every later one. For a multipart/alternative that is right: the parts
// are one body in several forms. For a multipart/mixed it loses content: its
// inline text parts are shown one after another by every mail client. The
// forward this server itself composes (forward-relay.ts) is exactly that
// shape, note first and the original's own body second, so reading one back
// returned the note and the forwarded-message block and none of the original.
//
// `parseEmailJoined` walks the same tree with the same leaf decoding and
// returns the body a mail client would show:
//
//   * multipart/alternative, multipart/related: ONE body. The first plain and
//     the first HTML form found, never both forms of the same text.
//   * any other container (mixed, signed, report, ...): every inline text
//     part, in document order, separated by a blank line.
//   * a part with `Content-Disposition: attachment`, a `filename` or a `name`
//     is an attachment whatever its type. A text/plain attachment is listed in
//     `attachments` and is never part of the body.
//   * an inline message/rfc822 part contributes a short forwarded-message
//     block (From / Date / Subject / To) and then its own displayed body; its
//     attachments are listed as attachments, AFTER the message's own, so no
//     existing attachment index moves.
//   * a part that only has HTML contributes its text through `htmlToText`.
//
// A message with a single displayed part comes back exactly as `parseEmail`
// returns it, which is every ordinary message. `parseEmail` itself is unchanged
// and still serves the callers that quote or re-send a body.
// ---------------------------------------------------------------------------

/** What one part contributes to the displayed body. */
export interface ShownBody {
  text: string | null;
  html: string | null;
  /**
   * Shown only when nothing else is: a text part that is neither plain nor
   * HTML (text/calendar, text/rfc822-headers), or the body of an ATTACHED
   * message.
   */
  fallback?: boolean;
}

const NOTHING_SHOWN: ShownBody = { text: null, html: null };

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plainTextAsHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtmlText(text)}</div>`;
}

/** The text one part shows: its plain form, or its HTML converted. */
function shownText(part: ShownBody, htmlToText: (html: string) => string): string {
  if (part.text !== null && part.text.trim() !== "") return part.text;
  return part.html ? htmlToText(part.html) : "";
}

/**
 * Fold the children of one container into the body it displays.
 * `alternative` / `related`: one body, first text and first HTML found.
 * Anything else: every visible child, in order.
 */
export function joinShownParts(
  mediaType: string,
  children: readonly ShownBody[],
  htmlToText: (html: string) => string,
): ShownBody {
  let visible = children.filter((c) => c.text !== null || c.html !== null);
  const fallbackOnly = visible.length > 0 && visible.every((c) => c.fallback);
  if (!fallbackOnly) visible = visible.filter((c) => !c.fallback);
  if (visible.length === 0) return NOTHING_SHOWN;
  let joined: ShownBody;
  if (mediaType === "multipart/alternative" || mediaType === "multipart/related" || visible.length === 1) {
    joined = {
      text: visible.find((c) => c.text !== null)?.text ?? null,
      html: visible.find((c) => c.html !== null)?.html ?? null,
    };
  } else {
    const texts = visible
      .map((c) => shownText(c, htmlToText).replace(/\s+$/, ""))
      .filter((t) => t !== "");
    const htmls = visible.some((c) => c.html !== null)
      ? visible
        .map((c) => c.html ?? (c.text !== null && c.text.trim() !== "" ? plainTextAsHtml(c.text) : ""))
        .filter((h) => h !== "")
      : [];
    joined = {
      text: texts.length ? texts.join("\n\n") : null,
      html: htmls.length ? htmls.join("\n") : null,
    };
  }
  return fallbackOnly ? { ...joined, fallback: true } : joined;
}

/** The four header lines shown above an embedded message, already decoded. */
export interface EmbeddedMessageSummary {
  from: string;
  date: string;
  subject: string;
  to: string;
}

const EMBEDDED_MESSAGE_RULE = "---------- Forwarded message ----------";

/**
 * An inline message/rfc822 part as a mail client shows it: the same block
 * forward-relay.ts writes above a forward, then the embedded message's body.
 * A header the embedded message does not carry is left out.
 */
export function embeddedMessageBody(
  summary: EmbeddedMessageSummary,
  inner: ShownBody,
  htmlToText: (html: string) => string,
): ShownBody {
  const lines = [EMBEDDED_MESSAGE_RULE];
  if (summary.from) lines.push(`From: ${summary.from}`);
  if (summary.date) lines.push(`Date: ${summary.date}`);
  if (summary.subject) lines.push(`Subject: ${summary.subject}`);
  if (summary.to) lines.push(`To: ${summary.to}`);
  const body = shownText(inner, htmlToText);
  return {
    text: body.trim() !== "" ? `${lines.join("\n")}\n\n${body}` : lines.join("\n"),
    html: inner.html !== null ? `<div>${lines.map(escapeHtmlText).join("<br>")}</div>\n${inner.html}` : null,
  };
}

/** How deep message/rfc822 parts are followed before one is left unread. */
const MAX_EMBEDDED_MESSAGE_DEPTH = 8;

/** What the walk carries: the result, plus the files found inside embedded messages. */
interface JoinedWalk extends ParsedEmail {
  embeddedAttachments: MimeAttachment[];
}

/**
 * {@link parseEmail}, with `text` and `html` holding the displayed body: the
 * inline text parts of a multipart/mixed joined in order. See the block above.
 * `htmlToText` converts a part that has only HTML when it is joined to others.
 *
 * `attachments` lists the message's own attachments first, exactly as
 * `parseEmail` lists them, and the attachments of inline embedded messages
 * AFTER them. An attachment index that was valid before embedded messages were
 * read therefore still names the same file.
 */
export function parseEmailJoined(
  raw: string,
  htmlToText: (html: string) => string,
): ParsedEmail {
  const { headerBlock, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const out: JoinedWalk = { headers, text: null, html: null, attachments: [], embeddedAttachments: [] };
  const shown = joinedPart(headers, body, out, htmlToText, 0);
  // After the walk, as in parseEmail: the boundary is matched octet for octet.
  decodeRawHeaderValues(headers);
  return {
    headers,
    text: shown.text,
    html: shown.html,
    attachments: [...out.attachments, ...out.embeddedAttachments],
  };
}

function joinedPart(
  headers: Map<string, string[]>,
  body: string,
  out: JoinedWalk,
  htmlToText: (html: string) => string,
  depth: number,
): ShownBody {
  const ct = parseContentType(getHeader(headers, "content-type"));
  const cte = (getHeader(headers, "content-transfer-encoding") ?? "7bit").toLowerCase();
  const disposition = getHeader(headers, "content-disposition") ?? "";
  // The same rule as parsePart, so the attachment list never differs.
  const isAttachment = /attachment/i.test(disposition) ||
    (!!ct.params["name"] || /filename=/i.test(disposition));

  if (ct.mediaType.startsWith("multipart/")) {
    const boundary = ct.params["boundary"];
    if (!boundary) return NOTHING_SHOWN;
    const children = splitMultipart(body, boundary).map((sub) => {
      const { headerBlock, body: subBody } = splitHeadersBody(sub);
      return joinedPart(parseHeaders(headerBlock), subBody, out, htmlToText, depth);
    });
    return joinShownParts(ct.mediaType, children, htmlToText);
  }

  if (ct.mediaType === "message/rfc822" && !isAttachment && depth < MAX_EMBEDDED_MESSAGE_DEPTH) {
    // RFC 2046 allows only 7bit / 8bit / binary here; decode the others anyway.
    const embedded = cte === "base64" || cte === "quoted-printable"
      ? bytesToLatin(decodeContent(body, cte))
      : body;
    const { headerBlock, body: embeddedBody } = splitHeadersBody(embedded);
    const embeddedHeaders = parseHeaders(headerBlock);
    const header = (name: string) =>
      decodeEncodedWords(decodeRawHeaderOctets(getHeader(embeddedHeaders, name) ?? ""));
    const inner = joinedPart(embeddedHeaders, embeddedBody, out, htmlToText, depth + 1);
    return embeddedMessageBody(
      { from: header("from"), date: header("date"), subject: header("subject"), to: header("to") },
      inner,
      htmlToText,
    );
  }

  const bytes = decodeContent(body, cte);
  if (isAttachment) {
    (depth === 0 ? out.attachments : out.embeddedAttachments).push({
      filename: attachmentFilename(ct, disposition),
      mimeType: ct.mediaType,
      size: bytes.length,
      content: bytes,
    });
    return NOTHING_SHOWN;
  }
  const charset = ct.params["charset"] ?? "";
  if (ct.mediaType === "text/plain") return { text: decodeCharset(bytes, charset), html: null };
  if (ct.mediaType === "text/html") return { text: null, html: decodeCharset(bytes, charset) };
  if (ct.mediaType.startsWith("text/")) return { text: decodeCharset(bytes, charset), html: null, fallback: true };
  return NOTHING_SHOWN;
}

function bytesToLatin(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}

/**
 * Walk every child of a multipart body into `out`.
 *
 * Split out of {@link parsePart} so the descent has exactly one implementation,
 * shared with {@link parseMultipartBodySource} — the entry point for the case
 * where the multipart's own headers were never fetched.
 */
function parseMultipartInto(body: string, boundary: string, out: ParsedEmail, cutTail = false): void {
  for (const sub of splitMultipart(body, boundary)) {
    const { headerBlock, body: subBody } = splitHeadersBody(sub);
    parsePart(parseHeaders(headerBlock), subBody, out, cutTail);
  }
}

/** How far into a part body we look for its first boundary delimiter. */
const MULTIPART_SNIFF_CHARS = 4096;

/**
 * The first boundary delimiter line of a part body: "--" plus the boundary,
 * alone on a line. RFC 2046 allows trailing whitespace on that line which is
 * not part of the boundary, so it is trimmed off the capture below.
 */
const FIRST_DELIMITER_LINE = /(?:^|\r?\n)--([^\r\n]{1,200})\r?\n/;

/** An RFC 5322 field name followed by its colon, at the start of a line. */
const PART_HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]{0,60}:/;

/**
 * The boundary a raw part BODY is delimited by, or null when the source is not
 * a multipart body at all.
 *
 * This exists because a fetched part body arrives without the headers that
 * declare it: `BODY[1]` of a multipart/mixed message returns the bytes of part
 * one and nothing else, so when part one is itself a multipart/alternative the
 * only surviving statement of its boundary is the delimiter line the body
 * starts with. Reading it back off that line is what makes the nested descent
 * possible at all (F-03, 2026-09-20 — see previewFromBodyPartSource).
 *
 * Two guards keep a plain-text body that merely starts a line with "--" (a
 * signature separator, a dashed rule) from being mistaken for a multipart: the
 * delimiter must be followed immediately by something shaped like a MIME header
 * field, and only the head of the source is examined.
 */
export function multipartBoundaryOfSource(source: string): string | null {
  const head = source.slice(0, MULTIPART_SNIFF_CHARS);
  const delimiter = FIRST_DELIMITER_LINE.exec(head);
  if (!delimiter) return null;
  const boundary = delimiter[1].replace(/[ \t]+$/, "");
  if (!boundary) return null;
  const afterDelimiter = head.slice(delimiter.index + delimiter[0].length);
  if (!PART_HEADER_LINE.test(afterDelimiter)) return null;
  return boundary;
}

/**
 * Parse a raw part BODY that is itself a multipart, discovering its boundary
 * from the source. Returns null when the source is not a multipart body, so the
 * caller can fall back to treating it as a leaf part.
 *
 * The returned `headers` map is empty on purpose: this parses a body whose own
 * headers were never fetched, and inventing them would be a lie a caller could
 * read back out.
 */
export function parseMultipartBodySource(source: string): ParsedEmail | null {
  const boundary = multipartBoundaryOfSource(source);
  if (!boundary) return null;
  const out: ParsedEmail = { headers: new Map(), text: null, html: null, attachments: [] };
  // The one caller is the preview, whose source is a PREFIX of the part: a
  // UTF-8 sequence may be cut at its end (see decodeUndeclared).
  parseMultipartInto(source, boundary, out, true);
  return out;
}

function filenameFromDisposition(disposition: string): string | null {
  const m = /filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
  if (!m) return null;
  return trimAscii(m[1] ?? m[2] ?? "");
}

/**
 * An RFC 2231 parameter (`name*=charset'lang'%XX...`, or the continuation
 * forms `name*0*=` / `name*1=`) of a header value, decoded; null when the
 * header carries none for `name`.
 *
 * Until 2026-10-04 `filename*=UTF-8''%E2%82%AC.pdf` was read by the plain
 * `filename=` rule and the attachment was listed as "UTF-8''%E2%82%AC.pdf".
 */
function rfc2231Parameter(header: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|;)[ \\t\\r\\n]*${name}\\*(?:(\\d+)(\\*)?)?=[ \\t]*("[^"]*"|[^;]*)`, "gi");
  const segments: { index: number; extended: boolean; value: string }[] = [];
  for (let m = pattern.exec(header); m !== null; m = pattern.exec(header)) {
    let value = trimAscii(m[3]);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    segments.push({ index: m[1] === undefined ? 0 : Number(m[1]), extended: m[1] === undefined || m[2] === "*", value });
  }
  if (segments.length === 0) return null;
  segments.sort((a, b) => a.index - b.index);
  let charset = "";
  let octets = "";
  segments.forEach((segment, i) => {
    let value = segment.value;
    if (!segment.extended) {
      octets += value;
      return;
    }
    if (i === 0) {
      const quoted = /^([^']*)'[^']*'([\s\S]*)$/.exec(value);
      if (quoted) {
        charset = quoted[1];
        value = quoted[2];
      }
    }
    octets += value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  });
  return decodeCharset(latinToBytes(octets), charset);
}

/**
 * The name an attachment part is listed under. In order: the Content-Type
 * `name`, the disposition's RFC 2231 `filename*`, its plain `filename`. The
 * plain forms may hold RFC 2047 encoded-words or raw 8-bit octets, and both
 * are decoded. (Whether a part IS an attachment is decided by the caller and
 * does not look at `filename*`, so no attachment index moves.)
 */
function attachmentFilename(ct: ContentType, disposition: string): string {
  const plain = ct.params["name"];
  if (plain !== undefined) return decodeEncodedWords(decodeRawHeaderOctets(plain));
  const extended = rfc2231Parameter(disposition, "filename");
  if (extended !== null && extended !== "") return extended;
  const filename = filenameFromDisposition(disposition);
  if (filename !== null) return decodeEncodedWords(decodeRawHeaderOctets(filename));
  return "attachment";
}

/** Split a multipart body into its constituent parts by boundary. */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const parts: string[] = [];
  const segments = body.split(delim);
  for (const seg of segments) {
    // Skip the preamble (before first boundary), the closing "--", and epilogue.
    if (seg === "" || seg.startsWith("--")) continue;
    // Each part begins right after the boundary's CRLF.
    parts.push(seg.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return parts;
}

/** Decode a part body (a byte string) into bytes per its transfer encoding. */
function decodeContent(body: string, cte: string): Uint8Array {
  if (cte === "base64") {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, "");
    // Trim to a whole quantum. A complete part is always a multiple of four
    // here, but a PARTIAL fetch is not: the preview path asks for the first 2KB
    // of a part, which cuts base64 mid-quantum, `atob` then throws, and the
    // latin1 fallback below hands the alphabet itself back as if it were text.
    // That is one of the two ways raw base64 reached a preview verbatim (F-03,
    // 2026-09-20). Losing up to three characters off the tail of a snippet costs
    // nothing; emitting the encoding costs the reader the whole field.
    const whole = clean.slice(0, clean.length - (clean.length % 4));
    try {
      const bin = atob(whole);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch {
      return latinToBytes(body);
    }
  }
  if (cte === "quoted-printable") {
    return latinToBytes(decodeQuotedPrintable(body));
  }
  // 7bit / 8bit / binary — raw bytes.
  return latinToBytes(body);
}

/** Decode quoted-printable (byte string in, byte string out). */
function decodeQuotedPrintable(input: string): string {
  return input
    // Soft line breaks.
    .replace(/=\r?\n/g, "")
    // =XX hex escapes.
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The octets of a byte string. Exact only for a byte string: see the note at
 * the top of this file on why the input must not come from
 * TextDecoder("latin1").
 */
function latinToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Charset labels that say nothing about 8-bit octets. `us-ascii` is the MIME
 * default and what careless senders put on a body that is really UTF-8 or
 * windows-1252; the rest are what mailers write when they do not know.
 */
const UNINFORMATIVE_CHARSETS = new Set([
  "",
  "us-ascii",
  "ascii",
  "ansi_x3.4-1968",
  "iso646-us",
  "unknown-8bit",
  "x-unknown",
  "default",
]);

const UTF8_LENIENT = new TextDecoder("utf-8", { fatal: false });
const WINDOWS_1252 = new TextDecoder("windows-1252");

/**
 * Text for octets nobody declared a usable charset for: UTF-8 when they are
 * valid UTF-8, windows-1252 otherwise.
 *
 * One decode in the common case. The lenient result is checked for U+FFFD, and
 * only when one is present are the octets validated strictly.
 *
 * `cutTail` is for a source known to be a PREFIX (the 2 KB preview fetch): the
 * validation then accepts a sequence cut off at the very end (`stream: true`),
 * which must not turn the whole text into windows-1252. It is off for anything
 * complete, a header value or a whole body, because there the same leniency
 * misreads windows-1252 text that ENDS in an accented letter: 0xE9 ("é") is
 * also the first octet of a three-octet UTF-8 sequence, so "Café" passed as
 * "valid UTF-8, cut short" and read back as "Caf" + U+FFFD.
 */
function decodeUndeclared(bytes: Uint8Array, cutTail = false): string {
  const lenient = UTF8_LENIENT.decode(bytes);
  if (!lenient.includes("\ufffd")) return lenient;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cutTail });
    return lenient;
  } catch {
    return WINDOWS_1252.decode(bytes);
  }
}

/**
 * Decode bytes to text with the declared charset. A missing, uninformative or
 * unknown charset falls to {@link decodeUndeclared}.
 *
 * `iso-8859-1` and `latin1` decode as windows-1252, as the WHATWG encoding
 * standard specifies and as every mail client does: mail labelled 8859-1 that
 * uses 0x80-0x9F means curly quotes, not C1 controls.
 */
function decodeCharset(bytes: Uint8Array, charset: string, cutTail = false): string {
  const label = charset.trim().toLowerCase();
  if (!UNINFORMATIVE_CHARSETS.has(label)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      // Not a label this runtime knows: let the octets decide.
    }
  }
  return decodeUndeclared(bytes, cutTail);
}

/** Any octet above 0x7F, in a byte string. */
const EIGHT_BIT_OCTET = /[\x80-\xff]/;
/** Any code unit that is not an octet: the string is already text. */
// deno-lint-ignore no-control-regex -- the range IS the test.
const NOT_AN_OCTET = /[^\x00-\xff]/;

/**
 * A raw header value (a byte string) as text.
 *
 * Headers are meant to be 7-bit, with RFC 2047 encoded-words for the rest, and
 * for those this returns its input. Senders that write raw 8-bit octets into a
 * Subject or a display name anyway (UTF-8 mostly, RFC 6532 even allows it;
 * windows-1252 from old systems) get them decoded as {@link decodeUndeclared}
 * does a body. Without this a raw UTF-8 subject reads as mojibake, and since
 * the read path became byte-exact a raw windows-1252 one would read as C1
 * control characters where it used to read, by accident, correctly.
 *
 * A value holding any code unit above U+00FF is not a byte string and is
 * returned untouched.
 */
export function decodeRawHeaderOctets(value: string): string {
  if (!EIGHT_BIT_OCTET.test(value) || NOT_AN_OCTET.test(value)) return value;
  return decodeUndeclared(latinToBytes(value));
}

/**
 * Decode RFC 2047 encoded-words in a header value, e.g.
 *   =?UTF-8?B?...?=  or  =?ISO-8859-1?Q?...?=
 */
export function decodeEncodedWords(input: string): string {
  // RFC 2047 section 6.2: whitespace SEPARATING two adjacent encoded-words is
  // not part of the text and must be dropped. Senders rely on this, because an
  // encoded-word may not exceed 75 octets, so any long non-ASCII subject is
  // split into several and folded onto continuation lines. Facebook sends
  //   =?UTF-8?B?Q2hlY2sgb3V0IHRoZSBw?=      "Check out the p"
  //   =?UTF-8?B?b3N0IFRvcnN0ZWluIFZh?=      "ost Torstein Va"
  // and joining those with the folding space produced "Check out the p ost
  // Torstein Va tna ... s hared" on every read. The lookahead (rather than
  // consuming the opening "=?") is what lets three or more in a row collapse
  // in a single pass. Whitespace NOT between two encoded-words is real text
  // and is left alone.
  const joined = input.replace(/\?=[ \t]*(?:\r?\n)?[ \t]+(?==\?)/g, "?=");
  // A RUN of adjacent encoded-words is decoded together: the octets of
  // neighbours that name the same charset are concatenated before the charset
  // decode. RFC 2047 forbids splitting a multi-byte character across two
  // words, and senders do it anyway (a long UTF-8 or GBK subject cut every N
  // octets); decoded one word at a time, each half became U+FFFD.
  return joined.replace(/(?:=\?[^?]+\?[BbQq]\?[^?]*\?=)+/g, (run) => {
    let out = "";
    let charset = "";
    let pending: Uint8Array[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      let size = 0;
      for (const p of pending) size += p.length;
      const all = new Uint8Array(size);
      let at = 0;
      for (const p of pending) {
        all.set(p, at);
        at += p.length;
      }
      out += decodeCharset(all, charset);
      pending = [];
    };
    for (const word of run.matchAll(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g)) {
      const [, wordCharset, enc, data] = word;
      let bytes: Uint8Array;
      try {
        if (enc.toUpperCase() === "B") {
          const bin = atob(data.replace(/\s/g, ""));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          // Q-encoding: like quoted-printable but "_" means space.
          const qp = data.replace(/_/g, " ");
          bytes = latinToBytes(decodeQuotedPrintable(qp));
        }
      } catch {
        flush();
        out += data;
        continue;
      }
      if (pending.length > 0 && wordCharset.toLowerCase() !== charset.toLowerCase()) flush();
      charset = wordCharset;
      pending.push(bytes);
    }
    flush();
    return out;
  });
}
