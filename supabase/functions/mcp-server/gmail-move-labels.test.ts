// ---------------------------------------------------------------------------
// Gmail relocation-plan tests.
//
// The property under test is not "labels are computed" — it is that a message
// sitting in Trash cannot be moved to a real label and left in Trash. That was
// production defect F1 (2026-08-30, message 1a0527fabc829d11): the move
// reported success, the label appeared, TRASH stayed on, and Gmail purged the
// message ~30 days later. Silent data loss on the recovery path.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  gmailRelocationPlan,
  gmailRelocationSemantics,
} from "./gmail-move-labels.ts";

/** Order-insensitive comparison — the label sets are sets, not sequences. */
function assertSameLabels(actual: string[], expected: string[], msg?: string) {
  assertEquals([...actual].sort(), [...expected].sort(), msg);
}

// ── F1: the defect itself ───────────────────────────────────────────────────

Deno.test("F1: a trashed message moved to a user label is un-trashed", () => {
  // The exact production state: email_delete left ["TRASH","SENT"], then the
  // move to Label_10 was asked for.
  const plan = gmailRelocationPlan(["TRASH", "SENT"], "Label_10");

  assertSameLabels(plan.addLabelIds, ["Label_10"]);
  assert(
    plan.removeLabelIds.includes("TRASH"),
    "TRASH must be removed: leaving it is the 30-day purge that loses the mail",
  );
  assertEquals(plan.restoredFromTrash, true);
  assertEquals(plan.destinationIsPendingDeletion, false);
});

Deno.test("F1: the semantics sentence states the un-trash, it does not imply it", () => {
  const plan = gmailRelocationPlan(["TRASH", "SENT"], "Label_10");
  const text = gmailRelocationSemantics(plan);

  assertStringIncludes(text, "TRASH");
  assertStringIncludes(text, "restored");
  // The old string claimed only "removed INBOX", which is what made the bug
  // invisible: it was accurate about the write and silent about the outcome.
  assert(
    !text.endsWith("any other labels remain unchanged.") ||
      text.includes("TRASH"),
    "the sentence must not read as the pre-fix 'INBOX only' wording",
  );
});

Deno.test("F1: other user labels survive the restore", () => {
  const plan = gmailRelocationPlan(
    ["TRASH", "SENT", "Label_7", "IMPORTANT"],
    "Label_10",
  );
  for (const kept of ["SENT", "Label_7", "IMPORTANT"]) {
    assert(
      !plan.removeLabelIds.includes(kept),
      `${kept} must not be removed by a move`,
    );
  }
});

// ── Moving INTO trash / spam must still trash / spam ────────────────────────

Deno.test("moving to the trash alias still trashes and does not self-cancel", () => {
  const plan = gmailRelocationPlan(["INBOX"], "TRASH");

  assertSameLabels(plan.addLabelIds, ["TRASH"]);
  assertSameLabels(plan.removeLabelIds, ["INBOX"]);
  assert(
    !plan.removeLabelIds.includes("TRASH"),
    "Gmail rejects add+remove of the same label with HTTP 400",
  );
  assertEquals(plan.destinationIsPendingDeletion, true);
  assertEquals(plan.restoredFromTrash, false);
});

Deno.test("a trashed message moved to trash stays trashed", () => {
  const plan = gmailRelocationPlan(["TRASH"], "TRASH");
  assertSameLabels(plan.addLabelIds, ["TRASH"]);
  assert(!plan.removeLabelIds.includes("TRASH"));
  assertEquals(plan.restoredFromTrash, false);
});

Deno.test("moving to spam leaves the pending-deletion labels alone", () => {
  const plan = gmailRelocationPlan(["INBOX"], "SPAM");
  assertSameLabels(plan.addLabelIds, ["SPAM"]);
  assertSameLabels(plan.removeLabelIds, ["INBOX"]);
  assertEquals(plan.destinationIsPendingDeletion, true);
});

Deno.test("the trash/spam destination check is case-insensitive", () => {
  // resolveFolderId returns the canonical upper-case id, but a caller passing a
  // raw provider id it typed itself must not fall through to user-label
  // treatment and get its own destination removed.
  const plan = gmailRelocationPlan(["INBOX"], "trash");
  assertEquals(plan.destinationIsPendingDeletion, true);
  assert(!plan.removeLabelIds.some((l) => l.toLowerCase() === "trash"));
});

// ── The ordinary case must not regress ──────────────────────────────────────

Deno.test("a normal inbox message moved to a user label loses INBOX only", () => {
  const plan = gmailRelocationPlan(["INBOX", "UNREAD", "Label_3"], "Label_10");

  assertSameLabels(plan.addLabelIds, ["Label_10"]);
  assert(plan.removeLabelIds.includes("INBOX"));
  assert(!plan.removeLabelIds.includes("UNREAD"));
  assert(!plan.removeLabelIds.includes("Label_3"));
  assertEquals(plan.restoredFromTrash, false);
  assertEquals(plan.restoredFromSpam, false);
  assertStringIncludes(
    gmailRelocationSemantics(plan),
    "was not in Trash or Spam",
  );
});

Deno.test("moving back into the inbox never adds and removes INBOX at once", () => {
  const plan = gmailRelocationPlan(["TRASH", "SENT"], "INBOX");

  assertSameLabels(plan.addLabelIds, ["INBOX"]);
  assert(
    !plan.removeLabelIds.includes("INBOX"),
    "add+remove of the same label is an HTTP 400 from Gmail",
  );
  // The inbox alias already un-trashed correctly in production because Gmail
  // does it implicitly; doing it explicitly makes the behaviour ours, testable,
  // and reportable rather than a provider side effect.
  assert(plan.removeLabelIds.includes("TRASH"));
  assertEquals(plan.restoredFromTrash, true);
});

// ── Spam ────────────────────────────────────────────────────────────────────

Deno.test("a spammed message moved to a user label is un-spammed", () => {
  const plan = gmailRelocationPlan(["SPAM"], "Label_10");

  assert(plan.removeLabelIds.includes("SPAM"));
  assertEquals(plan.restoredFromSpam, true);
  assertEquals(plan.restoredFromTrash, false);
  assertStringIncludes(gmailRelocationSemantics(plan), "SPAM");
});

Deno.test("a message in both trash and spam reports both restores", () => {
  const plan = gmailRelocationPlan(["TRASH", "SPAM"], "Label_10");
  assertEquals(plan.restoredFromTrash, true);
  assertEquals(plan.restoredFromSpam, true);
  const text = gmailRelocationSemantics(plan);
  assertStringIncludes(text, "TRASH");
  assertStringIncludes(text, "SPAM");
});

// ── Unknown current labels (the bulk paths) ─────────────────────────────────

Deno.test("unknown labels produce the SAME write as known ones", () => {
  // This is what lets the bulk paths skip a GET per message: the fix does not
  // depend on the pre-read, only the reporting does.
  const known = gmailRelocationPlan(["TRASH", "SENT"], "Label_10");
  const unknown = gmailRelocationPlan(null, "Label_10");

  assertSameLabels(unknown.addLabelIds, known.addLabelIds);
  assertSameLabels(unknown.removeLabelIds, known.removeLabelIds);
});

Deno.test("unknown labels report the restore as unknown, never as a guess", () => {
  const plan = gmailRelocationPlan(null, "Label_10");
  assertEquals(plan.restoredFromTrash, null);
  assertEquals(plan.restoredFromSpam, null);

  const text = gmailRelocationSemantics(plan);
  assertStringIncludes(text, "if either was set");
  assert(
    !text.includes("has been restored"),
    "must not claim a restore it did not verify",
  );
});

Deno.test("unknown labels into trash keep the pre-fix wording", () => {
  const plan = gmailRelocationPlan(null, "TRASH");
  assertSameLabels(plan.removeLabelIds, ["INBOX"]);
  assertEquals(
    gmailRelocationSemantics(plan),
    "Added the destination label and removed INBOX; any other labels remain unchanged.",
  );
});

// ── Archive (no destination) ────────────────────────────────────────────────

Deno.test("archiving a trashed message rescues it instead of no-opping", () => {
  // Pre-fix, "remove INBOX" on a trashed message changed nothing whatsoever and
  // still returned success — the same shape of silent loss as F1.
  const plan = gmailRelocationPlan(["TRASH", "SENT"], null);

  assertEquals(plan.addLabelIds, []);
  assertSameLabels(plan.removeLabelIds, ["INBOX", "TRASH", "SPAM"]);
  assertEquals(plan.restoredFromTrash, true);
  assertStringIncludes(gmailRelocationSemantics(plan), "All Mail");
});

Deno.test("archiving an ordinary inbox message is unchanged in effect", () => {
  const plan = gmailRelocationPlan(["INBOX", "UNREAD"], null);
  assertEquals(plan.addLabelIds, []);
  assert(plan.removeLabelIds.includes("INBOX"));
  assert(!plan.removeLabelIds.includes("UNREAD"));
  assertEquals(plan.restoredFromTrash, false);
});

// ── Structural invariant ────────────────────────────────────────────────────

Deno.test("add and remove sets never intersect, for any destination", () => {
  const destinations = ["Label_10", "INBOX", "TRASH", "SPAM", "SENT", "trash", null];
  const states: (string[] | null)[] = [
    null,
    [],
    ["INBOX"],
    ["TRASH", "SENT"],
    ["SPAM"],
    ["TRASH", "SPAM", "Label_1"],
  ];
  for (const dest of destinations) {
    for (const state of states) {
      const plan = gmailRelocationPlan(state, dest);
      for (const add of plan.addLabelIds) {
        assert(
          !plan.removeLabelIds.some((r) => r.toLowerCase() === add.toLowerCase()),
          `dest=${dest} state=${JSON.stringify(state)} both adds and removes ${add}`,
        );
      }
    }
  }
});
