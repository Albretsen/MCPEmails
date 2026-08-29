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

test('no feature list promises an analytics retention window', () => {
  // `analyticsRetentionDays` has ZERO readers anywhere in apps/ or
  // supabase/functions/: nothing truncates the analytics dashboard by plan, so
  // "30-day history" / "90-day history" / "1-year history" were claims the
  // product does not implement. They were removed from the pricing copy in all
  // five locales but survived here, and `plan.features` is what builds the
  // purchase confirmation email (src/lib/email/purchase-confirmation.ts) — so
  // every paying customer was emailed the claim after the page stopped making
  // it. These lists and the `pricing.plans.*.features` message arrays are two
  // renderings of one promise and must not diverge again.
  for (const plan of Object.values(PLANS)) {
    for (const feature of plan.features) {
      assert.ok(
        !/\b\d+[- ]?(day|month|year)s?\b|\bone[- ]year\b/i.test(feature),
        `plan ${plan.id} promises a retention window nothing enforces: ${feature}`,
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

// ---------------------------------------------------------------------------
// Personal, added 2026-08-27. The tier sits between Free and Pro and is the
// first internal id that matches its own display name, which is exactly why it
// needs its own assertions: the generic loops above iterate Object.values(PLANS)
// and stay green whatever the fourth entry actually contains.
// ---------------------------------------------------------------------------

test('Personal ships at the numbers it was signed off at', () => {
  const personal = PLANS.personal;
  assert.equal(personal.id, 'personal');
  assert.equal(personal.name, 'Personal');
  assert.equal(personal.monthlyPriceCents, 500);
  assert.equal(personal.yearlyPriceCents, 4800);
  // Twelve months less 20%, the same discount Pro and Team advertise. If the
  // monthly price ever moves, the yearly one has to move with it or the
  // pricing page prints a discount that is not the one being charged.
  assert.equal(personal.yearlyPriceCents, personal.monthlyPriceCents * 12 * 0.8);

  assert.equal(personal.limits.maxInboxes, 3);
  assert.equal(personal.limits.maxMembers, 1);
  assert.equal(personal.limits.maxRequestsPerMinute, 120);
  assert.equal(personal.limits.analyticsRetentionDays, 30);
  assert.equal(personal.limits.maxMonthlyToolCalls, 25_000);
  // A paid plan the customer cannot cancel themselves is a support ticket
  // waiting to happen, and in several jurisdictions a legal problem.
  assert.equal(personal.limits.billingPortalEnabled, true);
  assert.equal(personal.limits.analyticsEnabled, true);
  assert.equal(personal.limits.teamRolesEnabled, false);
  assert.equal(personal.limits.ssoEnabled, false);
  assert.equal(personal.limits.auditLogEnabled, false);
  assert.equal(personal.limits.supportTier, 'email');

  // Nothing else moved. Inserting a tier must not reprice the ones already sold.
  assert.equal(PLANS.free.limits.maxInboxes, 1);
  assert.equal(PLANS.solo.monthlyPriceCents, 2900);
  assert.equal(PLANS.solo.yearlyPriceCents, 27600);
  assert.equal(PLANS.pro.monthlyPriceCents, 7900);
  assert.equal(PLANS.pro.yearlyPriceCents, 75600);
});

test('the ladder is ordered Free, Personal, Pro, Team', () => {
  // The pricing page renders columns in Object.values(PLANS) order, so the
  // position of the key in the object literal IS the marketing layout. Moving
  // it produces a page that reads $0, $29, $5, $79 and nothing errors.
  assert.deepEqual(Object.keys(PLANS), ['free', 'personal', 'solo', 'pro']);

  const monthly = Object.values(PLANS).map((plan) => plan.monthlyPriceCents);
  assert.deepEqual(monthly, [0, 500, 2900, 7900]);
  for (let i = 1; i < monthly.length; i += 1) {
    assert.ok(monthly[i] > monthly[i - 1], 'the ladder must ascend in price');
  }
});

test('every plan renders under the name it is sold as, Personal included', () => {
  // planDisplayName falls back to capitalising the slug, and 'personal'
  // capitalises to 'Personal', so asserting the string alone would pass even if
  // the plan had been dropped from the catalogue entirely. Assert the name
  // comes OUT of the catalogue, and that the catalogue holds the right word.
  assert.equal(PLANS.personal.name, 'Personal');
  for (const plan of Object.values(PLANS)) {
    assert.equal(planDisplayName(plan.id), plan.name, `${plan.id} must render as its catalogue name`);
  }
  assert.equal(planDisplayName('personal'), 'Personal');
  assert.notEqual(planDisplayName('solo'), 'Solo');
});

test('a grandfathered user on Personal keeps unlimited inboxes', () => {
  // The one that silently costs a customer money: 176 accounts hold
  // `unlimited_inboxes`, and it must widen Personal's three exactly as it
  // widens Free's one. A grandfathered user who buys Personal for the analytics
  // or the burst rate must not be quietly cut down to three mailboxes.
  const grandfathered = resolvePlanLimits('personal', { unlimitedInboxes: true });
  assert.equal(grandfathered.maxInboxes, Infinity);

  // It lifts the inbox cap and nothing else: they are still a Personal account.
  assert.equal(grandfathered.maxMembers, 1);
  assert.equal(grandfathered.maxRequestsPerMinute, 120);
  assert.equal(grandfathered.analyticsRetentionDays, 30);
  assert.equal(grandfathered.maxMonthlyToolCalls, 25_000);
  assert.equal(grandfathered.supportTier, 'email');
  assert.equal(grandfathered.teamRolesEnabled, false);
});

test('a Personal user without the grandfather is capped at three inboxes', () => {
  assert.equal(resolvePlanLimits('personal').maxInboxes, 3);
  assert.equal(resolvePlanLimits('personal', { unlimitedInboxes: false }).maxInboxes, 3);
  // The comp is a Team grant, so it overrides the plan wholesale rather than
  // widening Personal in place.
  assert.equal(resolvePlanLimits('personal', { compedScale: true }).maxInboxes, Infinity);
  assert.equal(resolvePlanLimits('personal', { compedScale: true }).maxMembers, Infinity);
});

test('both Personal prices reverse-resolve to the Personal plan', async () => {
  // plans.ts reads the price ids from the environment at module load, so this
  // needs a fresh module instance rather than the one imported at the top.
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_monthly_fixture';
  process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_yearly_fixture';
  // The `?personal-prices` suffix is a cache-buster for Node's ESM loader: it
  // keys the module map by URL, so the query gives a second, freshly evaluated
  // instance that reads the env set above. It is a runtime-only specifier, and
  // tsc resolves it as a literal path and cannot find it. The cast keeps the
  // real module types, so nothing below this line is untyped.
  // @ts-expect-error TS2307: runtime cache-buster, not a resolvable path.
  const fresh = (await import('./plans.ts?personal-prices')) as typeof import('./plans.ts');

  const monthly = fresh.getPlanByStripePriceId('price_personal_monthly_fixture');
  assert.ok(monthly, 'the Personal monthly price must map to a plan');
  assert.equal(monthly.plan.id, 'personal');
  assert.equal(monthly.interval, 'month');

  const yearly = fresh.getPlanByStripePriceId('price_personal_yearly_fixture');
  assert.ok(yearly, 'the Personal yearly price must map to a plan');
  assert.equal(yearly.plan.id, 'personal');
  assert.equal(yearly.interval, 'year');

  // Personal is new, so it has no pre-repricing subscriptions to carry.
  assert.deepEqual(PLANS.personal.legacyStripePriceIds, []);

  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY;
  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY;
});
