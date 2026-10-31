// ---------------------------------------------------------------------------
// /api/automations: the key-scope refusal, and deleting a rule with forwards
// waiting. Only the Supabase clients and the active-workspace lookup are stubbed.
//
// Run with: npm run test:automations-routes
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let signedIn: { id: string } | null = { id: 'user-1' };

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  let insert: Row | null = null;
  const matching = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const run = () => {
    if (insert) {
      const row = { id: `new-${table}`, ...insert };
      (tables[table] ??= []).push(row);
      return [row];
    }
    const rows = matching();
    if (patch) for (const row of rows) Object.assign(row, patch);
    return rows;
  };
  const builder: any = {
    select: () => builder,
    insert: (row: Row) => ((insert = row), builder),
    update: (row: Row) => ((patch = row), builder),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (v: any) => unknown) => Promise.resolve({ data: run(), error: null, count: matching().length }).then(resolve),
  };
  return builder;
}
const db = { from: query };

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });

const collection = (await import('./route.ts')) as any;
const single = (await import('./[id]/route.ts')) as any;

const RULE = '11111111-1111-4111-8111-111111111111';
const INBOX = '22222222-2222-4222-8222-222222222222';
const SENDER = '33333333-3333-4333-8333-333333333333';
const READER = '44444444-4444-4444-8444-444444444444';
const FORWARD = { type: 'forward', to: ['bookkeeper@example.com'] };

function request(method: string, body?: unknown) {
  return new Request('https://mcpemails.com/api/automations', {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://mcpemails.com', host: 'mcpemails.com' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as any;
}
const params = { params: Promise.resolve({ id: RULE }) };

beforeEach(() => {
  signedIn = { id: 'user-1' };
  process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.com';
  tables = {
    workspace_members: [{ workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }],
    inboxes: [{ id: INBOX, workspace_id: 'ws-1', provider: 'imap' }],
    api_keys: [
      { id: SENDER, workspace_id: 'ws-1', scopes: ['read:email', 'send:email'], inbox_ids: null, kind: null },
      { id: READER, workspace_id: 'ws-1', scopes: ['read:email'], inbox_ids: null, kind: null },
    ],
    triage_rules: [{ id: RULE, workspace_id: 'ws-1', inbox_id: INBOX, api_key_id: SENDER, filter: { from: 'a@example.com' }, action: FORWARD, enabled: false, deleted_at: null, running_since: null }],
    send_approvals: [
      { id: 'a1', workspace_id: 'ws-1', triage_rule_id: RULE, status: 'pending' },
      { id: 'a2', workspace_id: 'ws-1', triage_rule_id: RULE, status: 'pending' },
      { id: 'decided', workspace_id: 'ws-1', triage_rule_id: RULE, status: 'approved' },
      { id: 'other-rule', workspace_id: 'ws-1', triage_rule_id: 'someone-else', status: 'pending' },
      { id: 'ai-send', workspace_id: 'ws-1', triage_rule_id: null, status: 'pending' },
    ],
  };
});

const newRule = (overrides: Row = {}) => ({
  name: 'Invoices', inbox_id: INBOX, api_key_id: SENDER, interval_minutes: 60, max_messages_per_run: 25,
  filter: { from: 'a@example.com' }, action: FORWARD, ...overrides,
});

test('POST refuses a forward on a key that cannot send, and saves nothing', async () => {
  const before = tables.triage_rules.length;
  const response = await collection.POST(request('POST', newRule({ api_key_id: READER })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'key_missing_scope');
  assert.equal(tables.triage_rules.length, before);
});

test('POST writes a rule switched off, whatever the body claims', async () => {
  const response = await collection.POST(request('POST', newRule({ enabled: true, no_approval: true, next_run_at: 'x' })));
  assert.equal(response.status, 201);
  const row = tables.triage_rules.at(-1) as Row;
  assert.equal(row.enabled, false);
  assert.equal('no_approval' in row, false);
  assert.equal('next_run_at' in row, false);
});

test('PATCH refuses moving a forward onto a key that cannot send', async () => {
  const response = await single.PATCH(request('PATCH', { api_key_id: READER }), params);
  assert.equal(response.status, 400);
  assert.equal(tables.triage_rules[0].api_key_id, SENDER);
});

test('PATCH refuses switching on a forward whose key cannot send', async () => {
  tables.triage_rules[0].api_key_id = READER;
  const response = await single.PATCH(request('PATCH', { enabled: true }), params);
  assert.equal(response.status, 400);
  assert.equal(tables.triage_rules[0].enabled, false);
});

test('PATCH still allows a rename and a switch-off on that same rule', async () => {
  tables.triage_rules[0].api_key_id = READER;
  assert.equal((await single.PATCH(request('PATCH', { name: 'Renamed' }), params)).status, 200);
  assert.equal((await single.PATCH(request('PATCH', { enabled: false }), params)).status, 200);
});

test('a rename leaves the stored filter exactly as it was', async () => {
  tables.triage_rules[0].filter = { from: 'a@example.com', cc: 'b@example.com', since: '2026-09-01' };
  await single.PATCH(request('PATCH', { name: 'Renamed' }), params);
  assert.deepEqual(tables.triage_rules[0].filter, { from: 'a@example.com', cc: 'b@example.com', since: '2026-09-01' });
});

const status = (id: string) => tables.send_approvals.find((row) => row.id === id)?.status;

test('DELETE without the option leaves waiting forwards approvable', async () => {
  const response = await single.DELETE(request('DELETE'), params);
  assert.equal(response.status, 200);
  assert.ok(tables.triage_rules[0].deleted_at);
  assert.equal(status('a1'), 'pending');
});

test('DELETE with the option cancels this rule\'s waiting forwards and nothing else', async () => {
  const response = await single.DELETE(request('DELETE', { cancel_waiting: true }), params);
  assert.equal((await response.json()).cancelled, 2);
  assert.equal(status('a1'), 'cancelled');
  assert.equal(status('a2'), 'cancelled');
  assert.equal(status('decided'), 'approved');
  assert.equal(status('other-rule'), 'pending');
  assert.equal(status('ai-send'), 'pending');
  const row = tables.send_approvals[0];
  assert.equal(row.decided_by, 'user-1');
  assert.equal(row.decided_via, 'dashboard');
});

test('DELETE with the option waits for a run in flight, which could still queue one', async () => {
  tables.triage_rules[0].running_since = new Date().toISOString();
  const response = await single.DELETE(request('DELETE', { cancel_waiting: true }), params);
  assert.equal(response.status, 409);
  assert.equal(tables.triage_rules[0].deleted_at, null);
  assert.equal(status('a1'), 'pending');
});

test('a member cannot delete or cancel', async () => {
  tables.workspace_members[0].role = 'member';
  const response = await single.DELETE(request('DELETE', { cancel_waiting: true }), params);
  assert.equal(response.status, 403);
  assert.equal(status('a1'), 'pending');
});

test('no session, no delete: a key cannot reach this', async () => {
  signedIn = null;
  const response = await single.DELETE(request('DELETE', { cancel_waiting: true }), params);
  assert.equal(response.status, 401);
  assert.equal(status('a1'), 'pending');
});
