/* Email HTML sanitizer for the reader. Dependency-free, DOMParser-based,
 * allow-list only. Ported from apps/mcp-app/src/sanitize.ts (layer 2: rebuild
 * the tree against an explicit allow-list) with three differences:
 *
 *   1. The result is a STRING, because the reader puts it into an iframe
 *      `srcdoc`. Serialising re-opens the mutation-XSS question the original
 *      avoids by adopting a fragment, so this sanitizer is NOT the only
 *      barrier: the iframe has no `allow-scripts`, and the document carries a
 *      `default-src 'none'` CSP. Markup that survived a re-parse still could
 *      not run or load anything.
 *   2. A filtered `style` attribute and the presentational table attributes
 *      are kept, so real-world mail keeps its layout. `<style>` blocks,
 *      `class` and `id` are dropped.
 *   3. `<img>` is kept only for `data:image/*` sources. Remote images are
 *      replaced by a text placeholder and counted, `cid:` images too (inline
 *      attachments are not wired yet) but those are not counted as remote.
 *
 * DOMParser.parseFromString(html, "text/html") builds an inert document: no
 * script runs and no resource loads while parsing.
 */

export const EMAIL_HTML_MAX_LENGTH = 512 * 1024;

/** Invisible characters that let text lie about itself (bidi overrides,
 *  zero-width, C0/C1 controls except \t \n \r). */
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function neutralizeText(value: string): string {
  return value.replace(UNSAFE_TEXT, "");
}

/** Kept. Anything else is unwrapped: the element goes, its children stay. */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
  "div", "dl", "dt", "em", "figcaption", "figure", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "li", "ol", "p", "pre", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "time", "tr", "u", "ul",
]);

/** Dropped along with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea",
  "select", "option", "noscript", "svg", "math", "template", "canvas", "video", "audio", "source", "track",
  "applet", "frame", "frameset", "map", "area", "title", "head", "picture", "dialog", "marquee",
]);

const GLOBAL_ATTRS = new Set(["dir", "lang", "title", "style", "align"]);
const TABLE_ATTRS = ["width", "height", "bgcolor", "valign", "border", "cellpadding", "cellspacing"];
const CELL_ATTRS = new Set([...TABLE_ATTRS, "colspan", "rowspan"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  table: new Set(TABLE_ATTRS),
  tr: new Set(TABLE_ATTRS),
  td: CELL_ATTRS,
  th: new Set([...CELL_ATTRS, "scope"]),
  col: new Set(["width", "span"]),
  ol: new Set(["start", "type"]),
  time: new Set(["datetime"]),
  font: new Set(["color", "size", "face"]),
};

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const NUMERIC = /^[0-9]{1,4}$/;
const LENGTH = /^[0-9]{1,4}(\.[0-9]{1,2})?(px|%)?$/;
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([0-9.,%\s]+\))$/i;
/** Whitespace and controls an attacker can use to hide a scheme ("java\tscript:"). */
const URL_NOISE = /[\u0000- \u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g;

/* ---- inline styles ---- */

const STYLE_PROPS = new Set([
  "color", "background-color", "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "text-align", "text-decoration", "text-transform", "text-indent",
  "vertical-align", "white-space", "word-break", "overflow-wrap",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style",
  "border-width", "border-radius", "border-collapse", "border-spacing",
  "width", "max-width", "min-width", "height", "max-height", "min-height",
  "display", "list-style", "list-style-type", "table-layout",
]);
/** Anything that can fetch, script, escape or hide: reject the declaration. */
const STYLE_VALUE_DENY = /url\s*\(|expression|javascript:|@import|behavior|-moz-binding|[\\<>]|var\s*\(|image-set|attr\s*\(/i;
const DISPLAY_OK = /^(block|inline|inline-block|table|table-row|table-cell|list-item|none)$/i;

/** Filters a `style` attribute down to a harmless subset. Returns "" when nothing survives. */
export function sanitizeStyle(raw: string): string {
  if (raw.length > 4096) return "";
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = neutralizeText(decl.slice(i + 1)).trim().replace(/\s*!important$/i, "");
    if (!STYLE_PROPS.has(prop) || !value || value.length > 200) continue;
    if (STYLE_VALUE_DENY.test(value) || value.includes("/*")) continue;
    if (prop === "display" && !DISPLAY_OK.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

function safeAttrValue(name: string, raw: string): string | null {
  const value = raw.trim();
  if (name === "src") return DATA_IMAGE.test(value) && value.length <= 256 * 1024 ? value : null;
  if (value.length > 4096) return null;
  switch (name) {
    case "href": {
      const collapsed = value.replace(URL_NOISE, "");
      return SAFE_HREF.test(collapsed) && collapsed.length <= 2048 ? collapsed : null;
    }
    case "style":
      return sanitizeStyle(value) || null;
    case "colspan":
    case "rowspan":
    case "start":
    case "span":
    case "border":
    case "cellpadding":
    case "cellspacing":
      return NUMERIC.test(value) ? value : null;
    case "width":
    case "height":
      return LENGTH.test(value) ? value : null;
    case "bgcolor":
    case "color":
      return COLOR.test(value) ? value : null;
    case "size":
      return /^[+-]?[1-7]$/.test(value) ? value : null;
    case "face":
      return /^[\w\s,'"-]{1,120}$/.test(value) ? value : null;
    case "align":
      return /^(left|right|center|justify)$/i.test(value) ? value.toLowerCase() : null;
    case "valign":
      return /^(top|middle|bottom|baseline)$/i.test(value) ? value.toLowerCase() : null;
    case "dir":
      return /^(ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
    case "lang":
      return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value) ? value : null;
    case "scope":
      return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value.toLowerCase() : null;
    case "type":
      return /^[a1AiI]$/.test(value) ? value : null;
    default:
      // title, alt, datetime: plain text, set via setAttribute (never parsed as markup).
      return neutralizeText(value).slice(0, 500);
  }
}

function isAllowedAttr(tag: string, name: string): boolean {
  if (name.startsWith("on")) return false;
  return GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag]?.has(name) ?? false);
}

interface Counters {
  remoteImages: number;
}

function imagePlaceholder(doc: Document, alt: string | null): HTMLElement {
  const span = doc.createElement("span");
  span.setAttribute("data-blocked-image", "");
  span.textContent = alt?.trim() ? `[image: ${neutralizeText(alt).slice(0, 80)}]` : "[image]";
  return span;
}

function rebuild(doc: Document, source: Node, into: Node, depth: number, counters: Counters): void {
  // Bound recursion: a deeply nested body is a cheap DoS otherwise.
  if (depth > 64) return;

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      into.appendChild(doc.createTextNode(neutralizeText(child.nodeValue ?? "")));
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue; // comments, PIs, doctypes

    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;

    if (!ALLOWED_TAGS.has(tag) || el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      // Unwrap: keep the text, lose the element.
      rebuild(doc, el, into, depth + 1, counters);
      continue;
    }

    if (tag === "img") {
      const src = (el.getAttribute("src") ?? "").trim();
      if (!DATA_IMAGE.test(src)) {
        // Tracking pixels (1x1, hidden) vanish without a placeholder.
        const tiny = Number(el.getAttribute("width")) <= 2 || Number(el.getAttribute("height")) <= 2;
        if (!/^cid:/i.test(src)) counters.remoteImages++;
        if (!(tiny && el.hasAttribute("width"))) into.appendChild(imagePlaceholder(doc, el.getAttribute("alt")));
        continue;
      }
    }

    const clean = doc.createElement(tag);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!isAllowedAttr(tag, name)) continue;
      const value = safeAttrValue(name, attr.value);
      if (value === null) continue;
      clean.setAttribute(name, value);
    }
    if (tag === "a" && clean.hasAttribute("href")) {
      clean.setAttribute("rel", "noopener noreferrer");
      clean.setAttribute("target", "_blank");
      if (!clean.getAttribute("title")) clean.setAttribute("title", clean.getAttribute("href") ?? "");
    }
    rebuild(doc, el, clean, depth + 1, counters);
    into.appendChild(clean);
  }
}

export interface SanitizedEmailHtml {
  /** Inert markup: allow-listed elements and attributes only. */
  html: string;
  /** Remote images that were replaced by a placeholder. */
  remoteImages: number;
  /** The input was longer than EMAIL_HTML_MAX_LENGTH and was cut. */
  truncated: boolean;
}

/** Sanitizes hostile email HTML into an inert subset, as a string for `srcdoc`. */
export function sanitizeEmailHtml(dirty: unknown): SanitizedEmailHtml {
  if (typeof dirty !== "string" || dirty === "") return { html: "", remoteImages: 0, truncated: false };
  let input = dirty;
  let truncated = false;
  if (input.length > EMAIL_HTML_MAX_LENGTH) {
    input = input.slice(0, EMAIL_HTML_MAX_LENGTH);
    truncated = true;
  }
  const parsed = new DOMParser().parseFromString(input, "text/html");
  // Build in a second inert document, so nothing is ever attached to the app's own.
  const out = document.implementation.createHTMLDocument("");
  const counters: Counters = { remoteImages: 0 };
  rebuild(out, parsed.body, out.body, 0, counters);
  return { html: out.body.innerHTML, remoteImages: counters.remoteImages, truncated };
}

/** The CSP of the email frame: nothing loads, nothing runs. Inline styles and
 *  inline (data:/cid:) images only. */
export const EMAIL_FRAME_CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'";

/** Sandbox flags of the email frame. See EmailFrame for why allow-same-origin
 *  is on; `allow-scripts` must NEVER be added next to it. */
export const EMAIL_FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/* Base styles of the email document. They mirror the reader's plain-text card
 * (14.5 px / 1.65, --fg-2). The frame cannot see the app's CSS variables or
 * fonts, so the values are literal ("Geist" never loads there: the system
 * fallbacks after it are what render). `display:flow-root` on body keeps a
 * nested last margin inside it, so the measured height is the whole email. */
const FRAME_CSS = `
html{overflow-x:auto;overflow-y:hidden}
body{display:flow-root;margin:0;padding:0;font:14.5px/1.65 "Geist",ui-sans-serif,-apple-system,"Segoe UI",sans-serif;color:#2F3447;background:#fff;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
body>:first-child{margin-top:0}
body>:last-child{margin-bottom:0}
p{margin:0 0 12px}
a{color:#2547E5;text-underline-offset:.18em}
img{max-width:100%;height:auto}
table{border-collapse:collapse;max-width:100%}
blockquote{margin:0 0 12px;padding-left:12px;border-left:2px solid #DEE1EB;color:#626A7D}
pre{white-space:pre-wrap;font:12.5px/1.6 "Geist Mono",ui-monospace,Menlo,monospace}
hr{border:none;border-top:1px solid #DEE1EB;margin:16px 0}
h1,h2,h3,h4,h5,h6{color:#0B1020;line-height:1.3;margin:0 0 10px}
h1{font-size:20px}h2{font-size:17px}h3,h4,h5,h6{font-size:15px}
[data-blocked-image]{display:inline-block;padding:1px 6px;border:1px dashed #C6CBDA;border-radius:4px;font-size:12px;color:#626A7D}
`.replace(/\n/g, "");

/** The full `srcdoc` for ALREADY SANITIZED markup. */
export function buildEmailSrcdoc(cleanHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_FRAME_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<base target="_blank"><style>${FRAME_CSS}</style></head><body>${cleanHtml}</body></html>`
  );
}
