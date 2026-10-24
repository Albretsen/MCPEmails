// ---------------------------------------------------------------------------
// The Stripe Tax and payment method configuration switches for Checkout.
//
// Both default OFF and must add nothing to a session while off: the checkout
// params with every switch off have to be the params from before the EUR work.
//
// Run: node --test --experimental-strip-types src/lib/stripe/tax-switch.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automaticTaxEnabled,
  checkoutTaxParams,
  paymentMethodConfigurationId,
  switchOn,
} from './tax-switch.ts';

test('a default-off switch is on only for true / on / 1 / yes', () => {
  assert.equal(switchOn(undefined), false);
  for (const off of ['', 'false', 'off', '0', 'no', 'enabled', 'y']) {
    assert.equal(switchOn(off), false, off);
  }
  for (const on of ['true', 'on', '1', 'yes', ' Yes ', 'TRUE']) {
    assert.equal(switchOn(on), true, on);
  }
});

test('Stripe Tax off adds no keys at all', () => {
  assert.equal(automaticTaxEnabled({}), false);
  assert.deepEqual(checkoutTaxParams({}), {});
  assert.deepEqual(checkoutTaxParams({ STRIPE_AUTOMATIC_TAX: 'false' }), {});
});

test('Stripe Tax on brings tax id collection and the customer_update an existing customer needs', () => {
  assert.deepEqual(checkoutTaxParams({ STRIPE_AUTOMATIC_TAX: 'on' }), {
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    customer_update: { name: 'auto', address: 'auto' },
  });
});

test('the payment method configuration is sent only when set and well formed', () => {
  assert.equal(paymentMethodConfigurationId({}), undefined);
  assert.equal(paymentMethodConfigurationId({ STRIPE_PMC_ID: '  ' }), undefined);
  assert.equal(paymentMethodConfigurationId({ STRIPE_PMC_ID: ' pmc_1AbC ' }), 'pmc_1AbC');
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(paymentMethodConfigurationId({ STRIPE_PMC_ID: 'pm_card_visa' }), undefined);
  } finally {
    console.error = originalError;
  }
});
