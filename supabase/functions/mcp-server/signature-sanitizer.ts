// ---------------------------------------------------------------------------
// signature-sanitizer — ALLOW-LIST signature HTML sanitizer (Deno / edge)
// ---------------------------------------------------------------------------
//
// This is the send-time and MCP-tool-time pass over per-inbox signature HTML.
// It used to live inline in index.ts as a stack of strip-the-bad-thing regexes.
// Every one of those regexes was bypassable, and four bypasses were
// demonstrated against the shipped web-app twin of the same code:
//
//   <img/src="https://a/b"onerror=alert(1)>   the on*= regex required
//                                             whitespace before the handler,
//                                             but a closing quote ends the
//                                             previous attribute just as well
//   <a href=" javascript:alert(1)">           leading whitespace inside the
//                                             quoted value, which the browser
//                                             strips before it navigates
//   <a href="jav&#x61;script:alert(1)">       browsers decode entities in
//                                             attribute values; the regex saw
//                                             only the raw bytes
//   <div style="background:url(javascript:alert(1))">   not covered at all
//
// This copy was WORSE than the web one, because it ran a single pass instead of
// iterating to a fixpoint, so `<scr<script>ipt>alert(1)</script>` survived here
// as well: removing the inner `<script>` glued `<scr` and `ipt>` back together.
//
// Patching those regexes only ever buys time until the next quirk, because a
// deny-list has to enumerate every way a browser can be surprised. This module
// now TOKENIZES the input the way the HTML spec says a browser does and rebuilds
// the markup from an ALLOW-LIST: unknown tags, unknown attributes, unknown URL
// schemes, unknown CSS properties and unknown CSS functions are dropped by
// default, and every byte of output is a byte this file constructed itself.
// Text is emitted with < and > escaped and attribute values are re-encoded, so
// the output cannot be re-parsed into markup that was not in the tree.
//
// That construction also kills the nested-tag evasion for free. In the spec's
// tag-name state `<` is an ordinary name character, so a browser reads
// `<scr<script>` as ONE start tag named `scr<script` — it does not reassemble a
// script element. We read it the same way, the allow-list drops the unknown
// tag, and the leftover `ipt>` is escaped as text. There is no strip-and-rescan
// step left for a payload to exploit, which is why the fixpoint loop is gone:
// one pass is the whole story.
//
// TWIN IMPLEMENTATION. The identical sanitizer exists in two places on purpose:
//   - apps/web/src/lib/sanitizeSignatureHtmlServer.js        (Next.js, Node)
//   - supabase/functions/mcp-server/signature-sanitizer.ts   (this file, Deno)
// They cannot share a module — two runtimes, two build systems — and the Node
// side additionally must stay dependency-free because jsdom's ESM-only
// transitive deps crash Next's server runtime with ERR_REQUIRE_ESM (that
// incident 500'd every signature save in production). The policy tables below
// are the actual contract: keep them identical in both files. The suite in
// signature-sanitizer.test.ts runs the same attack corpus as the Node suite and
// includes a drift check that reads the Node file, in the same spirit as
// text-safety.ts.
//
// Kept out of index.ts for the same reason as text-safety.ts and
// usage-limit-message.ts: it is a pure function with a real test suite, and
// index.ts cannot be imported by a test without booting the whole server.
//
// Signature-tuned, as before: https-hosted <img> logos are KEPT (that is the
// whole point of rich signatures); http:, data:, ftp: and every other scheme is
// stripped, and an <img> without a usable https source is removed outright.
//
// PURE: no I/O.
// ---------------------------------------------------------------------------

export const SIGNATURE_HTML_MAX_LENGTH = 100 * 1024;

/**
 * Email bodies get a far larger ceiling than signatures. A signature is a few
 * hundred bytes and an oversize one is a bug; a marketing email legitimately
 * runs to hundreds of kilobytes, and refusing to sanitize one would mean
 * handing back the raw thing or nothing at all.
 */
export const EMAIL_HTML_MAX_LENGTH = 512 * 1024;

// ---------------------------------------------------------------------------
// POLICY TABLES — keep identical to the Node twin.
// ---------------------------------------------------------------------------

/** Elements that survive. Everything else is dropped (see KEEP-CONTENT below). */
const SIGNATURE_ALLOWED_TAGS = new Set([
  "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "a",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "img", "table", "thead",
  "tbody", "tr", "td", "th", "blockquote", "hr", "font",
]);

/** Attributes that survive, on any allowed element. Everything else is dropped. */
const SIGNATURE_ALLOWED_ATTR = new Set([
  "href", "target", "rel", "src", "alt", "width", "height", "style",
  "align", "color",
]);

/** Elements with no closing tag; never pushed onto the open-element stack. */
const VOID_TAGS = new Set(["br", "img", "hr"]);

/**
 * Elements whose CONTENT must die with them, rather than being kept as text.
 * This is DOMPurify's FORBID_CONTENTS list plus textarea. For every OTHER
 * disallowed element we keep the children (DOMPurify KEEP_CONTENT: true), so a
 * pasted <section>Jane Doe</section> still contributes its text.
 */
const DROP_CONTENT_TAGS = new Set([
  "annotation-xml", "audio", "colgroup", "desc", "foreignobject", "head",
  "iframe", "math", "mi", "mn", "mo", "ms", "mtext", "noembed", "noframes",
  "noscript", "plaintext", "script", "style", "svg", "template", "textarea",
  "title", "video", "xmp",
]);

/**
 * Elements the spec parses in a raw-text / escapable-raw-text state: their
 * content is never markup, so `<script>if (a < b) {}</script>` must be skipped
 * to the first matching end tag rather than tokenized. Getting this wrong is
 * how a `</p>` inside a script body escapes a naive parser.
 */
const RAW_TEXT_TAGS = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed",
  "noframes", "noscript", "plaintext",
]);

/** target values we keep; anything else (including a URL) is dropped. */
const ALLOWED_TARGETS = new Set(["_blank", "_self", "_parent", "_top"]);

/**
 * Start tags that implicitly close an already-open element, so `<p>a<p>b`
 * serialises as two siblings instead of an ever-deepening nest. Cosmetic, not a
 * security property.
 */
const AUTO_CLOSE: Record<string, Set<string>> = {
  p: new Set(["p", "div", "ul", "ol", "table", "blockquote", "h1", "h2", "h3", "h4", "hr"]),
  li: new Set(["li"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  tr: new Set(["tr"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
};

/** Bound on nesting so a deeply nested payload cannot blow the stack. */
const MAX_DEPTH = 64;

/**
 * Inline CSS properties that survive, chosen to cover what the TipTap editor
 * emits and what pasted Gmail/Outlook signatures carry. This is deliberately
 * STRICTER than the old property deny-list: the server is the authority on what
 * gets stored, an unknown property can only cost styling, and unknown
 * properties are exactly where `-moz-binding` and `behavior` live.
 */
const ALLOWED_STYLE_PROPS = new Set([
  "color", "background-color",
  "font", "font-family", "font-size", "font-style", "font-weight", "font-variant",
  "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-decoration", "text-decoration-color",
  "text-decoration-line", "text-transform", "text-indent",
  "vertical-align", "white-space", "direction",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-radius",
  "border-collapse", "border-spacing",
  "width", "height", "max-width", "min-width", "max-height", "min-height",
  "display", "float", "clear", "outline",
  "list-style", "list-style-type", "list-style-position",
  "table-layout", "caption-side", "empty-cells",
]);

/** CSS functions that survive. url(), expression(), attr(), var() do not. */
const ALLOWED_CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc"]);

/**
 * Characters a declaration value may contain. Note what is NOT here: `:`
 * (so no scheme can appear in a value at all — `background: url(javascript:…)`
 * is rejected on the colon before we even look at the function name), `\`
 * (CSS escapes such as `\6a avascript`), `&` (entity re-decoding), `<`, `>`,
 * `@` (@import) and `*` (the `/*` comment trick).
 */
const SAFE_STYLE_VALUE = /^[a-zA-Z0-9\s#%.,()/'"+!_-]*$/;

/** Matches `name(` so every CSS function can be checked against the allow-list. */
const CSS_FUNCTION = /([a-zA-Z-]+)\s*\(/g;

/**
 * An entity reference this module did not decode. Any URL or style value still
 * containing one is REJECTED rather than guessed at: the browser will decode
 * whatever it is (`&colon;`, `&NewLine;`, some name added to HTML next year),
 * and a value we cannot fully normalise is a value we cannot safely
 * scheme-check. Fail closed.
 */
const RESIDUAL_ENTITY = /&#?[a-zA-Z0-9]{1,32};/;

/**
 * Named entities we DO decode. The list is deliberately heavy on the ones that
 * matter for bypasses (colon, semi, sol, lpar, Tab, NewLine, the quotes) plus
 * the typography a real signature uses. Anything missing is not a hole — it
 * trips RESIDUAL_ENTITY above and the value is dropped.
 */
/**
 * EMAIL BODY tag policy. A superset of the signature list, because a body is
 * prose written by someone else: headings past h4, definition lists, code,
 * captions and the inline semantic tags all carry meaning a reader (or the
 * model) would otherwise lose. `font` is kept for the same reason it is kept
 * for signatures: bulk mail is full of it.
 */
const EMAIL_ALLOWED_TAGS = new Set([
  ...SIGNATURE_ALLOWED_TAGS,
  "h5", "h6", "pre", "code", "kbd", "samp", "dl", "dt", "dd", "caption",
  "tfoot", "small", "sub", "sup", "abbr", "cite", "q", "del", "ins", "mark",
  "figure", "figcaption", "time", "dfn",
]);

/**
 * EMAIL BODY attribute policy.
 *
 * No `style`: a body is written by a stranger, and inline style is how a
 * phisher hides text from a human while leaving it readable to a parser. No
 * `target`/`rel` either, since nothing renders these links as a live document.
 * `colspan`/`rowspan` ARE here, because without them a data table read by the
 * model silently loses its shape.
 */
const EMAIL_ALLOWED_ATTR = new Set([
  "href", "src", "alt", "width", "height", "colspan", "rowspan",
  "dir", "lang", "title",
]);

/**
 * EMAIL BODY image sources: NOTHING that touches the network.
 *
 * A remote image in a stranger's mail is a read receipt. It fires the moment
 * anything renders the body and tells the sender the address is live, when it
 * was opened and from which IP. `cid:` points at an attachment already inside
 * this same message, so it costs no request; base64 raster `data:` is inline
 * bytes. `data:image/svg+xml` is deliberately NOT here: SVG is a document, not
 * a raster, and it is the one image type that carries script.
 */
const EMAIL_SRC = /^(?:cid:|data:image\/(?:png|gif|jpeg|jpg|webp|bmp);base64,)/;

/** http(s) and mailto, the same rule both policies use. */
const SAFE_HREF = /^(?:https?:|mailto:)/;

/**
 * Everything the tokenizer needs in order to decide "keep or drop". The two
 * call sites differ by CONFIGURATION, never by a second copy of the parser:
 * forking the tokenizer is how the email and signature rules drifted apart in
 * the first place, back when both were regex deny-lists.
 */
export interface SanitizerPolicy {
  /** Used in the error message when output exceeds maxLength. */
  label: string;
  allowedTags: Set<string>;
  allowedAttr: Set<string>;
  /** Allowed inline CSS properties, or null to drop `style` outright. */
  allowedStyleProps: Set<string> | null;
  isAllowedHref(probe: string): boolean;
  isAllowedSrc(probe: string): boolean;
  /**
   * Drop an `<img>` that ended up with no usable src?
   *
   * TRUE for signatures: a logo that cannot load is just a broken image.
   * FALSE for email: every external src is stripped by policy, so requiring one
   * would delete every image in every message along with its alt text, and the
   * alt text is often the only description of the image a reader ever gets.
   */
  requireImgSrc: boolean;
  maxLength: number;
}

export const SIGNATURE_POLICY: SanitizerPolicy = {
  label: "sanitizeSignatureHtml",
  allowedTags: SIGNATURE_ALLOWED_TAGS,
  allowedAttr: SIGNATURE_ALLOWED_ATTR,
  allowedStyleProps: ALLOWED_STYLE_PROPS,
  isAllowedHref: (probe) => SAFE_HREF.test(probe),
  // https ONLY, so a signature can never leak over plaintext http or inline a
  // hostile/huge data: URI. Hosted logos are the use case.
  isAllowedSrc: (probe) => /^https:\/\//.test(probe),
  requireImgSrc: true,
  maxLength: SIGNATURE_HTML_MAX_LENGTH,
};

export const EMAIL_POLICY: SanitizerPolicy = {
  label: "sanitizeEmailHtml",
  allowedTags: EMAIL_ALLOWED_TAGS,
  allowedAttr: EMAIL_ALLOWED_ATTR,
  allowedStyleProps: null,
  isAllowedHref: (probe) => SAFE_HREF.test(probe),
  isAllowedSrc: (probe) => EMAIL_SRC.test(probe),
  requireImgSrc: false,
  maxLength: EMAIL_HTML_MAX_LENGTH,
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">",
  quot: '"', QUOT: '"', apos: "'",
  nbsp: "\u00a0", NonBreakingSpace: "\u00a0", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", shy: "\u00ad", Tab: "\t", NewLine: "\n",
  colon: ":", semi: ";", sol: "/", bsol: "\\", verbar: "|", grave: "`",
  lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}",
  excl: "!", num: "#", dollar: "$", percnt: "%", ast: "*", plus: "+",
  comma: ",", period: ".", quest: "?", commat: "@", equals: "=",
  copy: "©", reg: "®", trade: "™", deg: "°",
  hellip: "…", mdash: "—", ndash: "–", bull: "•",
  middot: "·", sect: "§", para: "¶",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", dagger: "†", Dagger: "‡",
  times: "×", divide: "÷", plusmn: "±", frac12: "½",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
  larr: "←", rarr: "→", harr: "↔",
};

// ---------------------------------------------------------------------------
// Entity decoding + escaping
// ---------------------------------------------------------------------------

const ENTITY_PATTERN =
  /&(#[xX][0-9a-fA-F]{1,6};?|#[0-9]{1,7};?|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;

/**
 * Decode entity references in an ATTRIBUTE VALUE. This has to happen before any
 * scheme check: `jav&#x61;script:` is `javascript:` by the time the browser
 * reads the attribute, and the old regexes checked the undecoded bytes.
 *
 * Numeric references are decoded with OR without the trailing semicolon,
 * because browsers do (a missing semicolon is a parse error, not a refusal).
 */
function decodeEntities(value: string): string {
  if (value.indexOf("&") === -1) return value;
  return value.replace(ENTITY_PATTERN, (match: string, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = (hex ? body.slice(2) : body.slice(1)).replace(/;$/, "");
      const code = parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return "\ufffd";
      if (code >= 0xd800 && code <= 0xdfff) return "\ufffd";
      return String.fromCodePoint(code);
    }
    const name = body.slice(0, -1);
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
      ? NAMED_ENTITIES[name]
      : match;
  });
}

/**
 * Text nodes: only `<` and `>` can start markup, and entities are left intact so
 * `&nbsp;` and `&amp;` in a real signature keep rendering as themselves. An
 * entity in text can never become a tag — the browser decodes it into character
 * data long after tokenization — so there is nothing to normalise here.
 */
function escapeText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute values are fully re-encoded, since we decoded them on the way in. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// URL + style value policy
// ---------------------------------------------------------------------------

/** C0 controls and DEL, which browsers strip out of a URL before resolving it. */
// deno-lint-ignore no-control-regex
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Decode, strip control characters, trim. Returns null when the value still
 * holds an entity we do not understand (fail closed — see RESIDUAL_ENTITY).
 *
 * Control characters are removed anywhere in the value, not just at the ends,
 * because browsers strip TAB/LF/CR out of the middle of a URL before resolving
 * it: `java\nscript:` navigates just fine. Bypass #2 (a leading space inside
 * the quoted value) dies on the trim.
 */
function normalizeUrlValue(raw: string): string | null {
  const decoded = decodeEntities(raw);
  if (RESIDUAL_ENTITY.test(decoded)) return null;
  return decoded.replace(URL_CONTROL_CHARS, "").trim();
}

/** Whitespace-free lowercase form used for the scheme test only. */
function urlProbe(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/** Filter an inline style string down to allowed properties with allowed values. */
export function sanitizeStyleAttribute(
  style: string,
  allowedProps: Set<string> | null = ALLOWED_STYLE_PROPS,
): string {
  if (allowedProps === null) return "";
  if (typeof style !== "string" || style === "") return "";
  const decoded = decodeEntities(style);
  if (RESIDUAL_ENTITY.test(decoded)) return "";

  const kept: string[] = [];
  for (const declaration of decoded.split(";")) {
    const split = declaration.indexOf(":");
    if (split === -1) continue;
    const prop = declaration.slice(0, split).trim().toLowerCase();
    const value = declaration.slice(split + 1).trim();
    if (!prop || !value) continue;
    if (!allowedProps.has(prop)) continue;
    if (!SAFE_STYLE_VALUE.test(value)) continue;

    let functionsOk = true;
    CSS_FUNCTION.lastIndex = 0;
    let match = CSS_FUNCTION.exec(value);
    while (match) {
      if (!ALLOWED_CSS_FUNCTIONS.has(match[1].toLowerCase())) {
        functionsOk = false;
        break;
      }
      match = CSS_FUNCTION.exec(value);
    }
    if (!functionsOk) continue;

    kept.push(`${prop}: ${value}`);
  }
  return kept.join("; ");
}

/**
 * Apply the attribute policy to one element.
 *
 * Returns the attributes to emit, or null when the element itself must be
 * dropped (an <img> with no usable https source).
 */
function filterAttributes(
  tag: string,
  attrs: Array<[string, string]>,
  policy: SanitizerPolicy,
): Array<[string, string]> | null {
  const kept: Array<[string, string]> = [];
  const seen = new Set<string>();
  let relValue: string | null = null;
  let blankTarget = false;
  let imgHasSrc = false;

  for (const [name, raw] of attrs) {
    if (!policy.allowedAttr.has(name)) continue;
    // Browsers keep the FIRST occurrence of a repeated attribute, so
    // `<a href="/ok" href="javascript:1">` has to resolve to the first one here
    // too, or the sanitizer and the renderer would disagree about the URL.
    if (seen.has(name)) continue;

    if (name === "href" || name === "src") {
      const url = normalizeUrlValue(raw);
      if (url === null) continue;
      const probe = urlProbe(url);
      if (name === "href") {
        // http(s) and mailto only. Relative hrefs go too — a signature links to
        // somewhere real, and a bare relative URL in outgoing mail resolves
        // against whatever the reader's client happens to be.
        if (!policy.isAllowedHref(probe)) continue;
      } else {
        // https ONLY, so a signature can never leak over plaintext http or
        // inline a hostile/huge data: URI. Hosted logos are the use case.
        if (!policy.isAllowedSrc(probe)) continue;
        if (tag === "img") imgHasSrc = true;
      }
      seen.add(name);
      kept.push([name, url]);
      continue;
    }

    if (name === "style") {
      const cleaned = sanitizeStyleAttribute(raw, policy.allowedStyleProps);
      seen.add(name);
      if (cleaned) kept.push(["style", cleaned]);
      continue;
    }

    if (name === "target") {
      const value = decodeEntities(raw).trim().toLowerCase();
      if (!ALLOWED_TARGETS.has(value)) continue;
      if (value === "_blank") blankTarget = true;
      seen.add(name);
      kept.push(["target", value]);
      continue;
    }

    if (name === "rel") {
      // Held back and re-emitted below, because target may appear after rel and
      // a _blank link's rel is not the author's to choose.
      seen.add(name);
      relValue = decodeEntities(raw).replace(/[^a-zA-Z\s-]/g, "").trim();
      continue;
    }

    seen.add(name);
    kept.push([name, decodeEntities(raw)]);
  }

  // target="_blank" without noopener hands the opened page a window.opener
  // handle back into the tab that rendered the mail.
  if (blankTarget) {
    kept.push(["rel", "noopener noreferrer"]);
  } else if (relValue) {
    kept.push(["rel", relValue]);
  }

  if (policy.requireImgSrc && tag === "img" && !imgHasSrc) return null;
  return kept;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function isAsciiAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isTagWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Read a tag name starting at `start` (the index just after `<` or `</`).
 *
 * NOTE which characters terminate a name: whitespace, `/`, `>`. `<` is NOT one
 * of them — in the spec's tag-name state it is an ordinary name character. That
 * is exactly why `<scr<script>ipt>` is a single unknown tag here, as it is in a
 * browser, instead of something a strip-and-rescan pass can reassemble.
 */
function readTagName(source: string, start: number): { name: string; next: number } {
  let i = start;
  let name = "";
  while (i < source.length) {
    const ch = source[i];
    if (isTagWhitespace(ch) || ch === "/" || ch === ">") break;
    name += ch;
    i += 1;
  }
  return { name: name.toLowerCase(), next: i };
}

interface ParsedAttributes {
  attrs: Array<[string, string]>;
  next: number;
  selfClosing: boolean;
  closed: boolean;
}

/**
 * Parse the attribute list of a tag, starting just after the tag name, and
 * return the index after the closing `>`.
 *
 * `closed` is false when the input ran out mid-tag; the caller drops the token
 * in that case, which is what a browser does on EOF-in-tag.
 *
 * This loop does not require whitespace between attributes, which is the whole
 * of bypass #1: once a quoted value ends, the very next character can start the
 * next attribute name (`src="…"onerror=…`).
 */
function parseAttributes(source: string, start: number): ParsedAttributes {
  const attrs: Array<[string, string]> = [];
  let i = start;
  let selfClosing = false;
  let closed = false;

  while (i < source.length) {
    while (i < source.length && isTagWhitespace(source[i])) i += 1;
    if (i >= source.length) break;

    if (source[i] === ">") { i += 1; closed = true; break; }
    if (source[i] === "/") {
      if (source[i + 1] === ">") { selfClosing = true; i += 2; closed = true; break; }
      i += 1;
      continue;
    }

    let name = "";
    while (
      i < source.length &&
      !isTagWhitespace(source[i]) &&
      source[i] !== "=" &&
      source[i] !== ">" &&
      source[i] !== "/"
    ) {
      name += source[i];
      i += 1;
    }

    while (i < source.length && isTagWhitespace(source[i])) i += 1;

    let value = "";
    if (source[i] === "=") {
      i += 1;
      while (i < source.length && isTagWhitespace(source[i])) i += 1;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const end = source.indexOf(quote, i);
        if (end === -1) {
          value = source.slice(i);
          i = source.length;
        } else {
          value = source.slice(i, end);
          i = end + 1;
        }
      } else {
        while (i < source.length && !isTagWhitespace(source[i]) && source[i] !== ">") {
          value += source[i];
          i += 1;
        }
      }
    }

    if (name) attrs.push([name.toLowerCase(), value]);
  }

  return { attrs, next: i, selfClosing, closed };
}

/** Skip a raw-text element's body: no nesting, the first matching end tag wins. */
function skipRawText(source: string, from: number, name: string): number {
  const lower = source.toLowerCase();
  const needle = `</${name}`;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    const after = source[idx + needle.length];
    if (after === undefined || after === ">" || after === "/" || isTagWhitespace(after)) {
      const end = source.indexOf(">", idx);
      return end === -1 ? source.length : end + 1;
    }
    idx = lower.indexOf(needle, idx + 1);
  }
  return source.length;
}

/** Skip a normal element and everything inside it, honouring nesting. */
function skipElementWithContent(source: string, from: number, name: string): number {
  const lower = source.toLowerCase();
  let depth = 1;
  let i = from;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) return source.length;
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    const isEnd = source[lt + 1] === "/";
    const nameStart = lt + (isEnd ? 2 : 1);
    const read = readTagName(lower, nameStart);
    if (read.name === name) {
      const parsed = parseAttributes(source, read.next);
      if (isEnd) {
        depth -= 1;
        if (depth === 0) return parsed.next;
      } else if (!parsed.selfClosing) {
        depth += 1;
      }
      i = parsed.next;
      continue;
    }
    i = lt + 1;
  }
  return source.length;
}

function serializeStartTag(name: string, attrs: Array<[string, string]>): string {
  let out = `<${name}`;
  for (const [key, value] of attrs) out += ` ${key}="${escapeAttr(value)}"`;
  return `${out}>`;
}

/**
 * Tokenize `html` and rebuild it from the allow-list. Single pass: nothing is
 * ever stripped and rescanned, so there is no evasion window between passes.
 */
function rebuildFromAllowList(html: string, policy: SanitizerPolicy): string {
  const out: string[] = [];
  const stack: string[] = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(html.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(html.slice(i, lt)));
    i = lt;

    // Comments, doctypes, processing instructions, and the bogus-comment forms.
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    const marker = html[i + 1];
    if (marker === "!" || marker === "?") {
      const end = html.indexOf(">", i);
      i = end === -1 ? len : end + 1;
      continue;
    }

    if (marker === "/") {
      if (!isAsciiAlpha(html[i + 2] || "")) {
        const end = html.indexOf(">", i);
        i = end === -1 ? len : end + 1;
        continue;
      }
      const read = readTagName(html, i + 2);
      const parsed = parseAttributes(html, read.next);
      i = parsed.closed ? parsed.next : len;
      // Close the nearest matching open element, plus anything left dangling
      // inside it. An end tag with no open counterpart is simply dropped.
      const open = stack.lastIndexOf(read.name);
      if (open === -1) continue;
      while (stack.length > open) out.push(`</${stack.pop()}>`);
      continue;
    }

    if (!isAsciiAlpha(marker || "")) {
      // A bare `<` in prose ("a < b"). Text, not markup.
      out.push("&lt;");
      i += 1;
      continue;
    }

    const read = readTagName(html, i + 1);
    const parsed = parseAttributes(html, read.next);
    if (!parsed.closed) break; // EOF inside a tag: emit nothing, as browsers do.
    i = parsed.next;
    const name = read.name;

    // `<plaintext>` turns the rest of the document into text, permanently.
    if (name === "plaintext") break;

    if (DROP_CONTENT_TAGS.has(name)) {
      if (parsed.selfClosing) continue;
      i = RAW_TEXT_TAGS.has(name)
        ? skipRawText(html, i, name)
        : skipElementWithContent(html, i, name);
      continue;
    }

    // Disallowed but harmless container: drop the tag, keep the children.
    if (!policy.allowedTags.has(name)) continue;

    // Pop the WHOLE run of implicitly-closed peers, not just the top one.
    // `<tr><td>A<tr>` has to close the <td> AND the <tr> under it; stopping
    // after the <td> nests the new row inside the old one, which made the
    // output differ on a second pass. Caught on live Google AdMob and PayPal
    // mail, where rows and cells are routinely left unclosed.
    let implied = AUTO_CLOSE[stack[stack.length - 1]];
    while (implied && implied.has(name)) {
      out.push(`</${stack.pop()}>`);
      implied = AUTO_CLOSE[stack[stack.length - 1]];
    }

    if (stack.length >= MAX_DEPTH) continue;

    const attrs = filterAttributes(name, parsed.attrs, policy);
    if (attrs === null) continue;

    out.push(serializeStartTag(name, attrs));
    // A stray `/` on a non-void element does not close it in HTML, so the slash
    // is ignored here exactly as a browser ignores it.
    if (!VOID_TAGS.has(name)) stack.push(name);
  }

  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

/**
 * Sanitize an email BODY for return as `body_html`.
 *
 * Same tokenizer as the signature path, different policy object. The policy is
 * the only thing that differs, on three documented axes: no external image src
 * of any kind, no inline style at all, and a wider prose tag set. See
 * EMAIL_POLICY above for why each one is what it is.
 *
 * NEVER THROWS, unlike the signature entry point. A signature that will not
 * sanitize is a bug worth surfacing to whoever is writing it; an email body
 * that will not sanitize is someone else's mail, and failing the read would
 * strand the agent on a message it can do nothing about. Oversize output is
 * truncated at a tag boundary instead, which is safe here because the result is
 * read, never stored or re-sent.
 */
export function sanitizeEmailHtml(dirtyHtml: string): string {
  if (typeof dirtyHtml !== "string" || dirtyHtml === "") return "";
  const clean = rebuildFromAllowList(dirtyHtml, EMAIL_POLICY);
  if (clean.length <= EMAIL_HTML_MAX_LENGTH) return clean;
  // Cut back to the last complete tag so the tail can never be a half-written
  // element that a downstream concatenation could finish into something else.
  const cut = clean.lastIndexOf(">", EMAIL_HTML_MAX_LENGTH);
  return cut === -1 ? "" : clean.slice(0, cut + 1);
}

/**
 * Sanitize untrusted signature HTML.
 *
 * Same contract as the Node twin: throws on non-string input and on output
 * larger than SIGNATURE_HTML_MAX_LENGTH, because truncating HTML mid-tag would
 * store broken markup. Use `sanitizeSignatureHtmlSafe` on paths where a throw
 * would cost the user something they did not ask to risk (see below).
 */
export function sanitizeSignatureHtml(dirtyHtml: string): string {
  if (typeof dirtyHtml !== "string") {
    throw new Error("sanitizeSignatureHtml: input must be a string");
  }
  if (dirtyHtml === "") return "";

  const clean = rebuildFromAllowList(dirtyHtml, SIGNATURE_POLICY);

  if (clean.length > SIGNATURE_HTML_MAX_LENGTH) {
    throw new Error(
      `sanitizeSignatureHtml: sanitized HTML is ${clean.length} bytes, exceeds ${SIGNATURE_HTML_MAX_LENGTH} limit`,
    );
  }

  return clean;
}

/**
 * Non-throwing variant for the SEND path.
 *
 * At send time we are re-sanitizing HTML that is already stored, as a
 * belt-and-suspenders pass before it is injected into outgoing mail. A throw
 * there would fail the whole send over a signature, which is a far worse
 * outcome than sending without one — so an oversize or non-string value yields
 * an empty signature block instead. Every write path (the web PATCH route and
 * the MCP signature tool) uses the throwing version, so this branch is
 * effectively unreachable for anything written after this change; it exists for
 * rows written before it.
 */
export function sanitizeSignatureHtmlSafe(dirtyHtml: string): string {
  try {
    return sanitizeSignatureHtml(dirtyHtml);
  } catch {
    return "";
  }
}
