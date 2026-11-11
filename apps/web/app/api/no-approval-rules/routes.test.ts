// ---------------------------------------------------------------------------
// Who may write a no-approval rule, and as whom the write runs.
//
// The session client writes, never the service role: the database refuses the
// service role outright (supabase/tests/no_approval_rules.sql).
//
// Run with: npm run test:no-approval
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let signedIn: { id: string } | null = { id: 'user-1' };
let role = 'owner';
let sessionCalls: Array<[string, any]> = [];
let serviceCalls: Array<[string, any]> = [];
let sessionError: { code: string; message: string } | null = null;

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: signedIn } }) },
  rpc: async (name: string, args: any) => {
    sessionCalls.push([name, args]);
    return sessionError ? { data: null, error: sessionError } : { data: 'rule-id', error: null };
  },
};

/** What the GET reads: the overview, the coverage, the inboxes the caller sees, the automations. */
let overviewData: any = { rules: [] };
let coverageData: any[] = [];
let visibleInboxes: string[] = [];
let triageRules: Array<{ id: string; inbox_id: string | null }> = [];

const serviceClient = {
  from: (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { role } }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: table === 'triage_rules' ? triageRules : [], error: null }).then(resolve),
    };
    return chain;
  },
  rpc: async (name: string, args: any) => {
    serviceCalls.push([name, args]);
    if (name === 'no_approval_rules_overview') return { data: overviewData, error: null };
    if (name === 'no_approval_workspace_coverage') return { data: coverageData, error: null };
    if (name === 'visible_inbox_ids') return { data: visibleInboxes, error: null };
    return { data: [], error: null };
  },
};

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => sessionClient } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => serviceClient } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });

const collection = await import('./route.ts');
const single = await import('./[id]/route.ts');
const confirm = await import('./[id]/confirm/route.ts');
const pause = await import('./pause/route.ts');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const params = { params: Promise.resolve({ id: ID }) };
const body = { name: 'Books', recipients: ['a@example.com'], scope: 'all_automations', enabled: true };

function request(method: string, data: unknown = body, headers: Record<string, string> = {}) {
  const url = 'https://mcpemails.com/api/no-approval-rules';
  const init: any = {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://mcpemails.com', host: 'mcpemails.com', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
  };
  const req: any = new Request(url, init);
  req.nextUrl = new URL(url);
  return req;
}

function reset() {
  signedIn = { id: 'user-1' };
  role = 'owner';
  sessionCalls = [];
  serviceCalls = [];
  sessionError = null;
  overviewData = { rules: [] };
  coverageData = [];
  visibleInboxes = [];
  triageRules = [];
}

const writes: Array<[string, () => Promise<Response>]> = [
  ['create', () => collection.POST(request('POST'))],
  ['save', () => single.PATCH(request('PATCH'), params)],
  ['delete', () => single.DELETE(request('DELETE', {}), params)],
  ['confirm', () => confirm.POST(request('POST', { automation_id: ID }), params)],
  ['pause', () => pause.POST(request('POST', { paused: false }))],
];

test('a member gets 403 on every write, and the database is not asked', async () => {
  for (const [name, call] of writes) {
    reset();
    role = 'member';
    const response = await call();
    assert.equal(response.status, 403, name);
    assert.equal(sessionCalls.length, 0, name);
  }
});

test('no session, no write: an API key has no way in', async () => {
  for (const [name, call] of writes) {
    reset();
    signedIn = null;
    const response = await call();
    assert.equal(response.status, 401, name);
    assert.equal(sessionCalls.length, 0, name);
  }
});

test('a bearer key on the request changes nothing', async () => {
  reset();
  signedIn = null;
  const response = await collection.POST(request('POST', body, { authorization: 'Bearer mcpe_live_x' }));
  assert.equal(response.status, 401);
  assert.equal(sessionCalls.length, 0);
});

test('an owner writes as themselves, never through the service role', async () => {
  for (const [name, call] of writes) {
    reset();
    const response = await call();
    assert.ok(response.status < 300, `${name}: ${response.status}`);
    assert.equal(sessionCalls.length, 1, name);
    assert.equal(sessionCalls[0][1].p_workspace_id, 'ws-1', name);
    assert.equal(serviceCalls.length, 0, `${name} wrote with the service role`);
  }
});

test('a client can not name the workspace', async () => {
  reset();
  await collection.POST(request('POST', { ...body, workspace_id: 'other', p_workspace_id: 'other' }));
  assert.equal(sessionCalls[0][1].p_workspace_id, 'ws-1');
});

test('a cross-site request is refused', async () => {
  reset();
  const response = await collection.POST(request('POST', body, { origin: 'https://evil.example' }));
  assert.equal(response.status, 403);
  assert.equal(sessionCalls.length, 0);
});

test('the database refusing is a 403 too', async () => {
  reset();
  sessionError = { code: '42501', message: 'no_approval_forbidden' };
  const response = await collection.POST(request('POST'));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'forbidden');
});

test('a wildcard never reaches the database', async () => {
  reset();
  const response = await collection.POST(request('POST', { ...body, recipients: ['*@example.com'] }));
  assert.equal(response.status, 400);
  assert.equal(sessionCalls.length, 0);
});

test('reading is for every member', async () => {
  reset();
  role = 'member';
  const response = await collection.GET();
  assert.equal(response.status, 200);
  assert.equal(sessionCalls.length, 0);
  reset();
  signedIn = null;
  assert.equal((await collection.GET()).status, 401);
});

// ── Business privacy model (migration 20261111190000) ───────────────────────

test('privacy: automations on someone else\'s private inbox are left out of the overview and the coverage', async () => {
  reset();
  visibleInboxes = ['inbox-company'];
  triageRules = [
    { id: 'auto-visible', inbox_id: 'inbox-company' },
    { id: 'auto-private', inbox_id: 'inbox-someone-else' },
  ];
  overviewData = {
    paused_all: false,
    rules: [{ id: 'r1', name: 'Books', automations: [{ id: 'auto-visible', name: 'Invoices' }, { id: 'auto-private', name: 'Payroll for Kari' }] }],
  };
  coverageData = [
    { triage_rule_id: 'auto-visible', runs_without_approval: true },
    { triage_rule_id: 'auto-private', runs_without_approval: true },
  ];
  const res = await collection.GET();
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.deepEqual(payload.overview.rules[0].automations.map((a: any) => a.id), ['auto-visible']);
  assert.deepEqual(payload.coverage.map((row: any) => row.triage_rule_id), ['auto-visible']);
  assert.equal(JSON.stringify(payload).includes('Payroll for Kari'), false);
  assert.equal(payload.overview.paused_all, false);
});
