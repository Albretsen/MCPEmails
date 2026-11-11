// POST /api/billing/annual-switch end to end through the handler: the flag,
// auth, owner-only writes, the funnel rows (shown deduped per day), and the
// notice dismissal counter. Only POST exists; Next answers 405 for the rest.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/billing/annual-switch/route.test.ts
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';
const WS = '00000000-0000-4000-8000-0000000000c1';

let db = new FakeSupabase();
let user: { id: string } | null = null;

function client() {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => db.from(table),
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client() } });
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const route = await import('./route.ts');

function seed(flag = 'on') {
  process.env.ANNUAL_SWITCH_CARD_ENABLED = flag;
  db = new FakeSupabase();
  user = { id: OWNER };
  db.seed('workspaces', [{ id: WS, owner_id: OWNER, deleted_at: null, annual_switch_dismiss_count: 0, annual_switch_dismissed_at: null }]);
}

function post(body: unknown) {
  return route.POST(
    new Request('https://mcpemails.com/api/billing/annual-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );
}

test('only POST is exported', () => {
  assert.deepEqual(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)), ['POST']);
});

test('flag off: 404 and nothing written', async () => {
  seed('off');
  const res = await post({ event: 'shown', surface: 'billing', workspaceId: WS });
  assert.equal(res.status, 404);
  assert.equal(db.table('product_funnel_events').length, 0);
});

test('signed out is 401; a bad body is 400; another owner is 404', async () => {
  seed();
  user = null;
  assert.equal((await post({ event: 'shown', surface: 'billing', workspaceId: WS })).status, 401);
  user = { id: OWNER };
  assert.equal((await post({ event: 'bought', surface: 'billing', workspaceId: WS })).status, 400);
  assert.equal((await post({ event: 'shown', surface: 'chat', workspaceId: WS })).status, 400);
  assert.equal((await post({ event: 'dismissed', surface: 'billing', workspaceId: WS })).status, 400);
  user = { id: OTHER };
  assert.equal((await post({ event: 'clicked', surface: 'billing', workspaceId: WS })).status, 404);
  assert.equal(db.table('product_funnel_events').length, 0);
});

test('shown is one row per surface and day; every click counts', async () => {
  seed();
  assert.equal((await post({ event: 'shown', surface: 'billing', workspaceId: WS })).status, 200);
  // The fake has no column defaults: stamp what Postgres would.
  for (const row of db.table('product_funnel_events')) row.occurred_at = new Date().toISOString();
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await post({ event: 'shown', surface: 'billing', workspaceId: WS })).status, 200);
  }
  await post({ event: 'shown', surface: 'overview', workspaceId: WS });
  await post({ event: 'clicked', surface: 'billing', workspaceId: WS });
  await post({ event: 'clicked', surface: 'billing', workspaceId: WS });
  const rows = db.table('product_funnel_events').map((r) => `${r.stage}/${r.category}`);
  assert.deepEqual(rows.sort(), [
    'annual_switch_clicked/dashboard_billing',
    'annual_switch_clicked/dashboard_billing',
    'annual_switch_shown/dashboard_billing',
    'annual_switch_shown/surface_overview',
  ]);
});

test('dismissing the notice stamps the workspace and counts up to two', async () => {
  seed();
  assert.equal((await post({ event: 'dismissed', surface: 'overview', workspaceId: WS })).status, 200);
  let ws = db.table('workspaces')[0];
  assert.equal(ws.annual_switch_dismiss_count, 1);
  assert.equal(typeof ws.annual_switch_dismissed_at, 'string');
  await post({ event: 'dismissed', surface: 'overview', workspaceId: WS });
  await post({ event: 'dismissed', surface: 'overview', workspaceId: WS });
  ws = db.table('workspaces')[0];
  assert.equal(ws.annual_switch_dismiss_count, 2);
});
