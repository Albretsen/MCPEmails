// ---------------------------------------------------------------------------
// Email HTML sanitizer — dependency-free, two layers, no innerHTML anywhere.
//
// Provenance: layer 1 is a direct port of
// `apps/web/src/lib/sanitizeSignatureHtmlServer.js`. That module is
// dependency-free *by design*: its DOMPurify-based sibling drags in jsdom,
// whose ESM-only transitive deps blew up at request time and 500'd every
// signature save in production. Adding a sanitizer dependency here would also
// blow the bundle budget (findings Q3/Q4), so the same discipline applies.
//
// Layer 1 alone is a deny-list, which is the weaker construction. Email bodies
// are more hostile than signatures (a reply or forward quotes inbound mail
// written by a stranger), so layer 2 re-parses with DOMParser and rebuilds the
// tree against an explicit ALLOW-list. The result is handed back as a live
// DocumentFragment and adopted into the DOM directly — it is never serialised
// back to a string, so there is no re-parse step and no mutation-XSS surface.
//
// DOMParser.parseFromString(html, "text/html") builds an inert document: no
// script execution, no resource loading. The card additionally runs in a
// sandboxed iframe whose CSP has empty connect/resource/frame/baseUri domains.
// ---------------------------------------------------------------------------

export const EMAIL_HTML_MAX_LENGTH = 512 * 1024;

// ---- text neutralisation ---------------------------------------------------

/**
 * Invisible characters that let attacker-controlled *plain text* lie about
 * itself. Found while building this card: the harness fixture filename
 * `invoice<U+202E> fdp.exe` renders as `invoiceexe.pdf` — a right-to-left
 * override flips the tail so an executable looks like a PDF. The same trick
 * works on subjects and display names.
 *
 * Stripped: C0/C1 controls (except \t \n \r), zero-width and bidi formatting
 * characters, the BOM, and the Unicode bidi isolates.
 */
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function neutralizeText(value: string): string {
  return value.replace(UNSAFE_TEXT, "");
}

/**
 * Deep-clone a decoded payload, neutralising every string in it.
 *
 * Applied once, at the boundary where a tool result becomes card state, so no
 * component has to remember. Bounded in depth and array length because the
 * payload is not trusted to be well-formed either.
 */
export function neutralizeDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return neutralizeText(value) as unknown as T;
  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((v) => neutralizeDeep(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = neutralizeDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

// ---- layer 1: ported deny-list pre-pass -----------------------------------

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

function stripOnce(html: string): string {
  let result = html;

  // HTML comments (also kills conditional-comment payloads).
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  for (const tag of BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"), "");
    result = result.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  }

  // Event-handler attributes: onclick="...", onload='...', onerror=x
  result = result.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // javascript: in href/src, any quoting.
  result = result.replace(
    /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    "",
  );

  // Interactive form elements.
  result = result.replace(
    /<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi,
    "",
  );

  return result;
}

/** Run the deny-list to a fixpoint so nested evasions (`<scr<script>ipt>`) die. */
function denyListPass(dirty: string): string {
  let clean = dirty;
  for (let i = 0; i < 10; i++) {
    const next = stripOnce(clean);
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

// ---- layer 2: allow-list rebuild ------------------------------------------

/**
 * Elements kept. Anything not listed is dropped but its *children* are kept,
 * so unknown wrappers lose their semantics rather than their text.
 *
 * Deliberately absent: img (all of them — remote images are tracking pixels and
 * the resource CSP is empty anyway; replaced with a visible "[image]" marker),
 * video/audio/source, canvas, template, slot, marquee, and every element from
 * BLOCK_TAGS above.
 */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del",
  "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "ins", "li", "ol", "p", "pre", "q", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "time", "tr", "u", "ul",
]);

/** Dropped along with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "textarea", "select", "option", "noscript",
  "svg", "math", "template", "canvas", "video", "audio", "source", "track",
  "applet", "frame", "frameset", "map", "area",
]);

/**
 * Attributes kept, per tag. No `style`, no `class`, no `id`, no `src`, no
 * `target`, no `srcset`, no data-*, no aria-* (an attacker-controlled aria
 * label is a screen-reader spoof).
 */
const GLOBAL_ATTRS = new Set(["dir", "lang", "title"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  ol: new Set(["start", "type"]),
  time: new Set(["datetime"]),
};

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const NUMERIC = /^[0-9]{1,4}$/;

function safeAttrValue(tag: string, name: string, raw: string): string | null {
  const value = raw.trim();
  if (value.length > 2048) return null;
  if (name === "href") {
    // Strip control chars/whitespace an attacker could use to hide a scheme
    // ("java\tscript:"). Then require an explicit safe scheme.
    const collapsed = value.replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, "");
    return SAFE_HREF.test(collapsed) ? collapsed : null;
  }
  if (name === "colspan" || name === "rowspan" || name === "start") {
    return NUMERIC.test(value) ? value : null;
  }
  if (name === "dir") {
    return /^(ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
  }
  if (name === "lang") {
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value) ? value : null;
  }
  if (name === "scope") {
    return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value.toLowerCase() : null;
  }
  if (name === "type") {
    return /^[a1AiI]$/.test(value) ? value : null;
  }
  void tag;
  // title and datetime: plain text, set via setAttribute (never parsed as markup).
  return value;
}

function isAllowedAttr(tag: string, name: string): boolean {
  if (name.startsWith("on")) return false;
  return GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag]?.has(name) ?? false);
}

function imagePlaceholder(alt: string | null): HTMLElement {
  const span = document.createElement("span");
  span.className = "img-placeholder";
  // textContent, never innerHTML.
  span.textContent = alt ? `[image: ${alt.slice(0, 80)}]` : "[image]";
  return span;
}

function rebuild(source: Node, into: Node, depth: number) {
  // Bound recursion: a deeply nested body is a cheap DoS otherwise.
  if (depth > 64) return;

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3 /* text */) {
      into.appendChild(
        document.createTextNode(neutralizeText(child.nodeValue ?? "")),
      );
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue; // comments, PIs, doctypes

    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (DROP_WITH_CONTENT.has(tag)) continue;

    if (tag === "img") {
      into.appendChild(imagePlaceholder(el.getAttribute("alt")));
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the text, lose the element.
      rebuild(el, into, depth + 1);
      continue;
    }

    const clean = document.createElement(tag);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!isAllowedAttr(tag, name)) continue;
      const value = safeAttrValue(tag, name, attr.value);
      if (value === null) continue;
      clean.setAttribute(name, value);
    }
    if (tag === "a") {
      // Links are inert inside the sandbox (no allow-top-navigation), but make
      // the intent explicit and surface the destination on hover.
      clean.setAttribute("rel", "noopener noreferrer nofollow");
      const href = clean.getAttribute("href");
      if (href && !clean.getAttribute("title")) clean.setAttribute("title", href);
    }
    rebuild(el, clean, depth + 1);
    into.appendChild(clean);
  }
}

export interface SanitizeResult {
  fragment: DocumentFragment;
  truncated: boolean;
}

/**
 * Sanitize hostile email HTML into a live, inert DocumentFragment.
 *
 * @param dirtyHtml Raw HTML from an email body.
 */
export function sanitizeEmailHtml(dirtyHtml: unknown): SanitizeResult {
  const fragment = document.createDocumentFragment();
  if (typeof dirtyHtml !== "string" || dirtyHtml === "") {
    return { fragment, truncated: false };
  }

  let truncated = false;
  let input = dirtyHtml;
  if (input.length > EMAIL_HTML_MAX_LENGTH) {
    input = input.slice(0, EMAIL_HTML_MAX_LENGTH);
    truncated = true;
  }

  const preCleaned = denyListPass(input);
  const doc = new DOMParser().parseFromString(preCleaned, "text/html");
  rebuild(doc.body, fragment, 0);
  return { fragment, truncated };
}
