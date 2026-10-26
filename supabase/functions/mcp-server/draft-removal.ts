// ---------------------------------------------------------------------------
// Removing an IMAP draft after it was sent, and proving it is gone.
//
// Found 2026-10-26 on a Gmail IMAP+SMTP inbox: the card's Send delivered the
// mail and the draft stayed in Drafts, while the send path's
// STORE \Deleted + UID EXPUNGE had both answered OK. The cause was the Sent
// copy we APPENDed ourselves. Gmail keeps one message per Message-ID, and the
// APPEND carried the draft's Message-ID, so Gmail did not store a new message:
// it put the \Sent label on the DRAFT. A Gmail message that is both a draft and
// sent cannot leave Drafts the usual ways. EXPUNGE from Drafts answers OK and
// does nothing, and UID MOVE out of Drafts is refused ("Cannot MOVE messages
// out of the Drafts folder"). What does work is taking the \Draft label off in
// All Mail: `UID STORE <uid> -X-GM-LABELS (\Draft)`. Inside Drafts that same
// STORE is a no-op, because a folder's own label is hidden there.
//
// The APPEND is now skipped on Gmail SMTP (sent-copy.ts,
// smtpFilesSentCopyItself), which removes the cause. This module is the
// backstop: after the usual delete it checks the UID is really gone, takes the
// All Mail route on Gmail when it is not, and reports the truth, so a draft
// left behind is disclosed rather than assumed away.
//
// Pure apart from the client it is handed, so the sequence is unit tested.
// ---------------------------------------------------------------------------

export interface DraftRemovalMailbox {
  name: string;
  flags: string[];
}

export interface DraftRemovalClient {
  selectMailbox(mailbox: string): Promise<void>;
  uidStore(uids: number[], flags: string[], mode: "add" | "remove"): Promise<void>;
  uidExpunge(uids: number[]): Promise<void>;
  uidSearch(criteria: string): Promise<number[]>;
  hasCapability(name: string): boolean;
  fetchGmailIds(uids: number[]): Promise<Array<{ uid: number; threadId: string; messageId: string }>>;
  listMailboxes(): Promise<DraftRemovalMailbox[]>;
  uidStoreGmailLabels(uids: number[], labels: string[], mode: "add" | "remove"): Promise<void>;
}

export interface DraftRemovalResult {
  removed: boolean;
  /** How it went: which route removed it, or why it is still there. */
  via: "expunge" | "gmail_label" | "still_present" | "error";
  error?: string;
}

const isAllMail = (box: DraftRemovalMailbox): boolean => box.flags.some((f) => f.toLowerCase() === "\\all");

/** Is `uid` still in the selected mailbox? */
async function stillThere(client: DraftRemovalClient, uid: number): Promise<boolean> {
  const hits = await client.uidSearch(`UID ${uid}`);
  return hits.includes(uid);
}

/**
 * Delete draft `uid` from `folder` and confirm it left. Never throws: the
 * message was already sent, so the caller reports the outcome instead.
 */
export async function removeSentDraft(
  client: DraftRemovalClient,
  folder: string,
  uid: number,
): Promise<DraftRemovalResult> {
  try {
    await client.selectMailbox(folder);
    // Gmail's ids are read BEFORE the delete: if the expunge does take, the
    // UID is gone and so is the only way to ask for them.
    const gmail = client.hasCapability("X-GM-EXT-1");
    const gmailMsgId = gmail
      ? (await client.fetchGmailIds([uid]).catch(() => []))[0]?.messageId ?? ""
      : "";
    await client.uidStore([uid], ["\\Deleted"], "add");
    await client.uidExpunge([uid]);
    if (!(await stillThere(client, uid))) return { removed: true, via: "expunge" };
    if (!gmail || !gmailMsgId) return { removed: false, via: "still_present" };

    // Gmail kept it (see the header): take the \Draft label off in All Mail.
    const allMail = (await client.listMailboxes()).find(isAllMail);
    if (!allMail) return { removed: false, via: "still_present" };
    // Undo our \Deleted first: it is the Sent copy now, not a doomed draft.
    await client.uidStore([uid], ["\\Deleted"], "remove").catch(() => {});
    await client.selectMailbox(allMail.name);
    const [allUid] = await client.uidSearch(`X-GM-MSGID ${gmailMsgId}`);
    if (allUid === undefined) return { removed: false, via: "still_present" };
    await client.uidStoreGmailLabels([allUid], ["\\Draft"], "remove");
    await client.selectMailbox(folder);
    if (await stillThere(client, uid)) return { removed: false, via: "still_present" };
    return { removed: true, via: "gmail_label" };
  } catch (err) {
    return { removed: false, via: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** The receipt detail on the card when the draft outlived its send. */
export const DRAFT_KEPT_RECEIPT_DETAIL =
  "Accepted by the mail server for delivery. Sent, but the draft is still in Drafts.";

/** The note on the tool result when the draft outlived its send. */
export const DRAFT_KEPT_AFTER_SEND_NOTE =
  "The message was sent, but its draft could not be removed and is still in Drafts. " +
  "Do not send it again: the recipients have it. It can be deleted with the draft tool " +
  "(action 'delete') or in the mail app.";
