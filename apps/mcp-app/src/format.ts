// ---------------------------------------------------------------------------
// Formatting helpers.
//
// ── DATES ARE IN THE CARD'S LANGUAGE, NOT THE BROWSER'S ─────────────────────
// Every word on this card is English, so a date has to be English too. Phase-0
// Q6 said to format with the browser's resolved locale (or `hostContext.locale`
// when the host sends one), and that is how QA (2026-10-13) got "13. okt. 2026,
// 14:02" in the middle of an English sentence on a Norwegian machine. The
// LANGUAGE is now always `en`; the person's own locale is consulted only for
// the one convention that is about them rather than about the language, the
// clock (24-hour on a Norwegian machine, 12-hour on an American one). Should
// the card's text ever be localised, `CARD_LANGUAGE` is the one thing to change.
// ---------------------------------------------------------------------------

/** The language every string on the card is written in. */
export const CARD_LANGUAGE = "en";

/** The person's locale (host first, else the browser's). Clock style only. */
let locale: string | undefined;
let hourCycle: "h12" | "h23" | undefined;

export function setLocale(l: string | undefined) {
  locale = typeof l === "string" && l.length > 1 ? l : undefined;
  hourCycle = undefined;
  try {
    const hc = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    hourCycle = hc === "h11" || hc === "h12" ? "h12" : hc ? "h23" : undefined;
  } catch {
    hourCycle = undefined;
  }
}
setLocale(undefined);

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const withClock = options.timeStyle || options.hour ? { ...options, hourCycle } : options;
  try {
    return new Intl.DateTimeFormat(CARD_LANGUAGE, withClock);
  } catch {
    return new Intl.DateTimeFormat(CARD_LANGUAGE, options);
  }
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    return fmt({ dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
}

/**
 * When something was saved, as short as it can be while still unambiguous:
 * "14:02" today, "Oct 9, 14:02" this year, "Oct 9, 2025, 14:02" before that.
 */
export function formatWhen(iso: string | null | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    const sameYear = d.getFullYear() === now.getFullYear();
    if (sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return fmt({ hour: "numeric", minute: "2-digit" }).format(d);
    }
    return fmt({
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
}

export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    return fmt({ dateStyle: "medium" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "expires in 23h", "expires in 12 min", "expired". */
export function relativeExpiry(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const min = Math.round(ms / 60000);
  if (min < 60) return `expires in ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires ${formatDate(iso)}`;
}

/** "10:04:31". For a moment that has to be told apart from one seconds earlier. */
export function formatClockSeconds(ms: number): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";
  try {
    return fmt({ timeStyle: "medium" }).format(d);
  } catch {
    return d.toISOString().slice(11, 19);
  }
}

/** Whitespace-separated tokens. The body is counted, never quoted. */
export function wordCount(text: string | null | undefined): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// The sentences the card sends to the model live in model-context.ts, all of
// them, with the rules they share.

export function formatBytes(n: unknown): string {
  const bytes = typeof n === "number" && isFinite(n) && n >= 0 ? n : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recipient summary that stays on one line at 320px. */
export function summarizeRecipients(
  to: string[],
  cc: string[],
  bccCount: number,
): { primary: string; extra: string } {
  const first = to[0] ?? "(no recipient)";
  const rest = Math.max(0, to.length - 1);
  const bits: string[] = [];
  if (rest > 0) bits.push(`+${rest} more`);
  if (cc.length > 0) bits.push(`${cc.length} cc`);
  if (bccCount > 0) bits.push(`${bccCount} bcc`);
  return { primary: first, extra: bits.join(" · ") };
}

const OPERATION_LABELS: Record<string, string> = {
  email_send: "Send email",
  email_reply: "Send reply",
  email_forward: "Forward email",
  draft_send: "Send draft",
  schedule_create: "Schedule email",
};

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? "Send email";
}

const ACTION_LABELS: Record<string, string> = {
  delete_batch: "Delete",
  search_and_delete: "Delete",
  move_batch: "Move",
  search_and_move: "Move",
};

export function bulkVerb(action: string): string {
  return ACTION_LABELS[action] ?? "Modify";
}

export function bulkVerbProgressive(action: string): string {
  const v = bulkVerb(action);
  return v === "Delete" ? "Deleting" : v === "Move" ? "Moving" : "Working";
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

/**
 * Line endings folded to LF, for COMPARISON ONLY. Never for anything that is
 * stored or sent.
 *
 * `body.text` arrives from the server with the CRLF a real mail client wrote
 * (`"alpha\r\nbeta\r\n-- \r\nSig"`). A `<textarea>` does not keep that: per the
 * HTML spec its API value is the raw value with every CRLF and bare CR
 * normalised to LF, so the first keystroke anywhere in the box hands the card
 * back an LF copy of bytes the user never touched. Comparing that to the stored
 * text byte for byte reports EVERY line as an edit, which is how a draft nobody
 * meant to change ended up being rewritten (and its HTML part regenerated from
 * the plain text) on save.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/**
 * Did the user actually change the body, as opposed to the browser changing its
 * line endings?
 *
 * The cheap byte comparison first, because it is true for almost every real
 * edit and short-circuits the allocation; the normalised comparison is only
 * reached when the two differ, which is exactly the CRLF-vs-LF case.
 */
export function bodyTextChanged(edited: string, stored: string): boolean {
  return edited !== stored && normalizeEol(edited) !== normalizeEol(stored);
}

// ---------------------------------------------------------------------------
// Signature split
// ---------------------------------------------------------------------------

/**
 * The RFC 3676 §4.3 signature separator (`-- ` alone on a line), and the sloppy
 * variant (`--`) that mail clients emit anyway, in every line ending a draft can
 * arrive with.
 *
 * All three line endings on BOTH sides, because the two sides are independent:
 * an agent-authored body is LF throughout (`encodeTextAsBase64Lines` inserts the
 * body verbatim and `buildDraftMime` never canonicalises it), a body from a real
 * mail client is CRLF throughout, and a body that has been through a textarea is
 * LF for the part that was retyped. The LF-only list this replaced never fired
 * on a CRLF body at all, so the split shipped in 9af42ea did nothing for exactly
 * the drafts it was built for.
 *
 * Sorted longest-first, which is what makes the tie-break in `splitBody`
 * correct: on the body `"a\r\n-- \r\nsig"` both `\r\n-- \r\n` and `\n-- \r\n`
 * end at the same place, and taking the shorter one would weld a stray `\r` to
 * the end of the message.
 */
const SIG_SEPARATORS: readonly string[] = (() => {
  const eols = ["\r\n", "\n", "\r"];
  const out: string[] = [];
  for (const lead of eols) {
    for (const dashes of ["-- ", "--"]) {
      for (const tail of eols) out.push(lead + dashes + tail);
    }
  }
  // Ties broken on the string itself only so the order is deterministic across
  // engines; only the length ordering is load-bearing.
  return out.sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
})();

export interface SplitBody {
  /** Everything before the separator. The whole text when there is none. */
  message: string;
  /** The exact separator found, or null. Kept so `joinBody` is byte-exact. */
  separator: string | null;
  /** Everything after the separator, or null when there is none. */
  signature: string | null;
}

/**
 * Split a draft body into message and signature.
 *
 * Why this exists: the stored body carries the signature inline (contract §8
 * requires the card to show and save the text as-is, or the signature doubles),
 * and for a short message the signature is most of the box. Splitting lets the
 * card dim it without changing a byte of what gets saved.
 *
 * ── The tie-break ──────────────────────────────────────────────────────────
 * The LAST separator in the text wins, across all forms. The comment here used
 * to claim that while the code returned on the FIRST form it found anywhere, so
 * `"Hi\n-- \nAsgeir\n--\nPS"` split at 2 rather than at 13. Last-wins is the
 * right rule and is now what runs:
 *
 *   - A line of exactly `--` is legal inside prose (a dash rule, a diff, a
 *     quoted patch). When one shows up, the signature is still the FINAL block,
 *     so scanning from the end is the standard heuristic.
 *   - It also fails in the cheaper direction. Getting it wrong late means a
 *     trailing prose block is dimmed as a signature; getting it wrong early
 *     means the whole remainder of the message is dimmed and collapsed behind a
 *     one-line preview, which is the version that looks like data loss even
 *     though it is not.
 *   - It is never a correctness risk either way: `joinBody(splitBody(t))` is
 *     byte-exactly `t` for every input, including CRLF ones, because both
 *     halves and the separator are slices of the same string and `joinBody`
 *     concatenates them back in order. Nothing here normalises anything.
 *
 * Within one position, longest wins (see `SIG_SEPARATORS`).
 *
 * ── What counts as a separator line ────────────────────────────────────────
 * Every entry in `SIG_SEPARATORS` is `<eol> + ("-- " | "--") + <eol>`, so the
 * dashes need a line ending on BOTH sides. Both halves of that are load-bearing
 * and both cut in the conservative direction — no separator means "it is all
 * message", which is the reading that never collapses text behind a preview:
 *
 *   - LEADING: a body that OPENS with `-- \n` has no line ending before the
 *     dashes, so it is all message rather than all signature.
 *   - TRAILING: a body that ENDS at the dashes — `"a\n-- "`, or `"a\n--"` —
 *     has no line ending after them, so it does not split either. That is the
 *     half-typed case: someone who has just typed the separator and not yet
 *     pressed Enter does not have the line they are on torn out of the message
 *     box mid-keystroke. One more Enter and it splits.
 *
 * Both are pinned by tests in harness/draft-body.test.mjs ("a separator needs a
 * line ending on BOTH sides"), because they are the kind of rule that looks like
 * an oversight to the next reader.
 */
export function splitBody(text: string): SplitBody {
  // Deliberately not a single global regex scan. A global scan consumes the
  // line ending it matched, so in `"a\n--\n-- \nsig"` the `\n` that opens the
  // second separator has already been eaten by the first and the later, real
  // separator becomes invisible. Overlapping candidates are the normal case
  // here, so every form is located independently.
  //
  // Ranked on where each candidate ENDS, not where it starts. The forms overlap
  // each other on one and the same separator line: in `"a\r\n-- \r\nsig"` the
  // full `\r\n-- \r\n` starts at 1 while `\n-- \r\n` starts at 2, and ranking on
  // the start would pick the later, shorter one and leave a stray `\r` welded to
  // the end of the message. Every candidate for a given separator line ends at
  // or before that line's trailing EOL, and a LATER separator line always ends
  // further right, so "ends furthest right, longest at that end" is exactly
  // "the last separator line, matched greedily".
  let at = -1;
  let end = -1;
  let separator: string | null = null;
  for (const candidate of SIG_SEPARATORS) {
    const found = text.lastIndexOf(candidate);
    if (found === -1) continue;
    const candidateEnd = found + candidate.length;
    // Strictly greater, and SIG_SEPARATORS is longest-first, so the longest
    // candidate reaching a given end is the one that sticks.
    if (candidateEnd > end) {
      at = found;
      end = candidateEnd;
      separator = candidate;
    }
  }
  if (separator === null) {
    return { message: text, separator: null, signature: null };
  }
  return {
    message: text.slice(0, at),
    separator,
    signature: text.slice(at + separator.length),
  };
}

/** Inverse of `splitBody`. Byte-exact by construction. */
export function joinBody(parts: SplitBody): string {
  if (parts.separator === null || parts.signature === null) return parts.message;
  return parts.message + parts.separator + parts.signature;
}
