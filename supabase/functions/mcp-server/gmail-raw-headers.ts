// ---------------------------------------------------------------------------
// gmail-raw-headers.ts — the RAW header block of a Gmail message, read from
// the start of a `format=raw` response and nothing more (2026-10-16).
//
// WHY: Gmail's `format=metadata` / `format=full` header values arrive with
// RFC 2047 encoded-words already DECODED. Splitting such a value into
// recipients is the decode-then-split bug address-header.ts exists to prevent:
// a sender whose encoded display name decodes to "x@evil.com," turns one
// mailbox into two, and reply-all would address both. No rule applied to the
// decoded text can tell that apart from a genuine two-mailbox list, so the
// recipient structure has to come from the raw header.
//
// HOW, CHEAPLY: `format=raw` returns the whole message base64url-encoded in a
// small JSON envelope, attachments included. The header block is at the very
// start of `raw`, so this reads the response stream only until the decoded
// prefix holds the blank line that ends the headers, then cancels the body.
// Memory is bounded by `maxBytes` whatever the message size.
//
// Pure (takes a stream), so it is tested without a network.
// ---------------------------------------------------------------------------

/** Default read ceiling: far above any real header block, far below a big message. */
export const GMAIL_RAW_HEADER_MAX_BYTES = 512 * 1024;

/**
 * Read the header block (byte string, one char per octet, without the blank
 * line) from a Gmail `format=raw` JSON response stream. Returns null when the
 * `raw` field or the end of the headers is not found within `maxBytes` of
 * response. Always cancels/releases the stream.
 */
export async function rawHeaderBlockFromGmailJson(
  body: ReadableStream<Uint8Array>,
  maxBytes = GMAIL_RAW_HEADER_MAX_BYTES,
): Promise<string | null> {
  const reader = body.getReader();
  const text = new TextDecoder("utf-8");
  let json = "";
  let readBytes = 0;
  let b64Start = -1;
  let decoded = "";
  let consumed = 0; // base64url chars of `raw` already decoded
  try {
    while (readBytes < maxBytes) {
      const { value, done } = await reader.read();
      if (value) {
        readBytes += value.length;
        json += text.decode(value, { stream: !done });
      }
      if (b64Start === -1) {
        // `"raw"` as a key: an unescaped quote (inside another string value it
        // would be written \"raw\").
        const m = /(?:^|[^\\])"raw"\s*:\s*"/.exec(json);
        if (m) b64Start = m.index + m[0].length;
      }
      if (b64Start !== -1) {
        const endQuote = json.indexOf('"', b64Start + consumed);
        const available = endQuote === -1 ? json.length - b64Start : endQuote - b64Start;
        // Decode whole 4-char groups only (the tail, when the string ended).
        const usable = endQuote === -1 ? available - (available % 4) : available;
        if (usable > consumed) {
          decoded += decodeBase64url(json.slice(b64Start + consumed, b64Start + usable));
          consumed = usable;
        }
        const crlf = decoded.indexOf("\r\n\r\n");
        const lf = decoded.indexOf("\n\n");
        const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
        if (end !== -1) return decoded.slice(0, end);
        // The whole message is headers only.
        if (endQuote !== -1) return decoded.length > 0 ? decoded : null;
      }
      if (done) return null;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function decodeBase64url(chunk: string): string {
  const b64 = chunk.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  return atob(padded);
}
