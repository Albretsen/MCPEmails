// ---------------------------------------------------------------------------
// The referral dispatcher against a fake Stripe and the stateful fake
// database: what each outcome leaves behind in referrals, referral_rewards,
// the Stripe balances and the outbox, and that every reward is issued once.
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';
import type { ReferralEmailInput } from '@/lib/email/referral-emails';
import { PLANS } from '@/lib/stripe/plans';
import { dispatchReferrals } from './dispatch.ts';
import { FakeStripe } from './fake-stripe.ts';

const NOW = new Date('2026-11-20T10:15:00.000Z');
const CHARGED_AT = '2026-11-05T09:00:00.000Z';
const DUE = '2026-11-19T09:00:00.000Z';
const REFERRER = '00000000-0000-4000-8000-0000000000a1';
const FRIEND = '00000000-0000-4000-8000-0000000000b2';
const UNTIL = '2026-12-20T10:15:00.000Z';

interface World {
  db: FakeSupabase;
  stripe: FakeStripe;
  outbox: ReferralEmailInput[];
  deleted: Set<string>;
}

function world(options: {
  referrerPaying?: boolean;
  flag?: boolean;
  friendSub?: string;
  charge?: Partial<{ amount: number; refunded: boolean; amount_refunded: number; disputed: boolean; fingerprint: string | null }>;
  referral?: Record<string, unknown>;
} = {}): World {
  const db = new FakeSupabase();
  db.unique('referral_rewards', ['referral_id', 'side']);
  const stripe = new FakeStripe();
  db.seed('workspaces', [
    { id: 'ws-referrer', owner_id: REFERRER, plan: options.referrerPaying === false ? 'free' : 'solo', referral_enabled: options.flag ?? true, deleted_at: null },
    { id: 'ws-friend', owner_id: FRIEND, plan: 'personal', referral_enabled: false, deleted_at: null },
  ]);
  db.seed('users', [
    { id: REFERRER, email: 'referrer@example.com' },
    { id: FRIEND, email: 'friend@example.org' },
  ]);
  db.seed('user_billing', [
    options.referrerPaying === false
      ? { user_id: REFERRER, plan: 'free', stripe_customer_id: null, stripe_subscription_id: null, subscription_status: null }
      : { user_id: REFERRER, plan: 'solo', stripe_customer_id: 'cus_referrer', stripe_subscription_id: 'sub_referrer', subscription_status: 'active' },
    { user_id: FRIEND, plan: 'personal', stripe_customer_id: 'cus_friend', stripe_subscription_id: 'sub_friend', subscription_status: 'active' },
  ]);
  stripe.customer('cus_referrer').customer('cus_friend');
  stripe.cardFingerprints.set('cus_referrer', ['fp_referrer']);
  stripe.subscriptions.set('sub_friend', options.friendSub ?? 'active');
  stripe.charges.set('ch_first', {
    id: 'ch_first', amount: 900, refunded: false, amount_refunded: 0, disputed: false, fingerprint: 'fp_friend',
    ...options.charge,
  });
  db.seed('referrals', [{
    id: 'ref-1',
    code: 'ABCD2345',
    referrer_user_id: REFERRER,
    friend_user_id: FRIEND,
    friend_workspace_id: 'ws-friend',
    status: 'charged',
    first_charge_id: 'ch_first',
    first_charge_at: CHARGED_AT,
    qualifies_at: DUE,
    ip_hash: 'net-friend',
    ...options.referral,
  }]);
  db.rpcs.set('grant_referral_personal', () => ({ data: UNTIL, error: null }));
  return { db, stripe, outbox: [], deleted: new Set() };
}

function run(w: World, now = NOW) {
  return dispatchReferrals({
    db: asClient(w.db),
    stripe: w.stripe.api(),
    sendEmail: async (input) => {
      w.outbox.push(input);
      return { ok: true };
    },
    accountState: async (id) => (w.deleted.has(id) ? 'deleted' : 'live'),
    now,
  });
}

const ref = (w: World, id = 'ref-1') => w.db.table('referrals').find((r) => r.id === id) as Record<string, unknown>;
const rewards = (w: World) => w.db.table('referral_rewards').map((r) => [r.side, r.kind, r.amount_cents]);

test('a clean paying referral credits both sides one list-price month and emails both', async () => {
  const w = world();
  const summary = await run(w);
  assert.equal(summary.qualified, 1);
  assert.equal(ref(w).status, 'qualified');
  assert.equal(ref(w).qualified_at, NOW.toISOString());
  assert.equal(ref(w).ip_hash, null, 'the network hash is dropped once used');
  assert.deepEqual(rewards(w), [
    ['referrer', 'stripe_credit', PLANS.solo.monthlyPriceCents],
    ['friend', 'stripe_credit', PLANS.personal.monthlyPriceCents],
  ]);
  assert.equal(w.stripe.balances.get('cus_referrer'), -PLANS.solo.monthlyPriceCents);
  assert.equal(w.stripe.balances.get('cus_friend'), -PLANS.personal.monthlyPriceCents);
  assert.ok(w.db.table('referral_rewards').every((r) => typeof r.stripe_balance_txn_id === 'string'));
  assert.deepEqual(w.outbox.map((e) => [e.template, e.to, e.plan]), [
    ['referral_referrer_credit', 'referrer@example.com', 'solo'],
    ['referral_friend_credit', 'friend@example.org', 'personal'],
  ]);
  assert.deepEqual(w.db.table('product_funnel_events').map((e) => [e.stage, e.workspace_id]), [['referral_qualified', 'ws-friend']]);
});

test('a second run issues nothing and sends nothing', async () => {
  const w = world();
  await run(w);
  ref(w).status = 'charged'; // as if the status write had been lost
  w.outbox.length = 0;
  await run(w);
  assert.equal(w.stripe.txns.length, 2);
  assert.equal(w.outbox.length, 0);
});

test('a run that died after Stripe answered finds the credit instead of issuing it again', async () => {
  const w = world();
  w.db.seed('referral_rewards', [{ referral_id: 'ref-1', side: 'referrer', kind: 'stripe_credit', amount_cents: 1500, stripe_customer_id: 'cus_referrer', stripe_balance_txn_id: null }]);
  w.stripe.txns.push({ id: 'cbtxn_earlier', customer: 'cus_referrer', amount: -1500, metadata: { referral_id: 'ref-1', side: 'referrer', program: 'referral_v1' } });
  await run(w);
  assert.equal(w.stripe.txns.filter((t) => t.customer === 'cus_referrer').length, 1);
  assert.equal(w.db.table('referral_rewards').find((r) => r.side === 'referrer')?.stripe_balance_txn_id, 'cbtxn_earlier');
});

test('a Free referrer gets a Personal month through the RPC, and the email names the end date', async () => {
  const w = world({ referrerPaying: false });
  await run(w);
  assert.deepEqual(w.db.rpcCalls, [{ fn: 'grant_referral_personal', args: { p_user_id: REFERRER, p_days: 30 } }]);
  const row = w.db.table('referral_rewards').find((r) => r.side === 'referrer');
  assert.equal(row?.kind, 'personal_month');
  assert.equal(row?.entitlement_until, UNTIL);
  assert.deepEqual(w.outbox[0], { template: 'referral_referrer_personal', to: 'referrer@example.com', referralId: 'ref-1', until: UNTIL });
  // Never twice, even if the row is picked up again.
  ref(w).status = 'charged';
  await run(w);
  assert.equal(w.db.rpcCalls.length, 1);
});

test('a failed grant leaves no claim and the row charged for the next run', async () => {
  const w = world({ referrerPaying: false });
  w.db.rpcs.set('grant_referral_personal', () => ({ data: null, error: { message: 'down' } }));
  const summary = await run(w);
  assert.equal(summary.failed, 1);
  assert.equal(ref(w).status, 'charged');
  assert.equal(w.db.table('referral_rewards').filter((r) => r.side === 'referrer').length, 0);
});

test('a friend who cancelled gets nothing; the referrer is still rewarded', async () => {
  const w = world({ friendSub: 'canceled' });
  await run(w);
  assert.equal(ref(w).status, 'qualified');
  assert.deepEqual(rewards(w).map((r) => r[0]), ['referrer']);
  assert.deepEqual(w.outbox.map((e) => e.template), ['referral_referrer_credit']);
});

test('at the yearly cap the referrer gets nothing, the friend still does', async () => {
  const w = world();
  const past = Array.from({ length: 6 }, (_, i) => ({
    id: `old-${i}`, code: 'ABCD2345', referrer_user_id: REFERRER, friend_user_id: `friend-${i}`, status: 'qualified',
  }));
  w.db.seed('referrals', past);
  w.db.seed('referral_rewards', past.map((p) => ({ referral_id: p.id, side: 'referrer', kind: 'stripe_credit', issued_at: '2026-06-01T00:00:00.000Z' })));
  await run(w);
  assert.equal(ref(w).status, 'capped');
  assert.equal(w.db.table('referral_rewards').filter((r) => r.referral_id === 'ref-1').map((r) => r.side).join(), 'friend');
  assert.deepEqual(w.outbox.map((e) => e.template), ['referral_friend_credit']);
  assert.equal(w.db.table('product_funnel_events')[0].stage, 'referral_capped');
});

test('rewards older than 365 days do not count toward the cap', async () => {
  const w = world();
  const past = Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, code: 'ABCD2345', referrer_user_id: REFERRER, friend_user_id: `friend-${i}`, status: 'qualified' }));
  w.db.seed('referrals', past);
  w.db.seed('referral_rewards', past.map((p) => ({ referral_id: p.id, side: 'referrer', kind: 'stripe_credit', issued_at: '2025-11-01T00:00:00.000Z' })));
  await run(w);
  assert.equal(ref(w).status, 'qualified');
});

test('void outcomes: refunded, disputed, same card. Nobody is emailed or credited', async () => {
  for (const [name, charge, reason] of [
    ['refunded', { refunded: true, amount_refunded: 900 }, 'refunded'],
    ['partially refunded', { amount_refunded: 100 }, 'partially_refunded'],
    ['disputed', { disputed: true }, 'disputed'],
    ['same card', { fingerprint: 'fp_referrer' }, 'same_card'],
  ] as const) {
    const w = world({ charge });
    const summary = await run(w);
    assert.equal(summary.voided, 1, name);
    assert.equal(ref(w).status, 'voided', name);
    assert.equal(ref(w).void_reason, reason, name);
    assert.equal(w.stripe.txns.length, 0, name);
    assert.equal(w.outbox.length, 0, name);
  }
});

test('hold outcomes: same network, velocity', async () => {
  const same = world();
  same.db.seed('referrals', [{ id: 'ref-2', code: 'ABCD2345', referrer_user_id: REFERRER, friend_user_id: 'f2', status: 'attached', ip_hash: 'net-friend' }]);
  await run(same);
  assert.equal(ref(same).status, 'held');
  assert.equal(ref(same).hold_reason, 'same_network');
  assert.equal(ref(same).ip_hash, 'net-friend', 'kept for the person reviewing the hold');

  const fast = world();
  fast.db.seed('referrals', [1, 2, 3].map((i) => ({
    id: `fast-${i}`, code: 'ABCD2345', referrer_user_id: REFERRER, friend_user_id: `ff-${i}`, status: 'charged',
    first_charge_at: `2026-11-05T0${i}:00:00.000Z`, qualifies_at: '2026-12-31T00:00:00.000Z',
  })));
  await run(fast);
  assert.equal(ref(fast).status, 'held');
  assert.equal(ref(fast).hold_reason, 'velocity');
  assert.equal(fast.stripe.txns.length, 0);
});

test('a row whose charge is unknown is held, not rewarded', async () => {
  const w = world({ referral: { first_charge_id: null } });
  await run(w);
  assert.equal(ref(w).status, 'held');
  assert.equal(ref(w).hold_reason, 'charge_unknown');
});

test('not yet due, or the flag off, leaves the row alone', async () => {
  const early = world({ referral: { qualifies_at: '2026-11-25T00:00:00.000Z' } });
  assert.equal((await run(early)).due, 0);
  assert.equal(ref(early).status, 'charged');

  const off = world({ flag: false });
  const summary = await run(off);
  assert.equal(summary.skipped, 1);
  assert.equal(ref(off).status, 'charged');
  assert.equal(off.stripe.calls.length, 0);
});

test('one failing row does not stop the batch', async () => {
  const w = world();
  w.db.seed('referrals', [{
    id: 'ref-broken', code: 'ABCD2345', referrer_user_id: REFERRER, friend_user_id: 'broken', status: 'charged',
    first_charge_id: 'ch_missing', first_charge_at: '2026-10-01T00:00:00.000Z', qualifies_at: '2026-10-15T00:00:00.000Z',
  }]);
  const summary = await run(w);
  assert.equal(summary.failed, 1);
  assert.equal(summary.qualified, 1);
  assert.equal(ref(w, 'ref-broken').status, 'charged');
  assert.equal(ref(w).status, 'qualified');
});

test('a deleted account gets no email', async () => {
  const w = world();
  w.deleted.add(REFERRER);
  await run(w);
  assert.deepEqual(w.outbox.map((e) => e.template), ['referral_friend_credit']);
});
