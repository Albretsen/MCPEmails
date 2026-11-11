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

test('a refused invite leaves the active workspace alone', async () => {
  user = { id: 'user-1' };
  rpcResult = { data: null, error: { code: 'P0003', message: 'invite_expired' } };

  const res = await accept();

  assert.notEqual(res.status, 200);
  assert.equal(res.cookies.get(ACTIVE_WORKSPACE_COOKIE), undefined);
});

test('a signed-out caller is a 401 and sets nothing', async () => {
  user = null;

  const res = await accept();

  assert.equal(res.status, 401);
  assert.equal(res.cookies.get(ACTIVE_WORKSPACE_COOKIE), undefined);
});
