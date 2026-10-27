// ---------------------------------------------------------------------------
// updateSession hands a refreshed Supabase session to the page render.
//
// When the proxy refreshes an expired access token, Supabase rotates the
// refresh token. The render that follows (requireAdmin, the dashboard page)
// must see the NEW cookies. If it sees the ones the browser sent, it refreshes
// again with a token Supabase already rotated, which is how a used token gets
// replayed and the whole session revoked.
//
// Run: npm run test:session-refresh
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let refreshOnGetUser = true;

nodeMock.module('@supabase/ssr', {
  namedExports: {
    createServerClient: (
      _url: string,
      _key: string,
      { cookies }: { cookies: { setAll: (c: unknown[], h: Record<string, string>) => void } },
    ) => ({
      auth: {
        getUser: async () => {
          if (refreshOnGetUser) {
            cookies.setAll(
              [{ name: 'sb-test-auth-token', value: 'NEW', options: { path: '/', sameSite: 'lax' } }],
              { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0' },
            );
          }
          return { data: { user: { id: 'u1', email: 'owner@mcpemails.test' } } };
        },
      },
    }),
  },
});

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const { NextRequest } = await import('next/server');
const { updateSession } = await import('./middleware.ts');

function request(path: string) {
  const req = new NextRequest(`https://mcpemails.test${path}`, {
    headers: { cookie: 'sb-test-auth-token=OLD; other=1' },
  });
  // The proxy sets this before updateSession; it must survive the rebuild.
  req.headers.set('x-nonce', 'nonce-123');
  return req;
}

test('the render receives the refreshed cookie, not the one the browser sent', async () => {
  refreshOnGetUser = true;
  const response = await updateSession(request('/admin/growth'));
  const forwarded = response.headers.get('x-middleware-request-cookie') ?? '';
  assert.match(forwarded, /sb-test-auth-token=NEW/);
  assert.doesNotMatch(forwarded, /sb-test-auth-token=OLD/);
  assert.match(forwarded, /other=1/);
  assert.equal(response.headers.get('x-middleware-request-x-nonce'), 'nonce-123');
});

test('the browser is sent the refreshed cookie and no-store', async () => {
  refreshOnGetUser = true;
  const response = await updateSession(request('/dashboard'));
  assert.equal(response.cookies.get('sb-test-auth-token')?.value, 'NEW');
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
});

test('without a refresh the request passes through unchanged', async () => {
  refreshOnGetUser = false;
  const response = await updateSession(request('/dashboard'));
  assert.match(response.headers.get('x-middleware-request-cookie') ?? '', /sb-test-auth-token=OLD/);
  assert.equal(response.cookies.get('sb-test-auth-token'), undefined);
});
