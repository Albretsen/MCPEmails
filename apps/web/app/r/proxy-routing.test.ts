// ---------------------------------------------------------------------------
// /r/<code> reaches its route handler through apps/web/proxy.ts.
//
// The proxy sends every path it recognises as a marketing page to next-intl,
// which rewrites it under [locale] and strips Set-Cookie. A referral link
// swallowed that way would lose the very cookie it exists to set. This pins
// that /r/<code> is NOT a localized route (it goes to the Supabase session
// branch, which passes the handler's response through untouched) and that the
// proxy's matcher runs on it at all.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown>; defaultExport?: unknown }) => void;
};

const routed: string[] = [];

nodeMock.module('next-intl/middleware', {
  defaultExport: () => () => {
    routed.push('intl');
    return new Response(null, { status: 200 });
  },
});
nodeMock.module('@/lib/supabase/middleware', {
  namedExports: {
    updateSession: async () => {
      routed.push('session');
      return new Response(null, { status: 200 });
    },
    signedInDashboardRedirect: async () => null,
  },
});

const { default: proxy, config } = await import('../../proxy.ts');

function request(path: string) {
  const url = new URL(`https://mcpemails.test${path}`);
  return {
    method: 'GET',
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(),
    cookies: { get: () => undefined, getAll: () => [] },
  };
}

async function route(path: string): Promise<string> {
  routed.length = 0;
  await proxy(request(path) as unknown as Parameters<typeof proxy>[0]);
  return routed.join(',');
}

test('/r/<code> goes to the session branch, never to next-intl', async () => {
  assert.equal(await route('/r/ABCD2345'), 'session');
  assert.equal(await route('/r/abcd-2345'), 'session');
});

test('control: the home page and a localized page do go to next-intl', async () => {
  assert.equal(await route('/pricing'), 'intl');
  assert.equal(await route('/nb'), 'intl');
});

test('the proxy matcher runs on /r/<code>', () => {
  const pattern = new RegExp(`^${config.matcher[0]}$`);
  assert.ok(pattern.test('/r/ABCD2345'));
});
