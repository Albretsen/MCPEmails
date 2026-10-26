// ---------------------------------------------------------------------------
// POST /api/onboarding (the /onboarding flow's actions) and
// GET /api/onboarding/status. Supabase, the funnel writer, the reset and the
// internal check are stubbed; the pure parts have their own tests in
// src/lib/onboarding/*.test.*.
//
// Run: npm run test:onboarding-routes
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let user: { id: string; email: string } | null = { id: 'u1', email: 'asgeir@mcpemails.com' };
let ownerId = 'u1';
let internal = true;
let resetOk = true;
const funnel: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
let resets = 0;
let claimedRows: Array<Record<string, unknown>> = [{ onboarding_client: 'claude' }];

function chain(table: string) {
  const q: Record<string, unknown> = {};
  let pendingUpdate: Record<string, unknown> | null = null;
  const self = new Proxy(q, {
    get(_t, prop) {
      if (prop === 'update') return (patch: Record<string, unknown>) => { pendingUpdate = patch; updates.push({ table, ...patch }); return self; };
      if (prop === 'maybeSingle') return async () => ({ data: table === 'workspaces' ? { owner_id: ownerId } : null, error: null });
      if (prop === 'select') return () => (pendingUpdate ? { then: (r: (v: unknown) => void) => r({ data: claimedRows, error: null }) } : self);
      if (prop === 'then') return (r: (v: unknown) => void) => r({ data: null, error: null });
      return () => self;
    },
  });
  return self;
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) },
});
nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: () => ({ from: (table: string) => chain(table) }) },
});
nodeMock.module('@/lib/workspace/active', {
  namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' },
});
nodeMock.module('@/lib/analytics/product-funnel', {
  namedExports: {
    recordProductFunnelEvent: async (_db: unknown, event: Record<string, unknown>) => { funnel.push(event); },
    connectEntryPoint: () => null,
  },
});
nodeMock.module('@/lib/onboarding/reset', {
  namedExports: { resetOnboarding: async () => { resets += 1; return { ok: resetOk, resetAt: '2026-10-26T12:00:00.000Z' }; } },
});
nodeMock.module('@/lib/onboarding/variant', {
  namedExports: { isInternalViewer: async () => internal },
});
nodeMock.module('@/lib/onboarding/status', {
  namedExports: { loadOnboardingStatus: async (_db: unknown, id: string) => ({ workspaceId: id, inboxes: { count: 0 } }) },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const route = (await import('./route.ts')) as Record<string, unknown>;
const statusRoute = (await import('./status/route.ts')) as Record<string, unknown>;
const POST = route.POST as (req: Request) => Promise<Response>;
const STATUS = statusRoute.GET as () => Promise<Response>;

function post(body: unknown) {
  return POST(new Request('https://mcpemails.test/api/onboarding', { method: 'POST', body: JSON.stringify(body) }));
}

function reset() {
  user = { id: 'u1', email: 'asgeir@mcpemails.com' };
  ownerId = 'u1';
  internal = true;
  resetOk = true;
  funnel.length = 0;
  updates.length = 0;
  resets = 0;
  claimedRows = [{ onboarding_client: 'claude' }];
}

test('step_viewed records one funnel row per valid step and refuses others', async () => {
  reset();
  assert.equal((await post({ action: 'step_viewed', step: 'add_to_ai' })).status, 200);
  assert.deepEqual(funnel, [{ workspaceId: 'ws-1', stage: 'onboarding_step_viewed', outcome: 'success', category: 'step_add_to_ai' }]);
  assert.equal((await post({ action: 'step_viewed', step: 'dashboard' })).status, 400);
  assert.equal(funnel.length, 1);
});

test('client_changed stores the chip choice and records it', async () => {
  reset();
  const res = await post({ action: 'client_changed', client: 'claude_code' });
  assert.equal(res.status, 200);
  assert.equal(updates[0]?.onboarding_client, 'claude_code');
  assert.equal(funnel[0]?.stage, 'client_changed');
  assert.equal(funnel[0]?.category, 'claude_code');
  assert.equal((await post({ action: 'client_changed', client: 'unknown' })).status, 400);
  assert.equal((await post({ action: 'client_changed', client: 'Robert' })).status, 400);
});

test('completed stamps once and records the client', async () => {
  reset();
  assert.equal((await post({ action: 'completed' })).status, 200);
  assert.ok('onboarding_completed_at' in (updates[0] ?? {}));
  assert.deepEqual(funnel.map((e) => [e.stage, e.category]), [['onboarding_completed', 'claude']]);
  claimedRows = [];
  funnel.length = 0;
  assert.equal((await post({ action: 'completed' })).status, 200);
  assert.equal(funnel.length, 0, 'second completion records nothing');
});

test('reset: internal owners only', async () => {
  reset();
  const ok = await post({ action: 'reset' });
  assert.equal(ok.status, 200);
  assert.equal(resets, 1);
  assert.equal(funnel[0]?.stage, 'onboarding_reset');

  reset();
  internal = false;
  assert.equal((await post({ action: 'reset' })).status, 403);
  ownerId = 'someone-else';
  internal = true;
  assert.equal((await post({ action: 'reset' })).status, 403);
  assert.equal(resets, 0);

  reset();
  resetOk = false;
  assert.equal((await post({ action: 'reset' })).status, 500);
});

test('flow_b: shown rows, dismiss stamps, Continue on Free stamps, junk refused', async () => {
  reset();
  assert.equal((await post({ action: 'flow_b', event: 'plan_summary_shown', surface: 'overview' })).status, 200);
  assert.deepEqual(funnel, [{ workspaceId: 'ws-1', stage: 'plan_summary_shown', outcome: 'success', category: 'surface_overview' }]);
  assert.equal(updates.length, 0);

  reset();
  assert.equal((await post({ action: 'flow_b', event: 'plan_summary_dismissed', surface: 'onboarding' })).status, 200);
  assert.ok('plan_summary_dismissed_at' in (updates[0] ?? {}));
  assert.equal(funnel[0]?.category, 'surface_onboarding');

  reset();
  assert.equal((await post({ action: 'flow_b', event: 'plan_summary_clicked', plan: 'free' })).status, 200);
  assert.ok('plan_summary_dismissed_at' in (updates[0] ?? {}));
  reset();
  assert.equal((await post({ action: 'flow_b', event: 'plan_summary_clicked', plan: 'solo' })).status, 200);
  assert.equal(updates.length, 0, 'a buy click does not hide the card');
  assert.equal(funnel[0]?.category, 'solo');

  reset();
  assert.equal((await post({ action: 'flow_b', event: 'grace_end_note_dismissed' })).status, 200);
  assert.ok('grace_end_note_seen_at' in (updates[0] ?? {}));
  assert.equal(funnel.length, 0, 'a stamp-only event writes no funnel row');

  reset();
  assert.equal((await post({ action: 'flow_b', event: 'usage_meter_shown', level: 80, since: '2026-11-01T00:00:00Z' })).status, 200);
  assert.equal(funnel[0]?.category, 'level_80');
  for (const junk of [
    { event: 'usage_meter_shown', level: 70, since: '2026-11-01' },
    { event: 'usage_meter_shown', level: 80 },
    { event: 'plan_summary_shown', surface: 'pricing' },
    { event: 'plan_summary_clicked', plan: 'pro' },
    { event: 'drop_tables' },
  ]) {
    assert.equal((await post({ action: 'flow_b', ...junk })).status, 400, JSON.stringify(junk));
  }
});

test('signed out is 401; unknown actions and bad JSON are 400', async () => {
  reset();
  user = null;
  assert.equal((await post({ action: 'step_viewed', step: 'inbox' })).status, 401);
  reset();
  assert.equal((await post({ action: 'drop_tables' })).status, 400);
  const bad = await POST(new Request('https://mcpemails.test/api/onboarding', { method: 'POST', body: '{nope' }));
  assert.equal(bad.status, 400);
});

test('status: GET only, signed in, never cached', async () => {
  reset();
  const res = await STATUS();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(((await res.json()) as { workspaceId: string }).workspaceId, 'ws-1');
  user = null;
  assert.equal((await STATUS()).status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(statusRoute[method], undefined, method);
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(route[method], undefined, method);
});
