/**
 * Normalisation of the `sender_name` argument to `signature_set`, split out of
 * index.ts so it can be tested: index.ts calls Deno.serve at load and cannot be
 * imported.
 *
 * The value lands in `inboxes.display_name`, which every send path writes into
 * the From header as `<name> <address>`. Two things follow from that:
 *
 *   1. Header injection. CR/LF in the name would start a new header line, so
 *      every control character is removed here, before the value is stored,
 *      and again by the header encoder at send time (defence in depth).
 *   2. Mailbox syntax. `<` and `>` delimit the angle-addr, so a name containing
 *      them could smuggle a second address into the mailbox. They are stripped
 *      rather than escaped: a display name has no legitimate use for them.
 *
 * Everything else is left to the header encoder, which quotes or RFC 2047
 * encodes whatever the name needs.
 */

/** Maximum length of a sender name, in characters, after normalisation. */
export const SENDER_NAME_MAX_CHARS = 100;

export type SenderNameNormalisation =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Normalise a raw `sender_name` argument.
 *
 * Returns `{ ok: true, value: null }` when the name is empty after cleaning
 * (empty string, whitespace only, or nothing but control characters and angle
 * brackets), which the caller writes as NULL to clear the stored name. The
 * message on the error branch is the full tool-facing text, already prefixed
 * with the tool name.
 */
export function normaliseSenderName(raw: unknown): SenderNameNormalisation {
  if (typeof raw !== "string") {
    return {
      ok: false,
      message:
        `signature_set: sender_name must be a string of at most ${SENDER_NAME_MAX_CHARS} characters ` +
        "(empty string clears it).",
    };
  }
  const cleaned = raw
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return { ok: true, value: null };
  // Count characters, not UTF-16 code units, so an emoji is one and the limit
  // an agent is told matches the one it is measured against.
  if (Array.from(cleaned).length > SENDER_NAME_MAX_CHARS) {
    return {
      ok: false,
      message:
        `signature_set: sender_name must be at most ${SENDER_NAME_MAX_CHARS} characters after ` +
        "trimming and collapsing whitespace.",
    };
  }
  return { ok: true, value: cleaned };
}
