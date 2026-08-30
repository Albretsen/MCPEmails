// ---------------------------------------------------------------------------
// sanitizeSignatureHtmlServer: dependency-free signature HTML sanitizer for
// Node route handlers
// ---------------------------------------------------------------------------
//
// Why this exists alongside sanitizeSignatureHtml.js (the DOMPurify one):
// isomorphic-dompurify needs jsdom on the server, and jsdom's transitive deps
// (@asamuzakjp/css-color -> @csstools/css-calc) ship ESM-only. Under Next's
// server runtime on Vercel they are require()d as externals and crash with
// ERR_REQUIRE_ESM on every request, which 500'd every signature_html save in
// production. This module therefore has zero dependencies and cannot hit that
// failure mode.
//
// WHAT CHANGED: this used to be a hand-written regex DENY-LIST, a port of the
// one the edge function ran. That construction was bypassable (see the payload
// list at the top of ./htmlSanitizer.js for the seven inputs that went through
// it unchanged), so the sanitizing itself now lives in the shared allow-list
// tokenizer and this file is only the signature-specific wrapper around it:
// the SIGNATURE policy, plus the size and type contract the PATCH route relies
// on.
//
// It is one layer of three, not the only defense:
//   1. THIS pass gates what is stored.
//   2. The dashboard preview re-sanitizes with real DOMPurify in the browser
//      before any dangerouslySetInnerHTML render.
//   3. The edge function re-sanitizes at send time before HTML is injected
//      into outgoing mail.
//
// Signature-tuned: https-hosted <img> logos are KEPT, because a hosted logo is
// the point of a rich signature and the author is the account owner. http:,
// data: and ftp: image sources are stripped. (Email BODIES use the same
// tokenizer with the EMAIL policy, which keeps no external src at all: a body
// is written by a stranger and a remote image is a read receipt.)
//
// Same public API as the DOMPurify module so the PATCH route's error handling
// is unchanged: throws on non-string input and on output > 100KB.
// ---------------------------------------------------------------------------

import {
  sanitizeHtml,
  SIGNATURE_HTML_MAX_LENGTH,
  SIGNATURE_HTML_POLICY,
} from "./htmlSanitizer.js";

export { SIGNATURE_HTML_MAX_LENGTH };

/**
 * Sanitize untrusted signature HTML without any DOM dependency.
 *
 * @param {string} dirtyHtml Raw HTML from the editor / API client.
 * @returns {string} Sanitized HTML (may be empty).
 * @throws {Error} If input is not a string, or if the sanitized result exceeds
 *   SIGNATURE_HTML_MAX_LENGTH (~100 KB).
 */
export function sanitizeSignatureHtml(dirtyHtml) {
  if (typeof dirtyHtml !== "string") {
    throw new Error("sanitizeSignatureHtml: input must be a string");
  }
  if (dirtyHtml === "") return "";

  const clean = sanitizeHtml(dirtyHtml, SIGNATURE_HTML_POLICY);

  // The tokenizer truncates at the policy ceiling; the route contract is to
  // REJECT an oversized signature rather than silently store a cut one, so the
  // check stays here and is deliberately `>=` of the same limit.
  if (clean.length >= SIGNATURE_HTML_MAX_LENGTH) {
    throw new Error(
      `sanitizeSignatureHtml: sanitized HTML is ${clean.length} bytes, exceeds ${SIGNATURE_HTML_MAX_LENGTH} limit`,
    );
  }

  return clean;
}

export default sanitizeSignatureHtml;
