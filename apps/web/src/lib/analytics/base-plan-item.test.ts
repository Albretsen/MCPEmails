// ---------------------------------------------------------------------------
// Revenue readers take the PLAN's subscription item, not items.data[0].
//
// A Business subscription carries the plan's base item and the per-mailbox
// add-on, and Stripe does not promise the base item comes first. A reader
// that took the first item labelled a Business customer by the $3 add-on and
// read its interval and renewal from it. These pin both revenue readers with
// the add-on listed first.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/analytics/base-plan-item.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import type Stripe from 'stripe';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';

const { subscriptionFacts } = await import('./kiosk-revenue.ts');
const { toCustomerRow } = await import('./operator-revenue.ts');

const PLAN_END = 1_800_000_000;
const ADDON_END = 1_700_000_000;

/** A yearly Business subscription whose add-on Stripe happened to list first. */
function addonFirst(): Stripe.Subscription {
  return {
    id: 'sub_addon_first',
    status: 'active',
    created: 1_760_000_000,
    ended_at: null,
    canceled_at: null,
    cancel_at: null,
    cancel_at_period_end: false,
    currency: 'usd',
    customer: 'cus_1',
    discounts: [],
    items: {
      data: [
        {
          id: 'si_addon',
          quantity: 2,
          current_period_end: ADDON_END,
          price: { id: 'price_addon_month', unit_amount: 300, recurring: { interval: 'month', interval_count: 1 } },
        },
        {
          id: 'si_plan',
          quantity: 1,
          current_period_end: PLAN_END,
          price: { id: 'price_business_year', unit_amount: 39000, recurring: { interval: 'year', interval_count: 1 } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

test('kiosk revenue labels a Business subscription by its plan item', () => {
  const facts = subscriptionFacts(addonFirst());
  assert.match(facts.planLabel, /Business/);
  assert.match(facts.planLabel, /year/i);
});

test('operator revenue reads the interval and renewal from the plan item', () => {
  const row = toCustomerRow(addonFirst());
  assert.equal(row.interval, 'year');
  assert.equal(row.renewsAt, new Date(PLAN_END * 1000).toISOString());
  assert.match(row.planLabel, /Business/);
});
