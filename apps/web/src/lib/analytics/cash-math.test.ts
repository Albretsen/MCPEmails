import test from 'node:test';
import assert from 'node:assert/strict';
import { rollUpCash, stripeMode } from './cash-math.ts';

test('charges roll into UTC months, oldest first', () => {
  const months = rollUpCash([
    { grossMinor: 4800, refundedMinor: 0, at: '2026-08-29T17:35:04.000Z' },
    { grossMinor: 2900, refundedMinor: 0, at: '2026-07-02T09:00:00.000Z' },
    { grossMinor: 2900, refundedMinor: 0, at: '2026-08-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(months.map((month) => month.month), ['2026-07-01', '2026-08-01']);
  assert.equal(months[1].netMinor, 7700);
});

test('a refund is subtracted from the month the charge landed in, not the month it was refunded', () => {
  // The alternative books the earning month whole and shows a later month
  // losing money it never made, which is backwards for reading a trend.
  const months = rollUpCash([
    { grossMinor: 4800, refundedMinor: 4800, at: '2026-07-15T00:00:00.000Z' },
    { grossMinor: 2900, refundedMinor: 0, at: '2026-08-15T00:00:00.000Z' },
  ]);
  assert.equal(months[0].month, '2026-07-01');
  assert.equal(months[0].grossMinor, 4800);
  assert.equal(months[0].refundedMinor, 4800);
  assert.equal(months[0].netMinor, 0);
  assert.equal(months[1].netMinor, 2900);
});

test('no charges is an empty series, not a zero month', () => {
  // A zero bar for a month with no activity and a month with no data look the
  // same on a chart, and only one of them is a finding.
  assert.deepEqual(rollUpCash([]), []);
});

test('the Stripe account mode is read off the key prefix', () => {
  // `.env.local` holds a test key and only Vercel production holds the live
  // one, so a locally rendered revenue panel has to be able to label itself.
  assert.equal(stripeMode('sk_live_51abc'), 'live');
  assert.equal(stripeMode('rk_live_51abc'), 'live');
  assert.equal(stripeMode('sk_test_51abc'), 'test');
  assert.equal(stripeMode('rk_test_51abc'), 'test');
  assert.equal(stripeMode(undefined), 'unknown');
  assert.equal(stripeMode('something_else'), 'unknown');
});
