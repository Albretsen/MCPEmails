// ---------------------------------------------------------------------------
// attachReferral against real-shaped data: every refusal path of fraud.ts
// reached through the database and Stripe reads that feed it, and the one row
// a successful attach writes.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import { attachReferral } from './attach.ts';
import { FakeStripe } from './fake-stripe.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const REFERRER = '00000000-0000-4000-8000-0000000000a1';
const FRIEND = '00000000-0000-4000-8000-0000000000b2';
const CODE = 'ABCD2345';

function world(options: { flag?: boolean; disabled?: boolean } = {}) {
  const db = new FakeSupabase();
  db.unique('referrals', ['friend_user_id']);
  db.seed('referral_codes', [
    { user_id: REFERRER, code: CODE, disabled_at: options.disabled ? '2026-11-01T00:00:00.000Z' : null },
  ]);
  db.seed('users', [
    { id: REFERRER, email: 'referrer@example.com' },
    { id: FRIEND, email: 'friend@example.org' },
  ]);
  db.seed('workspaces', [
    { id: 'ws-referrer', owner_id: REFERRER, plan: 'solo', referral_enabled: options.flag ?? true, deleted_at: null, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'ws-friend', owner_id: FRIEND, plan: 'free', referral_enabled: false, deleted_at: null, created_at: '2026-11-09T00:00:00.000Z' },
  ]);
  return { db, stripe: new FakeStripe() };
}

const friend = (over: Record<string, unknown> = {}) => ({
  id: FRIEND,
  email: 'friend@example.org',
  created_at: '2026-11-09T12:00:00.000Z',
  ...over,
});

async function attach(w: ReturnType<typeof world>, over: Record<string, unknown> = {}, code: unknown = CODE) {
  return attachReferral(asClient(w.db), w.stripe.api(), {
    code,
    friend: friend(over),
    via: 'cookie',
    ipHash: 'hash-1',
    now: NOW,
  });
}

const refusedEvents = (db: FakeSupabase) =>
  db.table('product_funnel_events').filter((e) => e.stage === 'referral_attach_refused').length;

test('a new friend is attached once, with the code, the workspace and the network hash', async () => {
  const w = world();
  const outcome = await attach(w, {}, 'abcd-2345');
  assert.equal(outcome.ok, true);
  const rows = w.db.table('referrals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, CODE);
  assert.equal(rows[0].referrer_user_id, REFERRER);
  assert.equal(rows[0].friend_workspace_id, 'ws-friend');
  assert.equal(rows[0].attached_via, 'cookie');
  assert.equal(rows[0].status, 'attached');
  assert.equal(rows[0].ip_hash, 'hash-1');
  const events = w.db.table('product_funnel_events');
  assert.deepEqual(events.map((e) => [e.stage, e.outcome, e.category, e.workspace_id]), [
    ['referral_attached', 'success', 'free', 'ws-friend'],
  ]);

  const again = await attach(w);
  assert.deepEqual(again, { ok: false, reason: 'already_referred' });
  assert.equal(w.db.table('referrals').length, 1);
});

test('unknown, malformed and flag-off codes attach nothing and record nothing', async () => {
  for (const [w, code, reason] of [
    [world(), 'ZZZZ2345', 'unknown_code'],
    [world(), 'O0O0', 'unknown_code'],
    [world({ flag: false }), CODE, 'flag_off'],
  ] as const) {
    assert.deepEqual(await attach(w, {}, code), { ok: false, reason });
    assert.equal(w.db.table('referrals').length, 0);
    assert.equal(w.db.table('product_funnel_events').length, 0);
  }
});

test('each refusal is quiet: no row, one refused event, the reason returned', async () => {
  const cases: Array<[string, (w: ReturnType<typeof world>) => Record<string, unknown> | void, string]> = [
    ['code_disabled', () => {}, 'code_disabled'],
    ['self', () => ({ id: REFERRER, email: 'referrer@example.com' }), 'self'],
    ['same mailbox, other spelling', () => ({ email: 'Referrer+invite@Example.com' }), 'same_email'],
    ['disposable friend', () => ({ email: 'someone@mailinator.com' }), 'disposable'],
    ['older than 30 days', () => ({ created_at: '2026-10-01T00:00:00.000Z' }), 'not_new'],
    ['paid before (user_billing)', (w) => {
      w.db.seed('user_billing', [{ user_id: FRIEND, plan: 'free', stripe_customer_id: 'cus_f', stripe_subscription_id: 'sub_old', subscription_status: 'canceled' }]);
    }, 'paid_before'],
    ['paid invoice on own customer', (w) => {
      w.db.seed('user_billing', [{ user_id: FRIEND, plan: 'free', stripe_customer_id: 'cus_f', stripe_subscription_id: null, subscription_status: null }]);
      w.stripe.paidInvoices.set('cus_f', [900]);
    }, 'paid_before'],
    ['paid invoice on another customer, same address', (w) => {
      w.stripe.customer('cus_other', { email: 'friend@example.org' });
      w.stripe.paidInvoices.set('cus_other', [1500]);
    }, 'paid_before'],
    ['referrer is a member of the friend workspace', (w) => {
      w.db.seed('workspace_members', [{ workspace_id: 'ws-friend', user_id: REFERRER, role: 'member' }]);
    }, 'self'],
    ['friend is a member of the referrer workspace', (w) => {
      w.db.seed('workspace_members', [{ workspace_id: 'ws-referrer', user_id: FRIEND, role: 'member' }]);
    }, 'self'],
  ];
  for (const [name, arrange, reason] of cases) {
    const w = world({ disabled: name === 'code_disabled' });
    const over = arrange(w) ?? {};
    const outcome = await attach(w, over);
    assert.deepEqual(outcome, { ok: false, reason }, name);
    assert.equal(w.db.table('referrals').length, 0, name);
    assert.equal(refusedEvents(w.db), 1, name);
  }
});

test('a zero-amount invoice is not paid history', async () => {
  const w = world();
  w.db.seed('user_billing', [{ user_id: FRIEND, plan: 'free', stripe_customer_id: 'cus_f', stripe_subscription_id: null, subscription_status: null }]);
  w.stripe.paidInvoices.set('cus_f', [0]);
  assert.equal((await attach(w)).ok, true);
});

test('a Stripe failure refuses rather than guesses', async () => {
  const w = world();
  w.stripe.failNext.add('customers.list');
  assert.deepEqual(await attach(w), { ok: false, reason: 'error' });
  assert.equal(w.db.table('referrals').length, 0);
});
