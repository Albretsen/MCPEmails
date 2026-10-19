// ---------------------------------------------------------------------------
// Carrying a plain-text edit into a draft's HTML part (draft card, 2026-10-17)
//
// The draft editor card is a plain-text surface over a message that may have a
// formatted HTML part: a heading, bold text, a bulleted list, a link. Until
// this module, ANY change to the text regenerated the HTML part from the text
// (`plainTextBodyToHtml`), so typing one word into such a draft and pressing
// Save turned the heading into a line, the bullets into "- " lines and the
// link into words. Nothing warned before the save, and nothing said so after
// it, because the regenerated part was still an HTML part (QA, 2026-10-17).
//
// Two questions are answered here, and both the server and the card ask them,
// which is why this file is shared and has no imports:
//
//   * `mergeTextEditIntoHtml`: can this edit be made IN the stored HTML, so
//     the formatting stays? It can when every changed line of text is found,
//     with enough of its surrounding words to be unambiguous, inside exactly
//     one text run of the HTML. Then only that run's characters change.
//   * `htmlHasFormatting`: when it cannot, is anything lost by regenerating?
//     Not for HTML that is itself text with line breaks (what this server
//     writes for a text-only draft); yes for a heading, a list, a link.
//
// The server (`mcp-app-drafts.ts#applyDraftPatch`) writes the merged HTML when
// there is one; otherwise drops a formatted HTML part entirely and says so
// (`body.formatting_removed`); otherwise regenerates as before. The card
// (`DraftEditor.tsx`) runs the same two functions over the same stored text
// and HTML to warn BEFORE the save, so its warning and the server's outcome
// cannot disagree.
//
// ── WHY "EXACTLY ONE", THREE TIMES ──────────────────────────────────────────
// The danger of a merge is editing the wrong place: the HTML would then say
// something the text does not, which is the 2026-09-09 `approval_update` bug
// this whole area exists to prevent. So a change is placed only when its
// search string occurs exactly once in the old text, exactly once in a single
// text run of the HTML, and exactly once in the HTML's text read straight
// through (which catches a second copy split across inline tags). Anything
// less certain falls back, and the fallback is truthful. And before any of
// that, the two stored parts must say the same words (`sameWords`): a merge
// carries everything it did not change, so it must not carry a disagreement.
//
// ── WHAT IS NEVER A TARGET ─────────────────────────────────────────────────
// Text inside a link: changing the words of a link while its address stays is
// a link that says one place and goes to another. Text inside our signature
// block: a signature edit keeps its existing, separately warned path
// (`signature-compose.ts#rebuildHtmlKeepingSignature`). Text inside `<style>`,
// `<script>`, `<title>` and comments is not visible text at all. These still
// count towards "exactly once", so they can block a merge but never receive it.
//
// PURE: no I/O, no DOM, no Deno or browser API. The card bundles this file.
// ---------------------------------------------------------------------------

/** Elements whose content is not visible text. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "textarea", "noscript", "template"]);

/**
 * Elements that make an HTML part more than text with line breaks. Losing any
 * of these is losing formatting a person can see.
 */
const FORMATTING_ELEMENTS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "big",
  "sub", "sup", "code", "pre", "kbd", "tt", "font", "center", "blockquote", "q", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "img", "picture", "svg", "video", "audio",
]);

/** The wrapper `applySignature` writes around a signature. */
const SIGNATURE_OPEN = '<div class="mcpemails-signature">';

/** Never merge more changed lines than this; past it, the fallback is fine. */
const MAX_CHANGED_LINES = 40;

/** The context sizes tried around a change, widest first. */
const CONTEXTS = [Infinity, 32, 16, 8, 4, 2, 0];

/** A search string shorter than this is too likely to be a coincidence. */
const MIN_NEEDLE = 4;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®",
};

/** One visible character of a text run, and the source bytes it came from. */
interface TextUnit {
  ch: string;
  start: number;
  end: number;
}

/** A run of text between two tags. */
interface TextRun {
  units: TextUnit[];
  /** False for text that may count but must never be edited. */
  target: boolean;
  /** Inside our signature block. */
  sig: boolean;
  /**
   * Which line of the rendered message the run is on: it changes at every tag
   * that is not inline (a paragraph, a `<br>`, a list item, an image).
   */
  block: number;
  /**
   * Inside a link: where its outermost `<a` starts and its `</a>` ends, and
   * whether this run is the link's first or last. New words typed just before
   * or after a link go before its `<a` or after its `</a>`, never in it.
   */
  link?: { open: number; closeEnd: number | null; first: boolean; last: boolean };
}

/** Tags that keep text on the same line: a run on either side is the same line. */
const INLINE_ELEMENTS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "big",
  "sub", "sup", "code", "kbd", "tt", "font", "span", "q", "abbr", "cite", "var", "samp",
  "time", "label", "bdi", "bdo", "wbr",
]);

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
  attrs: string;
}

/** The tag that opens at `at` (a "<"), or null when "<" is just a character. */
function readTag(html: string, at: number): Tag | null {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(at, at + 64));
  if (!m) return null;
  let i = at + m[0].length;
  let quote: string | null = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      const attrs = html.slice(at + m[0].length, i);
      return {
        name: m[2].toLowerCase(),
        closing: m[1] === "/",
        selfClosing: attrs.trimEnd().endsWith("/"),
        end: i + 1,
        attrs,
      };
    }
  }
  return null;
}

function decodeEntity(html: string, at: number): { text: string; end: number } | null {
  const m = /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
    html.slice(at, at + 40),
  );
  if (!m) return null;
  const body = m[1];
  let text: string | undefined;
  if (body[0] === "#") {
    const code = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) text = String.fromCodePoint(code);
  } else {
    text = NAMED_ENTITIES[body.toLowerCase()];
  }
  return text === undefined ? null : { text, end: at + m[0].length };
}

/** Every run of visible text in `html`, in order. */
function textRuns(html: string): TextRun[] {
  const runs: TextRun[] = [];
  let units: TextUnit[] = [];
  let linkDepth = 0;
  let sigDepth = 0; // div depth inside our signature block, 0 = outside
  let block = 0;
  let linkOpen = -1;
  let linkRuns: TextRun[] = [];
  const flush = () => {
    if (units.length > 0) {
      const run: TextRun = {
        units,
        target: linkDepth === 0 && sigDepth === 0,
        sig: sigDepth > 0,
        block,
      };
      if (linkDepth > 0) {
        run.link = { open: linkOpen, closeEnd: null, first: linkRuns.length === 0, last: false };
        linkRuns.push(run);
      }
      runs.push(run);
    }
    units = [];
  };
  let i = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === "<") {
      if (html.startsWith("<!--", i)) {
        flush();
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? html.length : end + 3;
        continue;
      }
      if (html[i + 1] === "!" || html[i + 1] === "?") {
        flush();
        const end = html.indexOf(">", i);
        i = end === -1 ? html.length : end + 1;
        continue;
      }
      const tag = readTag(html, i);
      if (tag) {
        flush();
        if (!INLINE_ELEMENTS.has(tag.name)) block++;
        if (tag.name === "a" && !tag.selfClosing) {
          if (!tag.closing && linkDepth === 0) {
            linkOpen = i;
            linkRuns = [];
          }
          const wasInLink = linkDepth > 0;
          linkDepth = Math.max(0, linkDepth + (tag.closing ? -1 : 1));
          if (tag.closing && wasInLink && linkDepth === 0) {
            for (const r of linkRuns) r.link!.closeEnd = tag.end;
            if (linkRuns.length > 0) linkRuns[linkRuns.length - 1].link!.last = true;
            linkRuns = [];
          }
        }
        if (tag.name === "div" && !tag.selfClosing) {
          if (sigDepth > 0) sigDepth += tag.closing ? -1 : 1;
          else if (!tag.closing && html.startsWith(SIGNATURE_OPEN, i)) sigDepth = 1;
        }
        i = tag.end;
        if (!tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
          const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
          i = close === -1 ? html.length : close;
        }
        continue;
      }
    }
    if (c === "&") {
      const ent = decodeEntity(html, i);
      if (ent) {
        for (const ch of ent.text.split("")) units.push({ ch, start: i, end: ent.end });
        i = ent.end;
        continue;
      }
    }
    units.push({ ch: c, start: i, end: i + 1 });
    i++;
  }
  flush();
  return runs;
}

const isSpace = (ch: string) => /[ \t\n\r\f ]/.test(ch);

/** A text run with every whitespace run collapsed to one space, as a browser shows it. */
function collapseRun(units: TextUnit[]): { text: string; units: TextUnit[] } {
  const out: TextUnit[] = [];
  for (const u of units) {
    if (isSpace(u.ch)) {
      const last = out[out.length - 1];
      if (last && last.ch === " ") {
        last.end = u.end;
        continue;
      }
      out.push({ ch: " ", start: u.start, end: u.end });
    } else {
      out.push({ ...u });
    }
  }
  return { text: out.map((u) => u.ch).join(""), units: out };
}

/** `s` collapsed like a text run, and where each of `cuts` (offsets into `s`) lands in it. */
function collapseText(s: string, cuts: number[]): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let i = 0; i <= s.length; i++) {
    for (let k = 0; k < cuts.length; k++) if (cuts[k] === i) at[k] = out.length;
    if (i === s.length) break;
    const ch = isSpace(s[i]) ? " " : s[i];
    if (ch === " " && out.endsWith(" ")) continue;
    out += ch;
  }
  return { text: out, at };
}

function countOccurrences(hay: string, needle: string, limit = 2): number {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1 && n < limit; at = hay.indexOf(needle, at + 1)) n++;
  return n;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type CollapsedRun = TextRun & { text: string };
type Edge = "start" | "middle" | "end";

/** True when a cut before unit `a` would split one entity (`&#x1F600;`) in the source. */
function cutsEntity(u: TextUnit[], a: number): boolean {
  return a > 0 && a < u.length && u[a - 1].end > u[a].start;
}

/**
 * The source offset for words inserted at offset `o + offset` of `straight`
 * (the runs read straight through), where the context `needle` matched at `o`
 * across more than one run. Null when it cannot be placed with certainty.
 *
 * Inside a run, the words go there. Between two runs, they join the run on
 * the side the line continues: the run before at the end of a line, the run
 * after at its start, and in the middle the run before (an editor carries on
 * the formatting of the text before the caret) unless that is a link, then
 * the run after. A link is never edited: words at its edge go just outside
 * its `<a>`…`</a>`. Text in our signature block is never a target. And the
 * whole context must be on one line of the HTML, or the text's line and the
 * HTML's disagree about where the words are.
 */
function placeBetweenRuns(
  runs: CollapsedRun[],
  o: number,
  length: number,
  offset: number,
  edge: Edge,
  inserted: string,
): number | null {
  if (o < 0) return null;
  const point = o + offset;
  let before: { run: CollapsedRun } | null = null;
  let after: { run: CollapsedRun } | null = null;
  let inside: { run: CollapsedRun; k: number } | null = null;
  let block: number | null = null;
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    if (end > o && start < o + length) {
      if (block !== null && block !== run.block) return null;
      block = run.block;
    }
    if (start < point && point < end) inside = { run, k: point - start };
    else if (end === point) before = { run };
    else if (start === point && !after) after = { run };
  }
  if (block === null) return null;
  // Letters typed straight onto a link's word ("x.comX") may be meant as part
  // of the link's words: not certain either way, so not placed.
  const wordChar = /[\p{L}\p{N}]/u;
  const lastOf = (r: CollapsedRun) => r.text[r.text.length - 1] ?? "";
  if (before?.run.link && wordChar.test(lastOf(before.run)) && wordChar.test(inserted[0] ?? "")) return null;
  if (after?.run.link && wordChar.test(after.run.text[0] ?? "") && wordChar.test(inserted[inserted.length - 1] ?? "")) {
    return null;
  }
  if (inside) {
    if (!inside.run.target || cutsEntity(inside.run.units, inside.k)) return null;
    return inside.run.units[inside.k].start;
  }
  const atEnd = (r: CollapsedRun | undefined): number | null => {
    if (!r || r.block !== block || r.sig) return null;
    if (r.target) return r.units[r.units.length - 1].end;
    return r.link?.last && r.link.closeEnd !== null ? r.link.closeEnd : null;
  };
  const atStart = (r: CollapsedRun | undefined): number | null => {
    if (!r || r.block !== block || r.sig) return null;
    if (r.target) return r.units[0].start;
    return r.link?.first ? r.link.open : null;
  };
  if (edge === "end") return atEnd(before?.run);
  if (edge === "start") return atStart(after?.run);
  if (before?.run.target && before.run.block === block) return atEnd(before.run);
  if (after?.run.target && after.run.block === block) return atStart(after.run);
  return null;
}

/**
 * Change one line of text in `html`: `oldLine` (as it reads in `oldText`)
 * becomes `newLine`. Null when the change cannot be placed with certainty.
 */
function mergeLine(html: string, oldText: string, oldLine: string, newLine: string): string | null {
  let p = 0;
  while (p < oldLine.length && p < newLine.length && oldLine[p] === newLine[p]) p++;
  let s = 0;
  while (
    s < oldLine.length - p && s < newLine.length - p &&
    oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]
  ) s++;
  const oldEnd = oldLine.length - s;
  const inserted = newLine.slice(p, newLine.length - s);

  const runs: CollapsedRun[] = textRuns(html).map((r) => ({ ...r, ...collapseRun(r.units) }));
  const straight = runs.map((r) => r.text).join("");
  const flatOld = collapseText(oldText, []).text;

  // A list or quote marker the text writes at the start of a line ("- ",
  // "1. ", "> ") is not in the HTML's text; context never reaches into it.
  const marker = /^\s*(?:[-*\u2022]|\d{1,3}[.)]|>+)\s+/.exec(oldLine)?.[0].length ?? 0;
  const lineStart = Math.min(p, marker);
  // Where on its line a pure insertion is: it decides which run the new words
  // join when the insertion falls between two runs (see `placeBetweenRuns`).
  const edge: Edge = p >= oldLine.trimEnd().length ? "end" : p <= marker ? "start" : "middle";
  // Both sides first, then the side before the change, then the side after:
  // an insertion where two runs meet ("Hello |Dana", with Dana in <b>) has its
  // context in one run only. The run before it is preferred, which is what an
  // editor does: typed words carry on the formatting of the text before them.
  const shapes: Array<[number, number]> = [];
  for (const w of CONTEXTS) shapes.push([w, w], [w, 0], [0, w]);
  for (const [before, afterW] of shapes) {
    const from = Math.max(lineStart, p - before);
    const to = Math.min(oldLine.length, oldEnd + afterW);
    const { text: needle, at } = collapseText(oldLine.slice(from, to), [p - from, oldEnd - from]);
    if (needle.trim().length < MIN_NEEDLE) continue;
    if (countOccurrences(flatOld, needle) !== 1) continue;
    if (countOccurrences(straight, needle) !== 1) continue;
    let hit: { run: (typeof runs)[number]; index: number } | null = null;
    let found = 0;
    for (const run of runs) {
      for (let k = run.text.indexOf(needle); k !== -1; k = run.text.indexOf(needle, k + 1)) {
        found++;
        hit = { run, index: k };
      }
    }
    // Nothing deleted, and the context runs across tags ("…at <a>x.com</a>.|"):
    // the insertion point is still certain, so place it between the runs.
    if (found === 0 && p === oldEnd && inserted.length > 0) {
      const at0 = placeBetweenRuns(runs, straight.indexOf(needle), needle.length, at[0], edge, inserted);
      if (at0 === null) continue;
      return html.slice(0, at0) + escapeText(inserted) + html.slice(at0);
    }
    if (found !== 1 || !hit || !hit.run.target) continue;
    const a = hit.index + at[0];
    const b = hit.index + at[1];
    const u = hit.run.units;
    let rawStart: number;
    let rawEnd: number;
    if (a < b) {
      rawStart = u[a].start;
      rawEnd = u[b - 1].end;
    } else {
      rawStart = rawEnd = a < u.length ? u[a].start : u[a - 1].end;
    }
    // A cut through the middle of one entity (a character outside the BMP
    // decoded from `&#x1F600;`) cannot be made in the source. Fall back.
    if ((a > 0 && a < u.length && u[a - 1].end > u[a].start) ||
      (b > 0 && b < u.length && u[b - 1].end > u[b].start)) return null;
    return html.slice(0, rawStart) + escapeText(inserted) + html.slice(rawEnd);
  }
  return null;
}

/**
 * Letters and digits only, with web addresses left out, and the number of a
 * numbered line ("1. ", "2) ") too: an `<ol>` numbers its items without any
 * digit in the HTML's text (card re-test, 2026-10-17).
 */
function wordsOf(text: string): string {
  return text.replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, " ")
    .replace(/\b(?:https?:\/\/|mailto:|www\.)[^\s<>()\[\]]+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * True when the HTML part and the text part say the same words, ignoring
 * punctuation, layout and addresses ("- " bullets, "1. " numbers, "> " quotes, a link's URL
 * written out in the text).
 *
 * A merge changes only the lines that were edited and carries the rest of the
 * HTML part through. That is right only when the rest already said what the
 * text says. A draft whose two parts disagree (an agent wrote them apart, or
 * the text has a quoted original the HTML lacks) is regenerated from the text
 * as before, which brings them back in line; a merge would keep the
 * disagreement.
 */
function sameWords(html: string, text: string): boolean {
  const visible = textRuns(html).map((r) => r.units.map((u) => u.ch).join("")).join(" ");
  return wordsOf(visible) === wordsOf(text);
}

/**
 * The stored HTML part with a plain-text edit made inside it, keeping every tag
 * as it was, or null when the edit cannot be placed with certainty (see the
 * header). `oldText` is the stored text part the person started from, `newText`
 * what they are saving.
 *
 * Edits that keep the number of lines are merged line by line: each changed
 * line is placed on its own. Lines added only at the very end or only at the
 * very start, with every old line kept as it was, become new elements after
 * the last block or before the first (`appendLines`, `prependLines`). Any
 * other new or removed line (one added in the middle, a joined paragraph,
 * lines added while others changed) is structure the text cannot place, so it
 * falls back. Whatever is merged must still say the same words as `newText`.
 */
export function mergeTextEditIntoHtml(
  html: string | null | undefined,
  oldText: string | null | undefined,
  newText: string,
): string | null {
  if (typeof html !== "string" || html.length === 0) return null;
  if (typeof oldText !== "string" || oldText.trim().length === 0) return null;
  if (!sameWords(html, oldText)) return null;
  let oldLines = oldText.replace(/\r\n?/g, "\n").split("\n");
  let newLines = newText.replace(/\r\n?/g, "\n").split("\n");
  if (oldLines.length !== newLines.length) {
    // Blank lines at the end show nothing (a textarea's trailing newline).
    oldLines = withoutTrailingBlankLines(oldLines);
    newLines = withoutTrailingBlankLines(newLines);
  }
  let out: string | null;
  if (oldLines.length === newLines.length) {
    out = mergeSameLines(html, oldLines, newLines);
  } else if (newLines.length > oldLines.length) {
    const added = newLines.length - oldLines.length;
    const same = (shift: number) => oldLines.every((l, i) => l.trimEnd() === newLines[i + shift].trimEnd());
    if (same(0)) out = appendLines(html, newLines.slice(oldLines.length));
    else if (same(added)) out = prependLines(html, newLines.slice(0, added));
    else out = null;
  } else {
    out = null;
  }
  if (out === null) return null;
  // The last gate: the merged HTML says what the new text says.
  return out === html || sameWords(out, newText) ? out : null;
}

function withoutTrailingBlankLines(lines: string[]): string[] {
  let n = lines.length;
  while (n > 0 && lines[n - 1].trim() === "") n--;
  return lines.slice(0, n);
}

/** Lines changed in place, the count unchanged: each placed on its own. */
function mergeSameLines(html: string, oldLines: string[], newLines: string[]): string | null {
  const changed: number[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i].trimEnd() !== newLines[i].trimEnd()) changed.push(i);
  }
  if (changed.length === 0) return html;
  if (changed.length > MAX_CHANGED_LINES) return null;
  let out = html;
  const working = [...oldLines];
  for (const i of changed) {
    const next = mergeLine(out, working.join("\n"), working[i], newLines[i]);
    if (next === null) return null;
    out = next;
    working[i] = newLines[i];
  }
  return out;
}

// ── LINES ADDED AT THE EDGE (live claude.ai test, 2026-10-19) ───────────────
// A new last paragraph ("P.S. …") or a new first line ("Hi Dana,") is placed
// only where the HTML's own structure says what it should be: right after the
// block holding the last text (or before the one holding the first), when
// that block is a paragraph, a heading, a Gmail-style `<div>` line or a list
// item, and nothing but wrappers (`div`, `body`, `html`) lies beyond it. Then
// a new paragraph is a `<p>`, a new div line a `<div>`, a new "- " line under
// a list an `<li>`, and text with line breaks gets `<br>`s. Anything else (a
// quote, a table, an empty paragraph after the text, our signature block at
// the end) is not guessed at, and falls back.

const PARAGRAPH_LIKE = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);
const WRAPPERS = new Set(["div", "body", "html"]);
const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d{1,3}[.)]\s+/;

/** Lines split into paragraphs at blank lines, each as a `<p>` with `<br>`s. */
function asParagraphs(lines: string[]): string {
  const groups: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === "") {
      if (groups[groups.length - 1].length > 0) groups.push([]);
    } else {
      groups[groups.length - 1].push(escapeText(line.trim()));
    }
  }
  return groups.filter((g) => g.length > 0).map((g) => `<p>${g.join("<br>")}</p>`).join("");
}

/** Each line as a Gmail-style `<div>`, a blank one as `<div><br></div>`. */
function asDivs(lines: string[]): string {
  return lines.map((l) => `<div>${l.trim() === "" ? "<br>" : escapeText(l.trim())}</div>`).join("");
}

/** Lines that are all "- " (or all "1. ") items, as `<li>`s; null otherwise. */
function asItems(lines: string[], ordered: boolean): string | null {
  const marker = ordered ? NUMBER : BULLET;
  if (lines.length === 0 || !lines.every((l) => marker.test(l))) return null;
  return lines.map((l) => `<li>${escapeText(l.replace(marker, "").trim())}</li>`).join("");
}

const looksLikeItem = (l: string) => BULLET.test(l) || NUMBER.test(l);

function leadingBlankLines(lines: string[]): number {
  let n = 0;
  while (n < lines.length && lines[n].trim() === "") n++;
  return n;
}

/** `html` with `added` (lines after the last old line) placed after its last block. */
function appendLines(html: string, added: string[]): string | null {
  if (html.includes(SIGNATURE_OPEN)) return null;
  const lead = leadingBlankLines(added);
  const body = added.slice(lead);
  if (body.length === 0) return html;
  const last = [...textRuns(html)].reverse().find((r) => r.units.some((u) => !isSpace(u.ch)));
  if (!last) return null;
  const lastEnd = last.units[last.units.length - 1].end;
  // Only closing tags (and whitespace, comments) may follow the last text.
  const closings: Array<{ name: string; end: number }> = [];
  let i = lastEnd;
  while (i < html.length) {
    if (isSpace(html[i])) {
      i++;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    const tag = html[i] === "<" ? readTag(html, i) : null;
    if (!tag || !tag.closing) break;
    closings.push({ name: tag.name, end: tag.end });
    i = tag.end;
  }
  if (i < html.length && !closings.some((c) => c.name === "body" || c.name === "html")) return null;
  let k = 0;
  while (k < closings.length && INLINE_ELEMENTS.has(closings[k].name)) k++;
  const rest = closings.slice(k);
  const onlyWrappers = (list: typeof rest) => list.every((c) => WRAPPERS.has(c.name));
  const insert = (at: number, s: string) => html.slice(0, at) + s + html.slice(at);

  // Text with line breaks, in no block of its own.
  if (rest.length === 0 || rest[0].name === "body" || rest[0].name === "html") {
    const at = k === 0 ? lastEnd : closings[k - 1].end;
    return insert(at, "<br>" + added.map((l) => escapeText(l.trim())).join("<br>"));
  }
  const name = rest[0].name;
  if (PARAGRAPH_LIKE.has(name) && onlyWrappers(rest.slice(1))) {
    return insert(rest[0].end, asParagraphs(body));
  }
  if (name === "div" && onlyWrappers(rest.slice(1))) {
    return insert(rest[0].end, asDivs(added));
  }
  if (name === "li" && rest.length > 1 && (rest[1].name === "ul" || rest[1].name === "ol") &&
    onlyWrappers(rest.slice(2))) {
    // Straight under the last item: more items. After a blank line: a paragraph.
    if (lead === 0) {
      const items = asItems(body, rest[1].name === "ol");
      return items === null ? null : insert(rest[0].end, items);
    }
    return body.some(looksLikeItem) ? null : insert(rest[1].end, asParagraphs(body));
  }
  return null;
}

/** `html` with `added` (lines before the first old line) placed before its first block. */
function prependLines(html: string, added: string[]): string | null {
  const lines = added.slice(leadingBlankLines(added));
  const trail = lines.length - withoutTrailingBlankLines(lines).length;
  const body = lines.slice(0, lines.length - trail);
  if (body.length === 0) return html;
  const first = textRuns(html).find((r) => r.units.some((u) => !isSpace(u.ch)));
  if (!first) return null;
  const firstStart = first.units[0].start;
  // The tags opened since the last one closed, before the first text.
  let open: Array<{ name: string; start: number }> = [];
  let i = 0;
  while (i < firstStart) {
    const c = html[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (c === "&") {
      const ent = decodeEntity(html, i);
      if (!ent || !isSpace(ent.text)) return null;
      i = ent.end;
      continue;
    }
    const tag = c === "<" ? readTag(html, i) : null;
    if (!tag) return null;
    if (tag.closing) {
      open = [];
    } else {
      open.push({ name: tag.name, start: i });
      if (!tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
        const close = html.toLowerCase().indexOf(`</${tag.name}`, tag.end);
        if (close === -1) return null;
        i = close;
        continue;
      }
    }
    i = tag.end;
  }
  let j = open.length - 1;
  while (j >= 0 && INLINE_ELEMENTS.has(open[j].name)) j--;
  const insert = (at: number, s: string) => html.slice(0, at) + s + html.slice(at);
  if (j < 0 || open[j].name === "body" || open[j].name === "html") {
    const at = j + 1 < open.length ? open[j + 1].start : firstStart;
    return insert(at, lines.map((l) => escapeText(l.trim())).join("<br>") + "<br>");
  }
  const name = open[j].name;
  if (PARAGRAPH_LIKE.has(name)) return insert(open[j].start, asParagraphs(body));
  if (name === "div") return insert(open[j].start, asDivs(lines));
  if (name === "li" && j > 0 && (open[j - 1].name === "ul" || open[j - 1].name === "ol")) {
    if (trail === 0) {
      const items = asItems(body, open[j - 1].name === "ol");
      return items === null ? null : insert(open[j].start, items);
    }
    return body.some(looksLikeItem) ? null : insert(open[j - 1].start, asParagraphs(body));
  }
  return null;
}

/** `html` with our signature block (balanced `div`s) cut out. */
function withoutSignatureBlock(html: string): string {
  const at = html.lastIndexOf(SIGNATURE_OPEN);
  if (at === -1) return html;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = at + SIGNATURE_OPEN.length;
  let depth = 1;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, at) + html.slice(m.index + m[0].length);
  }
  return html.slice(0, at);
}

/**
 * True when the HTML part, outside our signature block, has formatting a person
 * would lose if it were regenerated from the text: a heading, emphasis, a list,
 * a link, a table, an image, a quote. False for HTML that is text with line
 * breaks and paragraphs, which `plainTextBodyToHtml` reproduces. The signature
 * block is left out because a body edit keeps it
 * (`rebuildHtmlKeepingSignature`); its own warning is `signature.rich`.
 */
export function htmlHasFormatting(html: string | null | undefined): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  const body = withoutSignatureBlock(html);
  for (let i = body.indexOf("<"); i !== -1; i = body.indexOf("<", i + 1)) {
    const tag = readTag(body, i);
    if (!tag) continue;
    if (!tag.closing && FORMATTING_ELEMENTS.has(tag.name)) return true;
    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name) && !tag.selfClosing) {
      const close = body.toLowerCase().indexOf(`</${tag.name}`, tag.end);
      if (close === -1) break;
      i = close;
    }
  }
  return false;
}

// ── A TEXT PART THAT SAYS WHAT THE HTML SAYS (card re-test, 2026-10-17) ──────
// `sameWords` gates every merge, and on the drafts Claude actually writes it
// never passed. `draft{action:"create"}` requires a plain-text `body`, and
// Claude writes its own: "Learn more: https://mcpemails.com" in the text next
// to `Learn more at <a href="…">mcpemails.com</a>` in the HTML, "- item" next
// to `<li>item</li>`. So one changed word in the card warned "Saving this edit
// turns the whole message into plain text", and saving stripped the heading,
// the list and the link (live claude.ai re-test, 2026-10-17). When Claude was
// made to write the text word for word from the HTML, the same one-word edit
// kept every tag: the merge was fine, the stored pair was not.
//
// So when an agent writes both parts (create, reply, update) and the HTML is
// formatted and says different words, the stored text part is the HTML's own
// text, read off it here, instead of the agent's. The merge gate is unchanged
// and still refuses parts that disagree; the card still asks it the same
// question as the server. What changes is that the server no longer stores a
// disagreement to begin with.
//
// The HTML wins because it is what nearly every recipient reads and what the
// card's "Show formatting" shows. The result is used only when `sameWords`
// holds for it, so it carries every word of the HTML and nothing else (link
// addresses aside). Anything this reader gets wrong fails that check and leaves
// the agent's text exactly as it was, which is the behaviour before this.
// Unformatted HTML and parts that already agree are never touched. It runs on
// the agent's own parts, before the signature or the quoted original is added
// (`applySignature`, `buildReplyTextBody`), so neither is involved.
//
// A draft stored before this, or written elsewhere with parts that disagree,
// still falls back with the warning: still true, just not fixed here.

/** Elements that end a paragraph: a blank line after them. */
const PARAGRAPH_ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "blockquote", "pre", "table", "hr",
]);

/** Elements that end a line. */
const LINE_ELEMENTS = new Set([
  "div", "li", "tr", "dt", "dd", "section", "article", "header", "footer", "main", "nav",
  "aside", "figure", "figcaption", "address", "center", "form", "fieldset",
]);

/** The address of an `<a>` tag, when it is one a reader can type in. */
function linkAddress(attrs: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim().replace(/&amp;/gi, "&");
  return /^(?:https?:\/\/|mailto:)\S+$/i.test(raw) ? raw : null;
}

/** An address, or a link's words, reduced to compare: no scheme, no `www.`, no trailing slash. */
function bareAddress(s: string): string {
  return s.trim().toLowerCase().replace(/^(?:https?:\/\/|mailto:)/, "").replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * The HTML read as plain text the way a person would type it: a line per
 * block with a blank line after a paragraph, "- " or "1. " before a list item,
 * and a link's address after its words when the words are not the address.
 */
function htmlAsText(html: string): string {
  let out = "";
  let gap = 0; // line breaks owed before the next visible character
  let space = false; // a space owed before it
  let markerOnly = false; // the current line holds just a list marker so far
  const lists: Array<{ ordered: boolean; n: number }> = [];
  const links: Array<{ href: string | null; from: number }> = [];
  const owe = (lines: number) => {
    if (markerOnly) return; // `<li><p>item</p></li>` stays on the marker's line
    gap = Math.max(gap, lines);
    space = false;
  };
  const put = (s: string) => {
    if (out.length > 0 && gap > 0) out += "\n".repeat(gap);
    else if (space && out.length > 0 && !out.endsWith("\n") && !out.endsWith(" ")) out += " ";
    gap = 0;
    space = false;
    markerOnly = false;
    out += s;
  };
  let i = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? html.length : end + 3;
        continue;
      }
      if (html[i + 1] === "!" || html[i + 1] === "?") {
        const end = html.indexOf(">", i);
        i = end === -1 ? html.length : end + 1;
        continue;
      }
      const tag = readTag(html, i);
      if (tag) {
        i = tag.end;
        if (!tag.closing && !tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
          const close = html.toLowerCase().indexOf(`</${tag.name}`, i);
          i = close === -1 ? html.length : close;
          continue;
        }
        if (tag.name === "br") {
          if (out.length > 0 && !markerOnly) gap = Math.min(2, gap + 1);
          space = false;
        } else if (tag.name === "ul" || tag.name === "ol") {
          // A nested list starts and ends on the next line; an outer one is a paragraph.
          const nested = tag.closing ? lists.length > 1 : lists.length > 0;
          if (tag.closing) lists.pop();
          else if (!tag.selfClosing) lists.push({ ordered: tag.name === "ol", n: 0 });
          owe(nested ? 1 : 2);
        } else if (tag.name === "li" && !tag.closing) {
          const list = lists[lists.length - 1];
          // Items follow one another on the next line, even after a `<p>` in the last one.
          if (list && list.n > 0 && out.length > 0) {
            gap = 1;
            space = false;
          } else {
            owe(1);
          }
          if (list) list.n++;
          put(list?.ordered ? `${list.n}. ` : "- ");
          markerOnly = true;
        } else if (PARAGRAPH_ELEMENTS.has(tag.name)) {
          owe(2);
        } else if (LINE_ELEMENTS.has(tag.name)) {
          owe(1);
        } else if (tag.name === "td" || tag.name === "th") {
          space = true;
        } else if (tag.name === "a" && !tag.selfClosing) {
          if (!tag.closing) {
            links.push({ href: linkAddress(tag.attrs), from: out.length });
          } else {
            const link = links.pop();
            const words = link ? out.slice(link.from).trim() : "";
            if (link?.href && words.length > 0 && bareAddress(words) !== bareAddress(link.href)) {
              out += ` (${link.href})`;
            }
          }
        }
        continue;
      }
    }
    if (c === "&") {
      const ent = decodeEntity(html, i);
      if (ent) {
        for (const ch of ent.text) {
          if (isSpace(ch)) space = true;
          else put(ch);
        }
        i = ent.end;
        continue;
      }
    }
    if (isSpace(c)) space = true;
    else put(c);
    i++;
  }
  return out.split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The text part to store next to `html` when an agent writes both: `text`
 * itself, unless `html` is formatted and says different words, in which case
 * the HTML's own text (see the block above). `text` comes back unchanged
 * whenever there is any doubt.
 */
export function textPartMatchingHtml(text: string, html: string | null | undefined): string {
  if (typeof html !== "string" || html.trim().length === 0) return text;
  if (!htmlHasFormatting(html) || sameWords(html, text)) return text;
  const own = htmlAsText(html);
  return own.length > 0 && sameWords(html, own) ? own : text;
}
