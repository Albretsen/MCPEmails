import assert from 'node:assert/strict';
import test from 'node:test';

import { checkPrice } from './verify-pro-v2-prices.mjs';

const good = {
  object: 'price',
  active: true,
  currency: 'usd',
  unit_amount: 18240,
  type: 'recurring',
  recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' },
  tax_behavior: 'exclusive',
  product: 'prod_pro',
};
const want = { cents: 18240, interval: 'year', product: 'prod_pro' };

test('a price that is exactly what the catalogue will sell passes', () => {
  assert.deepEqual(checkPrice(good, want), []);
});

test('the mistakes worth catching each fail', () => {
  // The Personal reprice once created the yearly amount as a MONTHLY price.
  assert.match(checkPrice({ ...good, recurring: { ...good.recurring, interval: 'month' } }, want).join(), /interval month/);
  assert.match(checkPrice({ ...good, unit_amount: 1824 }, want).join(), /unit_amount 1824/);
  assert.match(checkPrice({ ...good, currency: 'eur' }, want).join(), /currency eur/);
  assert.match(checkPrice({ ...good, active: false }, want).join(), /not active/);
  assert.match(checkPrice({ ...good, tax_behavior: 'unspecified' }, want).join(), /tax_behavior/);
  assert.match(checkPrice({ ...good, product: 'prod_personal' }, want).join(), /product prod_personal/);
  assert.deepEqual(checkPrice(null, want), ['not a Stripe price']);
});
