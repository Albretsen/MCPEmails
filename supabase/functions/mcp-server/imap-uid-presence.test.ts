// ---------------------------------------------------------------------------
// "Does this message exist?" — the question the mutation paths never asked.
//
// On 2026-09-20 a live run against a real Gmail-over-IMAP mailbox deleted and
// moved message ids that had never existed, and got `success: true` every
// time, because a UID command against a UID set that matches nothing is a
// tagged OK. These tests pin the four things the fix depends on:
//
//   1. THE PROBE ASKS ABOUT EXACTLY THE UIDS IT WAS GIVEN — the criteria is
//      `UID <set>` and nothing else, in the same set syntax the UID command
//      itself is built from.
//   2. A MISSING UID IS REPORTED AS MISSING, with the `message_not_found`
//      sentinel the read path and the bulk formatter already speak.
//   3. A REAL UID STILL SUCCEEDS, including the one shape that must not
//      regress: a message already flagged \\Deleted but not yet expunged is
//      PRESENT, so re-deleting an already-trashed message stays an idempotent
//      no-op rather than becoming a false "not found".
//   4. A FAILED PROBE FAILS, rather than being read as "not there". "Not
//      found" is a claim about the mailbox and is only ours to make when the
//      mailbox answered.
//
// Run: deno test --allow-all supabase/functions/mcp-server/imap-uid-presence.test.ts
// ---------------------------------------------------------------------------

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertUidPresent,
  presentUids,
  splitByPresence,
  type UidSearcher,
} from "./imap-uid-presence.ts";
import { MESSAGE_NOT_FOUND } from "./message-id-errors.ts";

/**
 * A mailbox that holds exactly `held`, answering UID SEARCH the way a server
 * does: the intersection, in ascending order, with nothing said about the
 * UIDs it does not have.
 */
function mailboxHolding(held: number[]): UidSearcher & { asked: string[] } {
  const asked: string[] = [];
  const have = new Set(held);
  return {
    asked,
    uidSearch(criteria: string): Promise<number[]> {
      asked.push(criteria);
      const set = criteria.replace(/^UID\s+/, "");
      const wanted: number[] = [];
      for (const part of set.split(",")) {
        const [lo, hi] = part.split(":").map(Number);
        for (let u = lo; u <= (hi ?? lo); u++) if (have.has(u)) wanted.push(u);
      }
      return Promise.resolve(wanted);
    },
  };
}

// ── The criteria on the wire ────────────────────────────────────────────────

Deno.test("the probe asks UID SEARCH for exactly the uids it was given", async () => {
  const mailbox = mailboxHolding([1, 2, 3, 5, 7, 8]);
  await presentUids(mailbox, [1, 2, 3, 5, 7, 8]);
  // Compressed to ranges by the same toUidSet the UID command uses, so the
  // probe and the command can never be asking about different message sets.
  assertEquals(mailbox.asked, ["UID 1:3,5,7:8"]);
});

Deno.test("an empty uid list costs no round trip at all", async () => {
  const mailbox = mailboxHolding([1]);
  assertEquals([...await presentUids(mailbox, [])], []);
  assertEquals(mailbox.asked, [], "a probe for nothing must not reach the server");
});

// ── Missing ids ─────────────────────────────────────────────────────────────

Deno.test("a uid the mailbox does not hold comes back missing", async () => {
  const mailbox = mailboxHolding([1, 2, 3]);
  const present = await presentUids(mailbox, [99999999]);
  assertEquals([...present], []);
});

Deno.test("assertUidPresent throws the not-found sentinel for a nonexistent uid", async () => {
  // The exact transcript from the 2026-09-20 run: "INBOX:99999999" on a
  // mailbox that holds nothing like it. Before the fix this path issued its
  // UID command, got a tagged OK, and returned success.
  const mailbox = mailboxHolding([1, 2, 3]);
  const err = await assertRejects(
    () => assertUidPresent(mailbox, 99999999),
    Error,
  );
  assertEquals(
    err.message,
    MESSAGE_NOT_FOUND,
    "the sentinel handleFlagError and formatBulkResult already translate",
  );
});

Deno.test("a mixed batch splits into the real ids and the stale ones, in order", async () => {
  // delete_batch(["INBOX:77777777","INBOX:2","INBOX:66666666"]) — two invented
  // ids around one real one. All three used to land in `succeeded`.
  const mailbox = mailboxHolding([2]);
  const items = [
    { uid: 77777777, messageId: "INBOX:77777777" },
    { uid: 2, messageId: "INBOX:2" },
    { uid: 66666666, messageId: "INBOX:66666666" },
  ];
  const split = splitByPresence(items, await presentUids(mailbox, items.map((i) => i.uid)));
  assertEquals(split.present.map((i) => i.messageId), ["INBOX:2"]);
  assertEquals(split.missing.map((i) => i.messageId), [
    "INBOX:77777777",
    "INBOX:66666666",
  ]);
});

// ── Real ids must still work ────────────────────────────────────────────────

Deno.test("a uid the mailbox holds is present, so the mutation still runs", async () => {
  const mailbox = mailboxHolding([1, 2, 3]);
  await assertUidPresent(mailbox, 2);
  assertEquals([...await presentUids(mailbox, [1, 3])], [1, 3]);
});

Deno.test("a message already flagged \\Deleted is still present, so re-deleting stays a no-op", async () => {
  // IMAP SEARCH has no implicit UNDELETED. A trashed-but-not-expunged message
  // answers a `UID <n>` search, which is what keeps "delete something already
  // in Trash" an idempotent success rather than a fabricated not-found.
  const stillThereButDeletedFlagged = mailboxHolding([42]);
  await assertUidPresent(stillThereButDeletedFlagged, 42);
});

// ── The probe's own failures ────────────────────────────────────────────────

Deno.test("a failed UID SEARCH propagates instead of being read as not-found", async () => {
  const brokenMailbox: UidSearcher = {
    uidSearch: () => Promise.reject(new Error("UID SEARCH failed: NO [SERVERBUG]")),
  };
  const err = await assertRejects(() => assertUidPresent(brokenMailbox, 7), Error);
  assertEquals(err.message, "UID SEARCH failed: NO [SERVERBUG]");
});

Deno.test("a server that answers more generously than it was asked cannot invent a hit", async () => {
  // Some servers have been seen to ignore a criteria they dislike and answer
  // with the mailbox. Intersecting with what was asked means the worst such a
  // server can do is make a present message look present.
  const chatty: UidSearcher = {
    uidSearch: () => Promise.resolve([1, 2, 3, 4, 5]),
  };
  assertEquals([...await presentUids(chatty, [4])], [4]);
  assertEquals(
    [...await presentUids(chatty, [99999999])],
    [],
    "an id the mailbox never mentioned must never count as present",
  );
});
