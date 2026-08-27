// ---------------------------------------------------------------------------
// The funnel's plan vocabulary is bounded on purpose: `product_funnel_events`
// stores a CHECK-constrained category, not a free-text slug, and anything the
// coercion does not recognise is written down as "free".
//
// That default is correct for a legacy value like `enterprise` and catastrophic
// for a live tier. A Personal customer coerced to `free` pays every month and
// still appears as a non-converting free user in every growth readout, which is
// the exact failure the 2026-08-19 review spent a day chasing in the SQL views.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/analytics/billing-funnel.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { billingTarget, planCategory } from './billing-funnel.ts';

test('a Personal customer is recorded as Personal, not collapsed into free', () => {
  assert.equal(planCategory('personal'), 'personal');
  assert.equal(planCategory('solo'), 'solo');
  assert.equal(planCategory('pro'), 'pro');
  assert.equal(planCategory('free'), 'free');
});

test('an unrecognised plan still degrades to free rather than throwing', () => {
  // The other half of the same rule: the fallback has to stay, it just must not
  // swallow a tier that is being sold.
  assert.equal(planCategory('enterprise'), 'free');
  assert.equal(planCategory(''), 'free');
  assert.equal(planCategory(null), 'free');
  assert.equal(planCategory(undefined), 'free');
});

test('both Personal checkout targets are in the bounded event vocabulary', () => {
  assert.equal(billingTarget('personal', 'month'), 'personal_month');
  assert.equal(billingTarget('personal', 'year'), 'personal_year');
});
