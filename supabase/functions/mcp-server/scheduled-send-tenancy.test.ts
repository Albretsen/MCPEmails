// ---------------------------------------------------------------------------
// The scheduled-send dispatcher resolves every row inside its OWN tenant, and
// an approval dispatches exactly once.
//
// ── THE HOLE (F-04-01, closed 2026-10-16) ──────────────────────────────────
// Until migration 20261016160400 any signed-in user could INSERT a
// scheduled_sends row over PostgREST, checked only on workspace_id. The
// dispatcher, running as service role over every tenant:
//   * loaded the inbox by `id` alone, so a row in the attacker's own workspace
//     could name a victim's inbox and be sent from it;
//   * sent plaintext payloads as they came;
//   * for a `{ approval_id }` marker, loaded the approval by id + 'approved'
//     alone (any tenant, any inbox) and re-ran it, and nothing stopped a
//     second, third, ... row from re-running the same approval.
//
// The grants are fixed in SQL (supabase/tests/scheduled_sends_writers.sql).
// These tests pin the dispatcher half, so a row that somehow still gets in
// (a future writer bug, a service-role script) cannot be turned into a send:
//   * the inbox, the approval and the originating key are all looked up with
//     the row's workspace_id (and the approval with its inbox_id);
//   * a plaintext payload is accepted only as an approval marker, or as a
//     legacy row older than payload encryption;
//   * an approval is bound to the one row that dispatches it
//     (send_approvals.dispatch_scheduled_send_id), so a replay is refused while
//     a retry of the SAME row after a provable non-send still goes through.
//
// The provider send and the approved-operation re-run are injected (`deps`),
// so the legitimate paths are asserted all the way to `status: 'sent'` without
// a socket.
//
// Run: cd supabase/functions/mcp-server &&
//      DENO_NO_PACKAGE_JSON=1 deno test --node-modules-dir=none --allow-env \
//        --allow-read --allow-run=git scheduled-send-tenancy.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { isRetryableEnvelopeRefusal, SmtpNotSentError } from "./smtp-client.ts";

const KEY_HEX = "0123456789abcdef".repeat(4);
Deno.env.set("ENCRYPTION_KEY", KEY_HEX);
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { handleScheduledDispatch } = await import("./index.ts");

const WS_VICTIM = "11111111-1111-4111-8111-111111111111";
const WS_ATTACKER = "22222222-2222-4222-8222-222222222222";
const INBOX_VICTIM = "33333333-3333-4333-8333-333333333333";
const INBOX_VICTIM_2 = "33333333-3333-4333-8333-333333333334";
const INBOX_ATTACKER = "44444444-4444-4444-8444-444444444444";
const APPROVAL = "55555555-5555-4555-8555-555555555555";
const KEY_VICTIM = "66666666-6666-4666-8666-666666666666";
const KEY_ATTACKER = "66666666-6666-4666-8666-666666666667";
const SEND_A = "77777777-7777-4777-8777-77777777777a";
const SEND_B = "77777777-7777-4777-8777-77777777777b";

type Row = Record<string, unknown>;

interface RecordedQuery {
  table: string;
  op: "select" | "update";
  projection: string | null;
  patch: Row | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
}

/**
 * A PostgREST-shaped client over in-memory tables. Filters are really applied,
 * updates really mutate (so a conditional claim really is conditional), and
 * `select("*")` returns the whole row while a column list projects it.
 */
function recordingClient(tables: Record<string, Row[]>) {
  const queries: RecordedQuery[] = [];
  const from = (table: string) => {
    const q: RecordedQuery = { table, op: "select", projection: null, patch: null, eq: [], is: [] };
    const lt: Array<[string, unknown]> = [];
    const lte: Array<[string, unknown]> = [];
    queries.push(q);
    const matched = () =>
      (tables[table] ?? []).filter((row) =>
        q.eq.every(([c, v]) => row[c] === v) &&
        q.is.every(([c, v]) => (row[c] ?? null) === v) &&
        lt.every(([c, v]) => String(row[c]) < String(v)) &&
        lte.every(([c, v]) => String(row[c]) <= String(v))
      );
    const project = (row: Row): Row => {
      if (!q.projection || q.projection.trim() === "*") return { ...row };
      const out: Row = {};
      for (const c of q.projection.split(",").map((s) => s.trim())) if (c in row) out[c] = row[c];
      return out;
    };
    let settled: { data: Row[]; error: null } | null = null;
    const settle = () => {
      if (settled) return settled;
      const rows = matched();
      if (q.op === "update" && q.patch) for (const row of rows) Object.assign(row, q.patch);
      settled = { data: rows.map(project), error: null };
      return settled;
    };
    const builder = {
      select(p: string) { q.projection = p; return builder; },
      update(patch: Row) { q.op = "update"; q.patch = patch; return builder; },
      eq(c: string, v: unknown) {
        if (v === null || typeof v === "boolean") throw new Error(`.eq("${c}", ${v}) needs .is()`);
        q.eq.push([c, v]);
        return builder;
      },
      is(c: string, v: unknown) { q.is.push([c, v]); return builder; },
      lt(c: string, v: unknown) { lt.push([c, v]); return builder; },
      lte(c: string, v: unknown) { lte.push([c, v]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() {
        const { data } = settle();
        if (data.length !== 1) return Promise.resolve({ data: null, error: { message: "no rows" } });
        return Promise.resolve({ data: data[0], error: null });
      },
      maybeSingle() {
        const { data } = settle();
        return Promise.resolve({ data: data[0] ?? null, error: null });
      },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: any) => unknown, reject?: (r: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    return builder;
  };
  return { client: { from }, queries, tables };
}

/** AES-256-GCM, IV(12) || ciphertext || tag, base64url — the stored-token layout. */
async function encrypt(plaintext: string): Promise<string> {
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(KEY_HEX.substring(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(plaintext)),
  );
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv);
  all.set(ct, iv.length);
  return btoa(String.fromCharCode(...all)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const MESSAGE = { to: ["friend@example.com"], subject: "Hello", body: "Scheduled body" };

function inbox(id: string, workspace_id: string): Row {
  return {
    id,
    workspace_id,
    status: "active",
    deleted_at: null,
    provider: "imap",
    email_address: `${id.slice(0, 4)}@example.com`,
    signature_html: null,
    signature_text: null,
  };
}

function apiKey(id: string, workspace_id: string): Row {
  return {
    id,
    workspace_id,
    created_by: null,
    name: "key",
    key_prefix: "mcpe_x",
    key_hash: "h",
    scopes: ["send:email"],
    inbox_ids: null,
    expires_at: null,
    last_used_at: null,
    deleted_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

async function approvalRow(overrides: Row = {}): Promise<Row> {
  return {
    id: APPROVAL,
    workspace_id: WS_VICTIM,
    inbox_id: INBOX_VICTIM,
    api_key_id: KEY_VICTIM,
    operation: "email_send",
    payload: { v: 1, data: await encrypt(JSON.stringify({ ...MESSAGE, subject: "Approved" })) },
    payload_encrypted: true,
    status: "approved",
    expires_at: null,
    decided_at: new Date(Date.now() - 120_000).toISOString(),
    dispatch_scheduled_send_id: null,
    ...overrides,
  };
}

/** Due a minute ago: inside the defer window, so a provable non-send is retried. */
const DUE = () => new Date(Date.now() - 60_000).toISOString();

function marker(id: string, overrides: Row = {}): Row {
  return {
    id,
    workspace_id: WS_VICTIM,
    inbox_id: INBOX_VICTIM,
    payload: { approval_id: APPROVAL },
    payload_encrypted: false,
    status: "pending",
    send_at: DUE(),
    created_at: new Date().toISOString(),
    sent_at: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function encryptedSend(id: string, overrides: Row = {}): Promise<Row> {
  return {
    id,
    workspace_id: WS_VICTIM,
    inbox_id: INBOX_VICTIM,
    payload: { v: 1, data: await encrypt(JSON.stringify(MESSAGE)) },
    payload_encrypted: true,
    status: "pending",
    send_at: DUE(),
    created_at: new Date().toISOString(),
    sent_at: null,
    error_detail: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

interface Calls {
  approved: Array<{ operation: string; original: Row; key: Row }>;
  completed: Array<[string, string, string | null]>;
  sent: Array<{ inbox: Row; params: Row }>;
  /** Each outbound brake check: whether the dispatcher said it was already counted. */
  brake: Array<{ alreadyCounted: boolean }>;
}

function harness(
  tables: Record<string, Row[]>,
  behaviour: {
    approved?: () => { logStatus: "success" | "error"; logErrorCode: string | null };
    send?: () => void;
    /** Stand in the outbound brake (always "allow"); left out, deps has none. */
    brake?: boolean;
  } = {},
) {
  const rec = recordingClient(tables);
  const calls: Calls = { approved: [], completed: [], sent: [], brake: [] };
  const deps = {
    runApprovedOperation(operation: string, original: Row, key: Row) {
      calls.approved.push({ operation, original, key });
      return Promise.resolve(behaviour.approved?.() ?? { logStatus: "success" as const, logErrorCode: null });
    },
    completeApprovedIdempotency(id: string, s: string, c: string | null) {
      calls.completed.push([id, s, c]);
      return Promise.resolve();
    },
    sendViaProvider(inboxRow: Row, params: Row) {
      calls.sent.push({ inbox: inboxRow, params });
      behaviour.send?.();
      return Promise.resolve({ message_id: "<m@x>", sent_at: new Date().toISOString() });
    },
    ...(behaviour.brake
      ? {
        outboundBrake(_ws: string, _inbox: Row, _params: Row, _approved: boolean, alreadyCounted: boolean) {
          calls.brake.push({ alreadyCounted });
          return Promise.resolve({ kind: "allow" as const });
        },
      }
      : {}),
  };
  const run = async () => {
    // deno-lint-ignore no-explicit-any
    const res = await handleScheduledDispatch(rec.client as any, deps as any);
    return await res.json();
  };
  return { run, calls, ...rec };
}

function sendRow(tables: Record<string, Row[]>, id: string): Row {
  const row = tables.scheduled_sends.find((r) => r.id === id);
  assert(row, `scheduled_sends row ${id} missing`);
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cross-tenant rows are refused
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a row naming another workspace's inbox is failed, never sent", async () => {
  // The attacker's own workspace, the victim's inbox id.
  const h = harness({
    scheduled_sends: [await encryptedSend(SEND_A, { workspace_id: WS_ATTACKER, inbox_id: INBOX_VICTIM })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM), inbox(INBOX_ATTACKER, WS_ATTACKER)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 0);
  assertEquals(summary.errored, 1);
  assertEquals(h.calls.sent.length, 0);
  const row = sendRow(h.tables, SEND_A);
  assertEquals(row.status, "error");
  assertStringIncludes(String(row.error_detail), "not found");
});

Deno.test("the inbox lookup is scoped to the row's workspace in SQL", async () => {
  const h = harness({
    scheduled_sends: [await encryptedSend(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  await h.run();
  const [q] = h.queries.filter((x) => x.table === "inboxes");
  assert(q.eq.some(([c, v]) => c === "workspace_id" && v === WS_VICTIM), "inbox query must filter workspace_id");
  assert(q.eq.some(([c, v]) => c === "id" && v === INBOX_VICTIM));
});

Deno.test("a marker naming another workspace's approval is refused and the approval is untouched", async () => {
  const approval = await approvalRow();
  const h = harness({
    scheduled_sends: [marker(SEND_A, { workspace_id: WS_ATTACKER, inbox_id: INBOX_ATTACKER })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM), inbox(INBOX_ATTACKER, WS_ATTACKER)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.errored, 1);
  assertEquals(h.calls.approved.length, 0);
  assertEquals(h.calls.sent.length, 0);
  assertStringIncludes(String(sendRow(h.tables, SEND_A).error_detail), "approved request not found");
  // Not claimed by the attacker's row, so the legitimate marker still can.
  assertEquals(approval.dispatch_scheduled_send_id, null);
});

Deno.test("a marker naming an approval for a different inbox of the same workspace is refused", async () => {
  const h = harness({
    scheduled_sends: [marker(SEND_A, { inbox_id: INBOX_VICTIM_2 })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM), inbox(INBOX_VICTIM_2, WS_VICTIM)],
    send_approvals: [await approvalRow()],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  await h.run();
  assertEquals(h.calls.approved.length, 0);
  assertEquals(sendRow(h.tables, SEND_A).status, "error");
});

Deno.test("the approval and key lookups carry the row's workspace (and inbox)", async () => {
  const h = harness({
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [await approvalRow()],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  await h.run();
  const approvalRead = h.queries.find((x) => x.table === "send_approvals" && x.op === "select");
  assert(approvalRead);
  assert(approvalRead.eq.some(([c, v]) => c === "workspace_id" && v === WS_VICTIM));
  assert(approvalRead.eq.some(([c, v]) => c === "inbox_id" && v === INBOX_VICTIM));
  const keyRead = h.queries.find((x) => x.table === "api_keys");
  assert(keyRead);
  assert(keyRead.eq.some(([c, v]) => c === "workspace_id" && v === WS_VICTIM));
});

Deno.test("an approval whose originating key belongs to another workspace is refused", async () => {
  const h = harness({
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [await approvalRow({ api_key_id: KEY_ATTACKER })],
    api_keys: [apiKey(KEY_ATTACKER, WS_ATTACKER)],
  });
  await h.run();
  assertEquals(h.calls.approved.length, 0);
  assertStringIncludes(String(sendRow(h.tables, SEND_A).error_detail), "originating API key is unavailable");
});

// ═══════════════════════════════════════════════════════════════════════════
// Plaintext payloads
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a plaintext message payload newer than payload encryption is refused", async () => {
  const h = harness({
    scheduled_sends: [marker(SEND_A, { payload: MESSAGE })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.errored, 1);
  assertEquals(h.calls.sent.length, 0);
  const row = sendRow(h.tables, SEND_A);
  assertEquals(row.status, "error");
  assertStringIncludes(String(row.error_detail), "unencrypted message payload");
});

Deno.test("a marker with extra fields is not a marker, and is refused", async () => {
  // `{ approval_id, to, ... }` must not smuggle content past the marker check.
  const h = harness({
    scheduled_sends: [marker(SEND_A, { payload: { approval_id: APPROVAL, ...MESSAGE } })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [await approvalRow()],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  await h.run();
  assertEquals(h.calls.approved.length, 0);
  assertEquals(h.calls.sent.length, 0);
  assertStringIncludes(String(sendRow(h.tables, SEND_A).error_detail), "unencrypted message payload");
});

Deno.test("the plaintext cutoff sits after the encryption deploy (2026-06-25T00:00Z)", async () => {
  // The encryption commit landed 2026-06-23 13:32 +0200 and deployed after,
  // so plaintext rows written on 06-23/06-24 are legitimate legacy rows.
  const legacy = harness({
    scheduled_sends: [marker(SEND_A, { payload: MESSAGE, created_at: "2026-06-24T23:59:59.000Z" })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  assertEquals((await legacy.run()).dispatched, 1);
  const after = harness({
    scheduled_sends: [marker(SEND_A, { payload: MESSAGE, created_at: "2026-06-25T00:00:00.000Z" })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  assertEquals((await after.run()).errored, 1);
  assertEquals(after.calls.sent.length, 0);
});

Deno.test("a legacy plaintext row from before payload encryption still sends", async () => {
  const h = harness({
    scheduled_sends: [marker(SEND_A, { payload: MESSAGE, created_at: "2026-06-01T00:00:00.000Z" })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(h.calls.sent.length, 1);
  assertEquals(sendRow(h.tables, SEND_A).status, "sent");
});

// ═══════════════════════════════════════════════════════════════════════════
// Legitimate sends
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a legitimate encrypted scheduled send dispatches", async () => {
  const h = harness({
    scheduled_sends: [await encryptedSend(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(h.calls.sent.length, 1);
  assertEquals(h.calls.sent[0].params.to, MESSAGE.to);
  assertEquals(h.calls.sent[0].params.subject, MESSAGE.subject);
  assertEquals(h.calls.sent[0].inbox.id, INBOX_VICTIM);
  const row = sendRow(h.tables, SEND_A);
  assertEquals(row.status, "sent");
  assert(row.sent_at);
});

Deno.test("a legitimate approved send dispatches once and binds the approval to its row", async () => {
  const approval = await approvalRow();
  const h = harness({
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(h.calls.approved.length, 1);
  const [call] = h.calls.approved;
  assertEquals(call.operation, "email_send");
  assertEquals(call.original.subject, "Approved");
  assertEquals(call.key.internalApprovalDispatch, true);
  assertEquals(call.key.id, KEY_VICTIM);
  assertEquals(h.calls.completed, [[APPROVAL, "success", null]]);
  assertEquals(sendRow(h.tables, SEND_A).status, "sent");
  assertEquals(approval.dispatch_scheduled_send_id, SEND_A);
  // The approval itself stays 'approved': the dashboard history is unchanged.
  assertEquals(approval.status, "approved");
});

// ═══════════════════════════════════════════════════════════════════════════
// Replay
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a second row pointing at an already-dispatched approval is refused", async () => {
  const approval = await approvalRow({ dispatch_scheduled_send_id: SEND_A });
  const h = harness({
    scheduled_sends: [
      marker(SEND_A, { status: "sent" }),
      marker(SEND_B),
    ],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 0);
  assertEquals(summary.errored, 1);
  assertEquals(h.calls.approved.length, 0);
  const row = sendRow(h.tables, SEND_B);
  assertEquals(row.status, "error");
  assertStringIncludes(String(row.error_detail), "already dispatched");
  assertEquals(approval.dispatch_scheduled_send_id, SEND_A);
});

Deno.test("two rows racing for one unbound approval send it exactly once", async () => {
  const approval = await approvalRow();
  const h = harness({
    scheduled_sends: [marker(SEND_A), marker(SEND_B)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(summary.errored, 1);
  assertEquals(h.calls.approved.length, 1);
  assertEquals(approval.dispatch_scheduled_send_id, SEND_A);
  assertEquals(sendRow(h.tables, SEND_A).status, "sent");
  assertStringIncludes(String(sendRow(h.tables, SEND_B).error_detail), "already dispatched");
});

Deno.test("re-running the dispatcher after an approved send does not send it again", async () => {
  const approval = await approvalRow();
  const tables = {
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables);
  await h.run();
  // A fresh marker for the same approval appears afterwards.
  tables.scheduled_sends.push(marker(SEND_B));
  await h.run();
  assertEquals(h.calls.approved.length, 1);
  assertEquals(sendRow(tables, SEND_B).status, "error");
});

Deno.test("a database without the binding column holds the approved send instead of destroying it", async () => {
  // The function deployed before migration 20261016160400. It must not
  // dispatch without the replay guard, and it must not fail a send a human
  // approved either: the row goes back to 'pending' and waits for the column,
  // even when it is long past the usual 15-minute defer window.
  const approval = await approvalRow();
  delete approval.dispatch_scheduled_send_id;
  const tables = {
    scheduled_sends: [marker(SEND_A, { send_at: "2026-01-01T00:00:00.000Z" })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables);
  const first = await h.run();
  assertEquals(first.deferred, 1);
  assertEquals(first.errored, 0);
  assertEquals(h.calls.approved.length, 0);
  const row = sendRow(tables, SEND_A);
  assertEquals(row.status, "pending");
  assertStringIncludes(String(row.error_detail), "deferred, nothing was sent");
  assertStringIncludes(String(row.error_detail), "20261016160400");

  // The migration lands: the column appears, and the same row now sends once.
  approval.dispatch_scheduled_send_id = null;
  const second = await h.run();
  assertEquals(second.dispatched, 1);
  assertEquals(h.calls.approved.length, 1);
  assertEquals(row.status, "sent");
  assertEquals(approval.dispatch_scheduled_send_id, SEND_A);
});

// ═══════════════════════════════════════════════════════════════════════════
// Transient failure: the SAME row may retry
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("an approved send refused before transmission is deferred, then retried by the same row", async () => {
  const approval = await approvalRow();
  let attempt = 0;
  const tables = {
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables, {
    approved: () =>
      ++attempt === 1
        ? { logStatus: "error", logErrorCode: "provider_not_sent" }
        : { logStatus: "success", logErrorCode: null },
  });

  const first = await h.run();
  assertEquals(first.deferred, 1);
  const row = sendRow(tables, SEND_A);
  assertEquals(row.status, "pending");
  assertStringIncludes(String(row.error_detail), "deferred, nothing was sent");
  // Claimed by this row on the first attempt...
  assertEquals(approval.dispatch_scheduled_send_id, SEND_A);

  // ...so the retry passes the single-use gate.
  const second = await h.run();
  assertEquals(second.dispatched, 1);
  assertEquals(h.calls.approved.length, 2);
  assertEquals(row.status, "sent");
});

Deno.test("a scheduled send refused before transmission is deferred, then retried", async () => {
  let attempt = 0;
  const tables = {
    scheduled_sends: [await encryptedSend(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables, {
    send: () => {
      if (++attempt === 1) throw new SmtpNotSentError("421 try again later", true);
    },
  });
  const first = await h.run();
  assertEquals(first.deferred, 1);
  assertEquals(sendRow(tables, SEND_A).status, "pending");
  const second = await h.run();
  assertEquals(second.dispatched, 1);
  assertEquals(sendRow(tables, SEND_A).status, "sent");
  assertEquals(h.calls.sent.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// A permanent refusal fails at once, and a retry is not counted twice
// (2026-10-29: 48 scheduled sends refused with 550 at RCPT TO were retried
// once a minute and filled one inbox's 500/day brake without a delivery)
// ═══════════════════════════════════════════════════════════════════════════

const reply = (code: number, text: string) => ({ code, text, lines: [text] });

Deno.test("a 550 account block at RCPT TO fails the row on the first attempt", async () => {
  const blocked = reply(550, "Outgoing mail from sender@example.com blocked");
  assertEquals(isRetryableEnvelopeRefusal(blocked), false);
  const tables = {
    scheduled_sends: [await encryptedSend(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables, {
    brake: true,
    send: () => {
      throw new SmtpNotSentError(`SMTP RCPT TO <a@example.com> rejected: 550 ${blocked.text}`, false);
    },
  });
  const first = await h.run();
  assertEquals(first.errored, 1);
  assertEquals(first.deferred, 0);
  assertEquals(sendRow(tables, SEND_A).status, "error");
  const second = await h.run();
  assertEquals(second.total, 0);
  assertEquals(h.calls.sent.length, 1, "never tried again");
  assertEquals(h.calls.brake.length, 1);
});

Deno.test("a deferred retry is checked by the brake but counted only once", async () => {
  let attempt = 0;
  const tables = {
    scheduled_sends: [await encryptedSend(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables, {
    brake: true,
    send: () => {
      if (++attempt <= 2) throw new SmtpNotSentError("SMTP RCPT TO <a@example.com> rejected: 451 4.7.1 try later", true);
    },
  });
  assertEquals((await h.run()).deferred, 1);
  assertStringIncludes(String(sendRow(tables, SEND_A).error_detail), "deferred, nothing was sent");
  assertEquals((await h.run()).deferred, 1);
  assertEquals((await h.run()).dispatched, 1);
  assertEquals(sendRow(tables, SEND_A).status, "sent");
  assertEquals(h.calls.brake.map((b) => b.alreadyCounted), [false, true, true]);
});

Deno.test("a row deferred by the brake itself is still counted when it finally sends", async () => {
  // A ScheduledDispatchHeld deferral happens before the brake counts, so the
  // row must not inherit the "already counted" mark from it.
  const tables = {
    scheduled_sends: [await encryptedSend(SEND_A, { error_detail: "deferred, nothing was sent: held by a send limit" })],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
  };
  const h = harness(tables, { brake: true });
  assertEquals((await h.run()).dispatched, 1);
  assertEquals(h.calls.brake.map((b) => b.alreadyCounted), [false]);
});

// ═══════════════════════════════════════════════════════════════════════════
// A rule's forward counts when it is sent
// ═══════════════════════════════════════════════════════════════════════════

function ruleForwardHarness(
  approval: Row,
  allowed: boolean,
  outcome: { logStatus: "success" | "error"; logErrorCode: string | null } = { logStatus: "success", logErrorCode: null },
) {
  const rec = recordingClient({
    scheduled_sends: [marker(SEND_A)],
    inboxes: [inbox(INBOX_VICTIM, WS_VICTIM)],
    send_approvals: [approval],
    api_keys: [apiKey(KEY_VICTIM, WS_VICTIM)],
  });
  const seen = {
    keys: [] as Row[],
    reserved: 0,
    settled: [] as Array<[string, string | null]>,
  };
  const deps = {
    runApprovedOperation(_operation: string, _original: Row, key: Row) {
      seen.keys.push(key);
      return Promise.resolve(outcome);
    },
    completeApprovedIdempotency: () => Promise.resolve(),
    sendViaProvider: () => Promise.reject(new Error("not used")),
    reserveRuleForward() {
      seen.reserved++;
      return Promise.resolve({ allowed, reservationId: allowed ? "res-1" : null });
    },
    settleRuleForward(_ws: string, status: string, reservationId: string | null) {
      seen.settled.push([status, reservationId]);
      return Promise.resolve();
    },
  };
  // deno-lint-ignore no-explicit-any
  const run = async () => await (await handleScheduledDispatch(rec.client as any, deps as any)).json();
  return { run, seen, tables: rec.tables };
}

const asForward = async (extra: Row) => ({
  ...(await approvalRow()),
  operation: "email_forward",
  ...extra,
});

Deno.test("an approved rule forward is reserved, sent marked, and booked once sent", async () => {
  const h = ruleForwardHarness(await asForward({ triage_rule_id: null, triage_rule_name: "Invoices" }), true);
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(h.seen.reserved, 1);
  assertEquals(h.seen.keys[0].ruleForwardDispatch, true);
  assertEquals(h.seen.settled, [["success", "res-1"]]);
});

Deno.test("at the cap an approved rule forward is not sent, not counted, and says why", async () => {
  const h = ruleForwardHarness(await asForward({ triage_rule_name: "Invoices" }), false);
  const summary = await h.run();
  assertEquals(summary.errored, 1);
  assertEquals(h.seen.keys.length, 0, "nothing was sent");
  assertEquals(h.seen.settled.length, 0, "nothing to book");
  const row = sendRow(h.tables, SEND_A);
  assertEquals(row.status, "error");
  assertStringIncludes(String(row.error_detail), "included actions");
});

Deno.test("a rule forward that fails hands its reservation back", async () => {
  const h = ruleForwardHarness(await asForward({ triage_rule_name: "Invoices" }), true, {
    logStatus: "error",
    logErrorCode: "message_not_found",
  });
  await h.run();
  assertEquals(h.seen.settled, [["error", "res-1"]]);
});

Deno.test("an AI's forward is not a rule forward: no marker, no second count", async () => {
  const h = ruleForwardHarness(await asForward({}), true);
  const summary = await h.run();
  assertEquals(summary.dispatched, 1);
  assertEquals(h.seen.reserved, 0);
  assertEquals(h.seen.keys[0].ruleForwardDispatch, false);
  assertEquals(h.seen.settled.length, 0);
});
