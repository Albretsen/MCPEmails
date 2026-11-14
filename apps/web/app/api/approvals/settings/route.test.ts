// ---------------------------------------------------------------------------
// /api/approvals/settings: the active workspace's approval window.
//
//   GET  any member reads it, plus canEdit
//   PUT  owner/admin, same origin, JSON, one of 24/72/168/336; every change is
//        a workspace_audit_events row
//
// Run: npm run test:approvals
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { NextRequest } from 'next/server';

/* eslint-disable @typescript-eslint/no-explicit-any */

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let signedIn = true;
let role: string | null = 'owner';
let stored: unknown = 24;
let writes: Array<Record<string, unknown>> = [];
let audits: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: 'user-1' } : null } }) } }),
  },
});
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-1' } });
nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => role,
    canManageWorkspace: (r: string | null) => r === 'owner' || r === 'admin',
  },
});
nodeMock.module('@/lib/workspace/audit-events', {
  namedExports: { recordWorkspaceAuditEvent: async (_db: unknown, input: Record<string, unknown>) => (audits.push(input), true) },
});
nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from(table: string) {
        assert.equal(table, 'workspaces');
        let patch: Record<string, unknown> | null = null;
        const b: any = {};
        const chain = () => b;
        Object.assign(b, {
          select: chain,
          eq: chain,
          is: chain,
          update: (p: Record<string, unknown>) => { patch = p; return b; },
          maybeSingle: async () => {
            if (patch) { writes.push(patch); stored = patch.approval_window_hours; }
            return { data: { approval_window_hours: stored }, error: null };
          },
        });
        return b;
      },
    }),
  },
});

const route = (await import('./route.ts')) as any;

function put(body: unknown, headers: Record<string, string> = {}) {
  return route.PUT(new NextRequest('https://mcpemails.com/api/approvals/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'https://mcpemails.com', host: 'mcpemails.com', ...headers },
    body: JSON.stringify(body),
  }));
}

function reset() {
  signedIn = true; role = 'owner'; stored = 24; writes = []; audits = [];
}

test('GET: a member reads the window and may not edit it', async () => {
  reset(); role = 'member'; stored = 168;
  const body = await (await route.GET()).json();
  assert.deepEqual(body, { windowHours: 168, canEdit: false });
});

test('GET: an unknown stored value reads as the 24h default', async () => {
  reset(); stored = null;
  assert.equal((await (await route.GET()).json()).windowHours, 24);
});

test('GET: no session is 401', async () => {
  reset(); signedIn = false;
  assert.equal((await route.GET()).status, 401);
});

test('PUT: an owner sets 7 days, and the change is audited', async () => {
  reset();
  const res = await put({ windowHours: 168 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { windowHours: 168 });
  assert.deepEqual(writes, [{ approval_window_hours: 168 }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].kind, 'approval_window_changed');
  assert.deepEqual(audits[0].details, { from_hours: 24, to_hours: 168 });
});

test('PUT: saving the same value writes no audit row', async () => {
  reset(); stored = 72;
  assert.equal((await put({ windowHours: 72 })).status, 200);
  assert.equal(audits.length, 0);
});

test('PUT: a member is refused and nothing is written', async () => {
  reset(); role = 'member';
  const res = await put({ windowHours: 336 });
  assert.equal(res.status, 403);
  assert.equal(writes.length, 0);
});

test('PUT: a value outside the four windows is 400', async () => {
  for (const windowHours of [0, 48, 1000, '168', null]) {
    reset();
    const res = await put({ windowHours });
    assert.equal(res.status, 400, String(windowHours));
    assert.equal(writes.length, 0);
  }
});

test('PUT: a cross-origin request is refused', async () => {
  reset();
  const res = await put({ windowHours: 168 }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(writes.length, 0);
});
