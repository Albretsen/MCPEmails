// ---------------------------------------------------------------------------
// GET /auth/callback with a referral cookie (mcpe_ref, set by /r/<code>).
//
//   - a new account is attached to the code (via 'cookie') with a salted
//     network hash, and the cookie is cleared;
//   - a refusal, an unknown code, a database failure or a Stripe failure
//     never changes where the login goes, and the cookie is still cleared;
//   - a login without the cookie touches nothing referral-related.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { FakeStripe } from '@/lib/referrals/fake-stripe';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const REFERRER = '00000000-0000-4000-8000-0000000000a1';
const FRIEND = '00000000-0000-4000-8000-0000000000b2';

let db = new FakeSupabase();
let stripe = new FakeStripe();
let user: Record<string, unknown> = {};

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        exchangeCodeForSession: async () => ({ data: { user, session: {} }, error: null }),
        getUser: async () => ({ data: { user } }),
        signOut: async () => ({ error: null }),
      },
    }),
  },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
// A getter, so each test's fresh FakeStripe is the one the route sees.
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    get stripe() {
      return stripe.api();
    },
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: {
      redirect: (url: string) => new Response(null, { status: 307, headers: { location: url } }),
    },
  },
});

process.env.REFERRAL_IP_SALT = 'unit-test-salt';
const { GET } = await import('./route.ts');

function reset(createdAt = new Date().toISOString()) {
  db = new FakeSupabase();
  db.unique('referrals', ['friend_user_id']);
  db.seed('referral_codes', [{ user_id: REFERRER, code: 'ABCD2345', disabled_at: null }]);
  db.seed('users', [{ id: REFERRER, email: 'referrer@example.com' }]);
  db.seed('workspaces', [
    { id: 'ws-referrer', owner_id: REFERRER, plan: 'solo', referral_enabled: true, deleted_at: null, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'ws-friend', owner_id: FRIEND, plan: 'free', referral_enabled: false, deleted_at: null, created_at: createdAt },
  ]);
  stripe = new FakeStripe();
  user = { id: FRIEND, email: 'friend@example.org', created_at: createdAt, app_metadata: { provider: 'email' } };
}

async function callback(cookie: string | null) {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.7' };
  if (cookie !== null) headers.cookie = cookie;
  const res = await GET(new Request('https://mcpemails.test/auth/callback?code=abc', { headers }));
  return {
    location: res.headers.get('location'),
    cookies: res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''],
  };
}

const cleared = (cookies: string[]) =>
  cookies.some((c) => c.startsWith('mcpe_ref=;') && c.includes('Max-Age=0') && c.includes('HttpOnly'));

test('a new account with the cookie is attached and the cookie is cleared', async () => {
  reset();
  const r = await callback('other=1; mcpe_ref=ABCD2345');
  assert.equal(r.location, 'https://mcpemails.test/dashboard');
  assert.ok(cleared(r.cookies));
  const rows = db.table('referrals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attached_via, 'cookie');
  assert.equal(rows[0].friend_user_id, FRIEND);
  assert.match(String(rows[0].ip_hash), /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].ip_hash, '203.0.113.7');
});

test('a refused attach (account older than the window) still logs in and clears', async () => {
  reset('2026-01-01T00:00:00.000Z');
  const r = await callback('mcpe_ref=ABCD2345');
  assert.equal(r.location, 'https://mcpemails.test/dashboard');
  assert.ok(cleared(r.cookies));
  assert.equal(db.table('referrals').length, 0);
});

test('an unknown or garbage code still logs in and clears', async () => {
  for (const value of ['ZZZZ9999', '%E0%A4%A', '']) {
    reset();
    const r = await callback(`mcpe_ref=${value}`);
    assert.equal(r.location, 'https://mcpemails.test/dashboard', value);
    assert.ok(cleared(r.cookies), value);
    assert.equal(db.table('referrals').length, 0, value);
  }
});

test('database and Stripe failures never break the login', async () => {
  reset();
  db.failTimes('referral_codes', { message: 'down' }, 5);
  let r = await callback('mcpe_ref=ABCD2345');
  assert.equal(r.location, 'https://mcpemails.test/dashboard');
  assert.ok(cleared(r.cookies));

  reset();
  stripe.failNext.add('customers.list');
  r = await callback('mcpe_ref=ABCD2345');
  assert.equal(r.location, 'https://mcpemails.test/dashboard');
  assert.ok(cleared(r.cookies));
  assert.equal(db.table('referrals').length, 0);
});

test('a login without the cookie sets no referral cookie and writes nothing', async () => {
  reset();
  const r = await callback(null);
  assert.equal(r.location, 'https://mcpemails.test/dashboard');
  assert.ok(!r.cookies.some((c) => c.startsWith('mcpe_ref=')));
  assert.equal(db.table('referrals').length, 0);
  assert.equal(stripe.calls.length, 0);
});
