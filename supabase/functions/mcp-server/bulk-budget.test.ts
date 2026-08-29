// ---------------------------------------------------------------------------
// Wall-clock budget tests.
//
// The property that matters is not "the budget expires" — it is that a run
// which expired says so in a way a model cannot misread as completion. Thirty
// days of production had ~9% of email_search_and_delete calls exceeding the
// window most MCP clients wait, and for a DESTRUCTIVE operation the failure
// mode of a silent truncation is a user believing mail is gone when it is not.
// So most of what is asserted here is about the wording and the completeness of
// the continuation, not about arithmetic.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BULK_ACT_PHASE_RESERVE_MS,
  BULK_WALL_CLOCK_BUDGET_MS,
  bulkPartialFields,
  bulkPartialNotice,
  continuationFor,
  createWorkBudget,
  remainingIds,
} from "./bulk-budget.ts";

/** A clock the test drives by hand, so no test ever sleeps. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

Deno.test("budget starts unspent and expires exactly when its allowance runs out", () => {
  const clock = fakeClock();
  const budget = createWorkBudget(25_000, clock.now);

  assertEquals(budget.exhausted(), false);
  assertEquals(budget.remainingMs(), 25_000);

  clock.advance(24_999);
  assertEquals(budget.exhausted(), false);

  clock.advance(1);
  assertEquals(budget.exhausted(), true);
  assertEquals(budget.remainingMs(), 0, "remaining never goes negative");
});

Deno.test("the default budget sits below every MCP client timeout we know of", () => {
  // Clients give up between 30s and 60s. A budget at or above 30s would not fix
  // the reported symptom at all, which is the whole point of this change.
  assert(BULK_WALL_CLOCK_BUDGET_MS < 30_000);
});

Deno.test("the search phase holds back a reserve so the act phase always runs", () => {
  const clock = fakeClock();
  const budget = createWorkBudget(25_000, clock.now);

  // With a 30s per-search ceiling, the whole-call budget is what binds.
  assertEquals(budget.searchPhaseMs(30_000), 25_000 - BULK_ACT_PHASE_RESERVE_MS);

  // A caller with a tighter ceiling of its own keeps it.
  assertEquals(budget.searchPhaseMs(5_000), 5_000);
});

Deno.test("a nearly-spent budget still gives the search a positive timer", () => {
  // A zero or negative timer would reject the search before it was issued,
  // turning a tight budget into a hard search_timeout error. Better to let one
  // search run and let the act phase report an honest zero.
  const clock = fakeClock();
  const budget = createWorkBudget(25_000, clock.now);
  clock.advance(24_000);
  assert(budget.searchPhaseMs(30_000) > 0);
});

Deno.test("remaining ids are whatever was neither succeeded nor failed", () => {
  const requested = ["a", "b", "c", "d", "e"];
  const left = remainingIds(requested, ["a", "c"], [{ id: "b" }]);
  assertEquals(left, ["d", "e"]);
});

Deno.test("remaining ids survive out-of-order processing", () => {
  // IMAP groups by SOURCE FOLDER, so ids are not processed in the order they
  // arrived: a run can finish group three before group two. A positional cursor
  // would report the wrong remainder here — on a delete, that means claiming
  // messages are gone that are not.
  const requested = ["inbox-1", "archive-1", "inbox-2", "archive-2", "inbox-3"];
  const left = remainingIds(requested, ["archive-1", "archive-2"], []);
  assertEquals(left, ["inbox-1", "inbox-2", "inbox-3"]);
});

Deno.test("a partial delete says how many were NOT deleted, in words", () => {
  const notice = bulkPartialNotice({
    operation: "email_search_and_delete",
    total: 500,
    succeeded: 140,
    failed: 0,
    remaining: 360,
    reason: "time_budget",
  });

  assertStringIncludes(notice, "did NOT finish");
  assertStringIncludes(notice, "140 of 500");
  // The subtraction must not be left to the reader.
  assertStringIncludes(notice, "360 messages were NOT");
  assertStringIncludes(notice, "unchanged");
});

Deno.test("a partial delete distinguishes trash from permanent", () => {
  const toTrash = bulkPartialNotice({
    operation: "email_search_and_delete",
    total: 10, succeeded: 4, failed: 0, remaining: 6, reason: "time_budget",
    permanent: false,
  });
  const forever = bulkPartialNotice({
    operation: "email_search_and_delete",
    total: 10, succeeded: 4, failed: 0, remaining: 6, reason: "time_budget",
    permanent: true,
  });

  // Whether the 4 that went are recoverable is not something a reader should
  // have to infer from a separate boolean elsewhere in the payload.
  assertStringIncludes(toTrash, "moved to Trash");
  assertStringIncludes(forever, "permanently deleted");
});

Deno.test("a budget stop is not reported as an error, a cancellation is not reported as a timeout", () => {
  const budgeted = bulkPartialNotice({
    operation: "email_search_and_move",
    total: 100, succeeded: 30, failed: 0, remaining: 70, reason: "time_budget",
  });
  const cancelled = bulkPartialNotice({
    operation: "email_search_and_move",
    total: 100, succeeded: 30, failed: 0, remaining: 70, reason: "cancelled",
  });

  assertStringIncludes(budgeted, "time limit");
  assertStringIncludes(budgeted, "not an error");
  assertStringIncludes(cancelled, "cancelled from the dashboard");
  assert(!cancelled.includes("time limit"));
});

Deno.test("the notice states facts and does not instruct the model", () => {
  const notice = bulkPartialNotice({
    operation: "email_search_and_delete",
    total: 50, succeeded: 20, failed: 0, remaining: 30, reason: "time_budget",
  });
  // Same rule the usage-cap message follows: describe the situation, leave the
  // decision to the model and its user.
  for (const imperative of ["You must", "you should", "Please call", "Now call"]) {
    assert(!notice.includes(imperative), `notice instructs the model: "${imperative}"`);
  }
});

Deno.test("continuation names the public consolidated tool, not the legacy one", () => {
  // A model can only call the consolidated names; handing it "email_search_and_delete"
  // would name a tool that does not exist on the wire.
  assertEquals(continuationFor("email_search_and_delete", ["x"]), {
    tool: "email_delete", action: "delete_batch", message_ids: ["x"],
  });
  assertEquals(continuationFor("email_search_and_move", ["x"]), {
    tool: "email_organize", action: "move_batch", message_ids: ["x"],
  });
  assertEquals(continuationFor("email_read_batch", ["x"]), {
    tool: "email_read", action: "read_batch", message_ids: ["x"],
  });
});

Deno.test("continuation carries the ids rather than the search that found them", () => {
  // Re-running the search is the obvious cheap resume and it is wrong: mail
  // that arrived during the first pass would match the second one, so a resumed
  // delete could destroy messages the user never saw. The ids bound the blast
  // radius to the set the first call already resolved.
  const ids = ["m1", "m2", "m3"];
  const cont = continuationFor("email_search_and_delete", ids);
  assertEquals(cont?.message_ids, ids);
});

Deno.test("no continuation when there is nothing left to do", () => {
  assertEquals(continuationFor("email_search_and_delete", []), null);
});

Deno.test("partial fields carry a machine flag and a human notice together", () => {
  const fields = bulkPartialFields({
    operation: "email_search_and_delete",
    total: 500,
    succeeded: 140,
    failed: 2,
    remainingIds: Array.from({ length: 358 }, (_, i) => `id-${i}`),
    reason: "time_budget",
    permanent: false,
  });

  // A client that renders only structuredContent and a client that renders only
  // text must EACH be able to tell the job is unfinished.
  assertEquals(fields.partial, true);
  assertEquals(fields.stopped_reason, "time_budget");
  assertEquals(fields.total_requested, 500);
  assertEquals(fields.remaining, 358);
  assertEquals(fields.remaining_message_ids.length, 358);
  assertEquals(fields.continuation?.tool, "email_delete");
  assertStringIncludes(fields.partial_notice, "358 messages were NOT");
});

Deno.test("the failed count is surfaced separately from the untouched count", () => {
  // "failed" and "not attempted" are different states and a delete result that
  // conflates them is unactionable: one needs investigating, the other needs
  // repeating.
  const fields = bulkPartialFields({
    operation: "email_delete_batch",
    total: 10,
    succeeded: 4,
    failed: 2,
    remainingIds: ["g", "h", "i", "j"],
    reason: "time_budget",
  });
  assertEquals(fields.remaining, 4);
  assertStringIncludes(fields.partial_notice, "A further 2 could not be");
});
