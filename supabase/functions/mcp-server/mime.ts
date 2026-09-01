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

function parseHeaders(block: string): Map<string, string[]> {
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

interface ContentType {
  mediaType: string;
  params: Record<string, string>;
}

function parseContentType(value: string | null): ContentType {
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
    for (const sub of splitMultipart(body, boundary)) {
      const { headerBlock, body: subBody } = splitHeadersBody(sub);
      const subHeaders = parseHeaders(headerBlock);
      parsePart(subHeaders, subBody, out);
    }
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
    try {
      const bin = atob(clean);
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
