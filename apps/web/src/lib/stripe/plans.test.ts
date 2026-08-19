import assert from 'node:assert/strict';
import test from 'node:test';

import { PLANS, getPlanByStripePriceId, planDisplayName, resolvePlanLimits } from './plans.ts';

test('the value metric is inboxes, and the tiers are named the way they are sold', () => {
  assert.equal(PLANS.free.name, 'Free');
  assert.equal(PLANS.solo.name, 'Pro');
  assert.equal(PLANS.pro.name, 'Team');

  // Free is one inbox. This is the paywall now; everything else follows from it.
  assert.equal(resolvePlanLimits('free').maxInboxes, 1);
  assert.equal(resolvePlanLimits('solo').maxInboxes, Infinity);
  assert.equal(resolvePlanLimits('pro').maxInboxes, Infinity);

  // Members are a Team feature. Pro buys mailboxes, not seats.
  assert.equal(resolvePlanLimits('free').maxMembers, 1);
  assert.equal(resolvePlanLimits('solo').maxMembers, 1);
  assert.equal(resolvePlanLimits('pro').maxMembers, Infinity);

  assert.equal(planDisplayName('solo'), 'Pro');
  assert.equal(planDisplayName('pro'), 'Team');
  assert.equal(planDisplayName('free'), 'Free');
  assert.equal(planDisplayName(null), 'Free');
});

test('prices match the published repricing', () => {
  assert.equal(PLANS.solo.monthlyPriceCents, 2900);
  assert.equal(PLANS.solo.yearlyPriceCents, 27600);
  assert.equal(PLANS.pro.monthlyPriceCents, 7900);
  assert.equal(PLANS.pro.yearlyPriceCents, 75600);
  assert.equal(PLANS.free.monthlyPriceCents, 0);
});

test('the action ceiling is an abuse backstop, not a tier feature', () => {
  // These exist so a runaway agent cannot burn unbounded provider quota. They
  // are never sold, so no marketing feature list may mention them. If this test
  // is updated, check that nothing customer-facing quotes the old numbers.
  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, 5_000);
  assert.equal(resolvePlanLimits('solo').maxMonthlyToolCalls, 100_000);
  assert.equal(resolvePlanLimits('pro').maxMonthlyToolCalls, 500_000);

  for (const plan of Object.values(PLANS)) {
    for (const feature of plan.features) {
      assert.ok(
        !/action/i.test(feature),
        `plan ${plan.id} sells an action allowance in its feature list: ${feature}`,
      );
    }
  }
});

test('a grandfathered user keeps unlimited inboxes on the Free plan', () => {
  // The promise made on 2026-08-19: every account that existed before the
  // repricing keeps unlimited inboxes, free, permanently. It is user-level, so
  // it applies whatever plan the workspace projects.
  const grandfathered = resolvePlanLimits('free', { unlimitedInboxes: true });
  assert.equal(grandfathered.maxInboxes, Infinity);

  // It lifts the INBOX cap and nothing else. A grandfathered account is still
  // a Free account for seats, support and the abuse ceiling.
  assert.equal(grandfathered.maxMembers, 1);
  assert.equal(grandfathered.maxMonthlyToolCalls, 5_000);
  assert.equal(grandfathered.supportTier, 'community');
  assert.equal(grandfathered.teamRolesEnabled, false);
});

test('a new Free user is capped at one inbox', () => {
  // The other half of the same contract: without the entitlement, Free is one
  // mailbox, and that is what the connect routes enforce.
  const fresh = resolvePlanLimits('free');
  assert.equal(fresh.maxInboxes, 1);
  assert.equal(resolvePlanLimits('free', { unlimitedInboxes: false }).maxInboxes, 1);
});

test('the two entitlements stack without either swallowing the other', () => {
  const compedFromFree = resolvePlanLimits('free', { compedScale: true });
  const compedFromPro = resolvePlanLimits('solo', { compedScale: true });

  assert.equal(compedFromFree.maxMonthlyToolCalls, Infinity);
  assert.equal(compedFromPro.maxMonthlyToolCalls, Infinity);
  assert.equal(compedFromFree.maxRequestsPerMinute, PLANS.pro.limits.maxRequestsPerMinute);
  assert.equal(compedFromFree.auditLogEnabled, true);

  const both = resolvePlanLimits('free', { compedScale: true, unlimitedInboxes: true });
  assert.equal(both.maxInboxes, Infinity);
  assert.equal(both.maxMonthlyToolCalls, Infinity);
  assert.equal(both.maxMembers, Infinity);

  // The Stripe/workspace projection remains an input, not a mutation made by
  // entitlement resolution. Webhook replays can safely continue to update it.
  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, 5_000);
  assert.equal(resolvePlanLimits('free').maxInboxes, 1);
});

test('unknown legacy plans safely use Free limits unless an entitlement applies', () => {
  assert.equal(resolvePlanLimits('unknown').maxMonthlyToolCalls, 5_000);
  assert.equal(resolvePlanLimits('unknown').maxInboxes, 1);
  assert.equal(resolvePlanLimits('unknown', { compedScale: true }).maxMonthlyToolCalls, Infinity);
  assert.equal(resolvePlanLimits('enterprise', { unlimitedInboxes: true }).maxInboxes, Infinity);
});

test('a subscription on a retired price still resolves to its plan', () => {
  // A customer who subscribed before the repricing keeps billing on the price
  // they signed up on. If the webhook cannot map that price, the next renewal
  // looks like an unknown price and the customer silently loses entitlement.
  const cases: Array<[string, string, 'month' | 'year']> = [
    ['price_1TcQBDARrgumc6cqy1Z9AAEw', 'solo', 'month'], // Agent monthly, $12
    ['price_1TcQBEARrgumc6cq6MGFktzy', 'solo', 'year'],  // Agent yearly, $120
    ['price_1TcQBFARrgumc6cqmaRTXJ5Q', 'pro', 'month'],  // Scale monthly, $49
    ['price_1TcQBGARrgumc6cqmy0LeLSL', 'pro', 'year'],   // Scale yearly, $490
    ['price_1Tb0HfARrgumc6cqMeQSsMNr', 'pro', 'month'],  // Team monthly, $19
    ['price_1Tb0HfARrgumc6cqQR33xYAN', 'pro', 'year'],   // Team yearly, $152
  ];
  for (const [priceId, planId, interval] of cases) {
    const resolved = getPlanByStripePriceId(priceId);
    assert.ok(resolved, `legacy price ${priceId} must map to a plan`);
    assert.equal(resolved.plan.id, planId, `legacy price ${priceId} plan`);
    assert.equal(resolved.interval, interval, `legacy price ${priceId} interval`);
  }
});

test('an unrecognised price resolves to null rather than throwing', () => {
  // The webhook logs and continues on null; a throw would 500 and make Stripe
  // retry the same event forever.
  assert.equal(getPlanByStripePriceId('price_does_not_exist'), null);
  assert.equal(getPlanByStripePriceId(null), null);
  assert.equal(getPlanByStripePriceId(undefined), null);
  assert.equal(getPlanByStripePriceId(''), null);
});

test('every legacy price id is listed once and only once', () => {
  // A duplicate would make resolution order-dependent, and the monthly/yearly
  // interval is derived from list POSITION, so pairs must stay paired.
  const seen = new Set<string>();
  for (const plan of Object.values(PLANS)) {
    assert.equal(plan.legacyStripePriceIds.length % 2, 0, `${plan.id} legacy ids must be monthly/yearly pairs`);
    for (const id of plan.legacyStripePriceIds) {
      assert.ok(!seen.has(id), `duplicate legacy price id ${id}`);
      seen.add(id);
    }
  }
});
