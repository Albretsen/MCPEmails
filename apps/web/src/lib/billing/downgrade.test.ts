/**
 * Switch Pro to Personal at period end, and the projection the webhook and
 * the cron both apply (plan-change-sync.ts projectSubscription).
 *
 * Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        src/lib/billing/downgrade.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PRICES, sec, setPlanChangeTestPrices, subscriptionFixture } from '@/lib/billing/plan-change-fixtures';

setPlanChangeTestPrices();
const dg = await import('@/lib/billing/downgrade');
const sync = await import('@/lib/billing/plan-change-sync');
const { pauseResumesAt } = await import('@/lib/billing/pause');

const NOW = new Date('2026-10-24T09:00:00Z');
const END = sec('2026-11-10T12:00:00Z');

test('eligibility: Pro only, same interval, monthly or annual', () => {
  const monthly = dg.downgradeEligibility(subscriptionFixture(), NOW);
  assert.equal(monthly.eligible, true);
  if (monthly.eligible) {
    assert.deepEqual(
      { ...monthly.quote },
      {
        fromPlan: 'solo',
        toPlan: 'personal',
        interval: 'month',
        priceId: PRICES.personalMonth,
        amountCents: 900,
        currency: 'usd',
        effectiveAt: END,
        inboxCap: 3,
      },
    );
  }
  const annual = dg.downgradeEligibility(subscriptionFixture({ price: PRICES.proYear }), NOW);
  assert.equal(annual.eligible && annual.quote.priceId, PRICES.personalYear);
  assert.equal(annual.eligible && annual.quote.amountCents, 8640);

  const refusal = (sub: ReturnType<typeof subscriptionFixture>) => {
    const v = dg.downgradeEligibility(sub, NOW);
    return v.eligible ? null : v.reason;
  };
  assert.equal(refusal(subscriptionFixture({ price: PRICES.personalMonth })), 'plan_not_eligible');
  assert.equal(refusal(subscriptionFixture({ price: PRICES.businessMonth })), 'plan_not_eligible');
  assert.equal(refusal(subscriptionFixture({ status: 'past_due' })), 'past_due');
  assert.equal(refusal(subscriptionFixture({ extraItem: true })), 'multiple_items');
  assert.equal(refusal(subscriptionFixture({ cancelAtPeriodEnd: true })), 'cancel_scheduled');
  assert.equal(refusal(subscriptionFixture({ pauseResumesAt: END + 1000 })), 'paused');
});

test('apply: price swap with proration none and the metadata the webhook reads', () => {
  const { params } = dg.downgradeUpdate(subscriptionFixture(), NOW);
  assert.deepEqual(params, {
    items: [{ id: 'si_plan', price: PRICES.personalMonth }],
    proration_behavior: 'none',
    metadata: {
      mcpe_downgrade_from: 'solo',
      mcpe_downgrade_from_price: PRICES.proMonth,
      mcpe_downgrade_effective_at: String(END),
    },
  });
});

test('state: pending until the date, effective after, none once back on Pro', () => {
  const booked = subscriptionFixture({
    price: PRICES.personalMonth,
    amount: 900,
    metadata: { mcpe_downgrade_from: 'solo', mcpe_downgrade_from_price: PRICES.proMonth, mcpe_downgrade_effective_at: String(END) },
  });
  assert.deepEqual(dg.downgradeState(booked, NOW), { state: 'pending', fromPlan: 'solo', toPlan: 'personal', effectiveAt: END });
  assert.equal(dg.downgradeState(booked, new Date('2026-11-11T00:00:00Z')).state, 'effective');
  const back = subscriptionFixture({ metadata: booked.metadata });
  assert.equal(dg.downgradeState(back, NOW).state, 'none', 'leftover metadata on the Pro price means nothing');
});

test('undo: back to the exact price it came from, metadata cleared', () => {
  const booked = subscriptionFixture({
    price: PRICES.personalMonth,
    metadata: { mcpe_downgrade_from: 'solo', mcpe_downgrade_from_price: PRICES.proMonth, mcpe_downgrade_effective_at: String(END) },
  });
  const { params } = dg.undoDowngradeUpdate(booked, NOW);
  assert.deepEqual(params.items, [{ id: 'si_plan', price: PRICES.proMonth }]);
  assert.equal(params.proration_behavior, 'none');
  assert.deepEqual(params.metadata, { mcpe_downgrade_from: '', mcpe_downgrade_from_price: '', mcpe_downgrade_effective_at: '' });
  assert.throws(() => dg.undoDowngradeUpdate(booked, new Date('2026-11-11T00:00:00Z')), /not_pending/);
  // A tampered from-price that is not a Pro price is refused.
  const tampered = subscriptionFixture({
    price: PRICES.personalMonth,
    metadata: { mcpe_downgrade_from: 'solo', mcpe_downgrade_from_price: PRICES.businessMonth, mcpe_downgrade_effective_at: String(END) },
  });
  assert.throws(() => dg.undoDowngradeUpdate(tampered, NOW), /unknown_price/);
});

test('switch to Free is offered unless already stopping or paused', () => {
  assert.equal(dg.switchFreeEligibility(subscriptionFixture()).eligible, true);
  assert.equal(dg.switchFreeEligibility(subscriptionFixture({ cancelAt: END })).reason, 'cancel_scheduled');
  assert.equal(dg.switchFreeEligibility(subscriptionFixture({ pauseResumesAt: END + 10 })).reason, 'paused');
});

test('projection: paused is Free and parks; scheduled keeps the plan; resumed unparks', () => {
  const from = END;
  const meta = { mcpe_pause_from: String(from), mcpe_pause_months: '1', mcpe_pause_history: `${from}:1` };
  const sub = subscriptionFixture({ pauseResumesAt: pauseResumesAt(from, 1), metadata: meta });

  const scheduled = sync.projectSubscription(sub, 'solo', NOW);
  assert.equal(scheduled.grantPlan, 'solo');
  assert.equal(scheduled.status, 'active');
  assert.equal(scheduled.parkTo, null);
  assert.equal(scheduled.columns.paused_from, new Date(from * 1000).toISOString());
  assert.deepEqual(scheduled.columns.pause_history, [{ from, months: 1 }]);

  const paused = sync.projectSubscription(sub, 'solo', new Date('2026-11-20T00:00:00Z'));
  assert.equal(paused.grantPlan, 'free');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.parkTo, 'free');

  const resumed = sync.projectSubscription(subscriptionFixture({ metadata: meta }), 'solo', new Date('2026-12-11T00:00:00Z'));
  assert.equal(resumed.grantPlan, 'solo');
  assert.equal(resumed.unpark, true);
  assert.equal(resumed.columns.paused_from, null);
  assert.equal(resumed.columns.pause_resumes_at, null);
});

test('projection: a pending downgrade keeps Pro until the date, then Personal and parks', () => {
  const booked = subscriptionFixture({
    price: PRICES.personalMonth,
    metadata: { mcpe_downgrade_from: 'solo', mcpe_downgrade_from_price: PRICES.proMonth, mcpe_downgrade_effective_at: String(END) },
  });
  const before = sync.projectSubscription(booked, 'personal', NOW);
  assert.equal(before.grantPlan, 'solo');
  assert.equal(before.parkTo, null);
  assert.equal(before.columns.pending_plan, 'personal');
  const after = sync.projectSubscription(booked, 'personal', new Date('2026-11-10T12:00:01Z'));
  assert.equal(after.grantPlan, 'personal');
  assert.equal(after.parkTo, 'personal');
  assert.equal(after.columns.pending_plan, null);
});

test('inbox caps respect the grandfather and comped grants', () => {
  const none = { unlimitedInboxes: false, compedScale: false };
  assert.equal(sync.inboxCapFor('free', none), 1);
  assert.equal(sync.inboxCapFor('personal', none), 3);
  assert.equal(sync.inboxCapFor('solo', none), 10);
  assert.equal(sync.inboxCapFor('solo', none, true), null, 'a Pro cutover-exempt workspace is unlimited');
  assert.equal(sync.inboxCapFor('pro', none), null);
  assert.equal(sync.inboxCapFor('free', { unlimitedInboxes: true, compedScale: false }), null);
  assert.equal(sync.inboxCapFor('free', { unlimitedInboxes: false, compedScale: true }), null);
});

test('sanitizeKeepOrder keeps uuids only, de-duplicated', () => {
  const a = '00000000-0000-4000-8000-00000000000a';
  assert.deepEqual(sync.sanitizeKeepOrder([a, 'x', a, 7]), [a]);
  assert.equal(sync.sanitizeKeepOrder('nope'), null);
});
