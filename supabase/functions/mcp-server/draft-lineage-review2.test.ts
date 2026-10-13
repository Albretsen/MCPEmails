// ---------------------------------------------------------------------------
// Draft lineage, second review of 2026-10-13. Every test here runs the logic:
// the lineage functions over the in-memory store (draft-lineage-fake.ts, a
// transcription of `public.draft_lineage_record`), and the send rules in
// draft-send-plan.ts with the provider calls injected.
//
//   1. a send-time recipient rewrite is recorded even when the id does not
//      move (Gmail, Outlook), so a card at the old revision cannot Send to
//      recipients it never showed;
//   2. revisions are computed atomically: two writers that read the same head
//      no longer both get N+1, and the one recorded second learns it was
//      contended and is given no revision to vouch for;
//   4. a held send is queued with the revision it was queued at, so the
//      post-approval re-run refuses a rewritten draft on every provider;
//   6c. an IMAP id the server never confirmed (`Drafts:0`) is not recorded.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { memoryLineageStore } from "./draft-lineage-fake.ts";
import {
  cardWriteConflict,
  closeDraftLine,
  type DraftLineageScope,
  draftIdIsRecordable,
  draftLineageRecordedFrom,
  preferExistingId,
  recordDraftWrite,
  resolveDraftId,
  type ResolvedDraft,
} from "./draft-lineage.ts";
import {
  applyRecipientOverride,
  approvedSendRefusalDetail,
  heldSendArgs,
  planDraftSend,
} from "./draft-send-plan.ts";

const S: DraftLineageScope = { workspaceId: "ws-1", inboxId: "inbox-1" };
const quiet = () => {};

// ── 2. Atomic revisions ─────────────────────────────────────────────────────

Deno.test("stable id: two writers that read the same revision get distinct revisions, and the second is told it was contended", async () => {
  const { store, rows } = memoryLineageStore();
  await recordDraftWrite(store, S, { previous: null, draftId: "g1", writtenBy: "agent" }, quiet);
  // Both resolve before either records (the card's check, then the model's update).
  const cardSees = await resolveDraftId(store, S, "g1", quiet);
  const modelSees = await resolveDraftId(store, S, "g1", quiet);
  assertEquals(cardWriteConflict(cardSees, 1), false);
  // The provider took the card's write first and the model's second, so the
  // mailbox holds the model's content; the lineage hears the model first.
  const events: string[] = [];
  const modelRev = await recordDraftWrite(
    store,
    S,
    { previous: modelSees, draftId: "g1", writtenBy: "agent" },
    (e) => events.push(`model:${e}`),
  );
  const cardRev = await recordDraftWrite(
    store,
    S,
    { previous: cardSees, draftId: "g1", writtenBy: "user" },
    (e) => events.push(`card:${e}`),
  );
  assertEquals(modelRev, 2);
  assertEquals(cardRev, null, "the card is given no revision it could vouch for");
  assertEquals(events, ["card:draft_lineage_write_contended"]);
  // The row was still written, at a revision of its own.
  assertEquals(rows.map((r) => [r.draft_id, r.revision]), [["g1", 3]]);
  // The card falls back to the revision it loaded (1); the line is at 3, so
  // its Send is refused and it re-reads, instead of sending the model's text.
  const atSend = await resolveDraftId(store, S, "g1", quiet);
  assertEquals(cardWriteConflict(atSend, cardSees.revision), true);
  // And the model's own envelope (revision 2) is behind too.
  assertEquals(cardWriteConflict(atSend, modelRev), true);
});

Deno.test("IMAP: two writers from the same base never leave two heads at one revision", async () => {
  const { store, rows } = memoryLineageStore();
  await recordDraftWrite(store, S, { previous: null, draftId: "D:1", writtenBy: "agent" }, quiet);
  const a = await resolveDraftId(store, S, "D:1", quiet);
  const b = await resolveDraftId(store, S, "D:1", quiet);
  assertEquals(await recordDraftWrite(store, S, { previous: a, draftId: "D:2", writtenBy: "user" }, quiet), 2);
  assertEquals(await recordDraftWrite(store, S, { previous: b, draftId: "D:3", writtenBy: "agent" }, quiet), null);
  assertEquals(rows.map((r) => [r.draft_id, r.revision]), [["D:1", 1], ["D:2", 2], ["D:3", 3]]);
  // The writer that recorded first holds an id that is no longer the head:
  // its next card write is refused by id.
  const fromA = await resolveDraftId(store, S, "D:2", quiet);
  assertEquals([fromA.redirected, fromA.draftId], [true, "D:3"]);
  assertEquals(cardWriteConflict(fromA, 2), true);
});

Deno.test("sequential writers are never contended", async () => {
  const { store } = memoryLineageStore();
  let line: ResolvedDraft | null = null;
  for (let i = 1; i <= 4; i++) {
    const rev = await recordDraftWrite(store, S, { previous: line, draftId: "g1", writtenBy: "user" }, quiet);
    assertEquals(rev, i);
    line = await resolveDraftId(store, S, "g1", quiet);
  }
});

Deno.test("a line started by somebody else since the caller looked is continued, not restarted at 1", async () => {
  const { store, rows } = memoryLineageStore();
  // A Gmail draft with no line: both writers resolve it as unknown.
  const cardSees = await resolveDraftId(store, S, "g9", quiet);
  const modelSees = await resolveDraftId(store, S, "g9", quiet);
  assertEquals(await recordDraftWrite(store, S, { previous: modelSees, draftId: "g9", writtenBy: "agent" }, quiet), 1);
  // Before: the card's record replaced the row with a NEW line at revision 1,
  // so a card holding revision 1 of the first line still passed its check.
  assertEquals(await recordDraftWrite(store, S, { previous: cardSees, draftId: "g9", writtenBy: "user" }, quiet), null);
  assertEquals(rows.length, 1);
  const now = await resolveDraftId(store, S, "g9", quiet);
  assertEquals(now.revision, 2);
  assertEquals(cardWriteConflict(now, 1), true);
});

Deno.test("an older id that the mailbox gave to another draft is not adopted into its old line", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, S, { previous: null, draftId: "D:1", writtenBy: "agent" }, quiet);
  await recordDraftWrite(store, S, {
    previous: await resolveDraftId(store, S, "D:1", quiet),
    draftId: "D:2",
    writtenBy: "agent",
  }, quiet);
  // preferExistingId turned the redirect of D:1 into "unknown" (it names a
  // different message now); a write that keeps the id starts a fresh line.
  const reused = preferExistingId(await resolveDraftId(store, S, "D:1", quiet), true);
  assertEquals([reused.known, reused.draftId], [false, "D:1"]);
  assertEquals(await recordDraftWrite(store, S, { previous: reused, draftId: "D:1", writtenBy: "user" }, quiet), 1);
  const head = await resolveDraftId(store, S, "D:2", quiet);
  assertEquals([head.draftId, head.revision], ["D:2", 2], "the old line is untouched");
});

Deno.test("closing an id with no line closes a line somebody opened for it meanwhile", async () => {
  const { store } = memoryLineageStore();
  const stale = await resolveDraftId(store, S, "g5", quiet);
  await recordDraftWrite(store, S, { previous: null, draftId: "g5", writtenBy: "agent" }, quiet);
  await closeDraftLine(store, S, stale, "sent", undefined, quiet);
  assertEquals((await resolveDraftId(store, S, "g5", quiet)).closed, "sent");
});

Deno.test("the store's unique (inbox, line, revision) key refuses a second row at one revision", async () => {
  const { store } = memoryLineageStore();
  const first = await store.record(S, {
    lineId: null, expectedRevision: null, draftId: "D:1", seedDraftId: null, adopt: false,
    writtenBy: "agent", writtenAt: "2026-10-13T12:00:00Z",
  });
  // A record that names a line and the revision it saw continues it; it can
  // never produce the same revision twice because the store computes it.
  const a = await store.record(S, {
    lineId: first.lineId, expectedRevision: 1, draftId: "D:2", seedDraftId: null, adopt: false,
    writtenBy: "user", writtenAt: "2026-10-13T12:00:01Z",
  });
  const b = await store.record(S, {
    lineId: first.lineId, expectedRevision: 1, draftId: "D:3", seedDraftId: null, adopt: false,
    writtenBy: "agent", writtenAt: "2026-10-13T12:00:02Z",
  });
  assertEquals([a.revision, a.contended, b.revision, b.contended], [2, false, 3, true]);
});

Deno.test("a database without draft_lineage_record fails soft: nothing recorded, nothing thrown", async () => {
  const { store } = memoryLineageStore({ failing: true });
  const events: string[] = [];
  const rev = await recordDraftWrite(store, S, { previous: null, draftId: "g1", writtenBy: "agent" }, (e) => events.push(e));
  assertEquals([rev, events], [null, ["draft_lineage_write_failed"]]);
});

Deno.test("the RPC answer is read strictly", () => {
  assertEquals(
    draftLineageRecordedFrom([{ recorded_line_id: "l-1", recorded_revision: 3, contended: false }]),
    { lineId: "l-1", revision: 3, contended: false },
  );
  assertEquals(
    draftLineageRecordedFrom({ recorded_line_id: "l-1", recorded_revision: 1, contended: true }).contended,
    true,
  );
  for (const bad of [null, [], [{}], [{ recorded_line_id: "l", recorded_revision: 0, contended: false }], [{ recorded_line_id: "l", recorded_revision: 2 }]]) {
    assertThrows(() => draftLineageRecordedFrom(bad));
  }
});

// ── 6c. Unconfirmed IMAP ids ─────────────────────────────────────────────────

Deno.test("an IMAP id the server never confirmed is not recordable", () => {
  assertEquals(draftIdIsRecordable("imap", "Drafts:0"), false);
  assertEquals(draftIdIsRecordable("imap", "INBOX.Drafts:0"), false);
  assertEquals(draftIdIsRecordable("imap", "Drafts:"), false);
  assertEquals(draftIdIsRecordable("imap", ""), false);
  assertEquals(draftIdIsRecordable("imap", "Drafts:41"), true);
  assertEquals(draftIdIsRecordable("fastmail", "Drafts:7"), true);
  assertEquals(draftIdIsRecordable("gmail", "r-0"), true);
  assertEquals(draftIdIsRecordable("outlook", "AAMkAG:0"), true);
});

// ── 1. A send-time recipient rewrite moves the revision ─────────────────────

/** A Gmail-like mailbox: ids never move. `rewrites` counts provider writes. */
async function gmailLine() {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, S, { previous: null, draftId: "g1", writtenBy: "agent" }, quiet);
  return store;
}

Deno.test("Gmail: a model send with a recipient override bumps the revision, so the card at the old one cannot Send", async () => {
  const store = await gmailLine();
  // The card mounted at revision 1.
  const cardBase = (await resolveDraftId(store, S, "g1", quiet)).revision;
  assertEquals(cardBase, 1);

  // The model sends with `to` set: the plan proceeds, the override is applied.
  const args = { action: "send", draft_id: "g1", to: ["new@x.com"], idempotency_key: "k" };
  const plan = planDraftSend({ args, line: await resolveDraftId(store, S, "g1", quiet), baseRevision: null, approvalDispatch: false });
  assert(plan.kind === "proceed");
  let rewrites = 0;
  const applied = await applyRecipientOverride(
    { args, draftId: plan.draftId, line: plan.line, baseRevision: null },
    {
      rewrite: (id) => {
        rewrites++;
        return Promise.resolve(id); // the id does not move
      },
      record: (previous, id) => recordDraftWrite(store, S, { previous, draftId: id, writtenBy: "agent" }, quiet),
      resolve: (id) => resolveDraftId(store, S, id, quiet),
    },
  );
  assertEquals(rewrites, 1);
  assertEquals([applied.draftId, applied.line.revision], ["g1", 2], "recorded although the id did not move");
  // Queued without the override, with the revision it now has.
  assertEquals(applied.approvalArgs, { action: "send", draft_id: "g1", idempotency_key: "k", base_revision: 2 });

  // The send is then held (or fails). The card, still at revision 1, presses Send.
  const cardSend = planDraftSend({
    args: { draft_id: "g1", base_revision: cardBase },
    line: await resolveDraftId(store, S, "g1", quiet),
    baseRevision: cardBase,
    approvalDispatch: false,
  });
  assertEquals(cardSend, { kind: "refuse", code: "draft_changed" });
});

Deno.test("IMAP: the rewritten id is recorded and the id the caller held keeps resolving", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, S, { previous: null, draftId: "Drafts:1", writtenBy: "agent" }, quiet);
  const line = await resolveDraftId(store, S, "Drafts:1", quiet);
  const applied = await applyRecipientOverride(
    { args: { draft_id: "Drafts:1", cc: ["c@x.com"] }, draftId: "Drafts:1", line, baseRevision: null },
    {
      rewrite: () => Promise.resolve("Drafts:2"),
      record: (previous, id) => recordDraftWrite(store, S, { previous, draftId: id, writtenBy: "agent" }, quiet),
      resolve: (id) => resolveDraftId(store, S, id, quiet),
    },
  );
  assertEquals(applied.approvalArgs, { draft_id: "Drafts:2", base_revision: 2 });
  assertEquals((await resolveDraftId(store, S, "Drafts:1", quiet)).draftId, "Drafts:2");
});

Deno.test("a rewrite that fails records nothing and says so by throwing", async () => {
  const store = await gmailLine();
  let recorded = 0;
  await assertRejects(() =>
    applyRecipientOverride(
      { args: { draft_id: "g1", to: ["a@x.com"] }, draftId: "g1", line: { requestedId: "g1", draftId: "g1", redirected: false, known: true, lineId: "x", revision: 1, writtenBy: "agent", writtenAt: null, closed: null }, baseRevision: null },
      {
        rewrite: () => Promise.reject(new Error("draft_not_found")),
        record: () => {
          recorded++;
          return Promise.resolve(2);
        },
        resolve: (id) => resolveDraftId(store, S, id, quiet),
      },
    ), Error, "draft_not_found");
  assertEquals(recorded, 0);
});

// ── 4. Approved held sends refuse a rewritten draft ─────────────────────────

Deno.test("Gmail: a model send queued at revision 1 is refused after approval when the draft was rewritten", async () => {
  const store = await gmailLine();
  const args = { action: "send", draft_id: "g1", idempotency_key: "k" };
  const queued = planDraftSend({ args, line: await resolveDraftId(store, S, "g1", quiet), baseRevision: null, approvalDispatch: false });
  assert(queued.kind === "proceed");
  assertEquals(queued.approvalArgs.base_revision, 1);

  // While the approval waits, the draft is rewritten in place.
  await recordDraftWrite(store, S, { previous: await resolveDraftId(store, S, "g1", quiet), draftId: "g1", writtenBy: "user" }, quiet);

  // The dispatcher re-runs exactly the queued arguments.
  const rerun = planDraftSend({
    args: queued.approvalArgs,
    line: await resolveDraftId(store, S, "g1", quiet),
    baseRevision: queued.approvalArgs.base_revision as number,
    approvalDispatch: true,
  });
  assertEquals(rerun, { kind: "refuse", code: "draft_changed" });
  // And the approver is told why, in plain words.
  const detail = approvedSendRefusalDetail("draft_send", "draft_changed")!;
  assert(/changed after this send was approved/.test(detail));
  assert(!/draft_changed|base_revision/.test(detail));
});

Deno.test("an untouched draft is sent after approval", async () => {
  const store = await gmailLine();
  const queued = planDraftSend({ args: { draft_id: "g1" }, line: await resolveDraftId(store, S, "g1", quiet), baseRevision: null, approvalDispatch: false });
  assert(queued.kind === "proceed");
  const rerun = planDraftSend({
    args: queued.approvalArgs,
    line: await resolveDraftId(store, S, "g1", quiet),
    baseRevision: queued.approvalArgs.base_revision as number,
    approvalDispatch: true,
  });
  assertEquals(rerun.kind, "proceed");
});

Deno.test("a draft with no line is queued at 0: a write after queueing refuses the re-run, none lets it through", async () => {
  const { store } = memoryLineageStore();
  const queued = planDraftSend({ args: { draft_id: "g7" }, line: await resolveDraftId(store, S, "g7", quiet), baseRevision: null, approvalDispatch: false });
  assert(queued.kind === "proceed");
  assertEquals(queued.approvalArgs.base_revision, 0);
  const untouched = planDraftSend({ args: queued.approvalArgs, line: await resolveDraftId(store, S, "g7", quiet), baseRevision: 0, approvalDispatch: true });
  assertEquals(untouched.kind, "proceed");
  await recordDraftWrite(store, S, { previous: await resolveDraftId(store, S, "g7", quiet), draftId: "g7", writtenBy: "agent" }, quiet);
  const rewritten = planDraftSend({ args: queued.approvalArgs, line: await resolveDraftId(store, S, "g7", quiet), baseRevision: 0, approvalDispatch: true });
  assertEquals(rewritten, { kind: "refuse", code: "draft_changed" });
});

Deno.test("heldSendArgs: the caller's own base_revision is kept when no line answers", () => {
  const unknown: ResolvedDraft = { requestedId: "g1", draftId: "g1", redirected: false, known: false, lineId: null, revision: 0, writtenBy: null, writtenAt: null, closed: null };
  assertEquals(heldSendArgs({ draft_id: "g1", base_revision: 4 }, "g1", unknown, 4, false).base_revision, 4);
  assertEquals(heldSendArgs({ draft_id: "g1" }, "g1", unknown, null, false).base_revision, 0);
  const args = { draft_id: "g1", to: ["a@x.com"], bcc: ["b@x.com"] };
  const out = heldSendArgs(args, "g2", unknown, null, true);
  assertEquals(out, { draft_id: "g2", base_revision: 0 });
  assertEquals(args.to, ["a@x.com"], "the caller's arguments are not mutated");
});

Deno.test("approvedSendRefusalDetail: only draft sends, only the lineage codes", () => {
  assertEquals(approvedSendRefusalDetail("email_send", "draft_changed"), null);
  assertEquals(approvedSendRefusalDetail("draft_send", "provider_error"), null);
  assertEquals(approvedSendRefusalDetail("draft_send", null), null);
  assert(/already been sent/.test(approvedSendRefusalDetail("draft_send", "draft_already_sent")!));
  assert(/changed or removed/.test(approvedSendRefusalDetail("draft_send", "draft_not_found")!));
});

Deno.test("index.ts wires the tested helpers into the send path and the dispatcher", async () => {
  // The only textual check: index.ts cannot be imported by a test (it serves
  // on load), so this pins that the logic tested above is the logic it runs.
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const send = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  assert(send.includes("await applyRecipientOverride("));
  assert(!send.includes("rewrittenId !== draftId"), "no path skips the record when the id did not move");
  assert(src.includes("approvedSendRefusalDetail(approval.operation, dispatchedResult.logErrorCode)"));
  assert(src.includes('supabase.rpc("draft_lineage_record"'));
});
