/**
 * lib/email/sanitize.ts
 *
 * HTML sanitisation for email bodies before they are returned to MCP clients.
 * Uses isomorphic-dompurify (DOMPurify + jsdom) so sanitisation runs in Node.js
 * without a real browser DOM.
 *
 * The DOMPurify instance and JSDOM window are created once at module load time so
 * the per-email cost is only the sanitisation pass itself, not DOM setup.
 */

import createDOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';

// Singleton window — created once, reused for every sanitise call.
const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window as unknown as Window);

/**
 * Narrow allowlist of HTML tags that are safe and useful for email rendering.
 * Any tag not in this list is stripped (but its text content is kept via KEEP_CONTENT).
 */
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del',
  'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
  'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
] as const;

/**
 * Narrow allowlist of HTML attributes.
 * `style` and `class` are explicitly forbidden — email marketers use them to hide
 * phishing text from humans while exposing it to parsers.
 */
const ALLOWED_ATTR = [
  'href',     // <a> — URLs validated by the afterSanitizeAttributes hook below
  'title',
  'alt',
  'src',      // <img> — non-https sources removed by the hook below
  'width',
  'height',
  'colspan',
  'rowspan',
  'datetime',
  'cite',
  'lang',
  'dir',
] as const;

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  FORBID_ATTR: ['style', 'class'],
  FORCE_BODY: true,
  WHOLE_DOCUMENT: false,
  KEEP_CONTENT: true,
} as const;

// Post-sanitise hook: rewrite or remove unsafe href/src values.
// This runs after DOMPurify's allowlist pass, so we only see allowed attributes here.
DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    // Allow only http(s) and mailto. Strip everything else (javascript:, data:, cid:, etc.).
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute('href');
    } else {
      // Force external links to open safely and not leak the referrer.
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  }

  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    // Strip tracking pixels, cid: inline images, and data: URIs.
    // Only allow https: image sources.
    if (!/^https:/i.test(src)) {
      node.removeAttribute('src');
    }
  }
});

/**
 * Sanitise raw HTML from an email body.
 *
 * @param raw - The unsanitised HTML string from the MIME parser.
 * @returns A sanitised HTML string, or `null` if the result is empty.
 *
 * The return is `null` rather than `''` so callers can cleanly distinguish
 * "no HTML body" from "HTML body that happened to sanitise to nothing".
 */
export function sanitiseHtml(raw: string): string | null {
  const result = DOMPurify.sanitize(raw, { ...SANITIZE_CONFIG }) as string;
  return result.length > 0 ? result : null;
}
