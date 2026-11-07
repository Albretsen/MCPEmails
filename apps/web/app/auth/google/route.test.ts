// ---------------------------------------------------------------------------
// GET /auth/google: starts a Supabase `google` sign-in that always shows
// Google's account chooser, keeps `next` on the callback URL, and
// lands on /auth/error when Supabase refuses to start.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/auth/google/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type OAuthArgs = { provider: string; options: { redirectTo: string; scopes?: string; queryParams?: Record<string, string> } };
let calls: OAuthArgs[] = [];
let result: { data: { url: string | null }; error: { message: string } | null } = { data: { url: null }, error: null };

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        signInWithOAuth: async (args: OAuthArgs) => {
          calls.push(args);
          return result;
        },
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

const { GET } = await import('./route.ts');

function reset(url: string | null = 'https://accounts.google.com/o/oauth2/v2/auth?x=1', error: string | null = null) {
  calls = [];
  result = { data: { url }, error: error ? { message: error } : null };
}

test('asks Supabase for google with the account chooser, and redirects to Google', async () => {
  reset();
  const res = await GET(new Request('https://mcpemails.com/auth/google'));
  assert.equal(res.headers.get('location'), 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');
  // Without this Google reuses the signed-in account, and a second Google
  // address becomes a second MCPEmails account without the person noticing.
  assert.equal(calls[0].options.queryParams?.prompt, 'select_account');
  assert.equal(calls[0].options.redirectTo, 'https://mcpemails.com/auth/callback');
});

test('keeps a relative next and drops an absolute one', async () => {
  reset();
  await GET(new Request('https://mcpemails.com/auth/google?next=%2Fdashboard'));
  assert.equal(new URL(calls[0].options.redirectTo).searchParams.get('next'), '/dashboard');
  reset();
  await GET(new Request('https://mcpemails.com/auth/google?next=https%3A%2F%2Fevil.example%2F'));
  assert.equal(new URL(calls[0].options.redirectTo).searchParams.has('next'), false);
});

test('a provider Supabase refuses to start lands on /auth/error', async () => {
  reset(null, 'oauth_off');
  const res = await GET(new Request('https://mcpemails.com/auth/google'));
  assert.equal(res.headers.get('location'), 'https://mcpemails.com/auth/error?reason=oauth_off');
});
