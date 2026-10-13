// ---------------------------------------------------------------------------
// draft{action:"send"}: what happens to the id it was handed (draft-send-plan.ts).
//
// Review of 2026-10-13, the findings these pin:
//   * a stale card's send followed the line to a newer revision and delivered
//     recipients the card never showed (finding 1);
//   * a draft whose line was closed by a send went out again on retry when the
//     IMAP post-send delete had failed (finding 3);
//   * a held send queued with an older id summarised as blank and failed after
//     approval as draft_not_found (finding 4).
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import { memoryLineageStore } from "./draft-lineage-fake.ts";
import {
  closeDraftLine,
  type DraftLineageScope,
  recordDraftWrite,
  resolveDraftId,
} from "./draft-lineage.ts";
import { planDraftSend } from "./draft-send-plan.ts";

const SCOPE: DraftLineageScope = { workspaceId: "ws-1", inboxId: "inbox-1" };

/** A line Drafts:1 -> Drafts:2 (an agent update on IMAP). */
async function movedLine() {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  await recordDraftWrite(store, SCOPE, {
    previous: await resolveDraftId(store, SCOPE, "Drafts:1"),
    draftId: "Drafts:2",
    writtenBy: "agent",
  });
  return store;
}

Deno.test("a model's send follows an older id to the current draft", async () => {
  const store = await movedLine();
  const args = { action: "send", draft_id: "Drafts:1", inbox_id: "inbox-1" };
  const plan = planDraftSend({
    args,
    line: await resolveDraftId(store, SCOPE, "Drafts:1"),
    baseRevision: null,
    approvalDispatch: false,
  });
  assertEquals(plan.kind, "proceed");
  if (plan.kind !== "proceed") return;
  assertEquals(plan.draftId, "Drafts:2");
});

Deno.test("two cards: the stale card's send is refused as draft_changed, by id or by revision", async () => {
  const store = await movedLine();
  // Card A holds Drafts:1 at revision 1; the model's update made Drafts:2 (revision 2).
  const stale = planDraftSend({
    args: { draft_id: "Drafts:1", base_revision: 1 },
    line: await resolveDraftId(store, SCOPE, "Drafts:1"),
    baseRevision: 1,
    approvalDispatch: false,
  });
  assertEquals(stale, { kind: "refuse", code: "draft_changed" });
  // Ids that never move: the right id, the wrong revision.
  const behind = planDraftSend({
    args: { draft_id: "Drafts:2", base_revision: 1 },
    line: await resolveDraftId(store, SCOPE, "Drafts:2"),
    baseRevision: 1,
    approvalDispatch: false,
  });
  assertEquals(behind, { kind: "refuse", code: "draft_changed" });
  // Card B, current on both counts, sends.
  const current = planDraftSend({
    args: { draft_id: "Drafts:2", base_revision: 2 },
    line: await resolveDraftId(store, SCOPE, "Drafts:2"),
    baseRevision: 2,
    approvalDispatch: false,
  });
  assertEquals(current.kind, "proceed");
});

Deno.test("a line closed by a send is never sent again, whoever asks", async () => {
  for (const how of ["sent", "sent_kept"] as const) {
    const { store } = memoryLineageStore();
    await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:5", writtenBy: "agent" });
    await closeDraftLine(store, SCOPE, await resolveDraftId(store, SCOPE, "Drafts:5"), how);
    const line = await resolveDraftId(store, SCOPE, "Drafts:5");
    for (const [baseRevision, approvalDispatch] of [[null, false], [1, false], [null, true]] as const) {
      const plan = planDraftSend({ args: { draft_id: "Drafts:5" }, line, baseRevision, approvalDispatch });
      assertEquals(plan, { kind: "refuse", code: "draft_already_sent", sentCopyKept: how === "sent_kept" });
    }
  }
});

Deno.test("a held send is queued with the resolved id, and an approved one keeps the id it was approved with", async () => {
  const store = await movedLine();
  const args = { draft_id: "Drafts:1", inbox_id: "inbox-1", idempotency_key: "k-1" };
  const held = planDraftSend({
    args,
    line: await resolveDraftId(store, SCOPE, "Drafts:1"),
    baseRevision: null,
    approvalDispatch: false,
  });
  assert(held.kind === "proceed");
  // With the revision it was queued at, so the re-run refuses a rewrite.
  assertEquals(held.approvalArgs, {
    draft_id: "Drafts:2",
    inbox_id: "inbox-1",
    idempotency_key: "k-1",
    base_revision: 2,
  });
  assertEquals(args.draft_id, "Drafts:1", "the caller's arguments are not mutated");

  // The dispatcher re-running an approval queued with Drafts:1 (an old queue,
  // or a draft rewritten since): it sends Drafts:1 or nothing.
  const approved = planDraftSend({
    args,
    line: await resolveDraftId(store, SCOPE, "Drafts:1"),
    baseRevision: null,
    approvalDispatch: true,
  });
  assert(approved.kind === "proceed");
  assertEquals([approved.draftId, approved.line.redirected], ["Drafts:1", false]);
});

Deno.test("index.ts sends through the plan, queues its approvalArgs and records a kept copy", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const send = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  assert(send.includes("planDraftSend({"), "the decision is the tested one");
  assert(send.includes("let approvalArgs: Record<string, unknown> = plan.approvalArgs;"));
  assert(!/approvalArgs[^=\n]*=\s*args;/.test(send), "never the caller's raw arguments");
  assert(send.includes('draftRemoved === false ? "sent_kept" : "sent"'));
  assert(send.includes("const { draft_removed: draftRemoved, ...sentPayload } = sendResult;"), "never in content");
});
