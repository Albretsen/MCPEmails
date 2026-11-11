// Business billed per person: every membership change re-syncs the workspace
// owner's seat count (src/lib/stripe/business-seats.ts), after the response,
// and only once the change has really landed.
//
//   DELETE /api/workspaces/members/[userId]   removing a member
//   PATCH  /api/workspaces/members/[userId]   changing a role (viewer <-> member)
//   POST   /api/workspaces/[id]/leave         leaving
//
// Run: npm run test:member-seat-sync
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const WS = 'ws-team';
let callerRole: string | null = 'owner';
let targetRole = 'member';
let writeError: { message: string } | null = null;

const realNextServer = await import('next/server');
const afterTasks: Array<Promise<unknown>> = [];
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: realNextServer.NextRequest,
    NextResponse: realNextServer.NextResponse,
    after: (task: () => unknown) => {
      afterTasks.push(Promise.resolve().then(task));
    },
  },
});

const seatSyncs: string[] = [];
nodeMock.module('@/lib/stripe/business-seats', {
  namedExports: {
    syncBusinessSeatsForWorkspace: async (workspaceId: string) => {
      seatSyncs.push(workspaceId);
      return { status: 'unchanged', quantity: 2 };
    },
  },
});

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'caller' } }, error: null }) },
    }),
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from() {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: chain,
          update: chain,
          eq: chain,
          single: async () => ({ data: { role: targetRole }, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: writeError }).then(resolve),
        });
        return builder;
      },
    }),
  },
});

nodeMock.module('@/lib/workspace/roles', {
  namedExports: {
    fetchWorkspaceRole: async () => callerRole,
    canManageWorkspace: (role: string) => role === 'owner' || role === 'admin',
  },
});

nodeMock.module('@/lib/workspace/membership', {
  namedExports: {
    removeWorkspaceMember: async () => ({ error: writeError }),
    revokeApiKeysBeyondViewerScopes: async () => ({ revokedKeyIds: [], error: null }),
    demotionRevocationNotice: () => '',
  },
});

nodeMock.module('@/lib/plans/check-member-limit', {
  namedExports: {
    checkMemberLimit: async () => ({
      resolved: true,
      atLimit: false,
      plan: 'pro',
      currentCount: 3,
      maxMembers: null,
      teamRolesEnabled: true,
    }),
  },
});

const members = await import('./route.ts');
const leave = await import('../../[id]/leave/route.ts');

function reset(opts: { caller?: string | null; target?: string; fail?: boolean } = {}) {
  callerRole = opts.caller === undefined ? 'owner' : opts.caller;
  targetRole = opts.target ?? 'member';
  writeError = opts.fail ? { message: 'boom' } : null;
  seatSyncs.length = 0;
  afterTasks.length = 0;
}

async function settled() {
  await Promise.all(afterTasks);
}

const req = (url: string, init?: { method: string; body?: string }) =>
  new realNextServer.NextRequest(new URL(url, 'https://mcpemails.com'), init);

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

test('removing a member re-syncs the seat count', async () => {
  reset();
  const res = await members.DELETE(req(`/api/workspaces/members/u2?workspaceId=${WS}`, { method: 'DELETE' }), {
    params: Promise.resolve({ userId: 'u2' }),
  });
  assert.equal(res.status, 200);
  await settled();
  assert.deepEqual(seatSyncs, [WS]);
});

test('a removal that failed or was refused syncs nothing', async () => {
  reset({ fail: true });
  const failed = await quiet(() =>
    members.DELETE(req(`/api/workspaces/members/u2?workspaceId=${WS}`, { method: 'DELETE' }), {
      params: Promise.resolve({ userId: 'u2' }),
    }),
  );
  assert.equal(failed.status, 500);
  reset({ target: 'owner' });
  const refused = await members.DELETE(req(`/api/workspaces/members/u2?workspaceId=${WS}`, { method: 'DELETE' }), {
    params: Promise.resolve({ userId: 'u2' }),
  });
  assert.equal(refused.status, 403);
  await settled();
  assert.deepEqual(seatSyncs, []);
});

test('a role change re-syncs the seat count', async () => {
  reset();
  const res = await members.PATCH(
    req('/api/workspaces/members/u2', { method: 'PATCH', body: JSON.stringify({ workspaceId: WS, role: 'viewer' }) }),
    { params: Promise.resolve({ userId: 'u2' }) },
  );
  assert.equal(res.status, 200);
  await settled();
  assert.deepEqual(seatSyncs, [WS]);
});

test('a role change that failed to write syncs nothing', async () => {
  reset({ fail: true });
  const res = await quiet(() =>
    members.PATCH(
      req('/api/workspaces/members/u2', { method: 'PATCH', body: JSON.stringify({ workspaceId: WS, role: 'member' }) }),
      { params: Promise.resolve({ userId: 'u2' }) },
    ),
  );
  assert.equal(res.status, 500);
  await settled();
  assert.deepEqual(seatSyncs, []);
});

test('leaving re-syncs the seat count; an owner cannot leave and syncs nothing', async () => {
  reset({ caller: 'member' });
  const res = await leave.POST(req(`/api/workspaces/${WS}/leave`, { method: 'POST' }), {
    params: Promise.resolve({ id: WS }),
  });
  assert.equal(res.status, 200);
  await settled();
  assert.deepEqual(seatSyncs, [WS]);

  reset({ caller: 'owner' });
  const owner = await leave.POST(req(`/api/workspaces/${WS}/leave`, { method: 'POST' }), {
    params: Promise.resolve({ id: WS }),
  });
  assert.equal(owner.status, 403);
  await settled();
  assert.deepEqual(seatSyncs, []);
});
