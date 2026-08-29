// ---------------------------------------------------------------------------
// Per-source-folder IMAP bulk loop tests.
//
// Two properties, both of which a delete path depends on:
//
//   1. GROUPING SURVIVES CONNECTION REUSE. A UID is only meaningful inside its
//      mailbox, so every UID command must land against the SELECT for the
//      folder it came from. Reusing one connection across folder groups (and
//      eliding the SELECT when the mailbox has not changed) is the speedup;
//      getting it wrong deletes mail out of the wrong folder.
//
//   2. A STOP LEAVES AN EXACT, RESUMABLE REMAINDER. The stop check runs before
//      each group, never inside one, so no group is ever half-applied and the
//      "not processed" set is precisely the groups not reached. Feeding that
//      set back in must finish the job and touch nothing twice — that is the
//      whole contract behind the `partial` result, and on a delete it is the
//      difference between a user who knows what happened and one who does not.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createWorkBudget, remainingIds } from "./bulk-budget.ts";
import {
  groupImapIdsByFolder,
  type ImapFolderGroup,
  runImapFolderGroups,
} from "./imap-bulk-groups.ts";
import { ImapSession } from "./imap-session.ts";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Ids are "folder:uid", matching the shape of the real encoded id. */
function decode(messageId: string): { folder: string; uid: number } {
  const [folder, uid] = messageId.split(":");
  return { folder, uid: Number(uid) };
}

interface AppliedCommand {
  /** The mailbox the fake connection had SELECTed when the command ran. */
  mailbox: string | null;
  uids: number[];
}

class FakeConnection {
  selected: string | null = null;
  loggedOut = false;
  readonly applied: AppliedCommand[] = [];
  /** Folder names whose UID command should throw, to exercise fault isolation. */
  failOn = new Set<string>();

  selectMailbox(mailbox: string): Promise<void> {
    this.selected = mailbox;
    return Promise.resolve();
  }
  logout(): Promise<void> {
    this.loggedOut = true;
    return Promise.resolve();
  }
}

function makeSession(connections: FakeConnection[]) {
  const queue = [...connections];
  let opened = 0;
  const session = new ImapSession<FakeConnection>(() => {
    opened++;
    return Promise.resolve(queue.shift() ?? connections[connections.length - 1]);
  });
  return { session, opened: () => opened };
}

/** The `apply` a move/delete would supply, recording where it actually ran. */
function recordingApply(conn: () => FakeConnection) {
  return (client: FakeConnection, group: ImapFolderGroup): Promise<void> => {
    void conn;
    if (client.failOn.has(group.folder)) {
      return Promise.reject(new Error(`UID MOVE failed in ${group.folder}`));
    }
    client.applied.push({
      mailbox: client.selected,
      uids: group.items.map((i) => i.uid),
    });
    return Promise.resolve();
  };
}

const classify = (err: unknown) => err instanceof Error ? err.message : String(err);
const identityFolder = (f: string) => f;

// ── Grouping ────────────────────────────────────────────────────────────────

Deno.test("ids are grouped by source folder in first-seen order", () => {
  const { groups, failed } = groupImapIdsByFolder(
    ["INBOX:1", "Archive:7", "INBOX:2", "Receipts:9", "Archive:8", "INBOX:3"],
    decode,
  );
  assertEquals(failed, []);
  assertEquals(groups.map((g) => g.folder), ["INBOX", "Archive", "Receipts"]);
  assertEquals(groups[0].items.map((i) => i.uid), [1, 2, 3]);
  assertEquals(groups[1].items.map((i) => i.uid), [7, 8]);
  assertEquals(groups[2].items.map((i) => i.uid), [9]);
});

Deno.test("a malformed id fails on its own and costs no network", () => {
  const { groups, failed } = groupImapIdsByFolder(
    ["INBOX:1", "INBOX:0", "INBOX:notanumber", "INBOX:2"],
    decode,
  );
  assertEquals(failed, [
    { id: "INBOX:0", error: "invalid_message_id" },
    { id: "INBOX:notanumber", error: "invalid_message_id" },
  ]);
  // The bad ids must not drag the good ones in the same folder down with them.
  assertEquals(groups.length, 1);
  assertEquals(groups[0].items.map((i) => i.uid), [1, 2]);
});

// ── Grouping correctness under a reused connection ──────────────────────────

Deno.test("every UID command runs against the mailbox its group came from", async () => {
  const conn = new FakeConnection();
  const { session, opened } = makeSession([conn]);
  const { groups, failed } = groupImapIdsByFolder(
    ["INBOX:1", "Archive:7", "INBOX:2", "Receipts:9", "Archive:8"],
    decode,
  );

  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    preFailed: failed,
    session,
    folderName: identityFolder,
    apply: recordingApply(() => conn),
    classifyError: classify,
  });
  await session.close();

  assertEquals(opened(), 1, "one connection serves every folder group");
  assertEquals(conn.applied, [
    { mailbox: "INBOX", uids: [1, 2] },
    { mailbox: "Archive", uids: [7, 8] },
    { mailbox: "Receipts", uids: [9] },
  ]);
  assertEquals(result.succeeded.length, 5);
  assertEquals(result.failed, []);
});

Deno.test("the folder-name resolver is applied, so aliases still reach the right mailbox", async () => {
  // The real resolver maps tokens like "TRASH" onto a server's namespaced or
  // localised mailbox (INBOX.Trash). Reuse must not bypass it.
  const conn = new FakeConnection();
  const { session } = makeSession([conn]);
  const { groups } = groupImapIdsByFolder(["TRASH:1", "INBOX:2"], decode);

  await runImapFolderGroups<FakeConnection>({
    groups,
    session,
    folderName: (f) => f === "TRASH" ? "INBOX.Trash" : f,
    apply: recordingApply(() => conn),
    classifyError: classify,
  });
  await session.close();

  assertEquals(conn.applied.map((a) => a.mailbox), ["INBOX.Trash", "INBOX"]);
});

Deno.test("one group's failure does not poison the groups after it", async () => {
  // Before connection reuse each group had its own connection and was
  // independently recoverable. Reuse must preserve that.
  const first = new FakeConnection();
  first.failOn.add("Archive");
  const second = new FakeConnection();
  const { session, opened } = makeSession([first, second]);
  const { groups } = groupImapIdsByFolder(
    ["INBOX:1", "Archive:7", "Receipts:9"],
    decode,
  );

  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    session,
    folderName: identityFolder,
    apply: recordingApply(() => first),
    classifyError: classify,
  });
  await session.close();

  assertEquals(result.succeeded, ["INBOX:1", "Receipts:9"]);
  assertEquals(result.failed, [{ id: "Archive:7", error: "UID MOVE failed in Archive" }]);
  assertEquals(opened(), 2, "the failed socket is dropped, not carried forward");
  assert(first.loggedOut, "the dropped connection must be released");
  assertEquals(second.applied, [{ mailbox: "Receipts", uids: [9] }]);
});

// ── Budget stop and resume ──────────────────────────────────────────────────

Deno.test("a budget stop never half-applies a group", async () => {
  const clock = { t: 0 };
  // 500ms of allowance, 600ms per group: the first group's stop check passes,
  // the second's does not.
  const budget = createWorkBudget(500, () => clock.t);
  const conn = new FakeConnection();
  const { session } = makeSession([conn]);
  const { groups } = groupImapIdsByFolder(
    ["INBOX:1", "INBOX:2", "Archive:7", "Archive:8", "Receipts:9"],
    decode,
  );

  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    session,
    folderName: identityFolder,
    apply: (client, group) => {
      clock.t += 600; // each group costs 600ms of the 1000ms allowance
      return recordingApply(() => conn)(client, group);
    },
    stop: () => Promise.resolve(budget.exhausted() ? "time_budget" : null),
    classifyError: classify,
  });
  await session.close();

  assertEquals(result.cancelled, true);
  assertEquals(result.stoppedReason, "time_budget");
  // The first group completed whole; the second was never started. No id is in
  // an in-between state.
  assertEquals(result.succeeded, ["INBOX:1", "INBOX:2"]);
  assertEquals(conn.applied, [{ mailbox: "INBOX", uids: [1, 2] }]);
});

Deno.test("resuming with the reported remainder finishes the job exactly once", async () => {
  // The end-to-end contract of a `partial` result: stop, hand back
  // remaining_message_ids, and a follow-up call with exactly those ids
  // completes the work with nothing done twice and nothing skipped.
  const requested = ["INBOX:1", "INBOX:2", "Archive:7", "Archive:8", "Receipts:9"];

  // ── Pass 1: budget runs out after the first folder group ──
  const clock1 = { t: 0 };
  const budget1 = createWorkBudget(500, () => clock1.t);
  const conn1 = new FakeConnection();
  const { session: s1 } = makeSession([conn1]);
  const first = await runImapFolderGroups<FakeConnection>({
    groups: groupImapIdsByFolder(requested, decode).groups,
    session: s1,
    folderName: identityFolder,
    apply: (client, group) => {
      clock1.t += 600;
      return recordingApply(() => conn1)(client, group);
    },
    stop: () => Promise.resolve(budget1.exhausted() ? "time_budget" : null),
    classifyError: classify,
  });
  await s1.close();

  const leftover = remainingIds(requested, first.succeeded, first.failed);
  assertEquals(leftover, ["Archive:7", "Archive:8", "Receipts:9"]);

  // ── Pass 2: the caller retries with exactly the remainder, budget intact ──
  const conn2 = new FakeConnection();
  const { session: s2 } = makeSession([conn2]);
  const second = await runImapFolderGroups<FakeConnection>({
    groups: groupImapIdsByFolder(leftover, decode).groups,
    session: s2,
    folderName: identityFolder,
    apply: recordingApply(() => conn2),
    classifyError: classify,
  });
  await s2.close();

  assertEquals(second.cancelled, undefined, "the resumed pass ran to completion");
  assertEquals(second.succeeded, leftover);

  // Nothing skipped: the two passes together cover the original request.
  const all = [...first.succeeded, ...second.succeeded];
  assertEquals(all.slice().sort(), requested.slice().sort());
  // Nothing done twice: the union is the same size as the request.
  assertEquals(new Set(all).size, requested.length);
  // And the resumed pass re-selected the folders it needed rather than assuming
  // the previous connection's selection.
  assertEquals(conn2.applied, [
    { mailbox: "Archive", uids: [7, 8] },
    { mailbox: "Receipts", uids: [9] },
  ]);
});

Deno.test("a resumed pass does not re-touch what the first pass already did", async () => {
  // The specific hazard on a COPY, where re-running is not idempotent: IMAP UID
  // COPY creates a brand new message every time, so a remainder that wrongly
  // included already-copied ids would leave duplicates.
  const requested = ["INBOX:1", "Archive:7", "Receipts:9"];
  const clock = { t: 0 };
  const budget = createWorkBudget(500, () => clock.t);
  const conn1 = new FakeConnection();
  const { session: s1 } = makeSession([conn1]);
  const first = await runImapFolderGroups<FakeConnection>({
    groups: groupImapIdsByFolder(requested, decode).groups,
    session: s1,
    folderName: identityFolder,
    apply: (client, group) => {
      clock.t += 400;
      return recordingApply(() => conn1)(client, group);
    },
    stop: () => Promise.resolve(budget.exhausted() ? "time_budget" : null),
    classifyError: classify,
  });
  await s1.close();

  const leftover = remainingIds(requested, first.succeeded, first.failed);
  assert(!leftover.includes("INBOX:1"), "an id already applied must not be resumed");

  const conn2 = new FakeConnection();
  const { session: s2 } = makeSession([conn2]);
  await runImapFolderGroups<FakeConnection>({
    groups: groupImapIdsByFolder(leftover, decode).groups,
    session: s2,
    folderName: identityFolder,
    apply: recordingApply(() => conn2),
    classifyError: classify,
  });
  await s2.close();

  const uidsTouchedTwice = conn2.applied
    .flatMap((a) => a.uids)
    .filter((uid) => conn1.applied.flatMap((a) => a.uids).includes(uid));
  assertEquals(uidsTouchedTwice, []);
});

Deno.test("a run stopped by a user cancellation is labelled as such, not as a timeout", async () => {
  const conn = new FakeConnection();
  const { session } = makeSession([conn]);
  const { groups } = groupImapIdsByFolder(["INBOX:1", "Archive:7"], decode);

  let calls = 0;
  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    session,
    folderName: identityFolder,
    apply: recordingApply(() => conn),
    stop: () => Promise.resolve(++calls > 1 ? "cancelled" : null),
    classifyError: classify,
  });
  await session.close();

  assertEquals(result.stoppedReason, "cancelled");
  assertEquals(result.succeeded, ["INBOX:1"]);
});

Deno.test("failed ids are excluded from the remainder, so a resume does not retry them forever", async () => {
  // A genuinely broken id must land in `failed` and stay there. Treating it as
  // "not yet processed" would make every resume attempt it again.
  const requested = ["INBOX:1", "INBOX:0", "Archive:7"];
  const conn = new FakeConnection();
  const { session } = makeSession([conn]);
  const { groups, failed } = groupImapIdsByFolder(requested, decode);

  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    preFailed: failed,
    session,
    folderName: identityFolder,
    apply: recordingApply(() => conn),
    classifyError: classify,
  });
  await session.close();

  assertEquals(remainingIds(requested, result.succeeded, result.failed), []);
});

Deno.test("no groups means no connection is ever opened", async () => {
  // A call whose ids are all malformed must not cost a handshake.
  const { session, opened } = makeSession([new FakeConnection()]);
  const { groups, failed } = groupImapIdsByFolder(["INBOX:0", "INBOX:bad"], decode);

  const result = await runImapFolderGroups<FakeConnection>({
    groups,
    preFailed: failed,
    session,
    folderName: identityFolder,
    apply: () => Promise.reject(new Error("must not run")),
    classifyError: classify,
  });
  await session.close();

  assertEquals(opened(), 0);
  assertEquals(result.succeeded, []);
  assertEquals(result.failed.length, 2);
});
