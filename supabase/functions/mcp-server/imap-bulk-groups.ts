// ---------------------------------------------------------------------------
// The per-source-folder IMAP bulk loop.
//
// Move, copy, delete and flag were four near-identical copies of: decrypt the
// password, group ids by source folder, connect, SELECT, issue one UID command
// covering the whole group, log out, repeat for the next folder. Only the one
// UID command ever differed. Four copies meant the connection reuse and the
// wall-clock budget would each have had to be added four times and kept in
// step, in code paths where a divergence loses mail.
//
// It lives here rather than in index.ts for a second reason: index.ts cannot be
// imported by a test (it calls `Deno.serve` and builds a service-role client at
// module load), and this loop is where the two properties that most need
// testing live — that grouping still sends every UID to the mailbox it actually
// belongs to, and that a budget stop reports an exact, resumable remainder.
// Every external dependency is injected, the same way mcp-app-bulk.ts injects
// its provider execution so "what would actually have been deleted" is
// observable in a test.
// ---------------------------------------------------------------------------

import type { BulkStopReason } from "./bulk-budget.ts";

/** One source folder's worth of work, after the ids have been decoded. */
export interface ImapFolderGroup {
  folder: string;
  items: { uid: number; messageId: string }[];
}

export interface ImapBulkGroupResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
  /**
   * True when the run stopped before processing every group. Kept as the same
   * flag user cancellation has always set, so existing dashboard handling is
   * unchanged; `stoppedReason` says which of the two it was.
   */
  cancelled?: boolean;
  stoppedReason?: BulkStopReason;
}

/**
 * Decodes bulk ids into per-source-folder groups, preserving first-seen order.
 *
 * IMAP addresses a message as (mailbox, UID) and can only operate on the
 * SELECTed mailbox, so grouping is not an optimisation — it is the only correct
 * shape. Order is preserved so a partial run's remainder reads in the same
 * order the caller supplied, which is what makes a resumed call legible.
 *
 * Malformed ids are rejected here rather than inside a group, so they cost no
 * network at all and cannot take a whole folder's group down with them.
 */
export function groupImapIdsByFolder(
  messageIds: string[],
  decode: (messageId: string) => { folder: string; uid: number },
): { groups: ImapFolderGroup[]; failed: { id: string; error: string }[] } {
  const byFolder = new Map<string, { uid: number; messageId: string }[]>();
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const { folder, uid } = decode(messageId);
    if (!Number.isFinite(uid) || uid <= 0) {
      failed.push({ id: messageId, error: "invalid_message_id" });
      continue;
    }
    const g = byFolder.get(folder);
    if (g) g.push({ uid, messageId });
    else byFolder.set(folder, [{ uid, messageId }]);
  }
  return {
    groups: [...byFolder].map(([folder, items]) => ({ folder, items })),
    failed,
  };
}

/** The bit of {@link ImapSession} this loop needs. Injected so tests can fake it. */
export interface FolderSelectingSession<C> {
  select(mailbox: string): Promise<C>;
  invalidate(): Promise<void>;
}

/**
 * Runs one UID command per source folder, stopping cleanly on request.
 *
 * Connection handling, and why it is exactly this shape:
 *
 *   * The session is reused across groups — that is the speedup. A five-folder
 *     move used to cost five TCP+TLS+AUTH handshakes; it now costs one.
 *   * A group that FAILS invalidates the session, so the next group reconnects.
 *     Before reuse, each group had its own connection and was independently
 *     recoverable; carrying a desynchronised or dead socket forward would turn
 *     one group's failure into every later group's failure. The reconnect is
 *     paid only when something has already gone wrong.
 *   * Commands are issued strictly one at a time and each is awaited.
 *     `ImapClient` shares one read buffer and one tag stream across a single
 *     socket, and a concurrent fan-out corrupts it — the incident that made
 *     `runExclusive` exist. Do NOT add a `Promise.all` here; parallelism, if it
 *     is ever wanted, has to come from separate clients with a capped pool.
 *
 * The stop check runs BEFORE each group rather than after, so a run that stops
 * has never half-applied a group: every id is either fully done or fully
 * untouched. That is what lets the caller state a remainder it can stand behind.
 */
export async function runImapFolderGroups<C>(opts: {
  groups: ImapFolderGroup[];
  /** Ids rejected during decoding, carried into the result unchanged. */
  preFailed?: { id: string; error: string }[];
  session: FolderSelectingSession<C>;
  /** Maps a stored folder token to the server's mailbox name. */
  folderName: (folder: string) => string;
  /** The one UID command that distinguishes move from copy from delete from flag. */
  apply: (client: C, group: ImapFolderGroup) => Promise<void>;
  /** Cooperative stop: budget exhausted, user cancellation, or neither. */
  stop?: (succeeded: number, failed: number) => Promise<BulkStopReason | null>;
  /** Turns a thrown provider error into the per-id error string. */
  classifyError: (err: unknown) => string;
}): Promise<ImapBulkGroupResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [...(opts.preFailed ?? [])];

  for (const group of opts.groups) {
    const stop = opts.stop ? await opts.stop(succeeded.length, failed.length) : null;
    if (stop) return { succeeded, failed, cancelled: true, stoppedReason: stop };

    try {
      const client = await opts.session.select(opts.folderName(group.folder));
      await opts.apply(client, group);
      for (const item of group.items) succeeded.push(item.messageId);
    } catch (err) {
      const message = opts.classifyError(err);
      for (const item of group.items) failed.push({ id: item.messageId, error: message });
      await opts.session.invalidate();
    }
  }

  return { succeeded, failed };
}
