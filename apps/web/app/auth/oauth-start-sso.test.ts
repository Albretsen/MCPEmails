// ---------------------------------------------------------------------------
// /auth/google, /auth/github and /auth/microsoft: when the sign-in page passes
// the typed address and its company enforces SSO, the route stops with the
// friendly /auth/error?reason=sso_required instead of sending the person to
// the provider. Without an enforced address, or when the lookup fails, the
// route starts the provider sign-in exactly as before. The real block is the
// Supabase auth hook (supabase/tests/auth_hooks_sso_enforcement.sql).
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/auth/oauth-start-sso.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let oauthCalls: Array<{ provider: string }> = [];
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: false, error: null };

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        signInWithOAuth: async (args: { provider: string }) => {
          oauthCalls.push(args);
          return { data: { url: `https://idp.example/authorize?p=${args.provider}` }, error: null };
        },
      },
    }),
  },
});
nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args });
        return Promise.resolve(rpcResult);
      },
    }),
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: {
      redirect: (url: string) => new Response(null, { status: 307, headers: { location: url } }),
    },
  },
});

const routes = {
  google: (await import('./google/route.ts')).GET,
  github: (await import('./github/route.ts')).GET,
  microsoft: (await import('./microsoft/route.ts')).GET,
};

function reset(data: unknown, error: string | null = null) {
  oauthCalls = [];
  rpcCalls = [];
  rpcResult = { data, error: error ? { message: error } : null };
}

for (const [name, GET] of Object.entries(routes)) {
  test(`${name}: an enforced address is refused before the provider, without echoing it`, async () => {
    reset(true);
    const res = await GET(new Request(`https://mcpemails.com/auth/${name}?email=staff%40enforced-sso.example&next=%2Fdashboard`));
    const location = res.headers.get('location') ?? '';
    assert.equal(location, 'https://mcpemails.com/auth/error?reason=sso_required');
    assert.equal(location.includes('enforced-sso'), false);
    assert.equal(oauthCalls.length, 0);
    assert.deepEqual(rpcCalls, [{ fn: 'sso_sign_in_required', args: { p_email: 'staff@enforced-sso.example' } }]);
  });

  test(`${name}: an address that is not enforced goes to the provider`, async () => {
    reset(false);
    const res = await GET(new Request(`https://mcpemails.com/auth/${name}?email=staff%40open-sso.example`));
    assert.match(res.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize/);
    assert.equal(oauthCalls.length, 1);
  });

  test(`${name}: no address, no lookup`, async () => {
    reset(true);
    const res = await GET(new Request(`https://mcpemails.com/auth/${name}`));
    assert.match(res.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize/);
    assert.equal(rpcCalls.length, 0);
  });

  test(`${name}: a lookup error fails open`, async () => {
    reset(null, 'connection refused');
    const original = console.error;
    console.error = () => {};
    try {
      const res = await GET(new Request(`https://mcpemails.com/auth/${name}?email=staff%40enforced-sso.example`));
      assert.match(res.headers.get('location') ?? '', /^https:\/\/idp\.example\/authorize/);
    } finally {
      console.error = original;
    }
  });
}
