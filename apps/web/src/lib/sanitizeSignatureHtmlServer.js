// ---------------------------------------------------------------------------
// sanitizeSignatureHtmlServer — dependency-free signature HTML sanitizer for
// Node route handlers
// ---------------------------------------------------------------------------
//
// Why this exists alongside sanitizeSignatureHtml.js (the DOMPurify one):
// isomorphic-dompurify needs jsdom on the server, and jsdom's transitive deps
// (@asamuzakjp/css-color -> @csstools/css-calc) ship ESM-only. Under Next's
// server runtime on Vercel they are require()d as externals and crash with
// ERR_REQUIRE_ESM on every request, which 500'd every signature_html save in
// production. This module is a pure-regex port of the signature sanitizer the
// MCP edge function already runs in production (supabase/functions/mcp-server
// index.ts sanitizeSignatureHtml), so it has zero dependencies and cannot hit
// that failure mode.
//
// It is one layer of three, not the only defense:
//   1. THIS pass gates what is stored (strips script/style/iframe/etc., all
//      on*= handlers, javascript: URLs, non-https img src).
//   2. The dashboard preview re-sanitizes with real DOMPurify in the browser
//      before any dangerouslySetInnerHTML render.
//   3. The edge function re-sanitizes at send time before HTML is injected
//      into outgoing mail.
//
// Signature-tuned like the edge version: https-hosted <img> logos are KEPT;
// http:, data:, ftp: image sources are stripped.
//
// Same public API as the DOMPurify module so the PATCH route's error handling
// is unchanged: throws on non-string input and on output > 100KB.
// ---------------------------------------------------------------------------

export const SIGNATURE_HTML_MAX_LENGTH = 100 * 1024;

const BLOCK_TAGS = [
  "script",
  "style",
  "link",
  "meta",
  "iframe",
  "object",
  "embed",
  "base",
  "form",
  "noscript",
  "svg",
  "math",
];

/** One pass of the strip rules. Run to fixpoint by the exported function. */
function stripOnce(html) {
  let result = html;

  // HTML comments (also kills conditional-comment payloads).
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // Dangerous block elements and their full content.
  for (const tag of BLOCK_TAGS) {
    // Paired open+content+close: <tag ...>...</tag>
    result = result.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"), "");
    // Self-closing variants: <tag ... />
    result = result.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
    // Orphaned opening/standalone tags:
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  }

  // All event-handler attributes: onclick="...", onload='...', onerror=x
  result = result.replace(
    /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );

  // href/src="javascript:..." (any quoting).
  result = result.replace(
    /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    "",
  );

  // Non-https image sources. https: img src is intentionally KEPT (hosted
  // logos); http:, data:, ftp: and other schemes are removed.
  result = result.replace(
    /\s+src\s*=\s*(?:"(?:http|ftp|data):[^"]*"|'(?:http|ftp|data):[^']*'|(?:http|ftp|data):[^\s>]+)/gi,
    "",
  );

  // Interactive form elements.
  result = result.replace(
    /<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi,
    "",
  );

  return result;
}

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

  // Iterate to a fixpoint so nested-tag evasions (e.g. <scr<script>ipt>) that
  // survive one pass are caught by the next. Bounded to guard against
  // pathological ping-pong input; 10 passes is far beyond any legit signature.
  let clean = dirtyHtml;
  for (let i = 0; i < 10; i++) {
    const next = stripOnce(clean);
    if (next === clean) break;
    clean = next;
  }

  if (clean.length > SIGNATURE_HTML_MAX_LENGTH) {
    throw new Error(
      `sanitizeSignatureHtml: sanitized HTML is ${clean.length} bytes, exceeds ${SIGNATURE_HTML_MAX_LENGTH} limit`,
    );
  }

  return clean;
}

export default sanitizeSignatureHtml;
