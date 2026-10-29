// ---------------------------------------------------------------------------
// The Stripe webhook and decision D3: a cancelled plan that ends parks the
// inboxes above Free's cap, only for a cancellation scheduled while
// BILLING_PARK_ON_CANCEL_ENABLED was on (src/lib/billing/park-on-cancel.ts).
//
// Pinned here: the marker is set on the first scheduled-cancel event with the
// flag on (or for an internal account) and never with it off; the end
// (deleted, or updated to canceled) parks down to one inbox, the customer's
// stored order first, then the most used; an undo clears the marker; a
// dunning end without the marker parks nothing; a marked subscription still
// parks after the flag goes off; a parking failure still answers 200 and the
// next end event repairs it; a later subscription unparks (subscription
// events and checkout.session.completed); the cancel email payload carries
// the park count.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/stripe/webhook/route.park-on-cancel.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  DAY,
  INBOX,
  PRICES,
  billingRow,
  deliver,
  inSeconds,
  parkedIds,
  seed,
  state,
  sub,
} from './route.plan-change-harness.ts';

const FLAG = 'BILLING_PARK_ON_CANCEL_ENABLED';

afterEach(() => {
  delete process.env[FLAG];
  delete process.env.GROWTH_INTERNAL_EMAILS;
  process.env.BILLING_LIFECYCLE_EMAILS = 'off';
});

const END = inSeconds(10 * DAY);

function scheduled(options: Parameters<typeof sub>[0] = {}) {
  return sub({ cancelAt: END, periodEnd: new Date(END * 1000).toISOString(), ...options });
}

function ended(options: Parameters<typeof sub>[0] = {}) {
  return sub({ status: 'canceled', cancelAt: END, ...options });
}

test('flag off: a scheduled cancel is not marked and its end parks nothing', async () => {
  seed();
  assert.equal((await deliver('customer.subscription.updated', scheduled())).status, 200);
  assert.equal(billingRow().park_on_end_subscription_id ?? null, null);
  assert.equal((await deliver('customer.subscription.deleted', ended())).status, 200);
  assert.deepEqual(parkedIds(), [], 'cancelled before the flag: never retroactive');
});

test('flag on: the cancel is marked, and the end keeps the most used inbox active', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  assert.equal(billingRow().park_on_end_subscription_id, 'sub_test');
  assert.ok(billingRow().park_on_end_marked_at, 'the moment is recorded');
  const marked = billingRow().park_on_end_marked_at;
  await deliver('customer.subscription.updated', scheduled());
  assert.equal(billingRow().park_on_end_marked_at, marked, 'a later event does not move the moment');

  const result = await deliver('customer.subscription.deleted', ended());
  assert.equal(result.status, 200);
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort(), 'a has the most calls');
  assert.equal(billingRow().park_on_end_subscription_id, null, 'cleared once parked');
  const stranger = state.db.table('inboxes').find((i) => i.id === 'stranger-inbox')!;
  assert.equal(stranger.parked_at, null, 'another workspace is never touched');
});

test('the stored keep order wins over usage', async () => {
  seed({ inbox_keep_order: [INBOX.c] });
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  await deliver('customer.subscription.deleted', ended());
  assert.deepEqual(parkedIds(), [INBOX.a, INBOX.b, INBOX.d].sort());
});

test('an update to canceled parks too, and the deleted that follows changes nothing', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  assert.equal((await deliver('customer.subscription.updated', ended())).status, 200);
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort());
  await deliver('customer.subscription.deleted', ended());
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort());
});

test('undo before the end clears the marker, and the end then parks nothing', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  assert.equal(billingRow().park_on_end_subscription_id, 'sub_test');
  await deliver('customer.subscription.updated', sub({}));
  assert.equal(billingRow().park_on_end_subscription_id, null);
  await deliver('customer.subscription.deleted', ended({ cancelAt: null }));
  assert.deepEqual(parkedIds(), []);
});

test('a dunning end (no scheduled cancel) never parks, flag or not', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', sub({ status: 'past_due' }));
  await deliver('customer.subscription.deleted', ended({ cancelAt: null }));
  assert.deepEqual(parkedIds(), []);
});

test('a subscription marked while the flag was on still parks after it goes off', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  delete process.env[FLAG];
  await deliver('customer.subscription.deleted', ended());
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort());
});

test('an internal account is marked with the flag off', async () => {
  seed();
  process.env.GROWTH_INTERNAL_EMAILS = 'owner@example.test';
  await deliver('customer.subscription.updated', scheduled());
  assert.equal(billingRow().park_on_end_subscription_id, 'sub_test');
});

test('a marker on another subscription does not park this one', async () => {
  seed({ park_on_end_subscription_id: 'sub_older', park_on_end_marked_at: '2026-10-01T00:00:00Z' });
  await deliver('customer.subscription.deleted', ended());
  assert.deepEqual(parkedIds(), []);
});

test('a parking failure still answers 200, keeps the marker, and the next end event repairs it', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  state.db.failTimes('inboxes', { message: 'boom' }, 50);
  const result = await deliver('customer.subscription.updated', ended());
  assert.equal(result.status, 200);
  assert.deepEqual(parkedIds(), []);
  assert.equal(billingRow().park_on_end_subscription_id, 'sub_test');
  state.db.failNext.delete('inboxes');
  state.db.failCounts.delete('inboxes');
  await deliver('customer.subscription.deleted', ended());
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort());
});

test('a new subscription later unparks up to its cap', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  await deliver('customer.subscription.deleted', ended());
  assert.equal(parkedIds().length, 3);
  await deliver(
    'customer.subscription.created',
    sub({ id: 'sub_again', price: PRICES.personalMonth, amount: 900 }),
  );
  assert.equal(parkedIds().length, 1, 'Personal includes three');
});

test('checkout.session.completed landing first unparks too', async () => {
  seed();
  process.env[FLAG] = 'on';
  await deliver('customer.subscription.updated', scheduled());
  await deliver('customer.subscription.deleted', ended());
  assert.equal(parkedIds().length, 3);
  state.retrieve = sub({ id: 'sub_again', price: PRICES.proMonth });
  const result = await deliver('checkout.session.completed', {
    id: 'cs_again',
    object: 'checkout.session',
    mode: 'subscription',
    customer: 'cus_test',
    subscription: 'sub_again',
    payment_status: 'paid',
    status: 'complete',
    metadata: { user_id: '00000000-0000-4000-8000-0000000000aa', plan_id: 'solo' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(parkedIds(), [], 'Pro has room for all four');
});

test('the cancel email payload carries the park count when the marker applies', async () => {
  seed();
  process.env[FLAG] = 'on';
  process.env.BILLING_LIFECYCLE_EMAILS = 'on';
  await deliver('customer.subscription.updated', scheduled());
  const row = state.db.table('billing_email_sends').find((r) => r.template === 'cancel_ask');
  assert.ok(row, 'the confirmation is queued');
  assert.equal((row.payload as { parkInboxCount?: number }).parkInboxCount, 4);
});

test('without the marker the cancel email payload has no park count', async () => {
  seed();
  process.env.BILLING_LIFECYCLE_EMAILS = 'on';
  await deliver('customer.subscription.updated', scheduled());
  const row = state.db.table('billing_email_sends').find((r) => r.template === 'cancel_ask');
  assert.ok(row, 'the confirmation is queued');
  assert.equal((row.payload as { parkInboxCount?: number }).parkInboxCount, undefined);
});
