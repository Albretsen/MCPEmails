// ---------------------------------------------------------------------------
// De-duplication of caller-supplied message id lists.
//
// ── The problem this exists to solve ────────────────────────────────────────
// `email_read_batch` has always de-duplicated its `message_ids` and says so in
// its schema ("Duplicates are removed, first occurrence kept."). The mutating
// batch tools did not. `email_organize action: move_batch` with
// [A, B, A, bogus] reported `succeeded: 3` and listed A twice, when only TWO
// messages had moved. `delete_batch` behaved the same way.
//
// The count is the part that matters. A model reads `succeeded` as "this many
// messages are now in the destination", and on a delete it reads it as "this
// many messages are gone". Both were wrong by the number of duplicates, and
// nothing in the response said so. One connector cannot honour two different
// contracts for the same argument, so the batch mutations now collapse
// duplicates exactly the way the batch read does.
//
// ── Why first occurrence, and why order is preserved ────────────────────────
// The per-message `results` array is the only record a caller has of what
// happened to each id, and callers zip it against the list they sent. Keeping
// the FIRST occurrence and the original relative order means the surviving
// entries line up with the caller's own list in the order it wrote it. A Set's
// insertion order gives exactly that, which is why the implementation is as
// small as it is.
// ---------------------------------------------------------------------------

/**
 * Trims, drops blanks, and removes duplicate message ids, keeping the first
 * occurrence of each and preserving the caller's ordering.
 *
 * Non-string entries are dropped rather than coerced: every caller of this
 * either validates the array first or wants the same lenient filter
 * `email_read_batch` applies.
 */
export function dedupeMessageIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id.length === 0) continue;
    seen.add(id);
  }
  return [...seen];
}

/**
 * How many ids a caller sent that this module collapsed away.
 *
 * Kept as a named helper because a bulk handler that wants to disclose the
 * collapse ("you asked for 4, 3 were distinct") should not re-derive the
 * subtraction and risk comparing against the wrong list.
 */
export function duplicateCount(
  requested: readonly unknown[],
  deduped: readonly string[],
): number {
  return Math.max(0, requested.length - deduped.length);
}
