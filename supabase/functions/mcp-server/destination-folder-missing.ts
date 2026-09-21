// ---------------------------------------------------------------------------
// The answer for a move or copy whose DESTINATION does not exist.
//
// ── The bug this exists to fix ─────────────────────────────────────────────
// A functional run against a live Gmail-over-IMAP mailbox on 2026-09-20 asked
// email_organize to move a real message into a folder that was never created,
// and got back:
//
//   "Provider error during email_move: UID COPY failed: [TRYCREATE] No folder
//    [MCPE-TEST-20260920-1501] NO-SUCH-FOLDER (Failure). Please try again in a
//    moment."
//
// Three things are wrong with that in one sentence. It leaks the raw IMAP line
// (see the header of provider-error.ts, which has complained about exactly this
// since 2026-09-01 and already carries a `folder_missing` reason for it). It
// calls a permanent, caller-caused condition a "provider error". And its advice
// is not merely useless but actively wrong: retrying cannot help, because the
// folder will still not be there in a moment, and a model that believes the
// hint burns its retry budget before reporting anything to the user.
//
// ── The bar ────────────────────────────────────────────────────────────────
// The draft errors in this connector are the standard to match: they state what
// was wrong, state what did and did not happen to the user's data, and name the
// exact call that fixes it. So does this one — it names destination_folder_id
// back to the caller, says the mailbox is unchanged, and points at folder_list
// (the read half that produces valid ids) and at folder create for the case
// where the caller meant to make it.
//
// Pure text in, pure text out, so the wording is testable without a mailbox.
//
// ── Who uses it ────────────────────────────────────────────────────────────
// 2026-09-20: the single-message paths only (executeMoveEmail's provider-error
// helper, so email_move / email_copy / email_organize's single forms). The bulk
// paths were deferred and kept leaking the raw line for a day longer.
// 2026-09-21: the bulk paths too — email_move_batch, email_copy_batch and
// email_search_and_move on a whole-batch failure (via the count form below),
// and any single failed item inside a batch, through `bulkFailureMessage` in
// message-id-errors.ts. One condition, one sentence, whether the caller passed
// one id or five hundred.
// ---------------------------------------------------------------------------

/**
 * `activity_log.error_code` for this condition.
 *
 * Already in the taxonomy — `folder_not_found` is what READ_PATH_ERROR_CODES in
 * provider-error.ts maps the `folder_missing` reason onto, and what the bulk
 * paths have logged for the same IMAP text since 2026-07-28. Reusing it keeps
 * one condition under one name instead of splitting its history.
 */
export const DESTINATION_FOLDER_MISSING_CODE = "folder_not_found";

/**
 * The sentence the caller reads when the destination folder is not there.
 *
 * @param tool             dispatch name, e.g. "email_move" / "email_copy".
 * @param destination      the destination_folder_id EXACTLY as the caller wrote
 *                         it, before alias/name resolution, because that is the
 *                         string they have to correct.
 * @param itemNoun         "folder" everywhere except Gmail, which has labels.
 * @param messageCount     how many messages the failure covers. Omit for a
 *                         single message, which is both the single-message
 *                         paths and one failed item inside a batch; pass the
 *                         batch size when a WHOLE batch died on this, so the
 *                         "nothing happened" clause speaks for all of it.
 *                         See the batch note below.
 */
export function destinationFolderMissingMessage(
  tool: string,
  destination: string,
  itemNoun: "folder" | "label" = "folder",
  messageCount?: number,
): string {
  return (
    `${tool}: destination_folder_id ${JSON.stringify(destination)} does not ` +
    `name a ${itemNoun} in this inbox, so the mail server refused the ` +
    `operation. ${unchangedClause(messageCount)} This will not succeed on a ` +
    `retry: the ${itemNoun} has to exist first. Call folder_list to see what ` +
    `this inbox actually has (an alias such as "archive" or "spam", an exact ` +
    `name, or an id from that list all resolve), then retry with one of those ` +
    `— or create it with folder { action: "create", name: ... } and retry ` +
    `after that.`
  );
}

/**
 * "Nothing happened to your mail", sized to what the failure covered.
 *
 * ── Why a batch needs its own wording (2026-09-21) ──────────────────────────
 * The single-message form of this error shipped on 2026-09-20; the bulk paths
 * were left leaking the raw IMAP line for another day, so email_move_batch,
 * email_copy_batch and email_search_and_move still answered a missing
 * destination with "Provider error during email_move: UID COPY failed:
 * [TRYCREATE] No folder <name> (Failure). Please try again in a moment."
 *
 * Reusing the single-message sentence there would have fixed the leak and
 * introduced a smaller lie: "the message is exactly where it was" says nothing
 * about the other 199 ids in the call, and a model reading it has to guess
 * whether a partial move happened. On a whole-batch failure nothing was
 * dispatched — the server refused the command — so the honest statement names
 * the count and is the one thing a caller most needs before it decides whether
 * to re-derive its id list.
 *
 * A single FAILED ITEM inside an otherwise fine batch keeps the singular form,
 * because there it is literally true and the caller can see the per-id split.
 */
function unchangedClause(messageCount?: number): string {
  if (messageCount === undefined || messageCount === 1) {
    return "Nothing was moved, copied or changed — the message is exactly where it was.";
  }
  return (
    `Nothing was moved, copied or changed — none of the ${messageCount} ` +
    `messages was touched and all of them are exactly where they were.`
  );
}
