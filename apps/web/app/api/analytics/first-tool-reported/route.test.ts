// ---------------------------------------------------------------------------
// POST /api/analytics/first-tool-reported
//
// After 20261016160100_workspaces_server_owned_writes.sql the user's own
// session cannot write public.workspaces, so this stamp goes through the
// service role. These tests pin that it still lands, only on the caller's own
// workspace, only once, and only for the owner (what the old owner-only RLS
// policy allowed).
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/analytics/first-tool-reported/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
let user: { id: string } | null = null;
let activeWorkspace: string | null = null;
let workspaces: Row[] = [];

function fakeClient(role: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from(table: string) {
      assert.equal(table, 'workspaces');
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row = {};
      const builder: Record<string, unknown> = {};
      builder.update = (v: Row) => { patch = v; return builder; };
      builder.eq = (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; };
      builder.is = (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; };
      builder.then = (resolve: (v: unknown) => unknown) => {
        // The user's session holds no UPDATE privilege on workspaces any more.
        if (role === 'user') return resolve({ error: { code: '42501', message: 'permission denied for table workspaces' } });
        for (const r of workspaces) if (filters.every((f) => f(r))) Object.assign(r, patch);
        return resolve({ error: null });
      };
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeClient('user') } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeClient('service') } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => activeWorkspace } });
nodeMock.module('next/server', {
  namedExports: { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
});

const { POST } = await import('./route.ts');

function reset() {
  user = { id: 'owner' };
  activeWorkspace = 'ws-own';
  workspaces = [
    { id: 'ws-own', owner_id: 'owner', analytics_first_tool_reported_at: null },
    { id: 'ws-shared', owner_id: 'someone-else', analytics_first_tool_reported_at: null },
  ];
}

test("the owner's stamp lands through the service role", async () => {
  reset();
  const res = await POST();
  assert.equal(res.status, 200);
  assert.equal(typeof workspaces[0].analytics_first_tool_reported_at, 'string');
  assert.equal(workspaces[1].analytics_first_tool_reported_at, null);
});

test('an existing stamp is never moved', async () => {
  reset();
  workspaces[0].analytics_first_tool_reported_at = '2026-09-01T00:00:00.000Z';
  await POST();
  assert.equal(workspaces[0].analytics_first_tool_reported_at, '2026-09-01T00:00:00.000Z');
});

test("a member's active workspace that they do not own is left alone, as before", async () => {
  reset();
  user = { id: 'member' };
  activeWorkspace = 'ws-shared';
  const res = await POST();
  assert.equal(res.status, 200);
  assert.equal(workspaces[1].analytics_first_tool_reported_at, null);
});

test('no session is 401 and no workspace is 404, with no write', async () => {
  reset();
  user = null;
  assert.equal((await POST()).status, 401);
  reset();
  activeWorkspace = null;
  assert.equal((await POST()).status, 404);
  assert.equal(workspaces.every((w) => w.analytics_first_tool_reported_at === null), true);
});
