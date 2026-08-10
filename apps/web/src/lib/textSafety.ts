/**
 * Neutralising invisible characters in attacker-controlled plain text.
 *
 * Node/Next.js mirror of `supabase/functions/mcp-server/text-safety.ts` and
 * `apps/mcp-app/src/sanitize.ts`. See the header of the first for the full
 * reasoning; the short version is that an attachment named
 * `invoice<U+202E> fdp.exe` renders as `invoiceexe.pdf`, so a reviewer looking
 * at the approve page approves a PDF and sends an executable. The same trick
 * works on subjects and sender display names.
 *
 * DELIBERATELY NOT APPLIED TO MESSAGE BODIES: bidi controls are legitimate in
 * right-to-left prose and stripping them would corrupt mail we are only meant
 * to display. This covers the short structural fields a reviewer *scans* --
 * subject, recipients, attachment filenames, display names.
 *
 * Keep the character class identical across all three copies.
 */

const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Strip the invisible characters from one string. Everything else survives. */
export function neutralizeText(value: string): string {
  return value.replace(UNSAFE_TEXT, '');
}

/** `neutralizeText` for a value that may be null or not a string. */
export function neutralizeNullable(value: string | null | undefined): string | null {
  return typeof value === 'string' ? neutralizeText(value) : null;
}

/** Neutralise every string in a list, dropping non-strings. */
export function neutralizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map(neutralizeText);
}
