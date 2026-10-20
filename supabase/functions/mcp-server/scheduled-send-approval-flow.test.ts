// ---------------------------------------------------------------------------
// A scheduled send held for review, end to end: schedule_create on an inbox
// with send_approval_required, the approval a human grants, and what the
// scheduled-send dispatcher does with it when it falls due.
//
// ── THE BUG (fixed 2026-10-20) ─────────────────────────────────────────────
// The held schedule_create stores the message in the approval's encrypted
// payload and the time in send_approvals.send_at only. Approving it
// (apps/web/src/lib/approvals/decide.ts) inserts a `{ approval_id }` marker
// due at that time. The dispatcher then RE-RAN executeScheduleSend with the
// payload, which has no send_at (and whose time is no longer in the future
// anyway), so it refused with -32602, the marker went to 'error' and the
// approved message was never sent.
//
// Now an approved schedule_create is sent as-is by the plain scheduled-send
// path, still behind every gate of the marker path (tenancy, expiry, the
// single-use binding, the originating key).
//
// Real executor, real dispatcher, real approved-operation path, real crypto.
// Only the provider send is stubbed and PostgREST faked. Every address is a
// reserved example domain.
//
// Run: HOST_GUARD_SKIP_NETWORK_TESTS=1 deno test --node-modules-dir=none \
//        --allow-read --allow-env --allow-run=git \
//        supabase/functions/mcp-server/scheduled-send-approval-flow.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";

// The harness has already imported index.ts against its fake network; this is
// the same module instance.
const server = await import("./index.ts");

type Row = Record<string, unknown>;

const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba";
const SEND_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_INBOX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MESSAGE = {
  to: ["partner@example.com"],
  cc: ["team@example.com"],
  subject: "Quarterly notes",
  body: "See you Thursday.",
};

/** AES-GCM decrypt of the server's storage format, with the harness's key. */
async function decryptStored(ciphertext: string): Promise<Row> {
  const keyHex = "5a".repeat(32);
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const bin = atob(ciphertext.replace(/-/g, "+").replace(/_/g, "/"));
  const all = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), tagLength: 128 }, key, all.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** A Supabase client for the dispatcher: applies eq/is/lt/lte, mutates on update. */
function recordingClient(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const eq: Array<[string, unknown]> = [];
    const is: Array<[string, unknown]> = [];
    const lt: Array<[string, unknown]> = [];
    const lte: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    const settle = () => {
      const rows = (tables[table] ?? []).filter((row) =>
        eq.every(([c, v]) => row[c] === v) && is.every(([c, v]) => (row[c] ?? null) === v) &&
        lt.every(([c, v]) => String(row[c]) < String(v)) && lte.every(([c, v]) => String(row[c]) <= String(v))
      );
      if (patch) for (const row of rows) Object.assign(row, patch);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      update: (p: Row) => {
        patch = p;
        return builder;
      },
      eq: (c: string, v: unknown) => (eq.push([c, v]), builder),
      is: (c: string, v: unknown) => (is.push([c, v]), builder),
      lt: (c: string, v: unknown) => (lt.push([c, v]), builder),
      lte: (c: string, v: unknown) => (lte.push([c, v]), builder),
      order: () => builder,
      limit: () => builder,
      single: () => {
        const { data } = settle();
        return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: "no rows" } });
      },
      maybeSingle: () => Promise.resolve({ data: settle().data[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(settle()).then(resolve, reject),
    };
    return builder;
  };
  return { from };
}

async function approvalInbox(): Promise<Row> {
  return await harness.inboxRow("gmail", { send_approval_required: true });
}

/**
 * schedule_create through the real executor on an inbox that holds sends. The
 * harness's PostgREST answers the insert with no row, so the tool reports the
 * queue unavailable; what matters is the row the server WROTE.
 */
async function holdScheduledSend(sendAt: string) {
  const { world } = await harness.runTool(await approvalInbox(), () => harness.json({}, 404), () =>
    server.dispatchExecutor(
      "schedule_create",
      { inbox_id: harness.INBOX_ID, ...MESSAGE, send_at: sendAt },
      harness.API_KEY,
    ));
  const insert = world.db.find((c) => c.method === "POST" && c.target === "send_approvals");
  assert(insert, "an approval row was written");
  return insert.body as Row;
}

/** What decide.ts writes on approve: the approval flips, a marker is due at its send_at. */
function approve(written: Row, keyOverrides: Row = {}): Record<string, Row[]> {
  return {
    send_approvals: [{
      ...written,
      id: APPROVAL_ID,
      status: "approved",
      decided_at: new Date().toISOString(),
      dispatch_scheduled_send_id: null,
    }],
    scheduled_sends: [marker(SEND_A, String(written.send_at))],
    api_keys: [{ ...harness.API_KEY, deleted_at: null, ...keyOverrides }],
  };
}

function marker(id: string, sendAt: string): Row {
  return {
    id,
    workspace_id: harness.WORKSPACE,
    inbox_id: harness.INBOX_ID,
    payload: { approval_id: APPROVAL_ID },
    payload_encrypted: false,
    send_at: sendAt,
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    sent_at: null,
    error_detail: null,
  };
}

interface Recorded {
  sent: Array<{ inbox: Row; params: Row }>;
  completed: Array<[string, string, string | null]>;
}

/** Run the dispatcher once with the REAL runApprovedOperation and a stubbed provider. */
async function dispatch(tables: Record<string, Row[]>, rec: Recorded, sendFails = false) {
  const inbox = await approvalInbox();
  tables.inboxes = [{ ...inbox, deleted_at: null }];
  const deps = {
    ...server.DEFAULT_SCHEDULED_DISPATCH_DEPS,
    sendViaProvider(inboxRow: Row, params: Row) {
      rec.sent.push({ inbox: inboxRow, params });
      if (sendFails) return Promise.reject(new Error("connection reset after DATA"));
      return Promise.resolve({ message_id: "<m@example.com>", sent_at: new Date().toISOString() });
    },
    completeApprovedIdempotency(id: string, status: string, code: string | null) {
      rec.completed.push([id, status, code]);
      return Promise.resolve();
    },
  };
  const { value } = await harness.runTool(inbox, () => harness.json({}, 404), async () => {
    // deno-lint-ignore no-explicit-any
    const response = await server.handleScheduledDispatch(recordingClient(tables) as any, deps as any);
    return await response.json();
  });
  return value as { dispatched: number; errored: number; deferred?: number };
}

function row(tables: Record<string, Row[]>, id: string): Row {
  const found = tables.scheduled_sends.find((r) => r.id === id);
  assert(found, `scheduled_sends row ${id} missing`);
  return found;
}

/** Schedule ~1s out, then wait until it is due, so the marker carries the real held time. */
async function heldAndDue(): Promise<Row> {
  const sendAt = new Date(Date.now() + 1_000).toISOString();
  const written = await holdScheduledSend(sendAt);
  const wait = Date.parse(sendAt) - Date.now() + 20;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return written;
}

Deno.test("held schedule_create: the time is on the approval, not in its payload", async () => {
  const sendAt = new Date(Date.now() + 3_600_000).toISOString();
  const written = await holdScheduledSend(sendAt);
  assertEquals(written.operation, "schedule_create");
  assertEquals(written.send_at, sendAt);
  const payload = await decryptStored(String((written.payload as Row).data));
  assertEquals(payload.to, MESSAGE.to);
  assertEquals(payload.subject, MESSAGE.subject);
  assert(!("send_at" in payload), "send_at lives only on send_approvals");
});

Deno.test("approved schedule_create: sent once at its time, marker 'sent', idempotency settled", async () => {
  const tables = approve(await heldAndDue());
  const rec: Recorded = { sent: [], completed: [] };
  const summary = await dispatch(tables, rec);

  assertEquals(row(tables, SEND_A).error_detail, null, "no refusal recorded");
  assertEquals(summary.dispatched, 1);
  assertEquals(rec.sent.length, 1, "exactly one provider send");
  const params = rec.sent[0].params;
  assertEquals(params.to, MESSAGE.to);
  assertEquals(params.cc, MESSAGE.cc);
  assertEquals(params.bcc, []);
  assertEquals(params.subject, MESSAGE.subject);
  assertEquals(params.textBody, MESSAGE.body);
  assertEquals(rec.sent[0].inbox.id, harness.INBOX_ID);
  assertEquals(row(tables, SEND_A).status, "sent");
  assert(row(tables, SEND_A).sent_at);
  assertEquals(tables.send_approvals[0].dispatch_scheduled_send_id, SEND_A);
  assertEquals(tables.send_approvals[0].status, "approved");
  assertEquals(rec.completed, [[APPROVAL_ID, "success", null]]);
});

Deno.test("a second dispatch of the same approved schedule sends nothing", async () => {
  const written = await heldAndDue();
  const tables = approve(written);
  const rec: Recorded = { sent: [], completed: [] };
  await dispatch(tables, rec);
  assertEquals(rec.sent.length, 1);

  // The same tick again: the marker is 'sent', so nothing is picked up.
  const again = await dispatch(tables, rec);
  assertEquals(again.dispatched, 0);
  assertEquals(rec.sent.length, 1);

  // A second marker for the same approval is refused by the single-use binding.
  tables.scheduled_sends.push(marker(SEND_B, String(written.send_at)));
  const replay = await dispatch(tables, rec);
  assertEquals(replay.dispatched, 0);
  assertEquals(replay.errored, 1);
  assertEquals(rec.sent.length, 1, "still exactly one provider send");
  assertEquals(row(tables, SEND_B).status, "error");
  assertStringIncludes(String(row(tables, SEND_B).error_detail), "already dispatched");
  assertEquals(tables.send_approvals[0].dispatch_scheduled_send_id, SEND_A);
  assertEquals(rec.completed.length, 1, "the idempotency record is settled once");
});

Deno.test("approved schedule_create is refused when its key was narrowed away from the mailbox", async () => {
  const tables = approve(await heldAndDue(), { inbox_ids: [OTHER_INBOX] });
  const rec: Recorded = { sent: [], completed: [] };
  const summary = await dispatch(tables, rec);
  assertEquals(summary.errored, 1);
  assertEquals(rec.sent.length, 0);
  assertEquals(row(tables, SEND_A).status, "error");
  assertStringIncludes(String(row(tables, SEND_A).error_detail), "no longer has access");
  assertEquals(rec.completed, [[APPROVAL_ID, "error", "provider_not_sent"]]);
});

Deno.test("approved schedule_create whose provider send fails mid-way settles as unknown, not sent", async () => {
  const tables = approve(await heldAndDue());
  const rec: Recorded = { sent: [], completed: [] };
  const summary = await dispatch(tables, rec, true);
  assertEquals(summary.errored, 1);
  assertEquals(rec.sent.length, 1);
  assertEquals(row(tables, SEND_A).status, "error");
  assertEquals(rec.completed, [[APPROVAL_ID, "error", "provider_error"]]);
});
