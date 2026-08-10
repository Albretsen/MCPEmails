// ---------------------------------------------------------------------------
// sanitizeSignatureHtml — server-side signature HTML sanitizer (web app)
// ---------------------------------------------------------------------------
//
// Signature HTML is stored on the inbox row, injected raw into outgoing mail,
// AND rendered in the dashboard preview, so it MUST be sanitized on the way in.
// This is a signature-tuned allowlist (distinct from the edge function's
// inbound `sanitizeEmailHtml`, which strips ALL external `src`): we KEEP
// https-hosted `<img>` (logos) and normal rich-text formatting, but strip
// scripts, styles, event handlers, iframes, SVG, and dangerous URLs.
//
// The browser path uses DOMPurify with the native DOM. During SSR we use the
// dependency-free server sanitizer so importing this client module never pulls
// jsdom into a Vercel serverless function.
// ---------------------------------------------------------------------------

import createDOMPurify from "dompurify";
import { sanitizeSignatureHtml as sanitizeSignatureHtmlServer } from "./sanitizeSignatureHtmlServer.js";

/**
 * Maximum length of the sanitized output, in bytes-ish (JS string length).
 * A signature is a small block of HTML plus a hosted image URL; ~100 KB is a
 * generous ceiling that still guards against pathological payloads. Input
 * longer than this after sanitization causes `sanitizeSignatureHtml` to THROW
 * (see below) rather than silently truncate, because truncating HTML mid-tag
 * would produce broken markup.
 */
export const SIGNATURE_HTML_MAX_LENGTH = 100 * 1024;

const ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "blockquote",
  "hr",
  "font",
];

const ALLOWED_ATTR = [
  "href",
  "target",
  "rel",
  "src",
  "alt",
  "width",
  "height",
  "style",
  "align",
  "color",
];

const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "svg",
  "math",
];

// DOMPurify's URI allowlist. We deliberately DO NOT include `data:` here (large
// base64 inline images are a non-goal and an XSS vector) and DO NOT include
// `javascript:`. `img[src]` is further tightened to https-only by the hook
// below; this regexp governs which schemes survive at all on any attribute.
// Relative URLs and fragment/anchor refs are also permitted by DOMPurify's
// default handling; the hook re-checks the two attributes we care about.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// Inline `style` properties that must never survive. Anything matching these
// (by property name or a poisoned value) is dropped from the style attribute.
// We keep benign presentational properties (color, font-*, text-align, width,
// height, background-color, etc.).
const FORBIDDEN_STYLE_PROP = /^(position|behavior|-moz-binding)$/i;
const FORBIDDEN_STYLE_VALUE = /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i;

let hooksRegistered = false;
let browserDOMPurify = null;

function getBrowserDOMPurify() {
  if (typeof window === "undefined") return null;
  if (!browserDOMPurify) browserDOMPurify = createDOMPurify(window);
  return browserDOMPurify;
}

function registerHooks(DOMPurify) {
  if (hooksRegistered) return;
  hooksRegistered = true;

  // Enforce URL-scheme rules per attribute and harden links / images.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.tagName ? node.tagName.toLowerCase() : "";

    // a[href]: only http(s) or mailto. Anything else (javascript:, data:,
    // relative, etc. that slipped past) is removed. Add noopener/noreferrer
    // to target=_blank links.
    if (tag === "a" && node.hasAttribute("href")) {
      const href = node.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href.trim())) {
        node.removeAttribute("href");
      }
    }
    if (tag === "a" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }

    // img[src]: https ONLY. Reject http:, data:, and anything else so a
    // signature can never leak plaintext over http or inline a huge/hostile
    // data URI. An image with a non-https src is dropped entirely.
    if (tag === "img") {
      const src = (node.getAttribute("src") || "").trim();
      if (!/^https:\/\//i.test(src)) {
        node.remove();
        return;
      }
    }

    // Scrub dangerous inline style properties while keeping benign formatting.
    if (node.hasAttribute("style")) {
      const cleaned = sanitizeStyle(node.getAttribute("style") || "");
      if (cleaned) {
        node.setAttribute("style", cleaned);
      } else {
        node.removeAttribute("style");
      }
    }
  });
}

/** Filter an inline style string to a safe subset of declarations. */
function sanitizeStyle(style) {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter(Boolean)
    .filter((decl) => {
      const idx = decl.indexOf(":");
      if (idx === -1) return false;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim();
      if (!prop || !value) return false;
      if (FORBIDDEN_STYLE_PROP.test(prop)) return false;
      if (FORBIDDEN_STYLE_VALUE.test(decl)) return false;
      return true;
    })
    .join("; ");
}

/**
 * Sanitize untrusted signature HTML into a safe, allowlisted subset.
 *
 * @param {string} dirtyHtml Raw HTML from the editor / MCP tool / API.
 * @returns {string} Sanitized HTML (may be empty).
 * @throws {Error} If input is not a string, or if the sanitized result exceeds
 *   SIGNATURE_HTML_MAX_LENGTH (~100 KB) — callers should surface this as a
 *   validation error rather than store truncated markup.
 */
export function sanitizeSignatureHtml(dirtyHtml) {
  if (typeof dirtyHtml !== "string") {
    throw new Error("sanitizeSignatureHtml: input must be a string");
  }
  if (dirtyHtml === "") return "";

  const DOMPurify = getBrowserDOMPurify();
  if (!DOMPurify) return sanitizeSignatureHtmlServer(dirtyHtml);

  registerHooks(DOMPurify);

  const clean = DOMPurify.sanitize(dirtyHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    // Belt-and-suspenders: drop all on* handlers even if a browser-specific
    // DOMPurify build would otherwise keep an exotic one.
    FORBID_ATTR: [],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP,
    // Return an HTML string, not a DOM node.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // Keep content of removed formatting-only wrappers where sensible; drop
    // dangerous elements wholesale (default DOMPurify behavior for FORBID_TAGS).
    KEEP_CONTENT: true,
  });

  if (clean.length > SIGNATURE_HTML_MAX_LENGTH) {
    throw new Error(
      `sanitizeSignatureHtml: sanitized HTML is ${clean.length} bytes, exceeds ${SIGNATURE_HTML_MAX_LENGTH} limit`,
    );
  }

  return clean;
}

export default sanitizeSignatureHtml;
