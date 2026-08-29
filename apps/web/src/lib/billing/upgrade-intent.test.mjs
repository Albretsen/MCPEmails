import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkoutStartHref,
  parseUpgradeIntent,
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
