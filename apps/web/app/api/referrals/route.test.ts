// ---------------------------------------------------------------------------
// /api/referrals, every method.
//
// GET: off for a workspace outside the rollout; on, it creates the caller's
// code once, reports the Stripe credit, the yearly count and the summary, and
// says whether a code may still be typed in.
// POST: the code-entry window (30 days from signup, before any paid charge),
// one generic refusal whatever the reason, a malformed body, and the
// link_copied event.
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

const ME = '00000000-0000-4000-8000-0000000000c3';
const OTHER = '00000000-0000-4000-8000-0000000000a1';

let db = new FakeSupabase();
let stripe = new FakeStripe();
let user: Record<string, unknown> | null = null;

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user }, error: null }) },
      from: (table: string) => db.from(table),
      rpc: (fn: string, args?: Record<string, unknown>) => db.rpc(fn, args),
    }),
  },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
nodeMock.module('@/lib/workspace/active', { namedExports: { resolveActiveWorkspaceId: async () => 'ws-me' } });
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    get stripe() {
      return stripe.api();
    },
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: class extends Response {
      static json(body: unknown, init?: ResponseInit) {
        return Response.json(body, init);
      }
    },
  },
});

process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';
const { GET, POST } = await import('./route.ts');

function reset(options: { flag?: boolean; createdAt?: string } = {}) {
  db = new FakeSupabase();
  db.unique('referral_codes', ['user_id']);
  db.unique('referral_codes', ['code']);
  db.unique('referrals', ['friend_user_id']);
  db.rpcs.set('my_referral_summary', (_args, store) => ({
    data: store.table('referrals')
      .filter((r) => r.referrer_user_id === ME)
      .map((r) => ({ id: r.id, status: r.status, attached_at: r.attached_at })),
    error: null,
  }));
  db.seed('users', [{ id: ME, email: 'me@example.com' }, { id: OTHER, email: 'other@example.net' }]);
  db.seed('workspaces', [
    { id: 'ws-me', owner_id: ME, plan: 'free', referral_enabled: options.flag ?? true, deleted_at: null, created_at: '2026-10-01T00:00:00.000Z' },
    { id: 'ws-other', owner_id: OTHER, plan: 'solo', referral_enabled: true, deleted_at: null, created_at: '2026-01-01T00:00:00.000Z' },
  ]);
  db.seed('referral_codes', [{ user_id: OTHER, code: 'ABCD2345', disabled_at: null }]);
  stripe = new FakeStripe();
  user = { id: ME, email: 'me@example.com', created_at: options.createdAt ?? new Date(Date.now() - 2 * 86_400_000).toISOString() };
}

const post = (body: unknown) =>
  POST(new Request('https://mcpemails.test/api/referrals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

test('GET and POST without a session are 401', async () => {
  reset();
  user = null;
  assert.equal((await GET()).status, 401);
  assert.equal((await post({ code: 'ABCD2345' })).status, 401);
});

test('GET outside the rollout says only enabled: false and creates nothing', async () => {
  reset({ flag: false });
  const res = await GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false });
  assert.equal(db.table('referral_codes').length, 1);
  assert.equal((await post({ code: 'ABCD2345' })).status, 404);
});

test('GET creates the code once and returns the summary', async () => {
  reset();
  const first = await (await GET()).json();
  assert.equal(first.enabled, true);
  assert.match(first.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(first.link, `https://mcpemails.test/r/${first.code}`);
  assert.equal(first.creditBalanceCents, 0);
  assert.equal(first.rewardsLast365d, 0);
  assert.equal(first.cap, 6);
  assert.equal(first.canEnterCode, true);
  assert.deepEqual(first.referrals, []);
  const second = await (await GET()).json();
  assert.equal(second.code, first.code);
  assert.equal(db.table('referral_codes').filter((r) => r.user_id === ME).length, 1);
  assert.equal(db.table('product_funnel_events').filter((e) => e.stage === 'referral_link_viewed').length, 0);
});

test('GET reports the credit as positive cents, and null when Stripe fails', async () => {
  reset();
  db.seed('user_billing', [{ user_id: ME, plan: 'solo', stripe_customer_id: 'cus_me', stripe_subscription_id: 'sub_me', subscription_status: 'active' }]);
  stripe.customer('cus_me', { balance: -1500 });
  let body = await (await GET()).json();
  assert.equal(body.creditBalanceCents, 1500);
  assert.equal(body.creditCurrency, 'usd', 'a customer without a currency reads as USD');
  assert.equal(body.canEnterCode, false, 'a paying customer cannot enter a code');
  stripe.customer('cus_me', { balance: -900, currency: 'eur' });
  body = await (await GET()).json();
  assert.equal(body.creditBalanceCents, 900);
  assert.equal(body.creditCurrency, 'eur');
  stripe.failNext.add('customers.retrieve');
  body = await (await GET()).json();
  assert.equal(body.creditBalanceCents, null);
});

test('POST attaches inside the window, once', async () => {
  reset();
  const res = await post({ code: 'abcd 2345' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const rows = db.table('referrals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attached_via, 'code');
  assert.equal(rows[0].friend_user_id, ME);
  assert.equal((await GET().then((r) => r.json())).canEnterCode, false);
  assert.equal((await post({ code: 'ABCD2345' })).status, 422);
});

test('POST refuses after 30 days, after a paid charge, and for an unknown code, with one message', async () => {
  const cases: Array<[string, () => void]> = [
    ['older than 30 days', () => reset({ createdAt: '2026-01-01T00:00:00.000Z' })],
    ['paid before', () => {
      reset();
      db.seed('user_billing', [{ user_id: ME, plan: 'personal', stripe_customer_id: 'cus_me', stripe_subscription_id: 'sub_me', subscription_status: 'active' }]);
    }],
    ['unknown code', () => reset()],
  ];
  for (const [name, arrange] of cases) {
    arrange();
    const res = await post({ code: name === 'unknown code' ? 'ZZZZ9999' : 'ABCD2345' });
    assert.equal(res.status, 422, name);
    assert.deepEqual(await res.json(), {
      ok: false,
      error_code: 'code_refused',
      error: "This code can't be used for this account.",
    }, name);
    assert.equal(db.table('referrals').length, 0, name);
  }
});

test('POST with a malformed body or no code is 400', async () => {
  reset();
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ code: '   ' })).status, 400);
});

test('POST link_copied records the event and attaches nothing', async () => {
  reset();
  const res = await post({ event: 'link_copied' });
  assert.equal(res.status, 204);
  assert.deepEqual(db.table('product_funnel_events').map((e) => [e.stage, e.workspace_id]), [['referral_link_copied', 'ws-me']]);
  assert.equal(db.table('referrals').length, 0);
});
