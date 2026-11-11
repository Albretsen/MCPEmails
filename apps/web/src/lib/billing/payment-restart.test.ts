/**
 * The restart email after a card-failure cancel: who gets it, the switch, and
 * the price the restart link keeps.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/billing/payment-restart.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Price ids are read from the environment when plans.ts loads, so they are set
// before the dynamic imports below.
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month_900';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year_8640';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_month_500';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_year_4800';
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_business_year';

const {
  RECENT_USE_DAYS,
  hasRecentSuccessfulCall,
  keptRestartPrice,
  paymentRestartMode,
  restartDecision,
  restartSubscriptionIdOrNull,
} = await import('@/lib/billing/payment-restart');
const { FakeSupabase, asClient } = await import('@/lib/billing/fake-supabase');

const CUSTOMER = 'cus_RESTART1';
const SUB = 'sub_ENDED12345';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY_S = 86_400;

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

test('PAYMENT_RESTART_EMAIL_ENABLED: on sends, dry_run logs, everything else is off', () => {
  assert.equal(paymentRestartMode({}), 'off');
  assert.equal(paymentRestartMode({ PAYMENT_RESTART_EMAIL_ENABLED: 'off' }), 'off');
  assert.equal(paymentRestartMode({ PAYMENT_RESTART_EMAIL_ENABLED: 'true' }), 'off');
  assert.equal(paymentRestartMode({ PAYMENT_RESTART_EMAIL_ENABLED: ' ON ' }), 'on');
  assert.equal(paymentRestartMode({ PAYMENT_RESTART_EMAIL_ENABLED: 'dry_run' }), 'dry_run');
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

function decision(overrides: Partial<Parameters<typeof restartDecision>[0]> = {}) {
  return restartDecision({
    mode: 'on',
    cancellationReason: 'payment_failed',
    accountDeleted: false,
    holdsPass: false,
    recentSuccessfulCall: true,
    plan: { planId: 'personal', interval: 'month' },
    hasRecipient: true,
    ...overrides,
  });
}

test('a card-failure cancel on an account still in use is eligible, same plan and interval', () => {
  assert.deepEqual(decision(), { send: true, planId: 'personal', interval: 'month' });
  assert.deepEqual(decision({ plan: { planId: 'solo', interval: 'year' } }), {
    send: true,
    planId: 'solo',
    interval: 'year',
  });
});

test('only payment_failed qualifies', () => {
  for (const reason of ['cancellation_requested', 'none', null, undefined]) {
    assert.deepEqual(decision({ cancellationReason: reason }), { send: false, skip: 'not_payment_failed' });
  }
});

test('every other gate skips with its own reason', () => {
  assert.deepEqual(decision({ mode: 'off' }), { send: false, skip: 'flag_off' });
  assert.deepEqual(decision({ accountDeleted: true }), { send: false, skip: 'account_deleted' });
  assert.deepEqual(decision({ holdsPass: true }), { send: false, skip: 'holds_pass' });
  assert.deepEqual(decision({ recentSuccessfulCall: false }), { send: false, skip: 'no_recent_use' });
  assert.deepEqual(decision({ plan: null }), { send: false, skip: 'no_plan' });
  assert.deepEqual(decision({ plan: { planId: 'free', interval: 'month' } }), { send: false, skip: 'no_plan' });
  assert.deepEqual(decision({ hasRecipient: false }), { send: false, skip: 'no_recipient' });
});

test('dry_run decides exactly like on (the caller then logs instead of queueing)', () => {
  assert.deepEqual(decision({ mode: 'dry_run' }), decision({ mode: 'on' }));
});

// ---------------------------------------------------------------------------
// "Still using it"
// ---------------------------------------------------------------------------

const OWNER = '00000000-0000-4000-8000-0000000000aa';

function dbWith(calls: Array<{ status: string; daysAgo: number; workspace?: string }>, deletedWs = false) {
  const db = new FakeSupabase();
  db.table('workspaces').push({ id: 'ws-1', owner_id: OWNER, deleted_at: deletedWs ? '2026-11-01T00:00:00Z' : null });
  for (const [i, c] of calls.entries()) {
    db.table('activity_log').push({
      id: i + 1,
      workspace_id: c.workspace ?? 'ws-1',
      status: c.status,
      created_at: new Date(NOW.getTime() - c.daysAgo * DAY_S * 1000).toISOString(),
    });
  }
  return asClient(db);
}

test('a successful call in the last 7 days counts as still using it', async () => {
  assert.equal(RECENT_USE_DAYS, 7);
  assert.equal(await hasRecentSuccessfulCall(dbWith([{ status: 'success', daysAgo: 2 }]), OWNER, NOW), true);
});

test('failed calls, old calls, other workspaces and deleted workspaces do not count', async () => {
  assert.equal(await hasRecentSuccessfulCall(dbWith([{ status: 'error', daysAgo: 1 }]), OWNER, NOW), false);
  assert.equal(await hasRecentSuccessfulCall(dbWith([{ status: 'success', daysAgo: 8 }]), OWNER, NOW), false);
  assert.equal(
    await hasRecentSuccessfulCall(dbWith([{ status: 'success', daysAgo: 1, workspace: 'ws-other' }]), OWNER, NOW),
    false,
  );
  assert.equal(await hasRecentSuccessfulCall(dbWith([{ status: 'success', daysAgo: 1 }], true), OWNER, NOW), false);
});

// ---------------------------------------------------------------------------
// The price a restart keeps
// ---------------------------------------------------------------------------

type Sub = Awaited<ReturnType<Parameters<typeof keptRestartPrice>[0]['stripe']['subscriptions']['retrieve']>>;

function endedSub(overrides: Partial<Sub> = {}, priceId = 'price_personal_month_500'): Sub {
  return {
    id: SUB,
    customer: CUSTOMER,
    status: 'canceled',
    ended_at: NOW_S - 1 * DAY_S,
    cancellation_details: { reason: 'payment_failed' },
    items: { data: [{ price: { id: priceId } }] },
    ...overrides,
  };
}

const PRICES: Record<string, { active: boolean; currency: string; unit_amount: number }> = {
  price_personal_month_500: { active: true, currency: 'usd', unit_amount: 500 },
  price_personal_month_900: { active: true, currency: 'usd', unit_amount: 900 },
  price_personal_year_4800: { active: true, currency: 'usd', unit_amount: 4800 },
  price_personal_year_8640: { active: true, currency: 'usd', unit_amount: 8640 },
};

function stripeWith(sub: Sub, prices: typeof PRICES = PRICES) {
  return {
    subscriptions: { retrieve: async () => sub },
    prices: {
      retrieve: async (id: string) => {
        const p = prices[id];
        if (!p) throw new Error(`no such price ${id}`);
        return { id, ...p };
      },
    },
  };
}

async function kept(sub: Sub, opts: { planId?: 'personal' | 'solo' | 'pro'; interval?: 'month' | 'year'; prices?: typeof PRICES; customer?: string } = {}) {
  return keptRestartPrice({
    stripe: stripeWith(sub, opts.prices),
    stripeCustomerId: opts.customer ?? CUSTOMER,
    subscriptionId: SUB,
    planId: opts.planId ?? 'personal',
    interval: opts.interval ?? 'month',
    now: NOW,
  });
}

test('the old Personal $5 price is kept for a card-failure restart of the same plan and interval', async () => {
  assert.equal(await kept(endedSub()), 'price_personal_month_500');
  assert.equal(
    await kept(endedSub({}, 'price_personal_year_4800'), { interval: 'year' }),
    'price_personal_year_4800',
  );
});

test('a subscription already on today\'s price keeps it', async () => {
  assert.equal(await kept(endedSub({}, 'price_personal_month_900')), 'price_personal_month_900');
});

test('the old price is not kept for somebody else\'s subscription', async () => {
  assert.equal(await kept(endedSub(), { customer: 'cus_SOMEONE_ELSE' }), null);
  assert.equal(await kept(endedSub({ customer: { id: 'cus_SOMEONE_ELSE' } })), null);
});

test('not kept unless the subscription ended for payment_failed, recently', async () => {
  assert.equal(await kept(endedSub({ cancellation_details: { reason: 'cancellation_requested' } })), null);
  assert.equal(await kept(endedSub({ status: 'active' })), null);
  assert.equal(await kept(endedSub({ ended_at: NOW_S - 61 * DAY_S })), null);
  assert.equal(await kept(endedSub({ ended_at: NOW_S - 59 * DAY_S })), 'price_personal_month_500');
});

test('not kept across a plan or interval change, or on Business', async () => {
  assert.equal(await kept(endedSub(), { interval: 'year' }), null, 'monthly price for a yearly checkout');
  assert.equal(await kept(endedSub(), { planId: 'solo' }), null, 'Personal price for a Pro checkout');
  assert.equal(await kept(endedSub({}, 'price_business_month'), { planId: 'pro' }), null, 'Business always takes the normal path');
});

test('not kept when the old price is archived, dearer than today, or in another currency', async () => {
  assert.equal(
    await kept(endedSub(), { prices: { ...PRICES, price_personal_month_500: { active: false, currency: 'usd', unit_amount: 500 } } }),
    null,
  );
  assert.equal(
    await kept(endedSub(), { prices: { ...PRICES, price_personal_month_500: { active: true, currency: 'usd', unit_amount: 1500 } } }),
    null,
  );
  assert.equal(
    await kept(endedSub(), { prices: { ...PRICES, price_personal_month_500: { active: true, currency: 'eur', unit_amount: 500 } } }),
    null,
  );
});

test('an unknown price or a Stripe error means today\'s price, never a throw', async () => {
  assert.equal(await kept(endedSub({}, 'price_unknown')), null);
  const failing = {
    subscriptions: { retrieve: async () => { throw new Error('stripe down'); } },
    prices: { retrieve: async () => { throw new Error('stripe down'); } },
  };
  assert.equal(
    await keptRestartPrice({ stripe: failing, stripeCustomerId: CUSTOMER, subscriptionId: SUB, planId: 'personal', interval: 'month', now: NOW }),
    null,
  );
});

test('the restart query value must look like a subscription id', () => {
  assert.equal(restartSubscriptionIdOrNull('sub_ABCdef123'), 'sub_ABCdef123');
  assert.equal(restartSubscriptionIdOrNull('cus_ABCdef123'), null);
  assert.equal(restartSubscriptionIdOrNull('sub_x'), null);
  assert.equal(restartSubscriptionIdOrNull("sub_abc'; drop"), null);
  assert.equal(restartSubscriptionIdOrNull(null), null);
  assert.equal(restartSubscriptionIdOrNull(42), null);
});
