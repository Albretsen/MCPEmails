// ---------------------------------------------------------------------------
// GET /auth/microsoft: starts a Supabase `azure` sign-in with sign-in-only
// scopes, keeps `next` and the acquisition params on the callback URL, and
// lands on /auth/error when Supabase refuses to start.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/auth/microsoft/route.test.ts
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

function reset(url: string | null = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1', error: string | null = null) {
  calls = [];
  result = { data: { url }, error: error ? { message: error } : null };
}

test('asks Supabase for the azure provider with openid email profile only, and redirects to Microsoft', async () => {
  reset();
  const res = await GET(new Request('https://mcpemails.com/auth/microsoft'));
  assert.equal(res.headers.get('location'), 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'azure');
  assert.equal(calls[0].options.scopes, 'openid email profile');
  // Never mailbox scopes: sign-in is not mailbox access.
  assert.equal(/Mail\.|offline_access|IMAP|SMTP/i.test(calls[0].options.scopes ?? ''), false);
  assert.equal(calls[0].options.queryParams?.prompt, 'select_account');
  assert.equal(calls[0].options.redirectTo, 'https://mcpemails.com/auth/callback');
});

test('keeps a relative next and the acquisition params on the callback', async () => {
  reset();
  await GET(new Request('https://mcpemails.com/auth/microsoft?next=%2Fdashboard%3Fprovider%3Doutlook&acq=reddit&landing=home&landing_path=%2F&acq_locale=en&referrer=direct'));
  const cb = new URL(calls[0].options.redirectTo);
  assert.equal(cb.origin + cb.pathname, 'https://mcpemails.com/auth/callback');
  assert.equal(cb.searchParams.get('next'), '/dashboard?provider=outlook');
  assert.equal(cb.searchParams.get('acq'), 'reddit');
});

test('drops an absolute next', async () => {
  reset();
  await GET(new Request('https://mcpemails.com/auth/microsoft?next=https%3A%2F%2Fevil.example%2F'));
  assert.equal(new URL(calls[0].options.redirectTo).searchParams.has('next'), false);
});

test('a provider Supabase refuses to start lands on /auth/error', async () => {
  reset(null, 'Unsupported provider: provider is not enabled');
  const res = await GET(new Request('https://mcpemails.com/auth/microsoft'));
  assert.equal(
    res.headers.get('location'),
    'https://mcpemails.com/auth/error?reason=Unsupported%20provider%3A%20provider%20is%20not%20enabled',
  );
});
