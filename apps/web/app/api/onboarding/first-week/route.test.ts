// ---------------------------------------------------------------------------
// GET and POST /api/onboarding/first-week
//
// Pins: only the owner of the active, paid workspace inside the 14 day window
// gets counts; every query after the owner check is scoped to that workspace;
// the 10-call error read is newest first; dismissal is saved per workspace in
// the owner's user_metadata and turns the next GET off.
//
// Run: npm run test:first-week-route
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
let user: { id: string; user_metadata: Record<string, unknown> } | null = null;
let activeWorkspace: string | null = null;
let tables: Record<string, Row[]> = {};
let queriedWorkspaceIds: unknown[] = [];

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let order: { col: string; asc: boolean } | null = null;
  let limit = Infinity;
  let head = false;
  const b: Record<string, unknown> = {};
  const rows = () => {
    let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (order) {
      const { col, asc } = order;
      out = [...out].sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    return out.slice(0, limit);
  };
  b.select = (_cols: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return b; };
  b.eq = (c: string, v: unknown) => {
    if (c === 'workspace_id' || (table === 'workspaces' && c === 'id')) queriedWorkspaceIds.push(v);
    filters.push((r) => r[c] === v);
    return b;
  };
  b.is = (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; };
  b.gte = (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return b; };
  b.order = (col: string, o: { ascending: boolean }) => { order = { col, asc: o.ascending }; return b; };
  b.limit = (n: number) => { limit = n; return b; };
  b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
  b.then = (resolve: (v: unknown) => unknown) => {
    const r = rows();
    return resolve(head ? { count: r.length, data: null, error: null } : { data: r, error: null });
  };
  return b;
}

const userClient = {
  auth: {
    getUser: async () => ({ data: { user } }),
    updateUser: async ({ data }: { data: Record<string, unknown> }) => {
      if (user) user.user_metadata = { ...user.user_metadata, ...data };
      return { error: null };
    },
  },
};

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => userClient } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => ({ from: query }) } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => activeWorkspace } });
nodeMock.module('next/server', {
  namedExports: { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
});

const { GET, POST } = await import('./route.ts');

const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();

function reset() {
  user = { id: 'owner', user_metadata: {} };
  activeWorkspace = 'ws-own';
  queriedWorkspaceIds = [];
  tables = {
    workspaces: [
      { id: 'ws-own', owner_id: 'owner', plan: 'personal', deleted_at: null },
      { id: 'ws-other', owner_id: 'someone-else', plan: 'solo', deleted_at: null },
    ],
    product_funnel_events: [
      { workspace_id: 'ws-own', stage: 'checkout_completed', occurred_at: ago(3) },
      { workspace_id: 'ws-own', stage: 'checkout_completed', occurred_at: ago(1) },
    ],
    activity_log: [
      { workspace_id: 'ws-own', status: 'success', error_code: null, inbox_id: 'ib-1', created_at: ago(2, 2) },
      { workspace_id: 'ws-own', status: 'success', error_code: null, inbox_id: 'ib-1', created_at: ago(2, 1) },
      { workspace_id: 'ws-own', status: 'error', error_code: 'auth_failed', inbox_id: 'ib-1', created_at: ago(0, 2) },
      { workspace_id: 'ws-own', status: 'success', error_code: null, inbox_id: 'ib-1', created_at: ago(0, 1) },
      { workspace_id: 'ws-own', status: 'success', error_code: null, inbox_id: 'ib-1', created_at: ago(10) },
      { workspace_id: 'ws-other', status: 'success', error_code: null, inbox_id: 'ib-9', created_at: ago(1) },
    ],
    triage_rules: [
      { workspace_id: 'ws-own', deleted_at: '2026-10-01T00:00:00Z' },
      { workspace_id: 'ws-own', deleted_at: null },
      { workspace_id: 'ws-other', deleted_at: null },
    ],
  };
}

test('GET: the owner gets counts since the first payment, scoped to their workspace', async () => {
  reset();
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.eligible, true);
  assert.equal(body.counts.paidAt, tables.product_funnel_events[0].occurred_at, 'the FIRST checkout, not a later one');
  assert.equal(body.counts.successDays >= 1 && body.counts.successDays <= 3, true);
  assert.deepEqual(body.counts.recentErrorCodes, [null, 'auth_failed', null, null], 'newest first, nothing from before payment');
  assert.equal(body.counts.troubleInboxId, 'ib-1');
  assert.equal(body.counts.automationCount, 1, 'deleted rules and other workspaces do not count');
  assert.equal(queriedWorkspaceIds.every((id) => id === 'ws-own'), true, 'never queries another workspace');
});

test('GET: a member of a workspace they do not own is not eligible, and nothing else is read', async () => {
  reset();
  activeWorkspace = 'ws-other';
  const body = await (await GET()).json();
  assert.deepEqual(body, { eligible: false });
  assert.deepEqual(queriedWorkspaceIds, ['ws-other']);
});

test('GET: free plan, no payment, or paid 14+ days ago is not eligible', async () => {
  reset();
  tables.workspaces[0].plan = 'free';
  assert.equal((await (await GET()).json()).eligible, false);
  reset();
  tables.product_funnel_events = [];
  assert.equal((await (await GET()).json()).eligible, false);
  reset();
  tables.product_funnel_events = [{ workspace_id: 'ws-own', stage: 'checkout_completed', occurred_at: ago(14, 1) }];
  assert.equal((await (await GET()).json()).eligible, false);
});

test('GET and POST: signed out is 401', async () => {
  reset();
  user = null;
  assert.equal((await GET()).status, 401);
  assert.equal((await POST()).status, 401);
});

test('POST: dismissal is stored for this workspace and the next GET is off', async () => {
  reset();
  user!.user_metadata = { first_week_checklist_dismissed: ['ws-older'], full_name: 'Ada' };
  const res = await POST();
  assert.equal(res.status, 200);
  assert.deepEqual(user!.user_metadata.first_week_checklist_dismissed, ['ws-older', 'ws-own']);
  assert.equal(user!.user_metadata.full_name, 'Ada', 'other metadata untouched');
  assert.deepEqual(await (await GET()).json(), { eligible: false });
});

test('POST: no active workspace is 404', async () => {
  reset();
  activeWorkspace = null;
  assert.equal((await POST()).status, 404);
});
