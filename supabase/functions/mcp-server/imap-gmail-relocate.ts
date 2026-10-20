// ---------------------------------------------------------------------------
// Gmail over IMAP: moving or archiving a message addressed by its ALL MAIL id.
//
// A Gmail message is one message with labels. IMAP shows it once per label
// folder, with a different UID in each, and once more in All Mail (the mailbox
// flagged \All). Archiving means "take the \Inbox label off"; moving to a label
// means "add that label, and take \Inbox off".
//
// For a message addressed by its INBOX id the ordinary UID MOVE does exactly
// that: Gmail turns the MOVE out of INBOX into removing \Inbox. For a message
// addressed by its All Mail id it does not. A MOVE out of All Mail never
// removes \Inbox (the message is still in the Inbox afterwards), and expunging
// a message from All Mail is how a message is deleted outright on Gmail.
//
// All Mail ids are common. The client's `thread` op (client-api mail/thread.ts)
// returns every message that is not in the folder the conversation was opened
// from with its All Mail id: open a conversation from Sent, and its Inbox
// messages carry "[Gmail]/All Mail:<uid>" ids. Archiving those left them in the
// Inbox (found 2026-10-19).
//
// So a relocation whose SOURCE is All Mail on a Gmail server is done with
// labels, on the UIDs it was given, and nothing is ever expunged from All Mail:
//
//   destination is Trash or Spam   not handled here: the usual UID MOVE is how
//                                  Gmail trashes or spams a message.
//   destination is INBOX           UID COPY to INBOX (adds \Inbox).
//   destination is All Mail        UID STORE -X-GM-LABELS (\Inbox): an archive.
//   any other destination          UID COPY to it (adds the label), then
//                                  UID STORE -X-GM-LABELS (\Inbox). COPY first,
//                                  so a failure in between leaves the message
//                                  in the Inbox rather than nowhere new.
//
// The message keeps its All Mail UID throughout, so its id after the
// relocation is the id it had before.
//
// Cost: nothing at all for a server without X-GM-EXT-1, and nothing for a
// Gmail source folder outside "[Gmail]/" or "[Google Mail]/" (INBOX and user
// labels: the UID MOVE stays the one command). A source under that prefix
// needs the folder list to tell All Mail from Sent or Starred: the caller's
// listing when it has one, else one LIST.
// ---------------------------------------------------------------------------

export interface GmailMailboxLike {
  name: string;
  flags: string[];
}

export interface GmailRelocateClient {
  hasCapability(name: string): boolean;
  uidCopy(uids: number[], targetMailbox: string): Promise<Map<number, number>>;
  uidStoreGmailLabels(uids: number[], labels: string[], mode: "add" | "remove"): Promise<void>;
}

/** Where Gmail keeps its system folders, All Mail among them (localised names, fixed prefix). */
const GMAIL_SYSTEM_FOLDER = /^\[(?:Gmail|Google Mail)\]\//i;

const hasFlag = (box: GmailMailboxLike, flag: string): boolean => box.flags.some((f) => f.toLowerCase() === flag);
const isInbox = (name: string): boolean => name.toUpperCase() === "INBOX";

/**
 * Could `sourceFolder` be Gmail's All Mail? A cheap test that needs no LIST:
 * false means the caller's usual UID MOVE is right and nothing more is asked.
 */
export function mayBeGmailAllMail(client: Pick<GmailRelocateClient, "hasCapability">, sourceFolder: string): boolean {
  return client.hasCapability("X-GM-EXT-1") && GMAIL_SYSTEM_FOLDER.test(sourceFolder);
}

/**
 * Relocate `uids` of the selected mailbox `sourceFolder` to `destination` with
 * Gmail labels when the source is All Mail on a Gmail server (see the header).
 *
 * Returns true when it did the relocation (the ids are unchanged), false when
 * it did nothing and the caller's ordinary UID MOVE applies. The caller has
 * already selected `sourceFolder` and checked the UIDs are there.
 */
export async function relocateFromGmailAllMail(
  client: GmailRelocateClient,
  sourceFolder: string,
  uids: number[],
  destination: string,
  mailboxes: () => Promise<GmailMailboxLike[]>,
): Promise<boolean> {
  if (uids.length === 0 || !mayBeGmailAllMail(client, sourceFolder)) return false;
  const boxes = await mailboxes();
  const allMail = boxes.find((box) => hasFlag(box, "\\all"));
  if (!allMail || allMail.name !== sourceFolder) return false;
  const target = boxes.find((box) => box.name === destination || (isInbox(box.name) && isInbox(destination)));
  if (target && (hasFlag(target, "\\trash") || hasFlag(target, "\\junk"))) return false;

  if (destination !== allMail.name) await client.uidCopy(uids, destination);
  if (!isInbox(destination)) await client.uidStoreGmailLabels(uids, ["\\Inbox"], "remove");
  return true;
}
