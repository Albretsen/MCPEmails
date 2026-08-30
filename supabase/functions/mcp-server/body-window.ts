// ---------------------------------------------------------------------------
// Bounded email bodies, with a continuation the server actually accepts.
//
// Until now nothing in this server capped `body_text` or `body_html`. Commit
// 19692b6 put a ceiling on TRANSPORT memory (a 40 MB IMAP literal can no longer
// OOM the isolate) but none at all on the RESPONSE, so a 4 MB newsletter was
// safely fetched, parsed, and then serialised into a model's context in full.
// `email_read_batch` is the sharp edge: it accepts 50 message ids and
// concatenates 50 uncapped bodies, and `jsonOk` emits the whole thing twice
// (content[0].text and structuredContent). One call, tens of thousands of
// tokens, with nothing in the code able to stop it.
//
// A cap on its own is not the fix, it is a different bug. The documented
// failure (microsoft/vscode#311068) is a truncation hint naming a recovery path
// the server does not service: the agent is told a way forward exists, tries
// it, fails, and has nowhere to go. So every cut this module makes reports
//
//   * that it happened            (`body_truncated: true`, never a silent slice)
//   * how much there is in total  (`body_total_chars`)
//   * where to resume             (`body_next_offset`)
//   * the literal call to make    (`body_continue`)
//
// and `body_next_offset` is the exact index this module cut at, so feeding it
// back as `body_offset` returns the following characters with nothing skipped
// and nothing repeated. That is a parameter `email_read` accepts, which is the
// whole point.
//
// Kept out of index.ts for the same reason as text-safety.ts and
// usage-limit-message.ts: index.ts calls Deno.serve at load, so nothing in it
// can be unit tested. Windowing is a pure function of its arguments and the
// arithmetic is exactly the part that must not be wrong.
// ---------------------------------------------------------------------------

/**
 * A single `read` is a deliberate request for ONE message: the model has
 * already decided this message is worth its context, so the window is
 * generous. 8,000 characters is roughly 2,000 tokens of prose.
 *
 * Evidence for the number: every real body measured during the 2026-08-19
 * token-cost investigation (docs/token-cost/) fits inside it with headroom.
 * A cleaned marketing body was 139 chars, an HTML notification 1,344, a
 * 4-link notification 1,418, and the largest, a four-deep reply chain carrying
 * its whole quoted history, 3,033. 8,000 is 2.6x that worst case, so ordinary
 * mail is never truncated and never costs a second round trip. The tail this
 * bounds is the newsletter and the 200 KB machine-generated report, which is
 * where the unbounded case actually lives.
 */
export const SINGLE_READ_BODY_CHARS = 8_000;

/**
 * `read_batch` is deliberately TIGHTER per message, and the asymmetry is the
 * design, not an oversight. 50 messages share one context window, so a budget
 * that is right for one message is 50x wrong here. 2,000 characters still
 * carries the substance of a normal mail (the two notification fixtures above
 * fit whole) while bounding a 50-id call.
 *
 * A batch read is a triage operation. When 2,000 characters is not enough for
 * one particular message, the right move is a single `read` of that id, which
 * is exactly what `body_continue` tells the model to do.
 */
export const BATCH_READ_BODY_CHARS = 2_000;

/**
 * The whole-response body ceiling for one `read_batch` call, on top of the
 * per-message cap. Without it, 50 x 2,000 is 100,000 characters of body in one
 * result, doubled on the wire, which is the failure this module exists to
 * prevent rather than a smaller version of it.
 *
 * 24,000 characters is roughly 6,000 tokens of body. Note that at 50 messages
 * the per-message ENVELOPE (addresses, labels, references, attachment
 * metadata) then dominates the response instead; that is a separate, known
 * item and is not something a body cap can fix.
 */
export const BATCH_BODY_RESPONSE_CHARS = 24_000;

/**
 * Ceiling on a caller-supplied `body_max_chars`. A model may ask for more than
 * the default when it knows it needs it, but "more" has to stop somewhere or
 * the parameter just re-opens the hole. Mirrors the spirit of
 * EXTRACTION_MAX_CHARS (120,000) while staying well below it, because an email
 * body lands in the context window whereas extracted attachment text is
 * usually being searched rather than read.
 */
export const BODY_MAX_CHARS_CEILING = 50_000;

/** What a windowed body looks like to the caller. */
export interface BodyWindowResult {
  /** The window itself. null in, null out. */
  text: string | null;
  /**
   * Truncation/continuation fields to merge into the result object. EMPTY when
   * a whole body was returned from offset 0, so ordinary mail is byte-identical
   * to what this server returned before the cap existed.
   */
  fields: Record<string, string | number | boolean>;
  /** Characters actually emitted. The unit the batch budget is spent in. */
  emitted: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Move a cut index back off the middle of a surrogate pair.
 *
 * JS strings are UTF-16, so `slice` counts code UNITS. Every character outside
 * the BMP (emoji, and the symbols senders use as bullets) is two of them, and a
 * cut landing between the halves produces a lone surrogate on both sides: the
 * chunk ends in an unpaired half that JSON.stringify emits as a bare \uD83D and
 * many consumers render as U+FFFD, and the continuation starts with the other
 * half. One character is destroyed and no offset can recover it.
 *
 * Cutting one unit earlier moves the whole pair into the NEXT window, so both
 * chunks stay valid and the pair survives intact. CJK and accented Latin are
 * single code units and are never affected, however many BYTES they occupy.
 */
function cutBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

/**
 * Read a caller-supplied offset. Negative, fractional and non-numeric all mean
 * "start at the beginning"; the upper bound and the surrogate boundary are
 * settled in windowBody, which is the only place that knows the body's length.
 */
export function readBodyOffset(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/**
 * Read and clamp `body_max_chars`. Absent or unusable falls back to the caller's
 * default; anything else is clamped to 0..BODY_MAX_CHARS_CEILING. 0 is allowed
 * and means "headers only", which is a legitimate cheap triage shape.
 */
export function clampBodyMaxChars(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < 0) return 0;
  return Math.min(n, BODY_MAX_CHARS_CEILING);
}

export interface WindowBodyOptions {
  /** Character offset to start at. Clamped into range and onto a boundary. */
  offset: number;
  /** Window size in characters. */
  maxChars: number;
  /**
   * Field-name prefix: `"body"` produces body_truncated / body_total_chars /
   * body_next_offset / body_offset / body_continue, and `"body_html"` the
   * matching body_html_* set. The two bodies are different strings of different
   * lengths, so they cannot share one offset; each gets its own, and each names
   * its own recovery parameter.
   */
  prefix: "body" | "body_html";
  /**
   * Builds the `*_continue` sentence. Takes the next offset and must name a
   * call THIS server accepts, with the argument values already filled in. The
   * caller owns it because only the caller knows whether the model is holding a
   * single read or one entry out of a batch.
   */
  recovery: (nextOffset: number) => string;
}

/**
 * Window one body string and describe the cut.
 *
 * Field emission is deliberately asymmetric:
 *
 *   * whole body, offset 0        no fields at all. This is the overwhelmingly
 *                                 common case and it must stay exactly as
 *                                 cheap as it was before this module existed.
 *   * truncated                   truncated/offset/total/next_offset/continue.
 *   * continuation, nothing left  truncated:false plus offset and total. The
 *                                 model asked for a specific window, so it gets
 *                                 a positive "you have now seen all N
 *                                 characters" rather than an ambiguous silence.
 *   * headers only (maxChars 0)   truncated:false plus total, and NEVER a
 *                                 continuation. See below.
 *
 * THE INVARIANT: a continuation is only ever emitted when it ADVANCES, i.e.
 * `*_next_offset` is strictly greater than the `*_offset` that produced it.
 * The documented contract is "when it says truncated, call again with
 * next_offset as offset", so a next offset equal to the current one is an
 * infinite loop by construction: the agent is obeying the contract and can
 * never terminate. That was live behaviour for `body_max_chars: 0`, which cut
 * at 0, found 0 < total, and advertised a resume at offset 0 for ever.
 *
 * `body_max_chars: 0` is documented as "returns headers only", and headers-only
 * is a COMPLETE answer to what was asked, not a truncated one. It reports the
 * total (so the model can see a body exists and re-read with a real window)
 * and nothing to continue.
 */
export function windowBody(
  body: string | null,
  opts: WindowBodyOptions,
): BodyWindowResult {
  const { prefix, maxChars, recovery } = opts;
  if (body === null) return { text: null, fields: {}, emitted: 0 };

  const total = body.length;

  let start = typeof opts.offset === "number" && Number.isFinite(opts.offset)
    ? Math.max(0, Math.floor(opts.offset))
    : 0;
  if (start > total) start = total;
  start = cutBoundary(body, start);

  const fields: Record<string, string | number | boolean> = {};

  // Headers only. Deliberately asked for no body at all, so there is no cut to
  // report and nothing to resume: an empty window is the whole answer.
  if (Math.max(0, Math.floor(maxChars)) === 0) {
    if (total > 0) {
      fields[`${prefix}_truncated`] = false;
      fields[`${prefix}_total_chars`] = total;
      if (start > 0) fields[`${prefix}_offset`] = start;
    }
    return { text: "", fields, emitted: 0 };
  }

  let end = cutBoundary(body, Math.min(total, start + Math.max(0, maxChars)));
  // A one-unit window landing inside a surrogate pair backs off to `start`,
  // which would emit nothing while more remains: the same non-advancing
  // continuation by a different route. Take the whole pair instead; one code
  // unit over a tiny budget is cheaper than a loop that cannot end.
  if (end <= start && start < total) end = Math.min(total, start + 2);

  const text = body.slice(start, end);
  // `end > start` is the invariant, asserted rather than assumed: no path may
  // hand back the offset it was given.
  const truncated = end < total && end > start;

  if (truncated) {
    fields[`${prefix}_truncated`] = true;
    fields[`${prefix}_offset`] = start;
    fields[`${prefix}_total_chars`] = total;
    fields[`${prefix}_next_offset`] = end;
    fields[`${prefix}_continue`] = recovery(end);
  } else if (end < total) {
    // Unreachable given the guard above, and kept as a fail-safe: if some
    // future edit produces a window that cannot advance, say so honestly
    // (there is more, here is the total) rather than emitting a resume point
    // that loops.
    fields[`${prefix}_truncated`] = false;
    fields[`${prefix}_offset`] = start;
    fields[`${prefix}_total_chars`] = total;
  } else if (start > 0) {
    fields[`${prefix}_truncated`] = false;
    fields[`${prefix}_offset`] = start;
    fields[`${prefix}_total_chars`] = total;
  }

  return { text, fields, emitted: text.length };
}

/**
 * Per-message allowance inside a `read_batch`, given what the batch has already
 * spent.
 *
 * Dividing the REMAINING budget by the REMAINING messages rather than handing
 * out the per-message cap first-come does two things worth having: no message
 * is starved because of where it sits in the array, and budget left unspent by
 * a short message flows to the ones after it. A 50-id batch therefore gives
 * every message the same floor instead of serving twelve in full and returning
 * thirty-eight empty bodies.
 */
export function batchBodyAllowance(
  perMessageCap: number,
  remainingBudget: number,
  remainingMessages: number,
): number {
  if (remainingMessages <= 0) return 0;
  const share = Math.floor(Math.max(0, remainingBudget) / remainingMessages);
  return Math.max(0, Math.min(perMessageCap, share));
}

/** The exact `email_read` call that returns the next window of one message. */
export function singleReadContinuation(
  messageId: string,
  nextOffset: number,
  html: boolean,
): string {
  const param = html ? "body_html_offset" : "body_offset";
  return (
    `Call email_read action: read with message_id ${JSON.stringify(messageId)} ` +
    `and ${param}: ${nextOffset}${html ? ", include_html: true" : ""} for the rest.`
  );
}
