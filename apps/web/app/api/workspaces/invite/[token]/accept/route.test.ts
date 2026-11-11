// POST /api/workspaces/invite/[token]/accept: accepting an invite makes the
// joined workspace the active one, so a person who signed up through the
// invite (and so also owns a fresh personal Free workspace) lands in the team
// workspace instead of their own, and connects their inbox there.
//
// Run: npm run test:invite-accept-route
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type RpcResult = { data: unknown; error: { code: string; message: string } | null };
let user: { id: string } | null = { id: 'user-1' };
let rpcResult: RpcResult = { data: null, error: null };
const rpcCalls: Array<{ fn: string; args: unknown }> = [];

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => {
      type Client = {
        auth: { getUser: () => Promise<{ data: { user: typeof user }; error: null }> };
        rest: object;
        rpc: (this: Client, fn: string, args: unknown) => Promise<RpcResult>;
      };
      const client: Client = {
        auth: { getUser: async () => ({ data: { user }, error: null }) },
        rest: {},
        rpc(fn, args) {
          // Mirrors supabase-js: rpc dereferences `this`, so an unbound call throws.
          if (!this?.rest) throw new TypeError('rpc called unbound');
          rpcCalls.push({ fn, args });
          return Promise.resolve(rpcResult);
        },
      };
      return client;
    },
  },
});

// The real NextRequest / NextResponse (the cookie assertions need them), with
// `after` run inline: outside a Next request scope the real one throws.
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

// Business billed per person: the accept re-syncs the owner's seat count.
const seatSyncs: string[] = [];
nodeMock.module('@/lib/stripe/business-seats', {
  namedExports: {
    syncBusinessSeatsForWorkspace: async (workspaceId: string) => {
      seatSyncs.push(workspaceId);
      return { status: 'skipped', reason: 'switch_off' };
    },
  },
});

const route = await import('./route.ts');
const { ACTIVE_WORKSPACE_COOKIE } = await import('@/lib/workspace/active');

function accept(token = 'raw-token') {
  return route.POST(
    new Request(`https://mcpemails.com/api/workspaces/invite/${token}/accept`, { method: 'POST' }) as never,
    { params: Promise.resolve({ token }) },
  );
}

test('accepting sets the joined workspace as the active one', async () => {
  user = { id: 'user-1' };
  rpcResult = { data: [{ workspace_id: 'ws-team', workspace_slug: 'team', role: 'member' }], error: null };
  rpcCalls.length = 0;

  const res = await accept();

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { workspaceId: 'ws-team', workspaceSlug: 'team', role: 'member' });
  assert.equal(rpcCalls[0]?.fn, 'accept_workspace_invite');
  const cookie = res.cookies.get(ACTIVE_WORKSPACE_COOKIE);
  assert.equal(cookie?.value, 'ws-team');
  assert.equal(cookie?.httpOnly, true);
  assert.equal(cookie?.path, '/');
});

test('accepting re-syncs the per-person seat count of the joined workspace, after the response', async () => {
  user = { id: 'user-1' };
  rpcResult = { data: [{ workspace_id: 'ws-team', workspace_slug: 'team', role: 'member' }], error: null };
  seatSyncs.length = 0;
  afterTasks.length = 0;

  await accept();
  await Promise.all(afterTasks);

  assert.deepEqual(seatSyncs, ['ws-team']);
});

test('a refused invite leaves the active workspace alone', async () => {
  user = { id: 'user-1' };
  rpcResult = { data: null, error: { code: 'P0003', message: 'invite_expired' } };

  seatSyncs.length = 0;
  const res = await accept();

  assert.notEqual(res.status, 200);
  assert.equal(res.cookies.get(ACTIVE_WORKSPACE_COOKIE), undefined);
  await Promise.all(afterTasks);
  assert.deepEqual(seatSyncs, [], 'a refused invite changes nobody\'s bill');
});

test('a signed-out caller is a 401 and sets nothing', async () => {
  user = null;

  const res = await accept();

  assert.equal(res.status, 401);
  assert.equal(res.cookies.get(ACTIVE_WORKSPACE_COOKIE), undefined);
});
