// ---------------------------------------------------------------------------
// folder_list on IMAP: every mailbox, and message counts for the first few.
//
// ── What this replaces ──────────────────────────────────────────────────────
// One LIST, then up to 25 STATUS commands, each waiting for the previous
// answer before it was sent: 26 round trips to a mail server on another
// continent to draw one folder list. Measured 2026-10-02 at p50 5.0 s and p95
// 15.7 s, the slowest read in the product.
//
// ── What it does now ────────────────────────────────────────────────────────
//   1. A server that advertises LIST-STATUS (RFC 5819: Dovecot, Cyrus and so
//      Fastmail, and most hosted IMAP) is asked for the list and the counts in
//      ONE command.
//   2. Any mailbox that still has no count is asked with the same STATUS
//      command as before, but the commands are pipelined: written up to twelve
//      at a time, then read. On a server without LIST-STATUS (Yahoo, Gmail
//      over IMAP) that is one LIST and three writes.
//   3. Anything the pipelined reply left in doubt is asked a third time, one
//      mailbox at a time, with the original `mailboxStatus`. That is the old
//      path, unchanged, and it has the last word.
//
// ── Why the output is the same ──────────────────────────────────────────────
// The mailbox list comes from the same LIST parser either way. The counts are
// the same two STATUS figures, MESSAGES and UNSEEN, whichever command carried
// them. A mailbox the server will not STATUS (a \Noselect name, a mailbox
// without permission) had null counts when its STATUS command answered NO, and
// has null counts now. Only the first `countLimit` mailboxes, in the order the
// list is returned in, are counted at all; the rest are listed with null
// counts, exactly as before.
//
// Kept out of index.ts so it can be run against a scripted server and held
// equal to the implementation it replaces; see imap-folder-counts.test.ts.
// ---------------------------------------------------------------------------

import type { ImapMailboxCounts, ImapMailboxInfo, ImapMailboxStatus } from "./imap-client.ts";

/** The slice of `ImapClient` a folder listing needs. Structural, so a test can fake it. */
export interface ImapFolderCountClient {
  supportsListStatus(): boolean;
  listMailboxes(): Promise<ImapMailboxInfo[]>;
  listMailboxesWithStatus(): Promise<
    { mailboxes: ImapMailboxInfo[]; counts: Map<string, ImapMailboxCounts> | null } | null
  >;
  mailboxStatusPipelined(mailboxes: string[]): Promise<Array<ImapMailboxStatus | null | "unsure">>;
  mailboxStatus(mailbox: string): Promise<ImapMailboxStatus>;
}

export interface ImapFoldersWithCounts {
  /** Every mailbox, sorted by name. Never truncated. */
  mailboxes: ImapMailboxInfo[];
  /** Parallel to `mailboxes`: its counts, or null when unknown or not asked. */
  counts: Array<ImapMailboxCounts | null>;
}

/**
 * List every mailbox and count the first `countLimit` of them.
 *
 * A failed LIST throws what it always threw. A failed count never throws: that
 * mailbox is listed with null counts.
 */
export async function listImapFoldersWithCounts(
  client: ImapFolderCountClient,
  countLimit: number,
): Promise<ImapFoldersWithCounts> {
  let mailboxes: ImapMailboxInfo[] | null = null;
  let fromList: Map<string, ImapMailboxCounts> = new Map();
  if (client.supportsListStatus()) {
    const extended = await client.listMailboxesWithStatus();
    if (extended) {
      mailboxes = extended.mailboxes;
      // Null means "do not trust any of them": every count is then asked for.
      fromList = extended.counts ?? new Map();
    }
  }
  // No LIST-STATUS, or a server that advertised it and then refused it.
  mailboxes ??= await client.listMailboxes();

  const counted = Math.min(mailboxes.length, Math.max(0, countLimit));
  const counts: Array<ImapMailboxCounts | null> = mailboxes.map(() => null);
  const toAsk: number[] = [];
  for (let i = 0; i < counted; i++) {
    const known = fromList.get(mailboxes[i].name);
    if (known) counts[i] = known;
    else toAsk.push(i);
  }
  if (toAsk.length === 0) return { mailboxes, counts };

  let piped: Array<ImapMailboxStatus | null | "unsure">;
  try {
    piped = await client.mailboxStatusPipelined(toAsk.map((i) => mailboxes[i].name));
  } catch {
    // The batch could not even start. Counts stay unknown; the list stands.
    return { mailboxes, counts };
  }
  for (let k = 0; k < toAsk.length; k++) {
    let answer = piped[k] ?? null;
    if (answer === "unsure") {
      // The old path, for this one mailbox. A rejection is a null count, as it
      // was under `Promise.allSettled`.
      answer = await client.mailboxStatus(mailboxes[toAsk[k]].name).catch(() => null);
    }
    counts[toAsk[k]] = answer === null ? null : { messages: answer.messages, unseen: answer.unseen };
  }
  return { mailboxes, counts };
}
