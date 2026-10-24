// ---------------------------------------------------------------------------
// The Stripe webhook and a switch to Personal booked for the period end.
//
// The price is swapped to Personal at confirm time (proration none), so the
// price alone would drop a customer to Personal for a period they paid at
// Pro. Pinned here: Pro holds until mcpe_downgrade_effective_at; after it,
// Personal is projected and inboxes above three are parked (the customer's
// pick first); an undo before the date changes nothing; a later upgrade back
// to Pro unparks; a parking failure still answers 200.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/stripe/webhook/route.downgrade.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY,
  INBOX,
  PRICES,
  billingRow,
  deliver,
  funnelStages,
  inSeconds,
  ownerPlan,
  parkedIds,
  seed,
  state,
  sub,
} from './route.plan-change-harness.ts';

function booked(effectiveOffset: number) {
  const at = inSeconds(effectiveOffset);
  return sub({
    price: PRICES.personalMonth,
    amount: 900,
    periodStart: new Date((at - 30 * DAY) * 1000).toISOString(),
    periodEnd: new Date(at * 1000).toISOString(),
    metadata: {
      mcpe_downgrade_from: 'solo',
      mcpe_downgrade_from_price: PRICES.proMonth,
      mcpe_downgrade_effective_at: String(at),
    },
  });
}

test('a booked switch keeps Pro until the date and stores the pending plan', async () => {
  seed();
  const result = await deliver('customer.subscription.updated', booked(10 * DAY));
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'solo', 'the period was paid at Pro');
  assert.equal(billingRow().pending_plan, 'personal');
  assert.ok(billingRow().pending_plan_effective_at);
  assert.deepEqual(parkedIds(), []);
});

test('once the date passes: Personal, and inboxes above three are parked', async () => {
  seed({ inbox_keep_order: [INBOX.b, INBOX.c, INBOX.d] });
  await deliver('customer.subscription.updated', booked(10 * DAY));
  // The renewal on the Personal price: the period rolled past the date.
  const landed = booked(-60);
  const result = await deliver('customer.subscription.updated', landed);
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'personal');
  assert.equal(billingRow().pending_plan, null);
  assert.deepEqual(parkedIds(), [INBOX.a], 'the three the customer picked stay active');
  const rows = state.db.table('product_funnel_events').map((r) => `${r.stage}:${r.outcome}:${r.category}`);
  assert.ok(rows.includes('plan_downgraded:success:personal_month'), rows.join(','));
});

test('an undo before the date leaves Pro and parks nothing', async () => {
  seed();
  await deliver('customer.subscription.updated', booked(10 * DAY));
  const undone = sub({}); // back on the Pro price, metadata cleared
  await deliver('customer.subscription.updated', undone);
  assert.equal(ownerPlan(), 'solo');
  assert.equal(billingRow().pending_plan, null);
  assert.deepEqual(parkedIds(), []);
});

test('a move back up to Pro after the switch unparks', async () => {
  seed();
  await deliver('customer.subscription.updated', booked(10 * DAY));
  await deliver('customer.subscription.updated', booked(-60));
  assert.equal(parkedIds().length, 1);
  const upgraded = sub({ metadata: booked(-60).metadata }); // Pro price again
  await deliver('customer.subscription.updated', upgraded);
  assert.equal(ownerPlan(), 'solo');
  assert.deepEqual(parkedIds(), []);
  assert.ok(funnelStages().includes('inbox_unparked:solo'));
});

test('a parking failure at the switch still answers 200 with Personal written', async () => {
  seed();
  await deliver('customer.subscription.updated', booked(10 * DAY));
  state.db.failTimes('inboxes', { message: 'timeout' }, 5);
  const result = await deliver('customer.subscription.updated', booked(-60));
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'personal');
});

test('a grandfathered owner is never parked', async () => {
  seed();
  state.db.seed('user_usage_entitlements', [
    { user_id: '00000000-0000-4000-8000-0000000000aa', kind: 'grandfather', unlimited_inboxes: true, expires_at: null },
  ]);
  await deliver('customer.subscription.updated', booked(10 * DAY));
  await deliver('customer.subscription.updated', booked(-60));
  assert.equal(ownerPlan(), 'personal');
  assert.deepEqual(parkedIds(), []);
});
