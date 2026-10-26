// ---------------------------------------------------------------------------
// POST /api/onboarding/authorize-event and the once-per-workspace rule in
// src/lib/onboarding/authorize-funnel.ts. Supabase and the funnel writer are
// stubbed.
//
// Run: npm run test:connector-first
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let user: { id: string } | null = { id: 'u1' };
const funnel: Array<Record<string, unknown>> = [];

function db() {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters[col] = val; return q; },
        limit: async () => ({
          data: funnel.filter((row) => row.workspaceId === filters.workspace_id && row.stage === filters.stage).map(() => ({ id: 1 })),
          error: null,
        }),
      };
      return q;
    },
  };
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: db } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });
nodeMock.module('@/lib/analytics/product-funnel', {
  namedExports: { recordProductFunnelEvent: async (_db: unknown, event: Record<string, unknown>) => { funnel.push(event); } },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const { POST } = (await import('./route.ts')) as unknown as { POST: (req: Request) => Promise<Response> };

function post(body: unknown) {
  return POST(new Request('https://mcpemails.test/api/onboarding/authorize-event', { method: 'POST', body: JSON.stringify(body) }));
}

test('records a browser stage once per workspace, client narrowed', async () => {
  funnel.length = 0;
  user = { id: 'u1' };
  const first = await post({ stage: 'authorize_inbox_step_viewed', client: 'claude' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).recorded, true);
  const again = await post({ stage: 'authorize_inbox_step_viewed', client: 'claude' });
  assert.equal((await again.json()).recorded, false);
  await post({ stage: 'authorize_skipped', client: '<script>' });
  assert.equal(funnel.length, 2);
  assert.deepEqual(funnel.map((e) => [e.stage, e.category, e.outcome]), [
    ['authorize_inbox_step_viewed', 'claude', 'success'],
    ['authorize_skipped', 'unknown', 'success'],
  ]);
});

test('refuses the server-only stage, unknown stages and bad JSON', async () => {
  funnel.length = 0;
  assert.equal((await post({ stage: 'authorize_signup_redirect' })).status, 400);
  assert.equal((await post({ stage: 'checkout_completed' })).status, 400);
  const bad = await POST(new Request('https://mcpemails.test/api/onboarding/authorize-event', { method: 'POST', body: '{' }));
  assert.equal(bad.status, 400);
  assert.equal(funnel.length, 0);
});

test('signed out: 401', async () => {
  user = null;
  assert.equal((await post({ stage: 'authorize_skipped' })).status, 401);
  user = { id: 'u1' };
});
