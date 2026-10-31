// ---------------------------------------------------------------------------
// Rule forwards after the queue: what a delivery reads as, the original as a page
// may see it, Forward again, Approve all, and the routes' refusals.
//
// Run with: npm run test:approvals
// Only the Supabase clients and the active-workspace lookup are stubbed.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, any>;

class FakeQuery {
  op = 'select';
  patch: Row = {};
  filters: Array<(r: Row) => boolean> = [];
  db: FakeDb;
  table: string;
  constructor(db: FakeDb, table: string) {
    this.db = db;
    this.table = table;
  }
  select() { return this; }
  insert(row: Row) { this.op = 'insert'; this.patch = row; return this; }
  update(patch: Row) { this.op = 'update'; this.patch = patch; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gt(c: string, v: string) { this.filters.push((r) => r[c] > v); return this; }
  limit() { return this; }
  async maybeSingle() { return this.run(true); }
  then(resolve: (v: any) => unknown) { return Promise.resolve(this.run(false)).then(resolve); }
  run(single: boolean) {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === 'insert') {
      if (this.patch.reforward_of && rows.some((r) => r.reforward_of === this.patch.reforward_of)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } };
      }
      const row = { id: `new-${rows.length}`, status: 'pending', revision: 1, ...this.patch };
      rows.push(row);
      return { data: single ? row : [row], error: null };
    }
    const matched = rows.filter((r) => this.filters.every((keep) => keep(r)));
    if (this.op === 'update') matched.forEach((r) => Object.assign(r, this.patch));
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  }
}

class FakeDb {
  rpcs = 0;
  tables: Record<string, Row[]>;
  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }
  from(table: string) { return new FakeQuery(this, table); }
  async rpc() { this.rpcs += 1; return { data: null, error: null }; }
}

let signedIn: { id: string } | null = { id: 'user-1' };
let routeDb = new FakeDb({});

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => routeDb } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });

const { encryptToken } = await import('../crypto.ts');
const { deliveryFromScheduledSend, deliveryReasonFromDetail } = await import('./delivery.ts');
const { approvalDecider } = await import('./origin.ts');
const { cleanOriginal } = await import('./original.ts');
const { forwardAgain, forwardAgainWindowOpen, RULE_FORWARD_APPROVAL_TTL_MS } = await import('./forward-again.ts');
const { approveAllFromRule, parseApproveAllItems, singleAddress, APPROVE_ALL_MAX, APPROVE_ALL_PACE_SECONDS } = await import('./approve-all.ts');
const forwardRoute = (await import('../../../app/api/approvals/[id]/forward-again/route.ts')) as any;
const approveRoute = (await import('../../../app/api/approvals/approve-rule/route.ts')) as any;
const originalRoute = (await import('../../../app/api/approvals/[id]/original/route.ts')) as any;

const ID = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'ap@example.com';
const sealed = (value: unknown) => ({ v: 1, data: encryptToken(JSON.stringify(value)) });
const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();
const future = (ms = 60 * 60_000) => new Date(Date.now() + ms).toISOString();

function expiredForward(overrides: Row = {}): Row {
  return {
    id: ID,
    workspace_id: 'ws-1',
    inbox_id: 'inbox-1',
    api_key_id: 'key-1',
    operation: 'email_forward',
    status: 'expired',
    payload: sealed({ inbox_id: 'inbox-1', message_id: 'INBOX:7', to: [ADDRESS] }),
    payload_encrypted: true,
    summary: sealed({ to: [ADDRESS], subject: 'Fwd: Invoice' }),
    expires_at: past(),
    decided_at: past(),
    triage_rule_id: 'rule-1',
    triage_rule_name: 'Invoices',
    ...overrides,
  };
}

function forwardDb(approval: Row = expiredForward(), rule: Row | null = { id: 'rule-1', deleted_at: null, workspace_id: 'ws-1' }) {
  return new FakeDb({
    send_approvals: [approval],
    triage_rules: rule ? [rule] : [],
    api_keys: [{ id: 'key-1', workspace_id: 'ws-1', deleted_at: null }],
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }],
    workspaces: [{ id: 'ws-1', sends_frozen_at: null }],
    inbox_send_brakes: [],
    outbound_send_events: [],
    scheduled_sends: [],
  });
}

// ── Delivery ────────────────────────────────────────────────────────────────

test('delivery: each marker status reads as what happened', () => {
  assert.equal(deliveryFromScheduledSend(null), null);
  assert.equal(deliveryFromScheduledSend({ status: 'cancelled' }), null);
  assert.deepEqual(deliveryFromScheduledSend({ status: 'sent', sent_at: 'T' }), { state: 'sent', reason: null, at: 'T' });
  assert.equal(deliveryFromScheduledSend({ status: 'sending' })?.state, 'sending');
  assert.equal(deliveryFromScheduledSend({ status: 'pending' })?.state, 'sending');
  const failed = deliveryFromScheduledSend({ status: 'error', error_detail: 'approved email_forward failed: original_ambiguous' });
  assert.deepEqual(failed, { state: 'failed', reason: 'original_ambiguous', at: null });
});

test('delivery: a time the person chose reads as scheduled; a paced row does not', () => {
  const later = future();
  assert.equal(deliveryFromScheduledSend({ status: 'pending', send_at: later }, later)?.state, 'scheduled');
  assert.equal(deliveryFromScheduledSend({ status: 'pending', send_at: later }, null)?.state, 'sending');
});

test('delivery: a brake hold reads as waiting, not as failed', () => {
  const held = deliveryFromScheduledSend({
    status: 'pending',
    error_detail: 'deferred, nothing was sent: approved email_forward held by a send limit (daily_send_limit); nothing was sent',
  });
  assert.deepEqual(held, { state: 'held', reason: 'send_limit', at: null });
});

test('delivery: reasons are reduced to known codes, and a provider sentence never comes through', () => {
  assert.equal(deliveryReasonFromDetail('approved email_forward failed: message_not_found'), 'original_not_found');
  assert.equal(deliveryReasonFromDetail('approved email_forward failed: original_not_found'), 'original_not_found');
  assert.equal(deliveryReasonFromDetail('approved email_forward failed: delivery_uncertain'), 'may_have_sent');
  assert.equal(deliveryReasonFromDetail('dispatch interrupted; marked failed to avoid double-send'), 'may_have_sent');
  assert.equal(deliveryReasonFromDetail('originating API key is unavailable'), 'key');
  assert.equal(deliveryReasonFromDetail('550 5.7.1 message from <someone@example.com> refused'), 'generic');
});

test('decider: expired names nobody; a person is a person; a future automatic decision is neither', () => {
  assert.equal(approvalDecider({ status: 'expired', decided_via: 'dashboard' }), 'none');
  assert.equal(approvalDecider({ status: 'cancelled' }), 'none');
  assert.equal(approvalDecider({ status: 'approved', decided_by: 'u', decided_via: 'dashboard' }), 'person');
  assert.equal(approvalDecider({ status: 'rejected', decided_via: 'mcp_app' }), 'person');
  assert.equal(approvalDecider({ status: 'approved', decided_via: 'auto_rule' }), 'automatic');
});

// ── The original ────────────────────────────────────────────────────────────

test('original: invisible and bidi characters are stripped from names, not from the preview', () => {
  const view = cleanOriginal({
    status: 'ok',
    from: { name: 'Bil​ling‮', email: 'b@example.com' },
    date: '2026-10-30T10:00:00.000Z',
    preview: 'שלום‏ <b>hi</b>',
    attachments: [{ filename: 'invoice‮ fdp.exe', size_bytes: 10 }, { filename: '​', size_bytes: 'big' }],
  });
  assert.equal(view.status, 'ok');
  if (view.status !== 'ok') return;
  assert.equal(view.from_name, 'Billing');
  assert.equal(view.attachments[0].filename, 'invoice fdp.exe');
  assert.equal(view.attachments[1].filename, 'attachment');
  assert.equal(view.attachments[1].size_bytes, null);
  assert.equal(view.preview.includes('‏'), true);
});

test('original: anything unexpected is "unavailable", and an unknown reason names no detail', () => {
  assert.deepEqual(cleanOriginal(null), { status: 'unavailable', reason: 'mailbox' });
  assert.deepEqual(cleanOriginal({ status: 'unavailable', reason: 'ambiguous' }), { status: 'unavailable', reason: 'ambiguous' });
  assert.deepEqual(cleanOriginal({ status: 'nope', reason: 'secret text' }), { status: 'unavailable', reason: 'mailbox' });
});

test('original route: a viewer gets no message content, and no session gets nothing', async () => {
  routeDb = forwardDb();
  routeDb.tables.workspace_members[0].role = 'viewer';
  const params = { params: Promise.resolve({ id: ID }) };
  assert.equal((await originalRoute.GET({}, params)).status, 403);
  signedIn = null;
  assert.equal((await originalRoute.GET({}, params)).status, 401);
  signedIn = { id: 'user-1' };
});

// ── Forward again ───────────────────────────────────────────────────────────

test('forward again: same stored message and address, a new deadline, and a link back', async () => {
  const db = forwardDb();
  const before = db.tables.send_approvals[0];
  const outcome = await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' });
  assert.equal(outcome.ok, true);
  const created = db.tables.send_approvals[1];
  assert.equal(created.status, 'pending');
  assert.equal(created.reforward_of, ID);
  assert.equal(created.payload, before.payload, 'the very same ciphertext');
  assert.equal(created.summary, before.summary);
  assert.equal(created.triage_rule_id, 'rule-1');
  const left = Date.parse(created.expires_at) - Date.now();
  assert.equal(left > RULE_FORWARD_APPROVAL_TTL_MS - 60_000 && left <= RULE_FORWARD_APPROVAL_TTL_MS, true);
});

test('forward again: a second click creates no second request', async () => {
  const db = forwardDb();
  await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' });
  const second = await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' });
  assert.equal(!second.ok && second.code, 'already');
  assert.equal(db.tables.send_approvals.length, 2);
});

test('forward again: past its deadline but not retired yet counts, and is closed by this', async () => {
  const db = forwardDb(expiredForward({ status: 'pending', decided_at: null }));
  assert.equal((await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' })).ok, true);
  assert.equal(db.tables.send_approvals[0].status, 'expired');
});

const refusals: Array<[string, () => FakeDb, string]> = [
  ['still pending', () => forwardDb(expiredForward({ status: 'pending', decided_at: null, expires_at: future() })), 'not_expired'],
  ['approved', () => forwardDb(expiredForward({ status: 'approved' })), 'not_expired'],
  ['rejected', () => forwardDb(expiredForward({ status: 'rejected' })), 'not_expired'],
  ['an AI forward', () => forwardDb(expiredForward({ triage_rule_id: null, triage_rule_name: null })), 'not_rule_forward'],
  ['a soft-deleted rule', () => forwardDb(expiredForward(), { id: 'rule-1', deleted_at: past() }), 'rule_deleted'],
  ['a removed rule', () => forwardDb(expiredForward({ triage_rule_id: null })), 'rule_deleted'],
  ['a cleared payload', () => forwardDb(expiredForward({ payload: {} })), 'gone'],
];
for (const [name, build, code] of refusals) {
  test(`forward again refuses ${name}`, async () => {
    const db = build();
    const outcome = await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' });
    assert.equal(!outcome.ok && outcome.code, code);
    assert.equal(db.tables.send_approvals.length, 1);
  });
}

test('forward again refuses when the key the rule ran with is gone', async () => {
  const db = forwardDb();
  db.tables.api_keys[0].deleted_at = past();
  const outcome = await forwardAgain({ db, approvalId: ID, workspaceId: 'ws-1' });
  assert.equal(!outcome.ok && outcome.code, 'key_gone');
});

test('forward again: the button goes away once retention would have cleared the message', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(forwardAgainWindowOpen({ decided_at: past(6 * day) }), true);
  assert.equal(forwardAgainWindowOpen({ decided_at: past(8 * day) }), false);
});

function request(body: unknown, headers: Record<string, string> = {}) {
  const all: Record<string, string> = {
    origin: 'https://staging.mcpemails.com',
    host: 'staging.mcpemails.com',
    'content-type': 'application/json',
    ...headers,
  };
  return { headers: new Headers(all), json: async () => body, nextUrl: new URL('https://staging.mcpemails.com/x') } as any;
}

test('forward again route: a request carrying a key is refused, even with a session', async () => {
  routeDb = forwardDb();
  const response = await forwardRoute.POST(request({}, { authorization: 'Bearer mcpe_test' }), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'session_required');
  assert.equal(routeDb.tables.send_approvals.length, 1);
});

test('forward again route: a member gets 403', async () => {
  routeDb = forwardDb();
  routeDb.tables.workspace_members[0].role = 'member';
  const response = await forwardRoute.POST(request({}), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 403);
  assert.equal(routeDb.tables.send_approvals.length, 1);
});

test('forward again route: no session gets 401', async () => {
  routeDb = forwardDb();
  signedIn = null;
  const response = await forwardRoute.POST(request({}), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 401);
  signedIn = { id: 'user-1' };
});

test('forward again route: a body naming an address is refused, and creates nothing', async () => {
  routeDb = forwardDb();
  const response = await forwardRoute.POST(request({ to: ['attacker@example.org'] }), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 400);
  assert.equal(routeDb.tables.send_approvals.length, 1);
});

test('forward again route: an owner gets a new request with the old address', async () => {
  routeDb = forwardDb();
  const response = await forwardRoute.POST(request({}), { params: Promise.resolve({ id: ID }) });
  assert.equal(response.status, 201);
  const created = routeDb.tables.send_approvals[1];
  assert.equal(created.summary, routeDb.tables.send_approvals[0].summary);
});

// ── Approve all ─────────────────────────────────────────────────────────────

function waiting(id: string, overrides: Row = {}): Row {
  return expiredForward({
    id,
    status: 'pending',
    decided_at: null,
    expires_at: future(),
    revision: 3,
    summary: sealed({ to: [ADDRESS], subject: id }),
    ...overrides,
  });
}

function approveDb(rows: Row[]) {
  const db = forwardDb(rows[0]);
  db.tables.send_approvals = rows;
  db.tables.triage_rules[0].workspace_id = 'ws-1';
  return db;
}

const run = (db: FakeDb, items: Array<{ id: string; revision: number }>, address = ADDRESS) =>
  approveAllFromRule({ db, workspaceId: 'ws-1', userId: 'user-1', ruleId: 'rule-1', address, items });

test('approve all: one address is all rows, once, with nobody else on them', () => {
  assert.equal(singleAddress([{ to: ['A@example.com'] }, { to: ['a@example.com '] }]), 'a@example.com');
  assert.equal(singleAddress([{ to: ['a@example.com'] }, { to: ['b@example.com'] }]), null);
  assert.equal(singleAddress([{ to: ['a@example.com', 'b@example.com'] }]), null);
  assert.equal(singleAddress([{ to: ['a@example.com'], cc: ['b@example.com'] }]), null);
  assert.equal(singleAddress([{ to: ['a@example.com'], bcc_count: 1 }]), null);
  assert.equal(singleAddress([]), null);
});

test('approve all: rows are approved at the revision shown, and paced apart', async () => {
  const db = approveDb([waiting('a'), waiting('b'), waiting('c')]);
  const result = await run(db, ['a', 'b', 'c'].map((id) => ({ id, revision: 3 })));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outcomes.map((row) => row.outcome), ['approved', 'approved', 'approved']);
  const times = db.tables.scheduled_sends.map((row) => Date.parse(row.send_at));
  assert.equal(times.length, 3);
  assert.equal(Math.round((times[1] - times[0]) / 1000), APPROVE_ALL_PACE_SECONDS);
  assert.equal(Math.round((times[2] - times[1]) / 1000), APPROVE_ALL_PACE_SECONDS);
  assert.equal(db.rpcs, 1, 'the dispatcher is asked once, not once per row');
});

test('approve all: a row that expired meanwhile is skipped and reported', async () => {
  const db = approveDb([waiting('a'), waiting('b', { expires_at: past() })]);
  const result = await run(db, [{ id: 'a', revision: 3 }, { id: 'b', revision: 3 }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outcomes, [{ id: 'a', outcome: 'approved' }, { id: 'b', outcome: 'expired' }]);
  assert.equal(db.tables.scheduled_sends.length, 1);
});

test('approve all: a row edited since the page loaded is not approved', async () => {
  const db = approveDb([waiting('a'), waiting('b', { revision: 4 })]);
  const result = await run(db, [{ id: 'a', revision: 3 }, { id: 'b', revision: 3 }]);
  assert.equal(result.ok && result.outcomes[1].outcome, 'changed');
  assert.equal(db.tables.send_approvals[1].status, 'pending');
});

test('approve all: refused outright when any waiting row goes elsewhere, even one not sent', async () => {
  const db = approveDb([waiting('a'), waiting('b', { summary: sealed({ to: ['other@example.com'], subject: 'b' }) })]);
  const result = await run(db, [{ id: 'a', revision: 3 }]);
  assert.equal(!result.ok && result.code, 'mixed_addresses');
  assert.equal(db.tables.scheduled_sends.length, 0);
  assert.equal(db.tables.send_approvals[0].status, 'pending');
});

test('approve all: refused when the confirmed address is not the one on the rows', async () => {
  const db = approveDb([waiting('a')]);
  const result = await run(db, [{ id: 'a', revision: 3 }], 'someone@example.com');
  assert.equal(!result.ok && result.code, 'mixed_addresses');
});

test('approve all: refused for a deleted rule', async () => {
  const db = approveDb([waiting('a')]);
  db.tables.triage_rules[0].deleted_at = past();
  const result = await run(db, [{ id: 'a', revision: 3 }]);
  assert.equal(!result.ok && result.code, 'rule_deleted');
});

test('approve all: nothing is approved while the workspace is frozen or the inbox is paused', async () => {
  const frozen = approveDb([waiting('a')]);
  frozen.tables.workspaces[0].sends_frozen_at = past();
  assert.equal((await run(frozen, [{ id: 'a', revision: 3 }])).ok, false);
  const paused = approveDb([waiting('a')]);
  paused.tables.inbox_send_brakes.push({ inbox_id: 'inbox-1', refusal_pause_until: future() });
  const result = await run(paused, [{ id: 'a', revision: 3 }]);
  assert.equal(!result.ok && result.code, 'sends_paused');
  assert.equal(paused.tables.scheduled_sends.length, 0);
});

test('approve all: rows past what is left today stay waiting and are reported', async () => {
  const db = approveDb([waiting('a'), waiting('b')]);
  db.tables.outbound_send_events = [{ inbox_id: 'inbox-1', kind: 'message', messages: 499, created_at: new Date().toISOString() }];
  const result = await run(db, [{ id: 'a', revision: 3 }, { id: 'b', revision: 3 }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.outcomes.map((row) => row.outcome), ['approved', 'left_waiting']);
  assert.equal(db.tables.send_approvals[1].status, 'pending');
});

test('approve all: at most one batch per click', async () => {
  const rows = Array.from({ length: APPROVE_ALL_MAX + 2 }, (_, i) => waiting(`r${i}`));
  const db = approveDb(rows);
  const result = await run(db, rows.map((row) => ({ id: row.id, revision: 3 })));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcomes.filter((row) => row.outcome === 'approved').length, APPROVE_ALL_MAX);
  assert.equal(result.outcomes.filter((row) => row.outcome === 'left_waiting').length, 2);
});

test('approve all: an id that is not a waiting row of this rule is not approved', async () => {
  const db = approveDb([waiting('a')]);
  db.tables.send_approvals.push(waiting('elsewhere', { triage_rule_id: 'rule-2' }));
  const result = await run(db, [{ id: 'a', revision: 3 }, { id: 'elsewhere', revision: 3 }]);
  assert.equal(result.ok && result.outcomes[1].outcome, 'not_pending');
  assert.equal(db.tables.send_approvals[1].status, 'pending');
});

test('approve all: the items must be well formed', () => {
  assert.equal(parseApproveAllItems([]), null);
  assert.equal(parseApproveAllItems('a'), null);
  assert.equal(parseApproveAllItems([{ id: 'a' }]), null);
  assert.deepEqual(parseApproveAllItems([{ id: 'a', revision: 1, to: 'x' }]), [{ id: 'a', revision: 1 }]);
});

const approveBody = { rule_id: 'rule-1', address: ADDRESS, items: [{ id: 'a', revision: 3 }] };

test('approve route: a request carrying a key is refused, a member gets 403, no session 401', async () => {
  routeDb = approveDb([waiting('a')]);
  assert.equal((await approveRoute.POST(request(approveBody, { authorization: 'Bearer mcpe_test' }))).status, 403);
  routeDb.tables.workspace_members[0].role = 'member';
  assert.equal((await approveRoute.POST(request(approveBody))).status, 403);
  signedIn = null;
  assert.equal((await approveRoute.POST(request(approveBody))).status, 401);
  signedIn = { id: 'user-1' };
  assert.equal(routeDb.tables.send_approvals[0].status, 'pending');
});

test('approve route: an owner gets one outcome per row', async () => {
  routeDb = approveDb([waiting('a')]);
  const response = await approveRoute.POST(request(approveBody));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).outcomes, [{ id: 'a', outcome: 'approved' }]);
});
