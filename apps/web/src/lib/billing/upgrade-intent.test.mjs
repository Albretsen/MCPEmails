import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUpgradeIntent, pricingUpgradeHref, upgradeDestination } from './upgrade-intent.mjs';

test('accepts only supported paid-plan checkout intents', () => {
  assert.deepEqual(parseUpgradeIntent('solo', 'month'), { planId: 'solo', interval: 'month' });
  assert.deepEqual(parseUpgradeIntent('pro', 'year'), { planId: 'pro', interval: 'year' });
  assert.equal(parseUpgradeIntent('free', 'month'), null);
  assert.equal(parseUpgradeIntent('pro', 'weekly'), null);
  assert.equal(parseUpgradeIntent('enterprise', 'year'), null);
});

test('keeps plan and interval through the pricing handoff', () => {
  const destination = upgradeDestination('pro', true);
  assert.equal(destination, '/dashboard/settings?upgrade=pro&interval=year');
  assert.equal(pricingUpgradeHref('pro', true, true), destination);
  assert.equal(
    pricingUpgradeHref('pro', true, false),
    '/signup?redirect=%2Fdashboard%2Fsettings%3Fupgrade%3Dpro%26interval%3Dyear',
  );
});
