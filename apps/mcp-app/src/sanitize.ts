// ---------------------------------------------------------------------------
// Email HTML sanitizer — dependency-free, two layers, no innerHTML anywhere.
//
// Provenance: layer 1 was ported from the regex pass that used to live in
// `apps/web/src/lib/sanitizeSignatureHtmlServer.js`. NOTE that the source has
// since moved on: those regexes turned out to be bypassable (quote-instead-of-
// space before an on*= handler, a leading space or an HTML entity inside a
// javascript: URL, style-based schemes) and that module is now an allow-list
// tokenizer. Layer 1 here is kept as-is deliberately — it is a cheap
// pre-filter, NOT the security boundary; layer 2 below is. (Its regexes were
// replaced by linear scanners with identical output on 2026-10-16; see the
// layer-1 comment below.) Do not treat the
// regexes as sufficient on their own if you ever reuse them elsewhere.
//
// That module is dependency-free *by design*: its DOMPurify-based sibling drags
// in jsdom, whose ESM-only transitive deps blew up at request time and 500'd
// every signature save in production. Adding a sanitizer dependency here would
// also blow the bundle budget (findings Q3/Q4), so the same discipline applies.
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
//
// Until 2026-10-16 this was a chain of global regexes:
//
//   /<!--[\s\S]*?-->/g                                   -> ""
//   per BLOCK_TAG:  /<tag[\s\S]*?<\/tag>/gi, /<tag[^>]*\/>/gi, /<tag[^>]*>/gi
//   /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi    (event handlers)
//   /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi
//   /<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi
//
// Every one of them is quadratic on someone else's mail: an opener with no
// closer rescans to the end of the input from every opener, and `\s+` retries
// from every position of a whitespace run. 64K spaces took 3.9 s, 64 KB of
// `<svg` 1.7 s, inside the card, on every render.
//
// The scanners below produce EXACTLY what those regexes produced (same
// matches, same left-to-right non-overlapping replacement), in linear time.
// harness/sanitize.test.mjs keeps the regex chain verbatim as an oracle and
// fuzzes the two against each other. Regex facts relied on: `/i` without `/u`
// folds ASCII letters only (so `asciiLower` keeps offsets and is the same
// comparison), and `\s` is the ECMAScript whitespace set (`isJsSpace`).

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

const FORM_TAGS = ["input", "button", "textarea", "select"];

/** Lower-case A-Z only. Same length as the input, so offsets carry over. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Exactly the characters JS `\s` matches. */
function isJsSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 ||
    code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 ||
    code === 0xfeff;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Splice out the sorted, non-overlapping [start, end) ranges. */
function removeRanges(value: string, ranges: number[]): string {
  if (ranges.length === 0) return value;
  const parts: string[] = [];
  let pos = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    parts.push(value.slice(pos, ranges[r]));
    pos = ranges[r + 1];
  }
  parts.push(value.slice(pos));
  return parts.join("");
}

/** `/<!--[\s\S]*?-->/g` -> "". No `-->` left means no later comment closes either. */
function removeComments(value: string): string {
  const ranges: number[] = [];
  let open = value.indexOf("<!--");
  while (open !== -1) {
    const close = value.indexOf("-->", open + 4);
    if (close === -1) break;
    ranges.push(open, close + 3);
    open = value.indexOf("<!--", close + 3);
  }
  return removeRanges(value, ranges);
}

/** `<tag[\s\S]*?<\/tag>` (gi): opener to the FIRST `</tag>` after it. */
function removeBlocks(value: string, lower: string, tag: string): string {
  const opener = `<${tag}`;
  const closer = `</${tag}>`;
  const ranges: number[] = [];
  let open = lower.indexOf(opener);
  while (open !== -1) {
    const close = lower.indexOf(closer, open + opener.length);
    if (close === -1) break;
    ranges.push(open, close + closer.length);
    open = lower.indexOf(opener, close + closer.length);
  }
  return removeRanges(value, ranges);
}

/**
 * `<tag[^>]*>` (gi), or with `selfClosingOnly` `<tag[^>]*\/>` (gi): from the
 * opener to the first `>` after it (which must follow a `/` for the
 * self-closing form, past the opener itself). No `>` left: nothing later can
 * match either.
 */
function removeOpeningTags(
  value: string,
  lower: string,
  tags: string[],
  selfClosingOnly: boolean,
): string {
  const ranges: number[] = [];
  let gt = -1;
  let pos = 0;
  for (;;) {
    // The leftmost opener of any listed tag at or after `pos` (all start with
    // "<" and none is a prefix of another, so at most one matches per offset).
    let open = -1;
    let length = 0;
    for (let lt = lower.indexOf("<", pos); lt !== -1; lt = lower.indexOf("<", lt + 1)) {
      for (const tag of tags) {
        if (lower.startsWith(tag, lt + 1)) {
          open = lt;
          length = tag.length + 1;
          break;
        }
      }
      if (open !== -1) break;
    }
    if (open === -1) break;
    const after = open + length;
    if (gt < after) gt = value.indexOf(">", after);
    if (gt === -1) break;
    if (selfClosingOnly && !(gt - 1 >= after && value.charCodeAt(gt - 1) === 0x2f /* / */)) {
      pos = open + 1;
      continue;
    }
    ranges.push(open, gt + 1);
    pos = gt + 1;
  }
  return removeRanges(value, ranges);
}

/**
 * Where an attribute value ends, for `(?:"[^"]*"|'[^']*'|[^\s>]+)` starting at
 * `k`, or -1. A quote with no partner falls through to the bare form, which
 * takes the quote itself as its first character, exactly as the alternation
 * did.
 */
function attributeValueEnd(value: string, k: number, lastDouble: number, lastSingle: number): number {
  const code = value.charCodeAt(k);
  if (code === 0x22 /* " */ && lastDouble > k) return value.indexOf('"', k + 1) + 1;
  if (code === 0x27 /* ' */ && lastSingle > k) return value.indexOf("'", k + 1) + 1;
  let e = k;
  while (e < value.length) {
    const c = value.charCodeAt(e);
    if (isJsSpace(c) || c === 0x3e /* > */) break;
    e += 1;
  }
  return e > k ? e : -1;
}

/** Past `\s*=\s*` at `k`, or -1 when there is no `=`, or nothing after it. */
function afterEquals(value: string, k: number): number {
  const n = value.length;
  while (k < n && isJsSpace(value.charCodeAt(k))) k += 1;
  if (value.charCodeAt(k) !== 0x3d /* = */) return -1;
  k += 1;
  while (k < n && isJsSpace(value.charCodeAt(k))) k += 1;
  return k < n ? k : -1;
}

/**
 * The two attribute rules, both of the shape `\s+NAME\s*=\s*VALUE` (gi).
 *
 * `\s+` is greedy and NAME never starts with whitespace, so a match can only
 * begin at the first character of a whitespace run and must use the whole run;
 * if the run's tail does not match, no position inside the run does. So each
 * maximal run is tried once, from its start.
 *
 *   handlers:   NAME = on[a-z]+         VALUE = "[^"]*" | '[^']*' | [^\s>]+
 *   javascript: NAME = href|src         VALUE = "javascript:[^"]*" | 'javascript:[^']*' | javascript:[^\s>]+
 */
function removeAttributes(value: string, lower: string, javascriptOnly: boolean): string {
  const n = value.length;
  const lastDouble = value.lastIndexOf('"');
  const lastSingle = value.lastIndexOf("'");
  const ranges: number[] = [];
  let i = 0;
  while (i < n) {
    if (!isJsSpace(value.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && isJsSpace(value.charCodeAt(i))) i += 1;
    // `i` is the tail: the first character after the run.
    let k = -1;
    if (!javascriptOnly) {
      if (lower.startsWith("on", i) && isAsciiLetter(value.charCodeAt(i + 2))) {
        let e = i + 3;
        while (e < n && isAsciiLetter(value.charCodeAt(e))) e += 1;
        k = afterEquals(value, e);
      }
    } else if (lower.startsWith("href", i)) {
      k = afterEquals(value, i + 4);
    } else if (lower.startsWith("src", i)) {
      k = afterEquals(value, i + 3);
    }
    if (k === -1) continue;

    let end = -1;
    if (!javascriptOnly) {
      end = attributeValueEnd(value, k, lastDouble, lastSingle);
    } else {
      const quote = value.charCodeAt(k);
      if ((quote === 0x22 || quote === 0x27) && lower.startsWith("javascript:", k + 1)) {
        // No partner quote at all: skip the search, so a run of unclosed
        // candidates cannot each scan to the end.
        const last = quote === 0x22 ? lastDouble : lastSingle;
        if (last >= k + 12) end = value.indexOf(value[k], k + 12) + 1;
      } else if (lower.startsWith("javascript:", k)) {
        let e = k + 11;
        while (e < n) {
          const c = value.charCodeAt(e);
          if (isJsSpace(c) || c === 0x3e /* > */) break;
          e += 1;
        }
        if (e > k + 11) end = e;
      }
    }
    if (end === -1) continue;
    ranges.push(start, end);
    i = end;
  }
  return removeRanges(value, ranges);
}

function stripOnce(html: string): string {
  // HTML comments (also kills conditional-comment payloads).
  let result = removeComments(html);

  for (const tag of BLOCK_TAGS) {
    if (asciiLower(result).indexOf(`<${tag}`) === -1) continue;
    result = removeBlocks(result, asciiLower(result), tag);
    result = removeOpeningTags(result, asciiLower(result), [tag], true);
    result = removeOpeningTags(result, asciiLower(result), [tag], false);
  }

  // Event-handler attributes: onclick="...", onload='...', onerror=x
  result = removeAttributes(result, asciiLower(result), false);

  // javascript: in href/src, any quoting.
  result = removeAttributes(result, asciiLower(result), true);

  // Interactive form elements. The old rule was
  // `<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)`, whose first
  // branch always matches at the first `>`: it removes the opening tag only.
  result = removeOpeningTags(result, asciiLower(result), FORM_TAGS, false);

  return result;
}

/**
 * Run the deny-list to a fixpoint so nested evasions (`<scr<script>ipt>`) die.
 * Exported for harness/sanitize.test.mjs only.
 */
export function denyListPass(dirty: string): string {
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
