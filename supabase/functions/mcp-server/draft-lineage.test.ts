import { assertEquals } from "jsr:@std/assert@1";
import { memoryLineageStore } from "./draft-lineage-fake.ts";
import {
  cardWriteConflict,
  closeDraftLine,
  type DraftLineageScope,
  lastSaveOf,
  lineRevision,
  needsExistenceCheck,
  parseBaseRevision,
  preferExistingId,
  recordDraftWrite,
  resolveDraftId,
} from "./draft-lineage.ts";

const SCOPE: DraftLineageScope = { workspaceId: "ws-1", inboxId: "inbox-1" };
const quiet = () => {};

Deno.test("an id nobody recorded resolves to itself", async () => {
  const { store } = memoryLineageStore();
  const r = await resolveDraftId(store, SCOPE, "Drafts:1");
  assertEquals([r.draftId, r.known, r.redirected, r.closed], ["Drafts:1", false, false, null]);
});

Deno.test("every older id of a line resolves to the current one", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  let line = await resolveDraftId(store, SCOPE, "Drafts:1");
  await recordDraftWrite(store, SCOPE, { previous: line, draftId: "Drafts:2", writtenBy: "user" });
  line = await resolveDraftId(store, SCOPE, "Drafts:2");
  await recordDraftWrite(store, SCOPE, { previous: line, draftId: "Drafts:3", writtenBy: "user" });

  for (const stale of ["Drafts:1", "Drafts:2", "Drafts:3"]) {
    const r = await resolveDraftId(store, SCOPE, stale);
    assertEquals(r.draftId, "Drafts:3", stale);
    assertEquals(r.redirected, stale !== "Drafts:3");
    assertEquals([r.revision, r.writtenBy], [3, "user"]);
  }
});

Deno.test("a provider that keeps the id bumps one row instead of adding rows", async () => {
  const { store, rows } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "r-1", writtenBy: "agent" });
  const line = await resolveDraftId(store, SCOPE, "r-1");
  await recordDraftWrite(store, SCOPE, { previous: line, draftId: "r-1", writtenBy: "user" });
  assertEquals(rows.length, 1);
  const r = await resolveDraftId(store, SCOPE, "r-1");
  assertEquals([r.draftId, r.revision, r.writtenBy, r.redirected], ["r-1", 2, "user", false]);
});

Deno.test("rewriting a draft that had no line makes the old id resolve from then on", async () => {
  const { store } = memoryLineageStore();
  const before = await resolveDraftId(store, SCOPE, "Drafts:7");
  await recordDraftWrite(store, SCOPE, { previous: before, draftId: "Drafts:8", writtenBy: "user" });
  const r = await resolveDraftId(store, SCOPE, "Drafts:7");
  assertEquals([r.draftId, r.revision], ["Drafts:8", 2]);
});

Deno.test("another workspace or another inbox never resolves the id", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  const line = await resolveDraftId(store, SCOPE, "Drafts:1");
  await recordDraftWrite(store, SCOPE, { previous: line, draftId: "Drafts:2", writtenBy: "agent" });

  for (const other of [{ ...SCOPE, workspaceId: "ws-2" }, { ...SCOPE, inboxId: "inbox-2" }]) {
    const r = await resolveDraftId(store, other, "Drafts:1");
    assertEquals([r.draftId, r.known], ["Drafts:1", false]);
  }
});

Deno.test("a closed line is reported as closed and never redirected", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  let line = await resolveDraftId(store, SCOPE, "Drafts:1");
  await recordDraftWrite(store, SCOPE, { previous: line, draftId: "Drafts:2", writtenBy: "user" });
  line = await resolveDraftId(store, SCOPE, "Drafts:2");
  await closeDraftLine(store, SCOPE, line, "sent");

  for (const id of ["Drafts:1", "Drafts:2"]) {
    const r = await resolveDraftId(store, SCOPE, id);
    assertEquals([r.draftId, r.closed, r.redirected], [id, "sent", false]);
  }
});

Deno.test("closing a draft with no line still leaves a record of what happened", async () => {
  const { store } = memoryLineageStore();
  const line = await resolveDraftId(store, SCOPE, "Drafts:9");
  await closeDraftLine(store, SCOPE, line, "deleted");
  assertEquals((await resolveDraftId(store, SCOPE, "Drafts:9")).closed, "deleted");
});

Deno.test("a write after a close starts a new line and leaves the old one closed", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  const line = await resolveDraftId(store, SCOPE, "Drafts:1");
  await closeDraftLine(store, SCOPE, line, "sent");
  const closed = await resolveDraftId(store, SCOPE, "Drafts:1");
  await recordDraftWrite(store, SCOPE, { previous: closed, draftId: "Drafts:2", writtenBy: "agent" });
  assertEquals((await resolveDraftId(store, SCOPE, "Drafts:1")).closed, "sent");
  const fresh = await resolveDraftId(store, SCOPE, "Drafts:2");
  assertEquals([fresh.closed, fresh.revision], [null, 1]);
});

Deno.test("a failing store never throws and resolves the id to itself", async () => {
  const { store } = memoryLineageStore({ failing: true });
  const r = await resolveDraftId(store, SCOPE, "Drafts:1", quiet);
  assertEquals([r.draftId, r.known], ["Drafts:1", false]);
  await recordDraftWrite(store, SCOPE, { previous: r, draftId: "Drafts:2", writtenBy: "user" }, quiet);
  await closeDraftLine(store, SCOPE, r, "sent", undefined, quiet);
});

Deno.test("no store at all behaves like an unknown id", async () => {
  const r = await resolveDraftId(null, SCOPE, "Drafts:1");
  assertEquals(r.draftId, "Drafts:1");
  await recordDraftWrite(undefined, SCOPE, { previous: r, draftId: "Drafts:2", writtenBy: "user" });
});

Deno.test("lastSaveOf reports the recorded writer, not the time of the read", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, {
    previous: null,
    draftId: "r-1",
    writtenBy: "user",
    at: "2026-10-13T12:00:00.000Z",
  });
  const line = await resolveDraftId(store, SCOPE, "r-1");
  assertEquals(lastSaveOf(line, "2026-10-13T12:00:03.000Z"), {
    at: "2026-10-13T12:00:00.000Z",
    by: "user",
  });
  // The mailbox says it changed long after our last write: edited elsewhere.
  assertEquals(lastSaveOf(line, "2026-10-13T13:30:00.000Z"), {
    at: "2026-10-13T13:30:00.000Z",
    by: null,
  });
  // No line: the provider's time if there is one, and nobody is named.
  assertEquals(lastSaveOf(null, "2026-10-13T09:00:00Z"), { at: "2026-10-13T09:00:00.000Z", by: null });
  assertEquals(lastSaveOf(null, null), { at: null, by: null });
});

// ── Review of 2026-10-13 ────────────────────────────────────────────────────

Deno.test("recordDraftWrite answers with the revision it recorded, and null when it recorded nothing", async () => {
  const { store } = memoryLineageStore();
  assertEquals(await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" }), 1);
  const line = await resolveDraftId(store, SCOPE, "Drafts:1");
  assertEquals(await recordDraftWrite(store, SCOPE, { previous: line, draftId: "Drafts:2", writtenBy: "user" }), 2);
  // An id with no line, rewritten: the old id is seeded as 1.
  const loose = await resolveDraftId(store, SCOPE, "Drafts:7");
  assertEquals(await recordDraftWrite(store, SCOPE, { previous: loose, draftId: "Drafts:8", writtenBy: "user" }), 2);
  const failing = memoryLineageStore({ failing: true }).store;
  assertEquals(
    await recordDraftWrite(failing, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" }, quiet),
    null,
  );
  assertEquals(await recordDraftWrite(null, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" }), null);
});

Deno.test("a send that left its draft behind reads as sent, with the copy flagged", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  await closeDraftLine(store, SCOPE, await resolveDraftId(store, SCOPE, "Drafts:1"), "sent_kept");
  const r = await resolveDraftId(store, SCOPE, "Drafts:1");
  assertEquals([r.closed, r.sentCopyKept, r.redirected], ["sent", true, false]);
  await closeDraftLine(store, SCOPE, await resolveDraftId(store, SCOPE, "Drafts:1"), "sent");
  assertEquals((await resolveDraftId(store, SCOPE, "Drafts:1")).sentCopyKept, undefined);
});

Deno.test("preferExistingId: the mailbox wins where the lineage would name another message", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  await recordDraftWrite(store, SCOPE, {
    previous: await resolveDraftId(store, SCOPE, "Drafts:1"),
    draftId: "Drafts:2",
    writtenBy: "agent",
  });
  const stale = await resolveDraftId(store, SCOPE, "Drafts:1");
  const head = await resolveDraftId(store, SCOPE, "Drafts:2");
  assertEquals([needsExistenceCheck(stale), needsExistenceCheck(head)], [true, false]);
  // Gone, as IMAP leaves it after a save: follow the line.
  assertEquals(preferExistingId(stale, false).draftId, "Drafts:2");
  // Still there: a reused id, which is its own (unknown) draft.
  const reused = preferExistingId(stale, true);
  assertEquals([reused.draftId, reused.known, reused.redirected], ["Drafts:1", false, false]);
  // The head is the head either way.
  assertEquals(preferExistingId(head, true), head);

  for (const [how, staysClosed] of [["deleted", false], ["sent", false], ["sent_kept", true]] as const) {
    const s2 = memoryLineageStore().store;
    await recordDraftWrite(s2, SCOPE, { previous: null, draftId: "Drafts:9", writtenBy: "agent" });
    await closeDraftLine(s2, SCOPE, await resolveDraftId(s2, SCOPE, "Drafts:9"), how);
    const closed = await resolveDraftId(s2, SCOPE, "Drafts:9");
    assertEquals(preferExistingId(closed, false).closed !== null, true, `${how}, gone`);
    assertEquals(preferExistingId(closed, true).closed !== null, staysClosed, `${how}, there`);
  }
});

Deno.test("cardWriteConflict: an older id, or another revision, is a conflict; an unplaceable id never is", async () => {
  const { store } = memoryLineageStore();
  await recordDraftWrite(store, SCOPE, { previous: null, draftId: "Drafts:1", writtenBy: "agent" });
  await recordDraftWrite(store, SCOPE, {
    previous: await resolveDraftId(store, SCOPE, "Drafts:1"),
    draftId: "Drafts:2",
    writtenBy: "agent",
  });
  const stale = await resolveDraftId(store, SCOPE, "Drafts:1");
  const head = await resolveDraftId(store, SCOPE, "Drafts:2");
  assertEquals(cardWriteConflict(stale, null), true, "an older id, revision or not");
  assertEquals(cardWriteConflict(head, 2), false);
  assertEquals(cardWriteConflict(head, 1), true);
  assertEquals(cardWriteConflict(head, 0), true, "0 is 'no line when I loaded it'");
  assertEquals(cardWriteConflict(head, null), false, "no revision given, no revision check");
  const unknown = await resolveDraftId(store, SCOPE, "Drafts:99");
  assertEquals(cardWriteConflict(unknown, 5), false);
  assertEquals(lineRevision(head), 2);
  assertEquals(lineRevision(unknown), null);
  assertEquals([parseBaseRevision(undefined), parseBaseRevision(0), parseBaseRevision(3)], [null, 0, 3]);
  for (const bad of [-1, 1.5, "1", true, {}]) assertEquals(parseBaseRevision(bad), "invalid");
});
