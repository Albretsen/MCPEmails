// ---------------------------------------------------------------------------
// htmlSanitizer: dependency-free ALLOW-LIST HTML sanitizer (Node twin)
// ---------------------------------------------------------------------------
//
// NODE TWIN OF supabase/functions/mcp-server/html-sanitizer.ts. Same algorithm,
// same policies, same payload corpus in the tests. Keep them in sync; the
// parity check in htmlSanitizer.test.mjs and its Deno counterpart run the same
// inputs through both and compare, so drift shows up as a failing test rather
// than as a hole on one runtime only.
//
// WHY THIS REPLACED THE REGEX DENY-LIST
//
// The sanitizer this supersedes was a chain of `.replace()` calls hunting for
// known-bad shapes. Every rule in it was written in response to a payload
// someone had already thought of, which is why all of these went through it
// unchanged:
//
//   <img/src="https://a/b"onerror=alert(1)>            the handler follows a
//                                                      quote, not whitespace,
//                                                      so /\s+on[a-z]+=/ never
//                                                      matched it
//   <a href=" javascript:alert(1)">                    a leading space inside
//                                                      the quoted value defeats
//                                                      /"javascript:/
//   <a href="jav&#x61;script:alert(1)">                the browser decodes the
//                                                      entity; the regex
//                                                      compared raw text
//   <div style="background:url(javascript:alert(1))">  style was never inspected
//   <scr<script>ipt>alert(1)</script>                  removing the inner tag
//                                                      splices the outer halves
//                                                      into a live <script>
//   <img src=https://evil.tld/pixel.gif>               unquoted values were not
//                                                      matched, so tracking
//                                                      pixels walked through
//   <img srcset="https://evil.tld/p.gif 1x">           srcset was never
//                                                      considered at all
//
// A deny-list cannot be patched into safety: each fix is one more special case,
// and the next payload is the one nobody wrote a rule for. So the rule is
// inverted. This module tokenizes and REBUILDS the input, emitting only
// elements and attributes on an explicit allow-list, with attribute values
// re-validated after entity decoding.
//
// NO DEPENDENCIES, ON PURPOSE
//
// The DOMPurify path needs jsdom on the server, and jsdom's ESM-only transitive
// deps (@asamuzakjp/css-color -> @csstools/css-calc) are require()d as externals
// under Next's server runtime and threw ERR_REQUIRE_ESM on every request, which
// 500'd every signature_html save in production. A sanitizer that cannot run is
// worth less than no sanitizer.
//
// PURE: no I/O, no globals, no DOM.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SanitizePolicy
 * @property {Set<string>} allowedTags Elements emitted as-is.
 * @property {Set<string>} dropWithContent Elements dropped WITH their subtree.
 *   Anything else not in `allowedTags` is unwrapped instead: the tag goes, the
 *   children stay, so an unknown wrapper loses its semantics not its text.
 * @property {Set<string>} globalAttrs Attributes allowed on every element.
 * @property {Record<string, Set<string>>} tagAttrs Per-element attributes.
 * @property {RegExp} hrefSchemes Schemes an `href` may carry, tested AFTER
 *   entity decoding and control-character removal.
 * @property {RegExp} srcSchemes Schemes an image `src` may carry. One of the
 *   two axes on which the email and signature policies differ.
 * @property {RegExp|null} styleProps CSS property names permitted inside a
 *   `style` attribute, or null to drop `style` outright. The other axis.
 *   EMAIL is null (a stranger's inline style hides text from humans while
 *   leaving it readable to a parser); SIGNATURE allows a filtered subset,
 *   because the editor expresses ALL formatting as inline style.
 * @property {number} maxOutputLength Hard ceiling on the returned string.
 */

// ---- shared vocabulary -----------------------------------------------------

/** Elements that never have children and never take an end tag. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/**
 * Elements whose content the HTML parser does NOT treat as markup. They must be
 * consumed raw up to their close tag, or `<style>x</style><img onerror=1>`-style
 * splits and `<title><img src=x onerror=1></title>` smuggling get a second life.
 * Every one is also in `dropWithContent`, so the raw run is discarded.
 */
const RAW_TEXT_TAGS = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed",
  "noframes", "noscript", "plaintext",
]);

/**
 * Elements each tag implicitly CLOSES when it opens. Real mail leaves `<p>`,
 * `<td>` and `<tr>` unclosed constantly, and without this every paragraph
 * nests one level deeper until the depth cap eats the rest of the message.
 *
 * The whole contiguous run gets popped, not just the first match. Opening a
 * `<tr>` has to close the open `<td>` AND the `<tr>` under it. Closing only
 * the `<td>` leaves the old row open and the new row nested inside it, which
 * showed up as a REAL non-idempotence on live PayPal and Google AdMob mail:
 * pass one emitted `</td><tr>`, pass two turned that into `</td></tr><tr>`.
 */
const IMPLIED_END = {
  p: new Set(["p"]),
  li: new Set(["li", "p"]),
  td: new Set(["td", "th", "p"]),
  th: new Set(["td", "th", "p"]),
  tr: new Set(["tr", "td", "th", "p"]),
  dt: new Set(["dt", "dd", "p"]),
  dd: new Set(["dt", "dd", "p"]),
};

/** Bound the output tree. A deeply nested body is otherwise a cheap DoS. */
const MAX_DEPTH = 64;
/** Bound tokenizer work independently of nesting. */
const MAX_TOKENS = 200000;

// ---- entity decoding -------------------------------------------------------

/**
 * Named entities that decode to characters an attacker can use to spell a
 * scheme (`&colon;`, `&Tab;`, `&NewLine;`, `&sol;`) plus the ones that carry
 * ordinary prose. Deliberately NOT the full HTML5 set.
 *
 * Partial coverage is safe here only because of two downstream guarantees:
 *   1. Decoded text is RE-ESCAPED on output, so an entity this table misses is
 *      re-emitted as `&amp;foo;` and renders exactly as `&foo;` did.
 *   2. `normalizeUrl` REJECTS any URL carrying `&` before its scheme colon, so
 *      an entity this table misses can never hide a scheme. That single rule
 *      covers the whole unknown-named-entity class without chasing the table.
 */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  colon: ":", tab: "\t", newline: "\n", sol: "/", bsol: "\\", lpar: "(",
  rpar: ")", semi: ";", num: "#", percnt: "%", plus: "+", equals: "=",
  quest: "?", commat: "@", excl: "!", period: ".", comma: ",", dollar: "$",
  ast: "*", grave: "`", verbar: "|", lsqb: "[", rsqb: "]", lcub: "{",
  rcub: "}", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘",
  rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", deg: "°", laquo: "«", raquo: "»",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", dagger: "†", permil: "‰",
  times: "×", divide: "÷", minus: "−", prime: "′",
};

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g;

/**
 * Decode HTML entities to their characters. Run before any value is validated,
 * because the browser decodes them too: `jav&#x61;script:` IS `javascript:` by
 * the time it reaches a URL parser, and validating the raw text is what let
 * that payload through.
 *
 * @param {string} input
 * @returns {string}
 */
export function decodeEntities(input) {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY_RE, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      // Lone surrogates are not encodable and String.fromCodePoint throws.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Escape a decoded string for emission as text or as a quoted attribute value. */
function escapeHtml(input) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- URL validation --------------------------------------------------------

/**
 * Characters a browser ignores inside a URL but an attacker uses to break up a
 * scheme: control characters, every flavour of Unicode space, and the BOM.
 * `java\tscript:` and `  javascript:` are both `javascript:` to a URL parser.
 */
const URL_NOISE =
  /[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g;

/**
 * Normalise a raw attribute value into something safe to scheme-check, or null
 * if it must not be kept.
 *
 * The `&`-before-colon rejection is the general defence against entity tricks:
 * a legitimate URL never carries an ampersand ahead of its scheme colon, but an
 * entity this file does not decode would have to. That closes the whole class,
 * including the named entities NAMED_ENTITIES omits.
 */
function normalizeUrl(raw, schemes) {
  const decoded = decodeEntities(raw).replace(URL_NOISE, "");
  if (decoded.length === 0 || decoded.length > 2048) return null;
  const colon = decoded.indexOf(":");
  if (colon >= 0 && decoded.slice(0, colon).includes("&")) return null;
  return schemes.test(decoded) ? decoded : null;
}

const NUMERIC = /^[0-9]{1,5}$/;

/**
 * CSS declarations a signature may keep. Purely presentational: colour, type,
 * spacing, borders, table layout. Derived from what the signature editor
 * actually emits (and verified against the live signatures in the DB), plus the
 * properties a signature pasted in from Outlook or Gmail brings with it.
 *
 * Absent on purpose: `position` (overlay/clickjacking), `behavior` and
 * `-moz-binding` (script execution in legacy engines), and anything that can
 * fetch. Same exclusions the save-time sanitizer enforces.
 */
const SAFE_STYLE_PROPS =
  /^(color|background-color|font|font-family|font-size|font-style|font-weight|font-variant|line-height|letter-spacing|text-align|text-decoration|text-indent|text-transform|vertical-align|white-space|word-break|display|opacity|outline|width|height|max-width|min-width|max-height|min-height|margin|margin-(top|right|bottom|left)|padding|padding-(top|right|bottom|left)|border|border-(collapse|spacing|radius|color|width|style)|border-(top|right|bottom|left)(-(color|width|style))?)$/i;

/**
 * A style VALUE that can reach the network or the script engine. `url(` covers
 * the `background:url(javascript:alert(1))` payload that defeated the old
 * deny-list, and also every tracking image a stranger could smuggle through CSS
 * rather than through `src`.
 */
const UNSAFE_STYLE_VALUE =
  /url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|behavior\s*:|@import|[<>\\]/i;

/**
 * Rebuild a `style` attribute from only the declarations that pass both the
 * property allow-list and the value check. Returns null when nothing survives,
 * which drops the attribute rather than emitting an empty one.
 */
function sanitizeStyleAttr(raw, props) {
  const kept = [];
  for (const decl of decodeEntities(raw).split(";")) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!value || value.length > 200) continue;
    if (!props.test(prop)) continue;
    if (UNSAFE_STYLE_VALUE.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * The one class name the sanitizer preserves.
 *
 * `composeSignatureBlocks` wraps every appended signature in
 * `<div class="mcpemails-signature">`, and `bodyAlreadyHasQuoteOrSignature`
 * looks for exactly that string to avoid appending a second signature when an
 * agent feeds a previous turn's body back in. Dropping `class` wholesale would
 * break that detection on any body that had been through a read.
 *
 * Allow-listing the VALUE rather than the attribute keeps the phishing surface
 * at zero: no attacker-chosen class name can survive this.
 */
const SIGNATURE_CONTAINER_CLASS = "mcpemails-signature";

/**
 * Validate one allow-listed attribute. Returning null drops the attribute while
 * keeping the element, which is what should happen to `href="javascript:..."`:
 * the link text stays readable, the payload does not.
 */
function safeAttrValue(tag, name, raw, policy) {
  if (name === "href") return normalizeUrl(raw, policy.hrefSchemes);
  if (name === "src") return normalizeUrl(raw, policy.srcSchemes);
  if (name === "style") {
    return policy.styleProps
      ? sanitizeStyleAttr(raw, policy.styleProps)
      : null;
  }

  const value = decodeEntities(raw).trim();
  if (value.length > 2048) return null;

  if (name === "class") {
    return value === SIGNATURE_CONTAINER_CLASS ? value : null;
  }
  if (name === "target") return value === "_blank" ? value : null;
  if (name === "align") {
    return /^(left|right|center|justify)$/i.test(value)
      ? value.toLowerCase()
      : null;
  }
  if (name === "color" || name === "bgcolor") {
    // Named colours and hex only. No `url(`, no functional notation.
    return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(value) ? value : null;
  }
  if (name === "face") return /^[\w\s,'"-]{1,120}$/.test(value) ? value : null;
  if (name === "size") return /^[+-]?[0-9]{1,2}$/.test(value) ? value : null;

  if (name === "colspan" || name === "rowspan" || name === "start") {
    return NUMERIC.test(value) ? value : null;
  }
  if (name === "width" || name === "height") {
    // Bare number, px, or percent. `width="100%"` is how every table-based
    // signature is laid out, so NUMERIC alone would quietly collapse them.
    return /^[0-9]{1,5}(px|%)?$/i.test(value) ? value : null;
  }
  if (name === "valign") {
    return /^(top|middle|bottom|baseline)$/i.test(value)
      ? value.toLowerCase()
      : null;
  }
  if (name === "dir") {
    return /^(ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
  }
  if (name === "lang") {
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(value) ? value : null;
  }
  if (name === "scope") {
    return /^(row|col|rowgroup|colgroup)$/i.test(value)
      ? value.toLowerCase()
      : null;
  }
  if (name === "type") return /^[a1AiI]$/.test(value) ? value : null;
  if (name === "cite" || name === "datetime") {
    // `cite` is a URL; `datetime` is machine text. Both are inert on output but
    // `cite` still gets the scheme check so it cannot carry javascript:.
    if (name === "cite") return normalizeUrl(raw, policy.hrefSchemes);
    return value;
  }
  void tag;
  // alt and title: free text, emitted escaped and never re-parsed.
  return value;
}

function isAllowedAttr(tag, name, policy) {
  // Belt and braces: `on*` can never be allow-listed, whatever a policy says.
  if (name.startsWith("on")) return false;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false;
  return policy.globalAttrs.has(name) ||
    (policy.tagAttrs[tag]?.has(name) ?? false);
}

// ---- tokenizer -------------------------------------------------------------

const ATTR_NAME_STOP = new Set(["=", ">", "/"]);

/**
 * Parse a start tag beginning at `<`, following the HTML5 tokenizer states
 * closely enough that we agree with a browser about where attributes begin.
 *
 * The agreement is the whole point. `<img/src="https://a/b"onerror=alert(1)>`
 * bypassed the old code because the old code assumed attributes are separated
 * by whitespace; a browser separates them at the closing quote too, so it saw
 * an `onerror` handler where the regex saw none. Here `/` and `"` both end the
 * previous attribute, so `onerror` is seen, is not on the allow-list, and dies.
 */
function parseStartTag(html, start) {
  let i = start + 1;
  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();

  const attrs = [];
  let selfClosing = false;

  while (i < html.length) {
    // Skip whitespace AND stray solidi between attributes: a browser treats
    // `<img/src=x>` as `<img src=x>`, so it must not read as a tag named "img/".
    while (i < html.length && (/\s/.test(html[i]) || html[i] === "/")) {
      if (html[i] === "/" && html[i + 1] === ">") selfClosing = true;
      i++;
    }
    if (i >= html.length) break;
    if (html[i] === ">") {
      i++;
      break;
    }

    // Attribute name: runs until whitespace, `=`, `>` or `/`. `<` is a legal
    // name character per spec, which is exactly why `<scr<script>ipt>` parses
    // as element `scr` with an attribute named `<script` rather than a script.
    const attrNameStart = i;
    while (
      i < html.length && !/\s/.test(html[i]) && !ATTR_NAME_STOP.has(html[i])
    ) i++;
    if (i === attrNameStart) {
      i++; // Unconsumable character; step over it so we cannot spin.
      continue;
    }
    const attrName = html.slice(attrNameStart, i).toLowerCase();

    while (i < html.length && /\s/.test(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        i++;
        const close = html.indexOf(quote, i);
        if (close === -1) {
          // Unterminated quote: the browser swallows the rest of the document.
          // Match that rather than guessing, so nothing after it is emitted.
          value = html.slice(i);
          i = html.length;
        } else {
          value = html.slice(i, close);
          i = close + 1;
        }
      } else {
        const valueStart = i;
        while (i < html.length && !/\s/.test(html[i]) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    attrs.push([attrName, value]);
  }

  return { name, attrs, selfClosing, end: i };
}

/**
 * Sanitize untrusted HTML against `policy`.
 *
 * Returns well-formed HTML: every element the tokenizer opens is closed, in
 * order, because the output is built from a stack rather than copied from the
 * input. That also means the result is idempotent (re-sanitizing it is a
 * no-op), and that no partial tag can survive to be completed by a later
 * concatenation.
 *
 * @param {string} html
 * @param {SanitizePolicy} policy
 * @returns {string}
 */
export function sanitizeHtml(html, policy) {
  if (typeof html !== "string" || html === "") return "";

  const out = [];
  const stack = [];
  let suppressDepth = 0;
  let i = 0;
  let tokens = 0;

  /** Emission is gated centrally so a suppressed subtree cannot leak a token. */
  const emit = (s) => {
    if (suppressDepth === 0) out.push(s);
  };

  const closeTo = (index) => {
    while (stack.length > index) {
      const entry = stack.pop();
      if (entry.suppressed) suppressDepth--;
      if (entry.emitted) emit(`</${entry.tag}>`);
    }
  };

  while (i < html.length && tokens++ < MAX_TOKENS) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      emit(escapeHtml(decodeEntities(html.slice(i))));
      break;
    }
    if (lt > i) emit(escapeHtml(decodeEntities(html.slice(i, lt))));

    const next = html[lt + 1];

    // Comments, CDATA, doctypes, bogus comments: dropped whole. `<!--` runs to
    // `-->`; everything else under `<!` runs to the next `>`. Conditional
    // comments (`<!--[if IE]><script>...`) die with the comment.
    if (next === "!") {
      if (html.startsWith("<!--", lt)) {
        const close = html.indexOf("-->", lt + 4);
        i = close === -1 ? html.length : close + 3;
      } else {
        const close = html.indexOf(">", lt + 2);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }

    // Processing instruction / bogus comment.
    if (next === "?") {
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    // End tag.
    if (next === "/") {
      let j = lt + 2;
      const nameStart = j;
      while (j < html.length && /[a-zA-Z0-9:_-]/.test(html[j])) j++;
      const name = html.slice(nameStart, j).toLowerCase();
      const close = html.indexOf(">", j);
      i = close === -1 ? html.length : close + 1;
      if (name === "") continue;
      // Close the nearest matching open element, and everything left dangling
      // inside it. An end tag with no open partner is ignored outright.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === name) {
          closeTo(k);
          break;
        }
      }
      continue;
    }

    // Anything not a letter after `<` is literal text, per the tag-open state.
    if (!next || !/[a-zA-Z]/.test(next)) {
      emit("&lt;");
      i = lt + 1;
      continue;
    }

    const tag = parseStartTag(html, lt);
    if (!tag) {
      emit("&lt;");
      i = lt + 1;
      continue;
    }
    i = tag.end;

    // Raw-text elements: their content is not markup, so consume it raw up to
    // the close tag and drop the lot. Doing this before any allow-list check is
    // what stops `<style>...</style>` bodies being re-tokenized as markup.
    if (RAW_TEXT_TAGS.has(tag.name)) {
      const closeRe = new RegExp(`</${tag.name}[\\s/>]`, "i");
      const rest = html.slice(i);
      const m = rest.match(closeRe);
      if (m && m.index !== undefined) {
        const after = html.indexOf(">", i + m.index);
        i = after === -1 ? html.length : after + 1;
      } else {
        i = html.length;
      }
      continue;
    }

    if (policy.dropWithContent.has(tag.name)) {
      if (VOID_TAGS.has(tag.name) || tag.selfClosing) continue;
      stack.push({ tag: tag.name, emitted: false, suppressed: true });
      suppressDepth++;
      continue;
    }

    if (!policy.allowedTags.has(tag.name)) {
      // Unwrap: drop the element, keep whatever is inside it.
      if (VOID_TAGS.has(tag.name) || tag.selfClosing) continue;
      stack.push({ tag: tag.name, emitted: false, suppressed: false });
      continue;
    }

    // Implied end tags, then the depth cap.
    const implied = IMPLIED_END[tag.name];
    if (implied) {
      // Walk down through the contiguous run of implicitly-closable peers and
      // close all of them at once. Unwrapped elements (an unknown wrapper that
      // emits nothing) are transparent here: they must not block the close, or
      // the same input would sanitize differently on a second pass.
      let target = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (implied.has(stack[k].tag)) {
          target = k;
          continue;
        }
        if (!stack[k].emitted) continue;
        break;
      }
      if (target >= 0) closeTo(target);
    }
    if (stack.length >= MAX_DEPTH) {
      if (!VOID_TAGS.has(tag.name) && !tag.selfClosing) {
        stack.push({ tag: tag.name, emitted: false, suppressed: false });
      }
      continue;
    }

    let open = `<${tag.name}`;
    const seen = new Set();
    for (const [name, raw] of tag.attrs) {
      if (seen.has(name)) continue; // First wins, as the parser does.
      if (!isAllowedAttr(tag.name, name, policy)) continue;
      const value = safeAttrValue(tag.name, name, raw, policy);
      if (value === null) continue;
      seen.add(name);
      open += ` ${name}="${escapeHtml(value)}"`;
    }
    // Links leave through a mail client or an agent; say what they are.
    if (tag.name === "a" && seen.has("href")) {
      open += ` rel="noopener noreferrer nofollow"`;
    }
    if (VOID_TAGS.has(tag.name)) {
      emit(`${open}>`);
      continue;
    }
    emit(`${open}>`);
    if (tag.selfClosing) {
      emit(`</${tag.name}>`);
      continue;
    }
    stack.push({ tag: tag.name, emitted: true, suppressed: false });
  }

  closeTo(0);

  const result = out.join("");
  return result.length > policy.maxOutputLength
    ? result.slice(0, policy.maxOutputLength)
    : result;
}

// ---- policies --------------------------------------------------------------

/** Structural elements both policies keep. */
const COMMON_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col",
  "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd",
  "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong",
  "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
  "u", "ul",
];

/**
 * Dropped with their subtree rather than unwrapped, because their content is
 * not prose: it is code, styling, or an embedded document.
 */
const COMMON_DROP = [
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "form", "input", "button", "textarea", "select", "option", "optgroup",
  "noscript", "svg", "math", "template", "canvas", "video", "audio", "source",
  "track", "applet", "frame", "frameset", "map", "area", "portal", "dialog",
];

/**
 * `id`, `srcset`, `data-*` and `aria-*` are absent on purpose. An
 * attacker-controlled aria-label is a screen-reader spoof, and `srcset` is a
 * second image-source channel that any `src` policy would otherwise miss.
 *
 * `class` is here but is VALUE-gated to the single signature container name
 * (see SIGNATURE_CONTAINER_CLASS); no attacker-chosen class survives.
 *
 * `style` is NOT here. The signature policy adds it below, filtered; the email
 * policy never gets it.
 */
const COMMON_GLOBAL_ATTRS = ["dir", "lang", "title", "class"];

const COMMON_TAG_ATTRS = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  ol: new Set(["start", "type"]),
  time: new Set(["datetime"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
};

/** http(s) and mailto only. `tel:` and `cid:` are not link targets. */
const SAFE_HREF_SCHEMES = /^(https?:\/\/|mailto:)/i;

/**
 * EMAIL: no external image source of any kind.
 *
 * `cid:` points at an attachment already inside the same message, so it costs
 * no request and leaks nothing. Base64 raster `data:` images are inline bytes,
 * likewise inert. `data:image/svg+xml` is deliberately EXCLUDED. SVG is a
 * document, not a raster, and it is the one image type that carries script.
 * Every remote scheme is gone: an `https:` pixel in a stranger's mail is a read
 * receipt that fires on render.
 */
const EMAIL_SRC_SCHEMES =
  /^(cid:|data:image\/(png|gif|jpeg|jpg|webp|bmp);base64,)/i;

/** SIGNATURE: https-hosted logos are the point, so they stay. */
const SIGNATURE_SRC_SCHEMES = /^https:\/\//i;

export const EMAIL_HTML_MAX_LENGTH = 512 * 1024;
export const SIGNATURE_HTML_MAX_LENGTH = 100 * 1024;

/** @type {SanitizePolicy} */
export const EMAIL_HTML_POLICY = {
  allowedTags: new Set(COMMON_TAGS),
  dropWithContent: new Set(COMMON_DROP),
  globalAttrs: new Set(COMMON_GLOBAL_ATTRS),
  tagAttrs: COMMON_TAG_ATTRS,
  hrefSchemes: SAFE_HREF_SCHEMES,
  srcSchemes: EMAIL_SRC_SCHEMES,
  styleProps: null,
  maxOutputLength: EMAIL_HTML_MAX_LENGTH,
};

/**
 * The signature policy is the email policy plus the presentational vocabulary a
 * real signature is written in.
 *
 * It mirrors the save-time sanitizer (./sanitizeSignatureHtml.js), which is the
 * authority on what a signature may contain and has always allowed `style`,
 * `align`, `color`, `target` and `<font>`. This pass is defense-in-depth, so
 * it must not be STRICTER than the thing that wrote the row: a pass that
 * strips formatting the editor legitimately saved would ship every rich
 * signature as unstyled text.
 */
const SIGNATURE_TAG_ATTRS = {
  ...COMMON_TAG_ATTRS,
  a: new Set(["href", "target"]),
  font: new Set(["color", "face", "size"]),
  table: new Set(["align", "width", "bgcolor"]),
  td: new Set(["colspan", "rowspan", "align", "valign", "width", "bgcolor"]),
  th: new Set([
    "colspan", "rowspan", "scope", "align", "valign", "width", "bgcolor",
  ]),
};

/** @type {SanitizePolicy} */
export const SIGNATURE_HTML_POLICY = {
  // `font` is legacy, but an Outlook signature pasted into the editor arrives
  // full of it, and the save-time policy accepts it.
  allowedTags: new Set([...COMMON_TAGS, "font"]),
  dropWithContent: new Set(COMMON_DROP),
  globalAttrs: new Set([...COMMON_GLOBAL_ATTRS, "style", "align", "color"]),
  tagAttrs: SIGNATURE_TAG_ATTRS,
  hrefSchemes: SAFE_HREF_SCHEMES,
  srcSchemes: SIGNATURE_SRC_SCHEMES,
  styleProps: SAFE_STYLE_PROPS,
  maxOutputLength: SIGNATURE_HTML_MAX_LENGTH,
};
