/**
 * Normalisation of the `sender_name` argument to `signature_set`, split out of
 * index.ts so it can be tested: index.ts calls Deno.serve at load and cannot be
 * imported.
 *
 * The value lands in `inboxes.display_name`, which every send path writes into
 * the From header as `<name> <address>`. Two things follow from that:
 *
 *   1. Header injection. A bare CR or LF in the name would start a new header
 *      line, so no CR or LF can survive this function, and the header encoder
 *      guards it again at send time (defence in depth).
 *   2. Mailbox syntax. `<` and `>` delimit the angle-addr, so a name containing
 *      them could smuggle a second address into the mailbox. They are stripped
 *      rather than escaped: a display name has no legitimate use for them.
 *
 * Everything else is left to the header encoder, which quotes or RFC 2047
 * encodes whatever the name needs.
 *
 * ── BUGFIX (2026-09-21): tab and newline are whitespace, not junk ───────────
 * Until now this removed every control character FIRST and collapsed runs of
 * whitespace SECOND, which meant the two rules the schema advertised in one
 * breath — "whitespace is collapsed; control characters are removed" — fought
 * each other. A tab or newline is both, and removal won, so "Bot\ttab\nnewline"
 * was stored as "Bottabnewline" while the same words separated by a plain space
 * came through intact. A caller that pasted a two-line name got one welded
 * word and no explanation.
 *
 * SP, HTAB, CR and LF are now folded to a space BEFORE the control-character
 * sweep, so they collapse with whatever surrounds them into a single space.
 * Everything else in C0 plus DEL — NUL, VT, FF, ESC, the rest — is still
 * DELETED, because those are genuinely non-printable and have no width to
 * stand in for.
 *
 * THIS DOES NOT WEAKEN THE INJECTION GUARD, and the reasoning is worth keeping
 * because the substitution looks like a loosening. What a From header cannot
 * survive is a raw CR or LF, because that ends the header line; the attack is
 * "Evancoe Bot\r\nBcc: attacker@example.com" becoming two headers. A space
 * cannot end a line, so the CRLF is just as gone as it was when it was deleted
 * — the text after it stays on the same line as inert display-name characters.
 * Nor does the fold create the other half of the attack: RFC 5322 §2.2.3 makes
 * CRLF followed by WSP a FOLD, a continuation of the same header, never a new
 * one, so even a downstream encoder that re-introduced a line break around this
 * whitespace would be folding, not injecting. The only way a name becomes a
 * header is a bare CR/LF reaching the wire, and `/[\t\n\r]/` runs before
 * anything else here, so none can. sender-name.test.ts pins that as a property,
 * not just as expected strings.
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
    // Whitespace that happens to be a control character: folded to a space
    // before the sweep below can delete it, so the words it separated stay
    // separated. This is also the line the header-injection guard rests on —
    // no CR or LF exists past it. See the header of this file.
    .replace(/[\t\n\r]/g, " ")
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
