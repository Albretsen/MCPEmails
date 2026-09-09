import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkoutStartHref,
  parseUpgradeIntent,
  pricingCompareHref,
  pricingUpgradeHref,
  upgradeDestination,
} from './upgrade-intent.mjs';

test('accepts only supported paid-plan checkout intents', () => {
  assert.deepEqual(parseUpgradeIntent('solo', 'month'), { planId: 'solo', interval: 'month' });
  assert.deepEqual(parseUpgradeIntent('pro', 'year'), { planId: 'pro', interval: 'year' });
  assert.equal(parseUpgradeIntent('free', 'month'), null);
  assert.equal(parseUpgradeIntent('pro', 'weekly'), null);
  assert.equal(parseUpgradeIntent('enterprise', 'year'), null);
});

test('the buy CTA points at the direct checkout route, not the dashboard', () => {
  // The whole point of the route: a buy click must not pay for a dashboard
  // render before it can reach Stripe.
  assert.equal(
    checkoutStartHref('pro', true),
    '/api/stripe/checkout/start?plan=pro&interval=year',
  );
  assert.equal(
    checkoutStartHref('personal', false),
    '/api/stripe/checkout/start?plan=personal&interval=month',
  );
  assert.equal(pricingUpgradeHref('pro', true, true), checkoutStartHref('pro', true));
});

test('anonymous buy intent survives signup and still lands on checkout', () => {
  assert.equal(
    pricingUpgradeHref('pro', true, false),
    '/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dpro%26interval%3Dyear',
  );
  assert.equal(
    pricingUpgradeHref('personal', false, false),
    '/signup?redirect=%2Fapi%2Fstripe%2Fcheckout%2Fstart%3Fplan%3Dpersonal%26interval%3Dmonth',
  );
});

test('the legacy ?upgrade= destination still resolves', () => {
  // Old links are already out in the world (emails, shared URLs, cached
  // marketing HTML, the sidebar upsell). BillingSection still honours them, so
  // this helper must keep producing exactly the shape parseUpgradeIntent reads.
  assert.equal(upgradeDestination('pro', true), '/dashboard/settings?upgrade=pro&interval=year');
  assert.equal(
    upgradeDestination('personal', false),
    '/dashboard/settings?upgrade=personal&interval=month',
  );
});

test('Personal is a paid plan the pricing CTA can actually hand off', () => {
  // PAID_PLANS is an allowlist, so a tier missing from it produces a CTA that
  // parses to null and does nothing at all: no error, no checkout, no clue.
  assert.deepEqual(parseUpgradeIntent('personal', 'month'), { planId: 'personal', interval: 'month' });
  assert.deepEqual(parseUpgradeIntent('personal', 'year'), { planId: 'personal', interval: 'year' });
  assert.equal(parseUpgradeIntent('personal', 'quarter'), null);
  assert.equal(
    pricingUpgradeHref('personal', false, true),
    '/api/stripe/checkout/start?plan=personal&interval=month',
  );
});

test('the compare link carries the offer the paywall was showing', () => {
  // The paywall's whole job is to put one number in front of one person. A
  // bare '/pricing' loses it: the page defaults to annual, so "$5 a month"
  // becomes "$4 a month, billed $48/year" between one click and the next.
  assert.equal(pricingCompareHref('personal', false), '/pricing?plan=personal&interval=month');
  assert.equal(pricingCompareHref('personal', true), '/pricing?plan=personal&interval=year');
  assert.equal(pricingCompareHref('solo', false), '/pricing?plan=solo&interval=month');
  assert.equal(pricingCompareHref('pro', true), '/pricing?plan=pro&interval=year');
});

test('an unsellable plan degrades to plain /pricing rather than a dead query', () => {
  // Same allowlist as the checkout intent, so the link can never advertise a
  // plan the consumer will refuse to honour. Free is a real plan and still not
  // a purchase, which is exactly the case worth pinning.
  assert.equal(pricingCompareHref('free', false), '/pricing');
  assert.equal(pricingCompareHref('enterprise', true), '/pricing');
  assert.equal(pricingCompareHref(undefined, false), '/pricing');
});
