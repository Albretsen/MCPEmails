// Tests for the bulk result card with Undo (mcp-app-undo.ts) and for how
// bulk_execute runs and words an Undo row (mcp-app-bulk.ts, scope_kind 'undo').
// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type BulkCaller, type BulkDeps, type BulkExecutionRequest, runBulkExecute } from "./mcp-app-bulk.ts";
import {
  BULK_SAMPLE_META_KEY,
  BULK_UNDO_TTL_MS,
  type BulkCardInput,
  buildBulkResultCard,
  bulkResultWords,
  folderLabel,
  undoTarget,
} from "./mcp-app-undo.ts";

type Row = Record<string, any>;
let ids = 0;
const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++ids).padStart(12, "0")}`;

/** Just enough of the supabase-js chain for these two modules. */
function fakeDb(store: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = store[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "insert" | "update" | "delete" = "select";
      let patch: Row = {};
      const run = () => {
        if (op === "insert") {
          const row = { id: uuid(), ...patch };
          rows.push(row);
          return { data: row, error: null };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") hit.forEach((r) => Object.assign(r, patch));
        if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { data: hit[0] ?? null, error: null };
      };
      const q: any = {
        select: () => q,
        insert: (r: Row) => ((op = "insert"), (patch = r), q),
        update: (r: Row) => ((op = "update"), (patch = r), q),
        delete: () => ((op = "delete"), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        lt: (c: string, v: string) => (filters.push((r) => r[c] < v), q),
        maybeSingle: () => Promise.resolve(run()),
        then: (a: any, b: any) => Promise.resolve(run()).then(a, b),
      };
      return q;
    },
  };
}

const NOW = Date.parse("2026-10-27T12:00:00Z");

function setup(opts: { execute?: (r: BulkExecutionRequest) => { succeeded: number; failed: number; error_code?: string } } = {}) {
  const store: Record<string, Row[]> = {};
  const calls: BulkExecutionRequest[] = [];
  let now = NOW;
  const deps: BulkDeps = {
    db: fakeDb(store),
    encrypt: (s) => Promise.resolve(btoa(unescape(encodeURIComponent(s)))),
    decrypt: (s) => Promise.resolve(decodeURIComponent(escape(atob(s)))),
    compatibility: () => ({ operations: {}, notes: [] }),
    execute: (r) => {
      calls.push(r);
      return Promise.resolve(opts.execute?.(r) ?? { succeeded: r.message_ids.length, failed: 0, error_code: null });
    },
    appUrl: "https://app.example",
    now: () => now,
  };
  return { store, calls, deps, tick: (ms: number) => (now += ms) };
}

const caller: BulkCaller = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  name: "key",
  inbox_ids: null,
  scopes: ["read:email", "manage:folders", "delete:email"],
};

function moveInput(over: Partial<BulkCardInput> = {}): BulkCardInput {
  return {
    action: "search_and_move",
    inbox: { id: "33333333-3333-4333-8333-333333333333", provider: "imap" },
    requested: 3,
    succeeded: ["INBOX:1", "INBOX:2", "INBOX:3"],
    failed: 0,
    newIds: { "INBOX:1": "Archive:11", "INBOX:2": "Archive:12", "INBOX:3": "Archive:13" },
    permanent: false,
    destination: "INBOX.Archive",
    stopped: false,
    sample: [{ from: "news@example.com", subject: "Weekly", date: "2026-10-26T10:00:00Z" }],
    ...over,
  };
}

Deno.test("headline: one line, from and to, in plain words", () => {
  assertEquals(bulkResultWords(moveInput()).headline, "Moved 3 messages from Inbox to Archive");
  assertEquals(
    bulkResultWords(moveInput({ action: "delete_batch", destination: null })).headline,
    "Moved 3 messages from Inbox to Trash",
  );
  const perm = bulkResultWords(moveInput({ action: "delete_batch", permanent: true, destination: null }));
  assertEquals(perm.headline, "Deleted 3 messages from Inbox permanently");
  assert(perm.detail.includes("cannot be undone"));
  assertEquals(bulkResultWords(moveInput({ requested: 0, succeeded: [] })).headline, "No messages matched. Nothing was moved.");
  const partial = bulkResultWords(moveInput({ requested: 5, failed: 2 }));
  assertEquals(partial.headline, "Moved 3 of 5 messages from Inbox to Archive");
  assert(partial.detail.startsWith("2 messages could not be moved."));
  assertEquals(folderLabel("INBOX.Receipts"), "Receipts");
});

Deno.test("Undo is offered only when it can be exact", () => {
  assertEquals(undoTarget(moveInput(), caller.scopes), { ids: ["Archive:11", "Archive:12", "Archive:13"], back: "INBOX" });
  // Not IMAP, permanent, no manage:folders, several source folders: no Undo.
  assertEquals(undoTarget(moveInput({ inbox: { id: "x", provider: "gmail" } }), caller.scopes), null);
  assertEquals(undoTarget(moveInput({ permanent: true }), caller.scopes), null);
  assertEquals(undoTarget(moveInput(), ["delete:email"]), null);
  assertEquals(
    undoTarget(moveInput({ succeeded: ["INBOX:1", "Work:2"], newIds: { "INBOX:1": "Archive:11", "Work:2": "Archive:12" } }), caller.scopes),
    null,
  );
  // A message whose new id was not reported is left alone; one that kept its
  // folder (a Gmail All Mail relocation) has nowhere to go back to.
  assertEquals(
    undoTarget(moveInput({ newIds: { "INBOX:1": "Archive:11", "INBOX:2": "INBOX:2" } }), caller.scopes),
    { ids: ["Archive:11"], back: "INBOX" },
  );
});

Deno.test("the card: receipt envelope with an undo id, sample in _meta, a 24 h undo plan row", async () => {
  const { store, deps } = setup();
  const card = await buildBulkResultCard(deps, caller, moveInput());
  const env = card.envelope as any;
  assertEquals(env.card, "receipt");
  assertEquals(env.receipt.headline, "Moved 3 messages from Inbox to Archive");
  assert(typeof env.undo.undo_id === "string");
  assertEquals(env.undo.expires_at, new Date(NOW + BULK_UNDO_TTL_MS).toISOString());
  // The sample is card-only; the envelope (structuredContent) carries none.
  assert(!JSON.stringify(env).includes("Weekly"));
  assertEquals((card.meta as any)[BULK_SAMPLE_META_KEY], [{ from: "news@example.com", subject: "Weekly" }]);

  const row = store.bulk_plans[0];
  assertEquals(row.id, env.undo.undo_id);
  assertEquals([row.action, row.scope_kind, row.status, row.match_count], ["move_batch", "undo", "pending", 3]);
  assertEquals(row.api_key_id, caller.id);
  assertEquals(row.workspace_id, caller.workspace_id);
  // Encrypted, and holds ids and the folder only.
  assert(!JSON.stringify(row.scope).includes("Archive:11"));
  const scope = JSON.parse(await deps.decrypt(row.scope.data));
  assertEquals(scope.message_ids, ["Archive:11", "Archive:12", "Archive:13"]);
  assertEquals(scope.destination_id, "INBOX");
});

Deno.test("no button, and no row, when Undo cannot be offered", async () => {
  for (const input of [moveInput({ permanent: true, action: "delete_batch" }), moveInput({ inbox: { id: "x", provider: "outlook" } })]) {
    const { store, deps } = setup();
    const card = await buildBulkResultCard(deps, caller, input);
    assertEquals((card.envelope as any).undo, undefined);
    assertEquals(store.bulk_plans ?? [], []);
  }
  // Zero matches: a one-line receipt, no sample.
  const { deps } = setup();
  const empty = await buildBulkResultCard(deps, caller, moveInput({ requested: 0, succeeded: [], newIds: {} }));
  assertEquals((empty.envelope as any).receipt.outcome, "executed");
  assertEquals(empty.meta, null);
});

Deno.test("a failed insert still renders the card, without Undo", async () => {
  const { deps } = setup();
  deps.db = { from: () => ({ insert: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: "x" } }) }) }) }) };
  const card = await buildBulkResultCard(deps, caller, moveInput());
  assertEquals((card.envelope as any).undo, undefined);
  assertEquals((card.envelope as any).receipt.headline, "Moved 3 messages from Inbox to Archive");
});

Deno.test("bulk_execute runs an Undo once, back to the source folder, and says Undone", async () => {
  const { calls, deps } = setup();
  const card = await buildBulkResultCard(deps, caller, moveInput());
  const undoId = (card.envelope as any).undo.undo_id;

  const first = await runBulkExecute(deps, caller, { plan_id: undoId });
  assertEquals(first.result.isError, false);
  const receipt = (first.result.structuredContent as any).receipt;
  assertEquals(receipt.headline, "Undone. 3 messages moved back to Inbox.");
  assertEquals((first.result.structuredContent as any).undo, undefined);
  assertEquals(calls, [{
    inbox_id: "33333333-3333-4333-8333-333333333333",
    action: "move_batch",
    message_ids: ["Archive:11", "Archive:12", "Archive:13"],
    destination_id: "INBOX",
    permanent: false,
  }]);

  const again = await runBulkExecute(deps, caller, { plan_id: undoId });
  assertEquals((again.result.structuredContent as any).receipt.headline, "Already undone.");
  assertEquals(calls.length, 1, "a second Undo moves nothing");
});

Deno.test("an Undo expires after 24 hours and says so plainly", async () => {
  const { calls, deps, tick } = setup();
  const card = await buildBulkResultCard(deps, caller, moveInput());
  tick(BULK_UNDO_TTL_MS + 1);
  const late = await runBulkExecute(deps, caller, { plan_id: (card.envelope as any).undo.undo_id });
  assertEquals((late.result.structuredContent as any).receipt.headline, "Undo expired.");
  assertEquals(calls.length, 0);
});

Deno.test("another workspace, another inbox allowlist, or a key without manage:folders cannot run it", async () => {
  const { calls, deps } = setup();
  const card = await buildBulkResultCard(deps, caller, moveInput());
  const undoId = (card.envelope as any).undo.undo_id;
  const foreign = await runBulkExecute(deps, { ...caller, workspace_id: "44444444-4444-4444-8444-444444444444" }, { plan_id: undoId });
  assertEquals(foreign.result.isError, true);
  const fenced = await runBulkExecute(deps, { ...caller, inbox_ids: ["55555555-5555-4555-8555-555555555555"] }, { plan_id: undoId });
  assertEquals(fenced.result.isError, true);
  const deleteOnly = await runBulkExecute(deps, { ...caller, scopes: ["delete:email"] }, { plan_id: undoId });
  assertEquals(deleteOnly.result.isError, true);
  assertEquals(calls.length, 0);
});

Deno.test("an Undo whose messages all moved again since says nothing was moved", async () => {
  const { deps } = setup({ execute: (r) => ({ succeeded: 0, failed: r.message_ids.length, error_code: "message_not_found" }) });
  const card = await buildBulkResultCard(deps, caller, moveInput());
  const res = await runBulkExecute(deps, caller, { plan_id: (card.envelope as any).undo.undo_id });
  const receipt = (res.result.structuredContent as any).receipt;
  assertEquals(receipt.headline, "Nothing to undo.");
  assert(receipt.detail.includes("nothing was moved back"));
});
