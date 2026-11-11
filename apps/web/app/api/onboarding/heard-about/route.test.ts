// ---------------------------------------------------------------------------
// POST /api/onboarding/heard-about
//
// Pins: signed out is 401; a bad body is 400 and writes nothing; a non-member
// is 404; a member's answer is saved once with heard_about_at, and the funnel
// row follows; a second POST (answer or dismiss) is 409 and changes nothing;
// dismiss stamps heard_about_at with no answer; only POST is exported.
//
// Run: npm run test:heard-about-route
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
let user: { id: string } | null = null;
let activeWorkspace: string | null = null;
let tables: Record<string, Row[]> = {};
let funnel: Array<Record<string, unknown>> = [];

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  const b: Record<string, unknown> = {};
  const matching = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  b.select = () => b;
  b.update = (p: Row) => { patch = p; return b; };
  b.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; };
  b.is = (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; };
  b.maybeSingle = async () => ({ data: matching()[0] ?? null, error: null });
  b.then = (resolve: (v: unknown) => unknown) => {
    const rows = matching();
    if (patch) for (const r of rows) Object.assign(r, patch);
    return resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
  };
  return b;
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => ({ from: query }) } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => activeWorkspace } });
nodeMock.module('@/lib/analytics/product-funnel', {
  namedExports: { recordProductFunnelEvent: async (_db: unknown, event: Record<string, unknown>) => { funnel.push(event); } },
});
nodeMock.module('next/server', {
  namedExports: { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
});

const routeModule = await import('./route.ts');
const { POST } = routeModule;

function reset() {
  user = { id: 'owner' };
  activeWorkspace = 'ws-own';
  funnel = [];
  tables = {
    workspaces: [
      { id: 'ws-own', deleted_at: null, heard_about: null, heard_about_other: null, heard_about_at: null },
      { id: 'ws-other', deleted_at: null, heard_about: null, heard_about_other: null, heard_about_at: null },
    ],
    workspace_members: [
      { workspace_id: 'ws-own', user_id: 'owner' },
      { workspace_id: 'ws-own', user_id: 'member' },
    ],
  };
}

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/onboarding/heard-about', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

const own = () => tables.workspaces.find((w) => w.id === 'ws-own')!;
const other = () => tables.workspaces.find((w) => w.id === 'ws-other')!;

test('only POST is exported (other methods answer 405 from Next)', () => {
  assert.deepEqual(Object.keys(routeModule).filter((k) => /^[A-Z]+$/.test(k)).sort(), ['POST']);
});

test('signed out: 401, nothing written', async () => {
  reset();
  user = null;
  const res = await post({ answer: 'chatgpt' });
  assert.equal(res.status, 401);
  assert.equal(own().heard_about_at, null);
});

test('bad body: 400, nothing written', async () => {
  reset();
  for (const body of ['not json', { answer: 'tiktok' }, { answer: 'other', other: 'x'.repeat(201) }, {}]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(own().heard_about_at, null);
  assert.equal(funnel.length, 0);
});

test('not a member of the resolved workspace: 404, nothing written', async () => {
  reset();
  activeWorkspace = 'ws-other';
  const res = await post({ answer: 'chatgpt' });
  assert.equal(res.status, 404);
  assert.equal(other().heard_about_at, null);
});

test('a member answers once; the second POST is 409 and changes nothing', async () => {
  reset();
  const res = await post({ answer: 'other', other: ' a newsletter ' });
  assert.equal(res.status, 200);
  assert.equal(own().heard_about, 'other');
  assert.equal(own().heard_about_other, 'a newsletter');
  assert.equal(typeof own().heard_about_at, 'string');
  assert.equal(other().heard_about_at, null, 'only the active workspace');
  assert.deepEqual(funnel.map((e) => [e.stage, e.category, e.workspaceId]), [['heard_about_answered', 'surface_overview', 'ws-own']]);

  const stamp = own().heard_about_at;
  const again = await post({ answer: 'claude' });
  assert.equal(again.status, 409);
  const dismissAfter = await post({ dismiss: true });
  assert.equal(dismissAfter.status, 409);
  assert.equal(own().heard_about, 'other');
  assert.equal(own().heard_about_at, stamp);
  assert.equal(funnel.length, 1);
});

test('dismiss stamps the time with no answer, and ends it', async () => {
  reset();
  user = { id: 'member' };
  const res = await post({ dismiss: true });
  assert.equal(res.status, 200);
  assert.equal(own().heard_about, null);
  assert.equal(typeof own().heard_about_at, 'string');
  assert.equal(funnel[0].stage, 'heard_about_dismissed');
  assert.equal((await post({ answer: 'chatgpt' })).status, 409);
});
