// ---------------------------------------------------------------------------
// checkoutCurrencyFor: which Checkout sessions are forced into EUR.
//
// Only an EU member outside the euro area gets `currency: 'eur'`, and only
// with STRIPE_EUR_PRICES on. Euro-area buyers are localized by Stripe from the
// prices' currency_options, and everyone else is left to Adaptive Pricing, so
// for them the function must answer undefined (no parameter at all).
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/currency.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EU_COUNTRIES,
  EURO_COUNTRIES,
  checkoutCurrencyFor,
  checkoutPresentsEur,
  eurPricesEnabled,
  forceUsdEnabled,
} from './currency.ts';

const ON = { STRIPE_EUR_PRICES: 'true' };

test('the EU has 27 members and 21 of them use the euro, Bulgaria included', () => {
  assert.equal(EU_COUNTRIES.size, 27);
  assert.equal(EURO_COUNTRIES.size, 21);
  assert.ok(EURO_COUNTRIES.has('BG'), 'Bulgaria adopted the euro on 2026-01-01');
  for (const code of EURO_COUNTRIES) assert.ok(EU_COUNTRIES.has(code), code);
  const nonEuro = [...EU_COUNTRIES].filter((c) => !EURO_COUNTRIES.has(c)).sort();
  assert.deepEqual(nonEuro, ['CZ', 'DK', 'HU', 'PL', 'RO', 'SE']);
});

test('with the switch on, the six non-euro EU countries are forced to EUR', () => {
  for (const code of ['SE', 'PL', 'CZ', 'DK', 'HU', 'RO']) {
    assert.equal(checkoutCurrencyFor(code, ON), 'eur', code);
  }
  assert.equal(checkoutCurrencyFor('se', ON), 'eur', 'case does not matter');
});

test('euro-area, non-EU and unknown buyers get no currency parameter', () => {
  for (const code of ['DE', 'FR', 'BG', 'NL', 'NO', 'CH', 'GB', 'US', 'ME']) {
    assert.equal(checkoutCurrencyFor(code, ON), undefined, code);
  }
  assert.equal(checkoutCurrencyFor(null, ON), undefined);
  assert.equal(checkoutCurrencyFor(undefined, ON), undefined);
  assert.equal(checkoutCurrencyFor('', ON), undefined);
});

test('the switch defaults off, and only explicit on-values turn it on', () => {
  assert.equal(checkoutCurrencyFor('SE', {}), undefined);
  assert.equal(eurPricesEnabled({}), false);
  for (const off of ['', 'false', 'off', '0', 'no', 'maybe', 'tru']) {
    assert.equal(eurPricesEnabled({ STRIPE_EUR_PRICES: off }), false, off);
    assert.equal(checkoutCurrencyFor('SE', { STRIPE_EUR_PRICES: off }), undefined, off);
  }
  for (const on of ['true', 'on', '1', 'yes', ' TRUE ', 'On']) {
    assert.equal(eurPricesEnabled({ STRIPE_EUR_PRICES: on }), true, on);
  }
});

test('STRIPE_FORCE_USD answers usd for everyone, and defaults off', () => {
  assert.equal(forceUsdEnabled({}), false);
  assert.equal(forceUsdEnabled({ STRIPE_FORCE_USD: 'off' }), false);
  const forced = { STRIPE_FORCE_USD: 'true', STRIPE_EUR_PRICES: 'true' };
  for (const code of ['SE', 'DE', 'US', null]) {
    assert.equal(checkoutCurrencyFor(code, forced), 'usd', String(code));
    assert.equal(checkoutPresentsEur(code, forced), false, String(code));
  }
});

test('the session presents EUR for every EU country once EUR prices are on', () => {
  for (const code of ['SE', 'DE', 'BG', 'fr']) assert.equal(checkoutPresentsEur(code, ON), true, code);
  for (const code of ['NO', 'CH', 'US', null]) assert.equal(checkoutPresentsEur(code, ON), false, String(code));
  assert.equal(checkoutPresentsEur('DE', {}), false, 'switch off');
});
