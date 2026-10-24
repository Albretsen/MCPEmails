// ---------------------------------------------------------------------------
// The Stripe webhook and a paused subscription, end to end through POST.
//
// Stripe keeps a paused subscription `active`, so without the pause branch
// the price would keep a paused customer on the paid plan for free. Pinned
// here: a scheduled pause keeps the plan; a running one projects Free and
// parks inboxes above Free's one (the customer's pick first); a replay changes
// nothing; the automatic resume restores the plan and unparks; a parking
// failure never costs Stripe its 200; invoice.voided re-projects too.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/stripe/webhook/route.pause.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY,
  INBOX,
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

/** A Pro subscription whose paid period ended `ago` seconds ago and is paused for a month. */
function pausedSub(fromOffset: number) {
  const from = inSeconds(fromOffset);
  return sub({
    periodStart: new Date((from - 30 * DAY) * 1000).toISOString(),
    periodEnd: new Date(from * 1000).toISOString(),
    pauseResumesAt: from + 30 * DAY - 3600,
    metadata: { mcpe_pause_from: String(from), mcpe_pause_months: '1', mcpe_pause_history: `${from}:1` },
  });
}

test('a scheduled pause keeps the paid plan and stores the dates', async () => {
  seed();
  const result = await deliver('customer.subscription.updated', pausedSub(5 * DAY));
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'solo');
  assert.equal(billingRow().subscription_status, 'active');
  assert.ok(billingRow().paused_from, 'paused_from is stored');
  assert.ok(billingRow().pause_resumes_at, 'pause_resumes_at is stored');
  assert.deepEqual(parkedIds(), [], 'nothing parks before the paid period ends');
});

test('a running pause projects Free, status paused, and parks all but the kept inbox', async () => {
  seed({ inbox_keep_order: [INBOX.c] });
  const result = await deliver('customer.subscription.updated', pausedSub(-DAY));
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'free');
  assert.equal(billingRow().plan, 'free');
  assert.equal(billingRow().subscription_status, 'paused');
  assert.deepEqual(parkedIds(), [INBOX.a, INBOX.b, INBOX.d].sort(), 'the customer kept c');
  const stranger = state.db.table('inboxes').find((i) => i.id === 'stranger-inbox')!;
  assert.equal(stranger.parked_at, null, 'nobody else is touched');
  assert.ok(funnelStages().includes('inbox_parked:free'));
});

test('without a pick, the most used inbox stays active', async () => {
  seed();
  await deliver('customer.subscription.updated', pausedSub(-DAY));
  assert.deepEqual(parkedIds(), [INBOX.b, INBOX.c, INBOX.d].sort());
});

test('a redelivered event is a no-op', async () => {
  seed();
  const first = await deliver('customer.subscription.updated', pausedSub(-DAY));
  const parkedAt = state.db.table('inboxes').map((i) => i.parked_at);
  const replay = await deliver('customer.subscription.updated', pausedSub(-DAY), first.id);
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual(state.db.table('inboxes').map((i) => i.parked_at), parkedAt);
});

test('the automatic resume restores the plan, unparks, clears the dates and records it', async () => {
  seed();
  await deliver('customer.subscription.updated', pausedSub(-DAY));
  assert.equal(ownerPlan(), 'free');

  // Stripe cleared pause_collection at resumes_at; the metadata stays behind.
  const resumed = pausedSub(-31 * DAY);
  resumed.pause_collection = null;
  const result = await deliver('customer.subscription.updated', resumed);
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'solo');
  assert.equal(billingRow().subscription_status, 'active');
  assert.deepEqual(parkedIds(), [], 'Pro includes all four');
  assert.equal(billingRow().paused_from, null);
  assert.equal(billingRow().pause_resumes_at, null);
  assert.ok(funnelStages().includes('pause_resumed:auto'));
  assert.ok(funnelStages().includes('inbox_unparked:solo'));
});

test('a parking failure still answers 200 with the plan written', async () => {
  seed();
  state.db.failTimes('inboxes', { message: 'connection reset' }, 5);
  const result = await deliver('customer.subscription.updated', pausedSub(-DAY));
  assert.equal(result.status, 200, 'Stripe is acked; the cron repairs the parking');
  assert.equal(ownerPlan(), 'free', 'the paused customer is not left on Pro');
});

test('invoice.voided re-projects a paused subscription', async () => {
  seed();
  state.retrieve = pausedSub(-DAY);
  const result = await deliver('invoice.voided', {
    id: 'in_void',
    customer: 'cus_test',
    status: 'void',
    parent: { subscription_details: { subscription: 'sub_test' } },
  });
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'free');
});

test('invoice.voided on an ordinary subscription changes nothing', async () => {
  seed();
  state.retrieve = sub({});
  await deliver('invoice.voided', { id: 'in_void2', customer: 'cus_test', status: 'void', subscription: 'sub_test' });
  assert.equal(ownerPlan(), 'solo');
});

test('a paused subscription that is cancelled records pause_ended_cancelled and clears the dates', async () => {
  seed();
  await deliver('customer.subscription.updated', pausedSub(-DAY));
  const ended = { ...pausedSub(-DAY), status: 'canceled' };
  const result = await deliver('customer.subscription.deleted', ended);
  assert.equal(result.status, 200);
  assert.equal(ownerPlan(), 'free');
  assert.equal(billingRow().paused_from, null);
  assert.ok(funnelStages().includes('pause_ended_cancelled:solo'));
});
