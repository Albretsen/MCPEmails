import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VALUATION_ARR_MULTIPLE,
  monthlyFromInterval,
  netMonthlyMinor,
  summarizeSubscriptions,
  planSplit,
  scheduledToStop,
  valuationFromArr,
  NO_DISCOUNT,
  priceInCurrency,
  taxInclusiveRatio,
  type SubscriptionFacts,
} from './revenue-math.ts';
import { monthOf, usdPerUnit } from './fx.ts';

const NOW = 1_800_000_000; // fixed clock; all fixtures are relative to it
const DAY = 86_400;

function sub(overrides: Partial<SubscriptionFacts> = {}): SubscriptionFacts {
  return {
    id: 'sub_test',
    status: 'active',
    createdAt: NOW - 200 * DAY,
    endedAt: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    currency: 'usd',
    grossMonthlyMinor: 2900,
    discount: NO_DISCOUNT,
    billingInterval: 'month',
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

test('mixed currencies are converted to USD and summed, not dropped', () => {
  const eurRate = usdPerUnit('eur', monthOf(NOW));
  assert.ok(eurRate !== null && eurRate > 0);
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'b' }), sub({ id: 'c', currency: 'eur', grossMonthlyMinor: 1000 })],
    WINDOW,
  );
  assert.equal(summary.currency, 'usd');
  assert.equal(summary.mrrMinor, Math.round(5800 + 1000 * eurRate));
  assert.equal(summary.payingCustomers, 3);
  assert.deepEqual(summary.otherCurrencies, []);
  assert.deepEqual(summary.byCurrency, [
    { currency: 'usd', customers: 2, mrrMinor: 5800, mrrUsdMinor: 5800 },
    { currency: 'eur', customers: 1, mrrMinor: 1000, mrrUsdMinor: Math.round(1000 * eurRate) },
  ]);
});

test('REGRESSION: no live subscription is dropped from MRR because of its currency', () => {
  // Every currency the rate table carries, one paying subscriber each. Before
  // the EUR launch the board kept only the biggest currency and silently left
  // the other nine out of every figure.
  const codes = ['usd', 'eur', 'gbp', 'nok', 'chf', 'sek', 'dkk', 'pln', 'czk', 'aud', 'cad'];
  const subs = codes.map((currency, i) =>
    sub({ id: `s${i}`, currency, grossMonthlyMinor: 900, createdAt: NOW - 5 * DAY }));
  const summary = summarizeSubscriptions(subs, WINDOW);
  assert.equal(summary.payingCustomers, codes.length);
  assert.equal(summary.newCustomers, codes.length);
  assert.ok(Math.abs(summary.churnSubscriberMonths - (codes.length * 5) / 30.44) < 1e-9);
  assert.equal(summary.byCurrency.length, codes.length);
  assert.deepEqual(summary.otherCurrencies, []);
  const expected = codes.reduce((total, code) => total + 900 * (usdPerUnit(code, monthOf(NOW)) ?? NaN), 0);
  assert.equal(summary.mrrMinor, Math.round(expected));
  assert.equal(summary.newMrrMinor, Math.round(expected));
  assert.ok(Math.abs(summary.churnMrrMonthsMinor - (expected * 5) / 30.44) < 1e-6);
});

test('a currency with no rate is named, not counted as zero', () => {
  const summary = summarizeSubscriptions(
    [
      sub({ id: 'a' }),
      sub({ id: 'b', currency: 'xts', grossMonthlyMinor: 5000 }),
      // A comp needs no rate: it is a customer worth nothing in any currency.
      sub({ id: 'c', currency: 'xts', discount: { percentOff: 100, amountOffMonthlyMinor: 0 } }),
    ],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 2900);
  assert.equal(summary.payingCustomers, 1);
  assert.equal(summary.compedCustomers, 1);
  assert.deepEqual(summary.otherCurrencies, ['xts']);
  assert.deepEqual(summary.byCurrency, [
    { currency: 'usd', customers: 1, mrrMinor: 2900, mrrUsdMinor: 2900 },
    { currency: 'xts', customers: 1, mrrMinor: 5000, mrrUsdMinor: null },
  ]);
});

test('churn converts at the rate of the month billing stopped', () => {
  const now = Date.UTC(2026, 9, 20) / 1000;
  const ended = Date.UTC(2026, 2, 15) / 1000;
  const marchRate = usdPerUnit('eur', '2026-03');
  const octoberRate = usdPerUnit('eur', '2026-10');
  assert.ok(marchRate !== null && octoberRate !== null && marchRate !== octoberRate);
  const summary = summarizeSubscriptions(
    [
      sub({ id: 'live', currency: 'eur', grossMonthlyMinor: 1000, createdAt: now - 400 * DAY }),
      sub({
        id: 'gone',
        status: 'canceled',
        currency: 'eur',
        grossMonthlyMinor: 1000,
        createdAt: now - 400 * DAY,
        canceledAt: ended - DAY,
        endedAt: ended,
      }),
    ],
    { nowSeconds: now, windowDays: 365 },
  );
  assert.equal(summary.mrrMinor, Math.round(1000 * octoberRate));
  assert.equal(summary.churnedMrrMinor, Math.round(1000 * marchRate));
  assert.equal(summary.movements.stopped.mrrMinor, Math.round(1000 * marchRate));
  const goneDays = (ended - DAY - (now - 365 * DAY)) / DAY;
  const mrrMonths = (1000 * octoberRate * 365 + 1000 * marchRate * goneDays) / 30.44;
  assert.ok(Math.abs(summary.churnMrrMonthsMinor - mrrMonths) < 1e-6);
  assert.equal(summary.cancelledCustomers, 1);
});

test('a VAT-inclusive price counts net of the tax it includes', () => {
  // EUR 9.00 including 19% VAT: 7.56 is ours, 1.44 belongs to the tax office.
  const ratio = taxInclusiveRatio(true, { total: 900, total_excluding_tax: 756 });
  assert.equal(ratio, 0.84);
  assert.equal(netMonthlyMinor(sub({ currency: 'eur', grossMonthlyMinor: 900, taxInclusiveRatio: ratio })), 756);
  // Applied after coupons: half off an inclusive price halves the net too.
  assert.equal(
    netMonthlyMinor(sub({ grossMonthlyMinor: 900, taxInclusiveRatio: 0.84, discount: { percentOff: 50, amountOffMonthlyMinor: 0 } })),
    378,
  );
  const summary = summarizeSubscriptions(
    [sub({ id: 'a' }), sub({ id: 'b', grossMonthlyMinor: 900, taxInclusiveRatio: 0.84 })],
    WINDOW,
  );
  assert.equal(summary.mrrMinor, 2900 + 756);
});

test('the VAT share is only taken from an inclusive price', () => {
  // Tax-exclusive: the total is list price PLUS tax, and the list price is ours.
  assert.equal(taxInclusiveRatio(false, { total: 1071, total_excluding_tax: 900 }), undefined);
  // The invoice says the tax was inclusive even when the price did not.
  assert.equal(
    taxInclusiveRatio(false, {
      total: 1000,
      total_excluding_tax: 800,
      total_taxes: [{ amount: 200, tax_behavior: 'inclusive' }],
    }),
    0.8,
  );
  // Inclusive price, no tax collected (outside a registered country): all ours.
  assert.equal(taxInclusiveRatio(true, { total: 900, total_excluding_tax: 900 }), 1);
  // Nothing to read: counted gross, as before.
  assert.equal(taxInclusiveRatio(true, null), undefined);
  assert.equal(taxInclusiveRatio(true, 'in_unexpanded'), undefined);
  assert.equal(taxInclusiveRatio(true, { total: 0, total_excluding_tax: 0 }), undefined);
  // A missing ratio changes nothing.
  assert.equal(netMonthlyMinor(sub()), netMonthlyMinor(sub({ taxInclusiveRatio: 1 })));
});

test('a EUR subscriber on a multi-currency USD price is priced in euros', () => {
  const price = {
    currency: 'usd',
    unit_amount: 900,
    tax_behavior: 'exclusive',
    currency_options: {
      usd: { unit_amount: 900, tax_behavior: 'exclusive' },
      eur: { unit_amount: 1000, tax_behavior: 'inclusive' },
    },
  };
  assert.deepEqual(priceInCurrency(price, 'usd'), { unitAmount: 900, taxBehavior: 'exclusive' });
  assert.deepEqual(priceInCurrency(price, 'eur'), { unitAmount: 1000, taxBehavior: 'inclusive' });
  // Options read separately, because a subscription item's price omits them.
  assert.deepEqual(
    priceInCurrency({ currency: 'usd', unit_amount: 900 }, 'eur', price.currency_options),
    { unitAmount: 1000, taxBehavior: 'inclusive' },
  );
  assert.equal(priceInCurrency({ currency: 'usd', unit_amount: 900 }, 'eur'), null);
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


/* ------------------------------------------------------------ plan split */

test('the plan split adds up to the headline, even when it does not fit', () => {
  // The bug this exists to stop: the subscriber tile printed the first three
  // plans and stopped, so a board reading 10 subscribers listed 8 of them and
  // said nothing about the other 2.
  const byPlan = [
    { label: 'Personal monthly', customers: 5 },
    { label: 'Pro monthly', customers: 2 },
    { label: 'Personal yearly', customers: 2 },
    { label: 'Pro yearly', customers: 1 },
  ];
  const rows = planSplit(byPlan, 3);
  assert.deepEqual(rows, [
    { label: 'Personal monthly', customers: 5 },
    { label: 'Pro monthly', customers: 2 },
    { label: 'Other 2 plans', customers: 3 },
  ]);
  assert.equal(
    rows.reduce((total, row) => total + row.customers, 0),
    byPlan.reduce((total, row) => total + row.customers, 0),
  );
});

test('a mix that fits is passed through untouched', () => {
  const byPlan = [
    { label: 'Pro monthly', customers: 2 },
    { label: 'Personal monthly', customers: 5 },
  ];
  assert.deepEqual(planSplit(byPlan, 5), byPlan);
  // Exactly at the limit is a fit, not an overflow: collapsing the last row
  // into "Other 1 plans" would hide a plan to save a row it already had.
  assert.deepEqual(planSplit(byPlan, 2), byPlan);
});

test('an empty mix is empty, and one row is still one row', () => {
  assert.deepEqual(planSplit([], 4), []);
  assert.deepEqual(planSplit([{ label: 'Pro monthly', customers: 1 }], 1), [
    { label: 'Pro monthly', customers: 1 },
  ]);
});

/* ------------------------------------------------------------- valuation */

test('valuation is ARR times the multiple, and says which multiple it used', () => {
  // $48 ARR at the default 3x, which is the figure on the wall board today.
  assert.deepEqual(valuationFromArr(4800, 3), {
    valuationMinor: 14_400,
    multiple: 3,
    arrMinor: 4800,
  });
});

test('the default multiple is the one the board actually prints', () => {
  // The board reads the default through valuationMultiple(); pin it here so a
  // change to the headline figure has to be a deliberate edit to this file.
  assert.equal(DEFAULT_VALUATION_ARR_MULTIPLE, 3);
});

test('no recurring revenue is worth nothing, with no floor invented for it', () => {
  // The one edit that would turn this from an arithmetic aid into a flattering
  // lie is a minimum. A business with no recurring revenue is worth zero on
  // this convention and the board must be willing to print that.
  assert.equal(valuationFromArr(0, 3).valuationMinor, 0);
  assert.equal(valuationFromArr(-100, 3).valuationMinor, 0);
});

test('a fat-fingered multiple is clamped rather than believed', () => {
  // The whole point of the clamp: an environment variable typo must produce an
  // obviously wrong small number, not a nine-figure headline nobody questions.
  assert.equal(valuationFromArr(4800, 400).multiple, 20);
  assert.equal(valuationFromArr(4800, -3).multiple, 0);
  assert.equal(valuationFromArr(4800, -3).valuationMinor, 0);
});

test('an unparseable multiple falls back to the default rather than to zero', () => {
  const result = valuationFromArr(4800, Number.NaN);
  assert.equal(result.multiple, DEFAULT_VALUATION_ARR_MULTIPLE);
  assert.equal(result.valuationMinor, 4800 * DEFAULT_VALUATION_ARR_MULTIPLE);
});

test('a fractional multiple lands on a whole number of minor units', () => {
  // Minor units are integers everywhere else in this module; a valuation of
  // 1234.5 cents would format as a rounded figure anyway and then disagree with
  // itself the moment anything added two of them together.
  const result = valuationFromArr(4801, 3.5);
  assert.equal(result.valuationMinor, Math.round(4801 * 3.5));
  assert.ok(Number.isInteger(result.valuationMinor));
});

test('a cancel scheduled through cancel_at counts as set to stop, not only the boolean', () => {
  // Stripe's dashboard and portal now cancel at period end this way; verified
  // live on 2026-09-23 against both September cancellations.
  assert.equal(scheduledToStop({ cancel_at_period_end: false, cancel_at: NOW + 20 * DAY }), true);
  assert.equal(scheduledToStop({ cancel_at_period_end: true, cancel_at: null }), true);
  assert.equal(scheduledToStop({ cancel_at_period_end: false, cancel_at: null }), false);
});

test('cancelled counts the click, churn rate divides by subscriber-months at risk', () => {
  const summary = summarizeSubscriptions(
    [
      // Pressed cancel 5 days ago, still paying until period end.
      sub({ id: 'leaving', cancelAtPeriodEnd: true, canceledAt: NOW - 5 * DAY, grossMonthlyMinor: 500 }),
      // Cancelled and ended inside the window.
      sub({ id: 'gone', status: 'canceled', canceledAt: NOW - 10 * DAY, endedAt: NOW - 3 * DAY, grossMonthlyMinor: 1500 }),
      // Cancelled before the window: not this window's churn, not in its base.
      sub({ id: 'old', status: 'canceled', canceledAt: NOW - 100 * DAY, endedAt: NOW - 90 * DAY }),
      // Two healthy customers, one of them new.
      sub({ id: 'a', grossMonthlyMinor: 500 }),
      sub({ id: 'b', createdAt: NOW - 2 * DAY, grossMonthlyMinor: 1500 }),
      // Never paid, and comped: neither is a customer who could churn.
      sub({ id: 'abandoned', status: 'incomplete_expired', endedAt: NOW - DAY }),
      sub({ id: 'comp', canceledAt: NOW - DAY, discount: { percentOff: 100, amountOffMonthlyMinor: 0 } }),
      // Ours.
      sub({ id: 'ours', internal: true, canceledAt: NOW - DAY }),
    ],
    WINDOW,
  );
  assert.equal(summary.cancelledCustomers, 2);
  assert.equal(summary.cancelledMrrMinor, 2000);
  // Days at risk: leaving 23, gone 18, a 28, b 2.
  const months = (days: number) => days / 30.44;
  assert.ok(Math.abs(summary.churnSubscriberMonths - months(71)) < 1e-9);
  assert.ok(Math.abs(summary.customerChurnRate! - 2 / months(71)) < 1e-9);
  const mrrMonths = months(23) * 500 + months(18) * 1500 + months(28) * 500 + months(2) * 1500;
  assert.ok(Math.abs(summary.churnMrrMonthsMinor - mrrMonths) < 1e-6);
  assert.ok(Math.abs(summary.revenueChurnRate! - 2000 / mrrMonths) < 1e-9);
  assert.equal(summary.leavingCustomers, 1);
  assert.equal(summary.churnedCustomers, 1);
});

test('customers signed up days ago barely dilute churn, however many there are', () => {
  const old = [
    sub({ id: 'gone', status: 'canceled', canceledAt: NOW - DAY, endedAt: NOW - DAY }),
    ...Array.from({ length: 9 }, (_, i) => sub({ id: `old${i}` })),
  ];
  const fresh = Array.from({ length: 90 }, (_, i) => sub({ id: `new${i}`, createdAt: NOW - DAY }));
  const before = summarizeSubscriptions(old, WINDOW).customerChurnRate!;
  const after = summarizeSubscriptions([...old, ...fresh], WINDOW).customerChurnRate!;
  // A head count would have cut this tenfold.
  assert.ok(after > before * 0.5, `${after} against ${before}`);
});

test('a cancel from before the window stops counting as exposure and as churn', () => {
  const summary = summarizeSubscriptions(
    [
      sub({ id: 'notice', cancelAtPeriodEnd: true, canceledAt: NOW - 40 * DAY }),
      sub({ id: 'stays' }),
    ],
    WINDOW,
  );
  assert.equal(summary.cancelledCustomers, 0);
  assert.ok(Math.abs(summary.churnSubscriberMonths - 28 / 30.44) < 1e-9);
});

test('monthly-billed churn leaves out annual plans, which cannot lapse yet', () => {
  const summary = summarizeSubscriptions(
    [
      sub({ id: 'm-gone', status: 'canceled', canceledAt: NOW, endedAt: NOW }),
      sub({ id: 'm' }),
      sub({ id: 'y1', billingInterval: 'year' }),
      sub({ id: 'y2', billingInterval: 'year' }),
    ],
    WINDOW,
  );
  const months = 28 / 30.44;
  assert.equal(summary.monthlyBilledCancelled, 1);
  assert.ok(Math.abs(summary.monthlyBilledSubscriberMonths - 2 * months) < 1e-9);
  assert.ok(Math.abs(summary.monthlyBilledChurnRate! - 1 / (2 * months)) < 1e-9);
  assert.ok(Math.abs(summary.customerChurnRate! - 1 / (4 * months)) < 1e-9);
});

test('a paused subscription is not at risk while it bills nothing', () => {
  const summary = summarizeSubscriptions([sub({ id: 'p', paused: true }), sub({ id: 'a' })], WINDOW);
  assert.ok(Math.abs(summary.churnSubscriberMonths - 28 / 30.44) < 1e-9);
});

test('churn rate is null, not zero, when nobody paid in the window', () => {
  const summary = summarizeSubscriptions([], WINDOW);
  assert.equal(summary.customerChurnRate, null);
  assert.equal(summary.revenueChurnRate, null);
});

test('movement rows never count the same customer twice', () => {
  const summary = summarizeSubscriptions(
    [
      // New this month and already set to stop: only "set to stop".
      sub({ id: 'new-leaving', createdAt: NOW - 3 * DAY, cancelAtPeriodEnd: true, canceledAt: NOW - DAY }),
      // Card failing and set to stop: only "set to stop".
      sub({ id: 'failing-leaving', status: 'past_due', cancelAtPeriodEnd: true }),
      // New this month with a failing card: only "card failing".
      sub({ id: 'new-failing', status: 'past_due', createdAt: NOW - 2 * DAY }),
      // Cancelled and ended inside the window: only "billing stopped".
      sub({ id: 'ended', status: 'canceled', canceledAt: NOW - 10 * DAY, endedAt: NOW - 5 * DAY }),
      // Plain new customer.
      sub({ id: 'new', createdAt: NOW - DAY }),
      // Old, healthy: on no row.
      sub({ id: 'steady' }),
    ],
    WINDOW,
  );
  const m = summary.movements;
  assert.deepEqual(
    [m.new.customers, m.stopped.customers, m.leaving.customers, m.failing.customers],
    [1, 1, 2, 1],
  );
  assert.equal(m.new.mrrMinor, 2900);
  assert.equal(m.leaving.mrrMinor, 5800);
  // The overlapping fields keep their own meaning for the other tiles.
  assert.equal(summary.newCustomers, 3);
  assert.equal(summary.cancelledCustomers, 2);
});
