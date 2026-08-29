import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthlyFromInterval,
  netMonthlyMinor,
  summarizeSubscriptions,
  NO_DISCOUNT,
  type SubscriptionFacts,
} from './revenue-math.ts';

const NOW = 1_800_000_000; // fixed clock; all fixtures are relative to it
const DAY = 86_400;

function sub(overrides: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  return {
    id: 'sub_test',
    status: 'active',
    createdAt: NOW - 200 * DAY,
    endedAt: null,
    cancelAtPeriodEnd: false,
    currency: 'usd',
    grossMonthlyMinor: 2900,
    discount: NO_DISCOUNT,
    planLabel: 'Pro monthly',
    internal: false,
    ...overrides,
  };
}

const WINDOW = { nowSeconds: NOW, windowDays: 28 };

test('a yearly price is spread across twelve months, not booked in one', () => {
  assert.equal(monthlyFromInterval(4308, 'year'), 359);
  assert.equal(monthlyFromInterval(2900, 'month'), 2900);
  assert.equal(monthlyFromInterval(12000, 'month', 2), 6000);
  assert.equal(monthlyFromInterval(2900, 'nonsense'), 2900);
  assert.equal(monthlyFromInterval(2900, 'month', 0), 2900);
});

test('a 100 percent off comp is worth nothing, not full list price', () => {
  const comped = sub({ discount: { percentOff: 100, amountOffMonthlyMinor: 0 } });
  assert.equal(netMonthlyMinor(comped), 0);
});

test('percentage and flat coupons both reduce, and never below zero', () => {
  assert.equal(netMonthlyMinor(sub({ discount: { percentOff: 50, amountOffMonthlyMinor: 0 } })), 1450);
  assert.equal(netMonthlyMinor(sub({ discount: { percentOff: 0, amountOffMonthlyMinor: 900 } })), 2000);
  assert.equal(netMonthlyMinor(sub({ discount: { percentOff: 50, amountOffMonthlyMinor: 9900 } })), 0);
  assert.equal(netMonthlyMinor(sub({ discount: { percentOff: 500, amountOffMonthlyMinor: 0 } })), 0);
});

test('a comped subscription is counted as a customer but not as revenue', () => {
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'b', discount: { percentOff: 100, amountOffMonthlyMinor: 0 } })],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 2900);
  assert.equal(summary.payingCustomers, 1);
  assert.equal(summary.compedCustomers, 1);
});

test('our own accounts are excluded from every figure', () => {
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'ours', internal: true, grossMonthlyMinor: 7900 })],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 2900);
  assert.equal(summary.payingCustomers, 1);
  assert.equal(summary.internalCustomers, 1);
});

test('dunning keeps its money in MRR and reports it as at risk', () => {
  const summary = summarizeSubscriptions([sub({ id: 'a', status: 'past_due' })], WINDOW);
  assert.equal(summary.mrrMinor, 2900);
  assert.equal(summary.atRiskMinor, 2900);
  assert.equal(summary.atRiskCustomers, 1);
});

test('an abandoned Stripe checkout is not a customer', () => {
  const summary = summarizeSubscriptions(
    [sub({ id: 'a', status: 'incomplete' }), sub({ id: 'b', status: 'incomplete_expired' }), sub({ id: 'c', status: 'trialing' })],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 0);
  assert.equal(summary.payingCustomers, 0);
});

test('churn is booked when billing stopped, not when cancel was pressed', () => {
  const stillPaying = sub({ id: 'leaving', cancelAtPeriodEnd: true });
  const gone = sub({ id: 'gone', status: 'canceled', endedAt: NOW - 3 * DAY });
  const longGone = sub({ id: 'old', status: 'canceled', endedAt: NOW - 300 * DAY });
  const summary = summarizeSubscriptions([stillPaying, gone, longGone], WINDOW);
  assert.equal(summary.mrrMinor, 2900, 'a subscription cancelling at period end still pays');
  assert.equal(summary.leavingCustomers, 1);
  assert.equal(summary.leavingMinor, 2900);
  assert.equal(summary.churnedCustomers, 1, 'only the one that ended inside the window');
  assert.equal(summary.churnedMrrMinor, 2900);
});

test('net new is new less churned over the window', () => {
  const fresh = sub({ id: 'new', createdAt: NOW - 2 * DAY, grossMonthlyMinor: 500 });
  const old = sub({ id: 'old' });
  const gone = sub({ id: 'gone', status: 'canceled', endedAt: NOW - DAY, grossMonthlyMinor: 7900 });
  const summary = summarizeSubscriptions([fresh, old, gone], WINDOW);
  assert.equal(summary.newCustomers, 1);
  assert.equal(summary.newMrrMinor, 500);
  assert.equal(summary.churnedMrrMinor, 7900);
  assert.equal(summary.netNewMrrMinor, -7400);
});

test('ARR is twelve months of MRR and ARPA divides by payers only', () => {
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'b', grossMonthlyMinor: 7900 }), sub({ id: 'c', discount: { percentOff: 100, amountOffMonthlyMinor: 0 } })],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 10_800);
  assert.equal(summary.arrMinor, 129_600);
  assert.equal(summary.arpaMinor, 5400);
});

test('mixed currencies report the biggest one and name the rest', () => {
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'b' }), sub({ id: 'c', currency: 'eur', grossMonthlyMinor: 1000 })],
    WINDOW,
  );
  assert.equal(summary.currency, 'usd');
  assert.equal(summary.mrrMinor, 5800);
  assert.deepEqual(summary.otherCurrencies, ['eur']);
});

test('an account with nothing in it reports zero dollars, not a blank', () => {
  const summary = summarizeSubscriptions([], WINDOW);
  assert.equal(summary.currency, 'usd');
  assert.equal(summary.mrrMinor, 0);
  assert.equal(summary.arpaMinor, 0);
  assert.deepEqual(summary.byPlan, []);
});

test('plans are ranked by the money in them', () => {
  const summary = summarizeSubscriptions(
    [
      sub({ id: 'a', planLabel: 'Personal yearly', grossMonthlyMinor: 359 }),
      sub({ id: 'b', planLabel: 'Team monthly', grossMonthlyMinor: 7900 }),
      sub({ id: 'c', planLabel: 'Team monthly', grossMonthlyMinor: 7900 }),
    ],
    WINDOW,
  );
  assert.deepEqual(summary.byPlan, [
    { label: 'Team monthly', customers: 2, mrrMinor: 15_800 },
    { label: 'Personal yearly', customers: 1, mrrMinor: 359 },
  ]);
});
