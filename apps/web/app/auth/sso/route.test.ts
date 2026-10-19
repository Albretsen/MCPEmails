// ---------------------------------------------------------------------------
// POST /auth/sso: email -> verified domain -> signInWithSSO({ providerId }).
// Unknown, unverified, disabled and consumer domains all get the same generic
// 404; a failed lookup is a 503, never "no SSO". GET opens the login form.
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

let rpcResult: { data: unknown; error: { message: string } | null } = { data: PROVIDER, error: null };
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
let ssoResult: { data: { url: string } | null; error: { message: string } | null } = {
  data: { url: 'https://idp.example/saml' },
  error: null,
};
let ssoCalls: unknown[] = [];

const service = {
  rpc(fn: string, args: unknown) {
    // rpc() reads `this` in supabase-js; the route must bind it.
    assert.equal(this, service);
    rpcCalls.push({ fn, args });
    return Promise.resolve(rpcResult);
  },
};

nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => service } });
nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        signInWithSSO: async (args: unknown) => {
          ssoCalls.push(args);
          return ssoResult;
        },
      },
    }),
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => Response.json(body, { status: init?.status ?? 200 }),
      redirect: (url: string) => new Response(null, { status: 307, headers: { location: url } }),
    },
  },
});

const { GET, POST } = await import('./route.ts');

function post(body: unknown) {
  return POST(new Request('https://mcpemails.test/auth/sso', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function reset() {
  rpcResult = { data: PROVIDER, error: null };
  rpcCalls = [];
  ssoResult = { data: { url: 'https://idp.example/saml' }, error: null };
  ssoCalls = [];
}

test('happy path: a verified domain starts SAML for its provider, back to /auth/callback', async () => {
  reset();
  const res = await post({ email: ' Pat@Company-SSO.example ', next: '/dashboard/settings' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: 'https://idp.example/saml' });
  assert.deepEqual(rpcCalls, [{ fn: 'sso_provider_for_domain', args: { p_domain: 'company-sso.example' } }]);
  assert.deepEqual(ssoCalls, [{
    providerId: PROVIDER,
    options: { redirectTo: 'https://mcpemails.test/auth/callback?next=%2Fdashboard%2Fsettings' },
  }]);
});

test('an off-site next is dropped', async () => {
  for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
    reset();
    await post({ email: 'pat@company-sso.example', next });
    assert.deepEqual(ssoCalls, [{ providerId: PROVIDER, options: { redirectTo: 'https://mcpemails.test/auth/callback' } }], next);
  }
});

test('unknown domain: generic 404, no SAML', async () => {
  reset();
  rpcResult = { data: null, error: null };
  const res = await post({ email: 'pat@unknown.example' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'sso_not_configured' });
  assert.equal(ssoCalls.length, 0);
});

test('unverified domain and disabled connection read exactly like an unknown one', async () => {
  // sso_provider_for_domain returns NULL for both; the route cannot and must
  // not tell them apart.
  for (const email of ['pat@unverified.example', 'pat@disabled.example']) {
    reset();
    rpcResult = { data: null, error: null };
    const res = await post({ email });
    assert.equal(res.status, 404, email);
    assert.deepEqual(await res.json(), { error: 'sso_not_configured' });
    assert.equal(ssoCalls.length, 0);
  }
});

test('a consumer address gets the same 404 without a database lookup', async () => {
  reset();
  const res = await post({ email: 'pat@gmail.com' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'sso_not_configured' });
  assert.equal(rpcCalls.length, 0);
});

test('an invalid email or body is a 400', async () => {
  for (const body of [{ email: 'not an email' }, {}, 'not json']) {
    reset();
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: 'invalid_email' });
    assert.equal(rpcCalls.length, 0);
  }
});

test('a failed lookup is a 503, never "not configured"', async () => {
  reset();
  rpcResult = { data: null, error: { message: 'connection reset' } };
  const res = await post({ email: 'pat@company-sso.example' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'sso_unavailable' });
});

test('Supabase refusing the SSO start is a 503', async () => {
  reset();
  ssoResult = { data: null, error: { message: 'SAML 2.0 is disabled' } };
  const res = await post({ email: 'pat@company-sso.example' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'sso_unavailable' });
});

test('GET opens the login page on the SSO form', async () => {
  const res = await GET(new Request('https://mcpemails.test/auth/sso'));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/login?sso=1');
});
