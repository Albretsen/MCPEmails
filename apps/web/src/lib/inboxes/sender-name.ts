// ---------------------------------------------------------------------------
// Sender display name ("Sender name") normaliser.
//
// `inboxes.display_name` ends up verbatim inside the From header that the MCP
// edge function builds (`"<display_name>" <address>`), so this is a header
// boundary. Everything that could break or forge a header is stripped here,
// once, on the way in:
//   - control characters (CR/LF/tab included): a bare "\r\n" would end the
//     From line and let the remainder inject arbitrary headers (Bcc, ...)
//   - `<` and `>`: they delimit the angle-addr and would confuse parsers
// Internal whitespace runs collapse to one space, the result is trimmed and
// capped at 100 characters. An empty result means "clear the name" and is
// returned as `null` so the caller writes NULL rather than ''.
// ---------------------------------------------------------------------------

export const SENDER_NAME_MAX_LENGTH = 100;

export type NormalizedSenderName =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// C0 controls, DEL, and C1 controls. `\s` below separately handles the
// Unicode space class (NBSP etc.), which is collapsed rather than stripped.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;
const ANGLE_BRACKETS = /[<>]/g;
const WHITESPACE_RUN = /\s+/g;

export function normalizeSenderName(input: unknown): NormalizedSenderName {
  if (typeof input !== 'string') {
    return { ok: false, error: 'display_name must be a string.' };
  }

  const value = input
    .replace(CONTROL_CHARS, '')
    .replace(ANGLE_BRACKETS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();

  if (value.length > SENDER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `display_name must be at most ${SENDER_NAME_MAX_LENGTH} characters.`,
    };
  }

  return { ok: true, value: value.length === 0 ? null : value };
}
