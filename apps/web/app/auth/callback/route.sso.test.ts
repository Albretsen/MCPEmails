// ---------------------------------------------------------------------------
// SAML SSO through GET /auth/callback: an SSO session joins its connection's
// workspace via add_workspace_member and is audited; one that cannot be
// placed (unknown, unverified, disabled, contract missing) is signed out and
// sent to /auth/error. Non-SSO sign-ins never touch any of it.
//
// Run: npm run test:sso
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

// Only reserved example domains.
const PROVIDER = '550ed000-0000-0000-0000-0000000000a1';
const WORKSPACE = 'aaaaaaaa-0000-0000-0000-000000000001';

type User = { id: string; email: string; created_at: string; app_metadata: { provider: string } };

let user: User | null = null;
let routedProvider: string | null = PROVIDER;
let connection: Record<string, unknown> | null = null;
let addMemberError: { code?: string; message: string } | null = null;
let signOuts: unknown[] = [];
let rpcs: Array<{ fn: string; args: unknown }> = [];
let inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

function fakeClient() {
  const client = {
    auth: {
      exchangeCodeForSession: async () => ({ data: { user, session: {} }, error: null }),
      getUser: async () => ({ data: { user } }),
      signOut: async (opts?: unknown) => {
        signOuts.push(opts);
        return { error: null };
      },
    },
    rpc(fn: string, args: unknown) {
      assert.equal(this, client);
      rpcs.push({ fn, args });
      if (fn === 'sso_provider_for_domain') return Promise.resolve({ data: routedProvider, error: null });
      if (fn === 'add_workspace_member') return Promise.resolve({ data: null, error: addMemberError });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      assert.equal(this, client);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.is = () => builder;
      builder.update = () => builder;
      builder.maybeSingle = async () => ({ data: table === 'sso_connections' ? connection : null, error: null });
      builder.insert = async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: null };
      };
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
      return builder;
    },
  };
  return client;
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeClient() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeClient() } });
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: {
      redirect: (url: string) => new Response(null, { status: 307, headers: { location: url } }),
    },
  },
});

const { GET } = await import('./route.ts');

function reset(overrides: Partial<User> = {}) {
  user = {
    id: 'user-1',
    email: 'pat@company-sso.example',
    created_at: new Date(Date.now() - 1000).toISOString(),
    app_metadata: { provider: `sso:${PROVIDER}` },
    ...overrides,
  };
  routedProvider = PROVIDER;
  connection = { id: 'conn-1', workspace_id: WORKSPACE, status: 'active', default_role: 'member' };
  addMemberError = null;
  signOuts = [];
  rpcs = [];
  inserts = [];
}

const callback = (query = 'code=abc') =>
  GET(new Request(`https://mcpemails.test/auth/callback?${query}`, {
    headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'test-agent' },
  }));

const addMemberCalls = () => rpcs.filter((r) => r.fn === 'add_workspace_member');
const auditRows = () => inserts.filter((i) => i.table === 'activity_log').map((i) => [i.row.tool_name, i.row.status, i.row.error_code]);

test('happy path: joined to the workspace, audited, sent on to next', async () => {
  reset();
  const res = await callback('code=abc&next=%2Fdashboard%2Finboxes');
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/dashboard/inboxes');
  assert.deepEqual(addMemberCalls(), [{
    fn: 'add_workspace_member',
    args: { p_workspace_id: WORKSPACE, p_user_id: 'user-1', p_role: 'member', p_source: 'sso' },
  }]);
  assert.deepEqual(auditRows(), [['sso.jit_join', 'success', null], ['sso.sign_in', 'success', null]]);
  assert.equal(inserts[0].row.workspace_id, WORKSPACE);
  assert.equal(inserts[0].row.ip_address, '203.0.113.7');
  assert.equal(signOuts.length, 0);
});

test('unknown provider: signed out, generic SSO error', async () => {
  reset();
  connection = null;
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/auth/error?reason=sso_not_configured');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.equal(addMemberCalls().length, 0);
});

test('unverified domain: signed out, audited, not joined', async () => {
  reset();
  routedProvider = null;
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/auth/error?reason=sso_not_configured');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.equal(addMemberCalls().length, 0);
  assert.deepEqual(auditRows(), [['sso.sign_in', 'error', 'domain_not_verified']]);
});

test('disabled connection: signed out, audited, not joined', async () => {
  reset();
  connection = { id: 'conn-1', workspace_id: WORKSPACE, status: 'disabled', default_role: 'member' };
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/auth/error?reason=sso_not_configured');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.equal(addMemberCalls().length, 0);
  assert.deepEqual(auditRows(), [['sso.sign_in', 'error', 'connection_disabled']]);
});

test('add_workspace_member not shipped yet: signed out with the join error', async () => {
  reset();
  addMemberError = { code: 'PGRST202', message: 'Could not find the function public.add_workspace_member' };
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/auth/error?reason=sso_join_failed');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.deepEqual(auditRows(), [['sso.jit_join', 'error', 'contract_missing']]);
});

test('a non-SSO sign-in never runs the SSO branch', async () => {
  reset({ app_metadata: { provider: 'google' } });
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/dashboard');
  assert.equal(rpcs.length, 0);
  assert.equal(inserts.length, 0);
  assert.equal(signOuts.length, 0);
});
