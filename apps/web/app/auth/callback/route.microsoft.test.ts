// ---------------------------------------------------------------------------
// Sign in with Microsoft through GET /auth/callback: an `azure` session whose
// email Microsoft did not vouch for (`xms_edov`) is signed out before anything
// is written, a verified one goes through, other providers are untouched, and
// failed OAuth redirects name their reason on /auth/error.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/auth/callback/route.microsoft.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type User = {
  id: string;
  created_at: string;
  app_metadata: { provider: string };
  identities: Array<{ provider: string; last_sign_in_at: string; identity_data: Record<string, unknown> }>;
};

let user: User | null = null;
let signOuts: Array<{ scope?: string } | undefined> = [];
let writes: string[] = [];

function fakeClient() {
  return {
    auth: {
      exchangeCodeForSession: async () => ({ data: { user, session: {} }, error: null }),
      getUser: async () => ({ data: { user } }),
      signOut: async (opts?: { scope?: string }) => {
        signOuts.push(opts);
        return { error: null };
      },
    },
    rpc: async (name: string) => {
      writes.push(`rpc:${name}`);
      return { error: null };
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      builder.update = () => {
        writes.push(`update:${table}`);
        return builder;
      };
      builder.eq = () => builder;
      builder.is = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
      return builder;
    },
  };
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

const NOW = () => new Date().toISOString();

function microsoftUser(customClaims: Record<string, unknown>, extra: User['identities'] = []): User {
  return {
    id: 'user-1',
    created_at: new Date(Date.now() - 1000).toISOString(),
    app_metadata: { provider: extra.length ? extra[0].provider : 'azure' },
    identities: [
      ...extra,
      {
        provider: 'azure',
        last_sign_in_at: NOW(),
        identity_data: { email: 'pat@example.com', custom_claims: { tid: '11111111-2222-3333-4444-555555555555', ...customClaims } },
      },
    ],
  };
}

function reset(u: User | null) {
  user = u;
  signOuts = [];
  writes = [];
}

// Carries acquisition params and a consent cookie, so a refused sign-in that
// leaked through would show up as a write.
function callback(query = 'code=abc&acq=direct&landing=home&landing_path=%2F&acq_locale=en&referrer=direct') {
  return GET(new Request(`https://mcpemails.com/auth/callback?${query}`, {
    headers: { cookie: 'mcpe_signup_mc=signup_checkbox_v1' },
  }));
}

test('an azure session without xms_edov is signed out (this session only) and writes nothing', async () => {
  reset(microsoftUser({}));
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/auth/error?reason=microsoft_email_unverified');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
  assert.deepEqual(writes, []);
  assert.match(res.headers.get('set-cookie') ?? '', /mcpe_signup_mc=;.*Max-Age=0/);
});

test('an azure session with xms_edov false is refused', async () => {
  reset(microsoftUser({ xms_edov: false }));
  const res = await callback();
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/auth/error?reason=microsoft_email_unverified');
  assert.equal(signOuts.length, 1);
});

test('an unverified Microsoft identity newly linked to an existing account is refused', async () => {
  reset(microsoftUser({}, [{ provider: 'email', last_sign_in_at: '2026-09-01T10:00:00Z', identity_data: { email: 'pat@example.com' } }]));
  const res = await callback('code=abc');
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/auth/error?reason=microsoft_email_unverified');
  assert.deepEqual(signOuts, [{ scope: 'local' }]);
});

test('a verified Microsoft sign-in goes through to next', async () => {
  reset(microsoftUser({ xms_edov: true }));
  const res = await callback('code=abc&next=%2Fdashboard%3Fprovider%3Doutlook');
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/dashboard?provider=outlook');
  assert.deepEqual(signOuts, []);
  // The positive control for "writes nothing" above: the same new account,
  // verified, does record its consent.
  assert.deepEqual(writes, ['rpc:record_signup_marketing_consent']);
});

test('a Google sign-in is never touched by the Microsoft guard', async () => {
  reset({
    id: 'user-1',
    created_at: '2026-08-01T10:00:00Z',
    app_metadata: { provider: 'google' },
    identities: [{ provider: 'google', last_sign_in_at: NOW(), identity_data: { email: 'pat@example.com' } }],
  });
  const res = await callback('code=abc');
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/dashboard');
  assert.deepEqual(signOuts, []);
});

test('failed OAuth redirects without a code name their reason', async () => {
  for (const [query, reason] of [
    ['error=access_denied&error_description=AADSTS65004%3A+User+declined', 'oauth_cancelled'],
    ['error=access_denied&error_description=AADSTS90094%3A+Admin+consent+is+required', 'microsoft_admin_approval'],
    ['error=access_denied&error_code=provider_email_needs_verification', 'provider_email_unverified'],
    ['error=server_error&error_description=boom', 'missing_code'],
    ['', 'missing_code'],
  ] as const) {
    reset(null);
    const res = await callback(query);
    assert.equal(res.headers.get('location'), `https://mcpemails.com/auth/error?reason=${reason}`, query);
    assert.deepEqual(signOuts, []);
  }
});
