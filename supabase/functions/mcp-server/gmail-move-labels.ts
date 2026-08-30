// ---------------------------------------------------------------------------
// gmail-move-labels.ts - what "move this message" means on Gmail's flat label
// model, as a pure decision.
//
// Gmail has no folders. A move is a messages.modify: some label ids go on, some
// come off. Which ones come off is the whole problem, and it used to be answered
// in three places with one hard-coded list, `["INBOX"]`.
//
// THE BUG THIS MODULE EXISTS TO CLOSE (2026-08-30, message 1a0527fabc829d11):
// a message that had been deleted carried TRASH. Moving it to a user label added
// the label and removed INBOX, exactly as documented, and left TRASH in place.
// The call returned success, the label appeared in Gmail, and Gmail purged the
// message roughly thirty days later. Every restore-a-deleted-message path led
// there, and nothing in the response said so.
//
// The rule: TRASH and SPAM are not ordinary labels. They are pending-deletion
// states with a clock attached. Relocating a message INTO a real destination is
// an unambiguous statement that the user wants to keep it, so the relocation
// clears them. Relocating INTO Trash or Spam obviously does not.
//
// Everything here is PURE: no I/O, no provider clients, no imports. The three
// Gmail callers in index.ts (single move, bulk move, archive) share one answer
// instead of three almost-agreeing ones.
// ---------------------------------------------------------------------------

/** Gmail system label ids this module reasons about. */
export const GMAIL_INBOX_LABEL = "INBOX";
export const GMAIL_TRASH_LABEL = "TRASH";
export const GMAIL_SPAM_LABEL = "SPAM";

/**
 * The pending-deletion labels. Both carry Gmail's ~30-day purge clock, which is
 * the only reason they get special treatment: leaving one on a message the user
 * just asked to file somewhere is silent data loss on a delay.
 */
const PENDING_DELETION_LABELS = [GMAIL_TRASH_LABEL, GMAIL_SPAM_LABEL] as const;

export interface GmailRelocationPlan {
  /** Label ids to add. Empty for an archive (archive has no destination). */
  addLabelIds: string[];
  /** Label ids to remove. Never overlaps `addLabelIds`. */
  removeLabelIds: string[];
  /**
   * Whether this relocation took the message out of Trash.
   *
   * `null` means "not known": the caller did not supply the message's current
   * labels (the bulk paths do not, to avoid a GET per message). The WRITE is
   * identical either way - removing a label a message does not carry is a no-op
   * on Gmail - so `null` weakens only the reporting, never the fix.
   */
  restoredFromTrash: boolean | null;
  /** As `restoredFromTrash`, for Spam. */
  restoredFromSpam: boolean | null;
  /** True when the destination is itself Trash or Spam. */
  destinationIsPendingDeletion: boolean;
}

/** Case-insensitive membership test - Gmail system ids are upper-case, but a
 * caller that hand-typed "trash" should not silently get user-label treatment. */
function hasLabel(labels: readonly string[], wanted: string): boolean {
  const lower = wanted.toLowerCase();
  return labels.some((l) => typeof l === "string" && l.toLowerCase() === lower);
}

function isSystemLabel(labelId: string, wanted: string): boolean {
  return labelId.trim().toLowerCase() === wanted.toLowerCase();
}

/**
 * Decides the add/remove label sets for a Gmail relocation.
 *
 * @param currentLabelIds The message's labels right now, or `null` when the
 *   caller did not look them up. `null` produces the same write and reports the
 *   un-trash as unknown rather than guessing.
 * @param destinationLabelId The resolved destination label id, or `null` for an
 *   archive (which removes the message from the inbox without a destination).
 *
 * Invariants:
 *   * INBOX is removed unless it IS the destination (Gmail rejects a modify that
 *     both adds and removes the same label with HTTP 400).
 *   * TRASH/SPAM are removed unless the destination is one of them.
 *   * Nothing else is ever removed: a message's other user labels survive a
 *     move, which is the documented and expected Gmail behaviour.
 */
export function gmailRelocationPlan(
  currentLabelIds: readonly string[] | null,
  destinationLabelId: string | null,
): GmailRelocationPlan {
  const dest = destinationLabelId?.trim() ?? "";
  const destinationIsPendingDeletion = dest.length > 0 &&
    PENDING_DELETION_LABELS.some((l) => isSystemLabel(dest, l));

  const addLabelIds = dest.length > 0 ? [dest] : [];

  const remove: string[] = [GMAIL_INBOX_LABEL];
  if (!destinationIsPendingDeletion) {
    remove.push(...PENDING_DELETION_LABELS);
  }
  // Gmail: "Cannot both add and remove the same label" (HTTP 400). Moving back
  // into the inbox makes INBOX the destination, so the filter is load-bearing.
  const removeLabelIds = remove.filter(
    (id) => !addLabelIds.some((add) => isSystemLabel(add, id)),
  );

  const known = currentLabelIds !== null;
  const restoredFromTrash = !known
    ? null
    : !destinationIsPendingDeletion && hasLabel(currentLabelIds, GMAIL_TRASH_LABEL);
  const restoredFromSpam = !known
    ? null
    : !destinationIsPendingDeletion && hasLabel(currentLabelIds, GMAIL_SPAM_LABEL);

  return {
    addLabelIds,
    removeLabelIds,
    restoredFromTrash,
    restoredFromSpam,
    destinationIsPendingDeletion,
  };
}

/**
 * The `provider_semantics` sentence for a Gmail relocation.
 *
 * This string is the tool's only account of what it did to a mailbox it does not
 * show the caller, so it states the un-trash explicitly rather than leaving the
 * reader to infer it. When the current labels were not looked up it describes
 * the CONDITIONAL ("if either was set"), which is honest about what the write
 * did without claiming a restore that may not have happened.
 */
export function gmailRelocationSemantics(plan: GmailRelocationPlan): string {
  const isArchive = plan.addLabelIds.length === 0;
  const opening = isArchive
    ? "Removed INBOX (Gmail archives by unlabelling, the message stays in All Mail)"
    : "Added the destination label and removed INBOX";

  if (plan.destinationIsPendingDeletion) {
    return `${opening}; any other labels remain unchanged.`;
  }

  const restored: string[] = [];
  if (plan.restoredFromTrash === true) restored.push("TRASH");
  if (plan.restoredFromSpam === true) restored.push("SPAM");

  if (restored.length > 0) {
    return `${opening}, and removed ${restored.join(" and ")}: the message was in ` +
      `${restored.length > 1 ? "Trash and Spam" : restored[0] === "TRASH" ? "Trash" : "Spam"} ` +
      `and has been restored, so it is no longer scheduled for permanent deletion. ` +
      `Any other labels remain unchanged.`;
  }

  if (plan.restoredFromTrash === false && plan.restoredFromSpam === false) {
    return `${opening}; the message was not in Trash or Spam. Any other labels remain unchanged.`;
  }

  // Labels unknown (bulk path): describe the write, not a guess about the state.
  return `${opening}, and removed TRASH and SPAM if either was set, so any message ` +
    `that was in Trash or Spam is restored rather than left scheduled for permanent ` +
    `deletion. Any other labels remain unchanged.`;
}
