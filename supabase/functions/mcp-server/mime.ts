/**
 * mime.ts — minimal RFC 5322 / MIME parser for the MCP edge function (Deno).
 *
 * IMAP returns raw RFC 822 bytes; unlike Gmail/Outlook/JMAP there is no
 * structured JSON. This parser extracts headers, the plain-text and HTML
 * bodies, and attachment metadata from a raw message.
 *
 * Input is a latin1 string (1 char === 1 byte) so byte-accurate decoding of
 * base64 / quoted-printable parts is possible. Charset decoding to UTF-8 is
 * applied per-part using the part's declared charset.
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

/** Parse a raw (latin1) RFC 822 message into structured parts. */
export function parseEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const result: ParsedEmail = { headers, text: null, html: null, attachments: [] };
  parsePart(headers, body, result);
  return result;
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

export function parseHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  // Unfold: lines beginning with whitespace continue the previous header.
  const lines = block.split(/\r\n|\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
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
  const mediaType = parts[0].trim().toLowerCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    const k = parts[i].slice(0, eq).trim().toLowerCase();
    let v = parts[i].slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { mediaType, params };
}

function parsePart(
  headers: Map<string, string[]>,
  body: string,
  out: ParsedEmail,
): void {
  const ct = parseContentType(getHeader(headers, "content-type"));
  const cte = (getHeader(headers, "content-transfer-encoding") ?? "7bit").toLowerCase();
  const disposition = getHeader(headers, "content-disposition") ?? "";
  const isAttachment = /attachment/i.test(disposition) ||
    (!!ct.params["name"] || /filename=/i.test(disposition));

  if (ct.mediaType.startsWith("multipart/")) {
    const boundary = ct.params["boundary"];
    if (!boundary) return;
    parseMultipartInto(body, boundary, out);
    return;
  }

  // Leaf part.
  const bytes = decodeContent(body, cte);

  if (isAttachment) {
    const filename = decodeEncodedWords(
      ct.params["name"] ?? filenameFromDisposition(disposition) ?? "attachment",
    );
    out.attachments.push({
      filename,
      mimeType: ct.mediaType,
      size: bytes.length,
      content: bytes,
    });
    return;
  }

  const charset = ct.params["charset"] ?? "utf-8";
  if (ct.mediaType === "text/plain" && out.text === null) {
    out.text = decodeCharset(bytes, charset);
  } else if (ct.mediaType === "text/html" && out.html === null) {
    out.html = decodeCharset(bytes, charset);
  } else if (ct.mediaType.startsWith("text/") && out.text === null) {
    out.text = decodeCharset(bytes, charset);
  }
}

// ---------------------------------------------------------------------------
// The first-party read (client-api only; first-party.ts `joinInlineParts`).
//
// `parsePart` keeps the FIRST text/plain and the FIRST text/html it meets and
// drops every later one. For a multipart/alternative that is right: the parts
// are one body in several forms. For a multipart/mixed it loses content: its
// inline text parts are shown one after another by every mail client. The
// forward this server itself composes (forward-relay.ts) is exactly that
// shape, note first and the original's own body second, so reading one back
// returned the note and the forwarded-message block and none of the original.
//
// `parseEmailJoined` walks the same tree with the same leaf decoding and joins
// the visible parts of a multipart/mixed (or any container that is not
// alternative/related) in order. It also restores the exact octets of an 8bit
// source first: the raw message arrives through TextDecoder("latin1"), which
// is windows-1252, and `latinToBytes` cannot undo that for 0x80-0x9F.
//
// MCP reads still go through `parseEmail`, unchanged.
// ---------------------------------------------------------------------------

/** What one part contributes to the displayed body. */
export interface ShownBody {
  text: string | null;
  html: string | null;
  /** A text part that is neither plain nor HTML: used only when nothing else is. */
  fallback?: boolean;
}

function escapeAsHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="white-space:pre-wrap">${escaped}</div>`;
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
  if (visible.some((c) => !c.fallback)) visible = visible.filter((c) => !c.fallback);
  if (visible.length === 0) return { text: null, html: null };
  if (mediaType === "multipart/alternative" || mediaType === "multipart/related" || visible.length === 1) {
    return {
      text: visible.find((c) => c.text !== null)?.text ?? null,
      html: visible.find((c) => c.html !== null)?.html ?? null,
    };
  }
  const texts = visible
    .map((c) => c.text !== null && c.text.trim() !== "" ? c.text : c.html ? htmlToText(c.html) : "")
    .map((t) => t.replace(/\s+$/, ""))
    .filter((t) => t !== "");
  const anyHtml = visible.some((c) => c.html !== null);
  return {
    text: texts.length ? texts.join("\n\n") : null,
    html: anyHtml ? visible.map((c) => c.html ?? escapeAsHtml(c.text ?? "")).join("\n") : null,
  };
}

/** The 0x80-0x9F code points of windows-1252, back to their octets. */
const CP1252_OCTETS: Map<number, number> = (() => {
  const bytes = new Uint8Array(0x20);
  for (let i = 0; i < 0x20; i++) bytes[i] = 0x80 + i;
  const chars = new TextDecoder("latin1").decode(bytes);
  const map = new Map<number, number>();
  for (let i = 0; i < chars.length; i++) map.set(chars.charCodeAt(i), 0x80 + i);
  return map;
})();

/** One character per octet, exactly, from a string read through TextDecoder("latin1"). */
function exactOctetString(raw: string): string {
  // deno-lint-ignore no-control-regex
  if (!/[^\x00-\xff]/.test(raw)) return raw;
  // deno-lint-ignore no-control-regex
  return raw.replace(/[^\x00-\xff]/g, (ch) => {
    const octet = CP1252_OCTETS.get(ch.charCodeAt(0));
    return octet === undefined ? ch : String.fromCharCode(octet);
  });
}

/** {@link parseEmail}, with the inline text parts of a multipart/mixed joined. */
export function parseEmailJoined(raw: string, htmlToText: (html: string) => string): ParsedEmail {
  const { headerBlock, body } = splitHeadersBody(exactOctetString(raw));
  const headers = parseHeaders(headerBlock);
  const out: ParsedEmail = { headers, text: null, html: null, attachments: [] };
  const shown = joinedPart(headers, body, out, htmlToText);
  out.text = shown.text;
  out.html = shown.html;
  return out;
}

function joinedPart(
  headers: Map<string, string[]>,
  body: string,
  out: ParsedEmail,
  htmlToText: (html: string) => string,
): ShownBody {
  const ct = parseContentType(getHeader(headers, "content-type"));
  const cte = (getHeader(headers, "content-transfer-encoding") ?? "7bit").toLowerCase();
  const disposition = getHeader(headers, "content-disposition") ?? "";
  const isAttachment = /attachment/i.test(disposition) ||
    (!!ct.params["name"] || /filename=/i.test(disposition));

  if (ct.mediaType.startsWith("multipart/")) {
    const boundary = ct.params["boundary"];
    if (!boundary) return { text: null, html: null };
    const children = splitMultipart(body, boundary).map((sub) => {
      const { headerBlock, body: subBody } = splitHeadersBody(sub);
      return joinedPart(parseHeaders(headerBlock), subBody, out, htmlToText);
    });
    return joinShownParts(ct.mediaType, children, htmlToText);
  }

  const bytes = decodeContent(body, cte);
  if (isAttachment) {
    out.attachments.push({
      filename: decodeEncodedWords(ct.params["name"] ?? filenameFromDisposition(disposition) ?? "attachment"),
      mimeType: ct.mediaType,
      size: bytes.length,
      content: bytes,
    });
    return { text: null, html: null };
  }
  const charset = ct.params["charset"] ?? "utf-8";
  if (ct.mediaType === "text/plain") return { text: decodeCharset(bytes, charset), html: null };
  if (ct.mediaType === "text/html") return { text: null, html: decodeCharset(bytes, charset) };
  if (ct.mediaType.startsWith("text/")) return { text: decodeCharset(bytes, charset), html: null, fallback: true };
  return { text: null, html: null };
}

/**
 * Walk every child of a multipart body into `out`.
 *
 * Split out of {@link parsePart} so the descent has exactly one implementation,
 * shared with {@link parseMultipartBodySource} — the entry point for the case
 * where the multipart's own headers were never fetched.
 */
function parseMultipartInto(body: string, boundary: string, out: ParsedEmail): void {
  for (const sub of splitMultipart(body, boundary)) {
    const { headerBlock, body: subBody } = splitHeadersBody(sub);
    parsePart(parseHeaders(headerBlock), subBody, out);
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
  parseMultipartInto(source, boundary, out);
  return out;
}

function filenameFromDisposition(disposition: string): string | null {
  const m = /filename\*?=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
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

/** Decode a part body (latin1 string) into bytes per its transfer encoding. */
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

/** Decode quoted-printable (latin1 string in, latin1 string out). */
function decodeQuotedPrintable(input: string): string {
  return input
    // Soft line breaks.
    .replace(/=\r?\n/g, "")
    // =XX hex escapes.
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function latinToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

/** Decode bytes to a UTF-8 string using the declared charset, with fallbacks. */
function decodeCharset(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return new TextDecoder("latin1").decode(bytes);
    }
  }
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
  return joined.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset: string, enc: string, data: string) => {
      try {
        let bytes: Uint8Array;
        if (enc.toUpperCase() === "B") {
          const bin = atob(data.replace(/\s/g, ""));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          // Q-encoding: like quoted-printable but "_" means space.
          const qp = data.replace(/_/g, " ");
          bytes = latinToBytes(decodeQuotedPrintable(qp));
        }
        return decodeCharset(bytes, charset);
      } catch {
        return data;
      }
    },
  );
}
