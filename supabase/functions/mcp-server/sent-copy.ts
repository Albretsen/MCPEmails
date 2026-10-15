/**
 * sent-copy.ts — where an SMTP send's Sent copy goes, and what the caller is
 * told when it goes nowhere.
 *
 * SMTP submission does not file a Sent copy (unlike the Gmail, Graph and JMAP
 * send APIs), so after a send over IMAP+SMTP we APPEND one ourselves. That used
 * to be a blind walk over four English names ("Sent", "Sent Messages",
 * "Sent Items", "INBOX.Sent"). On a server that names the mailbox anything
 * else (QQ Mail's 已发送, a German "Gesendet") every APPEND was refused, the
 * send still answered `status: "sent"`, and nothing told the agent or the user
 * that the copy was missing.
 *
 * Now the mailbox is resolved the way every other role is (SPECIAL-USE flag
 * first, then names; see resolveImapAlias), and a copy that could not be saved
 * is disclosed on the result as a note. The send itself still succeeds: the
 * message WAS delivered, and failing the call would invite a duplicate retry.
 *
 * Pure: no I/O. index.ts calls Deno.serve at load and cannot be imported by a
 * test, so the decisions live here.
 */

import {
  lookupCanonicalAlias,
  type MailboxListEntry,
  resolveImapAlias,
} from "./imap-folder-target.ts";

/**
 * The names the Sent copy used to be tried against, in order. Still the
 * fallback when the account's layout cannot be listed or does not single out
 * one Sent mailbox, so no account that saved its copy before saves it
 * somewhere different now.
 */
export const LEGACY_SENT_FOLDER_CANDIDATES = ["Sent", "Sent Messages", "Sent Items", "INBOX.Sent"] as const;

/**
 * Mailboxes to try APPENDing the Sent copy to, in order.
 *
 * A single resolved Sent mailbox (flagged \Sent, or the only mailbox wearing a
 * Sent name, 已发送 included) is tried first. Ambiguous or unmatched layouts
 * fall back to the legacy list, which is exactly the old behaviour. Never
 * creates a mailbox: a Sent copy is not worth inventing a folder for.
 */
export function sentCopyCandidates(mailboxes: readonly MailboxListEntry[]): string[] {
  const alias = lookupCanonicalAlias("sent")!;
  const match = resolveImapAlias([...mailboxes], alias);
  const ordered: string[] = match.kind === "matched" ? [match.name] : [];
  for (const name of LEGACY_SENT_FOLDER_CANDIDATES) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

/** The note a send result carries when its Sent copy could not be saved. */
export const SENT_COPY_NOT_SAVED_NOTE =
  "The message was sent, but its copy could not be saved to the Sent folder: " +
  "the mail server did not accept it in any Sent mailbox. It will not appear " +
  "in Sent. Do not resend it; the recipients have it.";
