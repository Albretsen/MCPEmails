// ---------------------------------------------------------------------------
// imap-search-budget.ts — when a multi-folder IMAP search should stop early.
//
// ── Why ────────────────────────────────────────────────────────────────────
// IMAP SEARCH covers one mailbox, so `include_folders` with N entries is N
// serial rounds of SELECT + UID SEARCH + UID FETCH on one connection. Measured
// from the tools/call log line on 2026-10-15: searches of roughly 5 to 10
// folders were 27% of email_search calls, 54% of its wall time and 60% of its
// failures, at an average of 15.5s and a p95 of 34.7s. The loop never looked
// at the clock, so the 30-second race fired in the middle of folder 7 and the
// six folders already searched were thrown away with the socket: the caller
// got `search_timeout` and nothing else.
//
// ── What this decides ──────────────────────────────────────────────────────
// Before each folder after the first, whether there is time for one more. The
// estimate for the next folder is the slowest folder so far, padded, plus a
// reserve for the preview pass and for handing the result back. When it does
// not fit, the search returns what it has and a note naming the folders it
// did not reach, in the same shape as the Outlook fan-out note
// (search-folder-scope.ts), so the caller can search those separately.
//
// The first folder always runs: stopping before it would answer nothing, and
// a single folder that cannot finish is still the timer's to report.
//
// Pure functions, separate from index.ts for the usual reason in this
// directory: index.ts calls `Deno.serve` at module load and exports nothing.
// ---------------------------------------------------------------------------

/**
 * Held back from the deadline for the work after the folder loop: the preview
 * FETCH for the final page on a multi-folder search, then building and
 * returning the result before the race's timer fires.
 */
export const IMAP_SEARCH_FINISH_RESERVE_MS = 3_000;

/** The next folder is assumed to take this much longer than the slowest so far. */
export const IMAP_FOLDER_ESTIMATE_PADDING = 1.25;

/**
 * May the search start another folder?
 *
 * @param remainingMs   time left before the caller's deadline
 * @param folderTimesMs how long each folder searched so far took
 */
export function hasTimeForNextFolder(remainingMs: number, folderTimesMs: readonly number[]): boolean {
  if (folderTimesMs.length === 0) return true;
  const slowest = Math.max(...folderTimesMs);
  return remainingMs >= slowest * IMAP_FOLDER_ESTIMATE_PADDING + IMAP_SEARCH_FINISH_RESERVE_MS;
}

/**
 * The caller-visible note for a search that stopped before every folder.
 * Names both halves, as the Outlook fan-out note does: a bare "some folders
 * were skipped" would leave the caller unable to say what the results cover.
 */
export function imapSearchStoppedEarlyNote(searched: readonly string[], skipped: readonly string[]): string {
  return `include_folders listed ${searched.length + skipped.length} folders and the mail ` +
    `server was too slow to search all of them within the 30-second limit, so this search ` +
    `covered ${searched.length} of them: ${searched.join(", ")}. ` +
    `NOT searched: ${skipped.join(", ")}. ` +
    `No message from an unsearched folder is in these results, and \`total\` counts only ` +
    `the folders searched. Run the search again with include_folders set to the folders ` +
    `that were not searched to cover the rest.`;
}
