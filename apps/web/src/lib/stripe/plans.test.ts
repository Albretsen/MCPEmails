import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  BUSINESS_EXTRA_INBOX_YEARLY_CENTS,
  BUSINESS_INCLUDED_INBOXES,
  FREE_ACTION_ALLOWANCE,
  FREE_ACTION_GRACE_DAYS,
  PLANS,
  PRO_INBOX_CAP,
  basePlanItem,
  extraMailboxQuantity,
  isMailboxAddonPriceId,
  mailboxAddonItem,
  mailboxAddonPriceId,
  planCommitmentRank,
  getPlanByStripePriceId,
  planDisplayName,
  resolvePlanLimits,
} from './plans.ts';

/** The one Free feature line that quotes the allowance, built as plans.ts builds it. */
const FREE_ALLOWANCE_FEATURE = `${FREE_ACTION_ALLOWANCE} email actions a month, first ${FREE_ACTION_GRACE_DAYS} days uncounted`;

test('the value metric is inboxes, and the tiers are named the way they are sold', () => {
  assert.equal(PLANS.free.name, 'Free');
  assert.equal(PLANS.solo.name, 'Pro');
  assert.equal(PLANS.pro.name, 'Business');

  // Free is one inbox. This is the paywall now; everything else follows from it.
  // Pro is ten for a new customer (2026-10-19); Business is never capped, it
  // bills past ten instead.
  assert.equal(resolvePlanLimits('free').maxInboxes, 1);
  assert.equal(resolvePlanLimits('solo').maxInboxes, 10);
  assert.equal(resolvePlanLimits('pro').maxInboxes, Infinity);

  // Members are a Business feature. Pro buys mailboxes, not seats.
  assert.equal(resolvePlanLimits('free').maxMembers, 1);
  assert.equal(resolvePlanLimits('solo').maxMembers, 1);
  assert.equal(resolvePlanLimits('pro').maxMembers, Infinity);

  assert.equal(planDisplayName('solo'), 'Pro');
  assert.equal(planDisplayName('pro'), 'Business');
  assert.equal(planDisplayName('free'), 'Free');
  assert.equal(planDisplayName(null), 'Free');
});

test('prices match the published repricing', () => {
  assert.equal(PLANS.solo.monthlyPriceCents, 1900);
  assert.equal(PLANS.solo.yearlyPriceCents, 18240);
  assert.equal(PLANS.pro.monthlyPriceCents, 3900);
  assert.equal(PLANS.pro.yearlyPriceCents, 37440);
  assert.equal(PLANS.free.monthlyPriceCents, 0);
});

test('Free sells its action allowance; the paid ceilings stay silent', () => {
  // Free's allowance is public (2026-09-12): the pricing page, the dashboard
  // and the docs all quote it, and the MCP edge function refuses at exactly
  // this number. The constants are mirrored from the SQL function
  // workspace_action_allowance (c_free_cap = 150) and free_action_grace_ends_at
  // (3 days for new workspaces); if either
  // moves here, the migration and the pricing copy move with it.
  assert.equal(FREE_ACTION_ALLOWANCE, 150);
  assert.equal(FREE_ACTION_GRACE_DAYS, 3);
  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, FREE_ACTION_ALLOWANCE);
  assert.ok(
    PLANS.free.features.includes(FREE_ALLOWANCE_FEATURE),
    'the Free feature list must state the allowance, derived from the constants',
  );

  // The paid ceilings exist so a runaway agent cannot burn unbounded provider
  // quota. They are never sold, so no feature list may quote them as a number:
  // "No monthly action cap" is the only sentence a paid tier may say about
  // actions. If this test is updated, check that nothing customer-facing
  // quotes the old numbers.
  assert.equal(resolvePlanLimits('personal').maxMonthlyToolCalls, 100_000);
  assert.equal(resolvePlanLimits('solo').maxMonthlyToolCalls, 100_000);
  assert.equal(resolvePlanLimits('pro').maxMonthlyToolCalls, 500_000);
  assert.ok(PLANS.personal.features.includes('No monthly action cap'));

  for (const plan of Object.values(PLANS)) {
    if (plan.id === 'free') continue;
    for (const feature of plan.features) {
      assert.ok(
        !/\d[\d,_.]*\s*(k\s*)?(email\s+)?actions?\b/i.test(feature),
        `plan ${plan.id} quotes an action number in its feature list: ${feature}`,
      );
    }
  }
});

test('no feature list promises an analytics retention window', () => {
  // `analyticsRetentionDays` IS enforced now (2026-09-01): src/lib/analytics/
  // retention.ts turns it into the window the Usage page, the per-inbox call
  // counts and the audit log are all bounded by, and the dashboard labels
  // quote the same number. Before that it was dead config, so "30-day history"
  // / "90-day history" / "1-year history" were claims the product did not
  // implement.
  //
  // This assertion stays anyway, for a different reason: `plan.features` is
  // what builds the purchase confirmation email
  // (src/lib/email/purchase-confirmation.ts), and a retention promise made in
  // a feature list is a promise made in an email that nothing re-checks when
  // the window changes. Quote the window in the UI, where it is computed from
  // the plan, not in a hardcoded marketing string. These lists and the
  // `pricing.plans.*.features` message arrays are two renderings of one
  // promise and must not diverge again.
  //
  // The Free allowance line ("first 3 days uncounted") is the one exception:
  // it is a metering rule, not a retention window, and it is built from the
  // same constant the enforcing SQL mirrors, so it cannot drift on its own.
  for (const plan of Object.values(PLANS)) {
    for (const feature of plan.features) {
      if (feature === FREE_ALLOWANCE_FEATURE) continue;
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
  // a Free account for seats, support and the action allowance. (Whether a
  // given workspace is actually metered against that allowance is decided
  // per workspace by workspace_action_allowance(): everything created before
  // 2026-09-12 is exempt. That is not this function's business.)
  assert.equal(grandfathered.maxMembers, 1);
  assert.equal(grandfathered.maxMonthlyToolCalls, FREE_ACTION_ALLOWANCE);
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
  // The comp is Business's limits, and Business has no audit-log feature.
  assert.equal(compedFromFree.auditLogEnabled, false);
  assert.equal(compedFromFree.maxInboxes, Infinity);
  assert.equal(compedFromPro.maxInboxes, Infinity);

  const both = resolvePlanLimits('free', { compedScale: true, unlimitedInboxes: true });
  assert.equal(both.maxInboxes, Infinity);
  assert.equal(both.maxMonthlyToolCalls, Infinity);
  assert.equal(both.maxMembers, Infinity);

  // The Stripe/workspace projection remains an input, not a mutation made by
  // entitlement resolution. Webhook replays can safely continue to update it.
  assert.equal(resolvePlanLimits('free').maxMonthlyToolCalls, FREE_ACTION_ALLOWANCE);
  assert.equal(resolvePlanLimits('free').maxInboxes, 1);
});

test('unknown legacy plans safely use Free limits unless an entitlement applies', () => {
  assert.equal(resolvePlanLimits('unknown').maxMonthlyToolCalls, FREE_ACTION_ALLOWANCE);
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
    ['price_1U69IuARrgumc6cqLGFI2FLR', 'solo', 'month'], // Pro monthly, $29
    ['price_1U69J5ARrgumc6cqmIIP8DAw', 'solo', 'year'],  // Pro yearly, $276
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
      // An empty slot is an unset env-sourced legacy id holding its position.
      if (id === '') continue;
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
  // Repriced 2026-09-29 from $5 / $48, for new customers only.
  assert.equal(personal.monthlyPriceCents, 900);
  assert.equal(personal.yearlyPriceCents, 8640);
  // Twelve months less 20%, the same discount Pro and Team advertise. If the
  // monthly price ever moves, the yearly one has to move with it or the
  // pricing page prints a discount that is not the one being charged. Integer
  // form (x5 = x12x4) so a float rounding cannot make this pass or fail.
  assert.equal(personal.yearlyPriceCents * 5, personal.monthlyPriceCents * 12 * 4);

  assert.equal(personal.limits.maxInboxes, 3);
  assert.equal(personal.limits.maxMembers, 1);
  assert.equal(personal.limits.maxRequestsPerMinute, 120);
  assert.equal(personal.limits.analyticsRetentionDays, 90);
  assert.equal(personal.limits.maxMonthlyToolCalls, 100_000);
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
  assert.equal(PLANS.solo.monthlyPriceCents, 1900);
  assert.equal(PLANS.solo.yearlyPriceCents, 18240);
  assert.equal(PLANS.pro.monthlyPriceCents, 3900);
  assert.equal(PLANS.pro.yearlyPriceCents, 37440);
});

test('the ladder is ordered Free, Personal, Pro, Business', () => {
  // The pricing page renders columns in Object.values(PLANS) order, so the
  // position of the key in the object literal IS the marketing layout. Moving
  // it produces a page that reads $0, $15, $5, $79 and nothing errors.
  assert.deepEqual(Object.keys(PLANS), ['free', 'personal', 'solo', 'pro']);

  const monthly = Object.values(PLANS).map((plan) => plan.monthlyPriceCents);
  assert.deepEqual(monthly, [0, 900, 1900, 3900]);
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
  assert.equal(grandfathered.analyticsRetentionDays, 90);
  assert.equal(grandfathered.maxMonthlyToolCalls, 100_000);
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
  // Since the 2026-09-29 repricing the sold prices are the _V2 variables.
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_monthly_fixture';
  process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_yearly_fixture';
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

  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2;
  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2;
});

// ---------------------------------------------------------------------------
// The 2026-09-29 repricing, $5 -> $9. Every Personal subscriber before it keeps
// billing on the $5 / $48 prices, whose ids stay in the UNSUFFIXED variables;
// new customers buy the _V2 prices. Both generations must resolve to Personal
// at the right interval, or a renewal of a grandfathered customer reaches the
// webhook as an unknown price.
// ---------------------------------------------------------------------------

test('old $5 / $48 and new $9 / $86.40 Personal prices all resolve to Personal', async () => {
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_500_fixture';
  process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_4800_fixture';
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900_fixture';
  process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_8640_fixture';
  // @ts-expect-error TS2307: runtime cache-buster, not a resolvable path.
  const fresh = (await import('./plans.ts?personal-reprice')) as typeof import('./plans.ts');

  const cases: Array<[string, 'month' | 'year']> = [
    ['price_personal_500_fixture', 'month'],
    ['price_personal_4800_fixture', 'year'],
    ['price_personal_900_fixture', 'month'],
    ['price_personal_8640_fixture', 'year'],
  ];
  for (const [priceId, interval] of cases) {
    const resolved = fresh.getPlanByStripePriceId(priceId);
    assert.ok(resolved, `${priceId} must map to a plan`);
    assert.equal(resolved.plan.id, 'personal', `${priceId} plan`);
    assert.equal(resolved.interval, interval, `${priceId} interval`);
  }

  // New customers are sold the NEW prices, never the retired ones.
  assert.equal(fresh.PLANS.personal.stripePriceIdMonthly, 'price_personal_900_fixture');
  assert.equal(fresh.PLANS.personal.stripePriceIdYearly, 'price_personal_8640_fixture');
  assert.deepEqual(fresh.PLANS.personal.legacyStripePriceIds, [
    'price_personal_500_fixture',
    'price_personal_4800_fixture',
  ]);

  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY;
  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY;
  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2;
  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2;
});

test('an unset _V2 price never falls back to the retired $5 price', async () => {
  // The unsuffixed variables now hold the $5 / $48 prices. Selling from them
  // would charge $5 under copy that says $9; unconfigured must stay unbuyable.
  process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_500_fixture';
  process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_4800_fixture';
  // @ts-expect-error TS2307: runtime cache-buster, not a resolvable path.
  const fresh = (await import('./plans.ts?personal-v2-unset')) as typeof import('./plans.ts');

  assert.equal(fresh.PLANS.personal.stripePriceIdMonthly, null);
  assert.equal(fresh.PLANS.personal.stripePriceIdYearly, null);
  // ...while the grandfathered subscriptions still resolve.
  assert.equal(fresh.getPlanByStripePriceId('price_personal_500_fixture')?.plan.id, 'personal');

  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY;
  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY;
});

test('a half-configured legacy pair keeps the yearly id in the yearly slot', async () => {
  // Interval is read off list POSITION. If only the yearly retired id were set
  // and the monthly one collapsed out of the list, the $48 annual subscriptions
  // would resolve as MONTHLY and every plan-change direction would flip.
  delete process.env.STRIPE_PRICE_PERSONAL_MONTHLY;
  process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_4800_only_fixture';
  // @ts-expect-error TS2307: runtime cache-buster, not a resolvable path.
  const fresh = (await import('./plans.ts?personal-half-legacy')) as typeof import('./plans.ts');

  const yearly = fresh.getPlanByStripePriceId('price_personal_4800_only_fixture');
  assert.equal(yearly?.plan.id, 'personal');
  assert.equal(yearly?.interval, 'year');
  // The empty placeholder can never be matched.
  assert.equal(fresh.getPlanByStripePriceId(''), null);

  delete process.env.STRIPE_PRICE_PERSONAL_YEARLY;
});

test('the commitment rank orders every (plan, interval) pair', () => {
  // The ordering that decides whether an in-place plan change was expansion or
  // contraction. Three cases, each of which a simpler comparison gets wrong.

  // 1. Same tier, longer commitment. A plan-id comparison sees no change, and a
  //    yearly-revenue comparison calls it a downgrade, because $86.40 a year is
  //    less than $108 of monthlies. It is an upgrade.
  assert.ok(
    planCommitmentRank('personal', 'year') > planCommitmentRank('personal', 'month'),
    'personal/year must outrank personal/month',
  );

  // 2. A tier up beats an interval down: the interval must never be able to
  //    reach across a tier boundary.
  assert.ok(
    planCommitmentRank('solo', 'month') > planCommitmentRank('personal', 'year'),
    'a tier up is an upgrade at any interval',
  );

  // 3. A cheaper tier bought for a year is still a downgrade.
  assert.ok(
    planCommitmentRank('solo', 'year') < planCommitmentRank('pro', 'month'),
    'Pro annual sits below Team monthly',
  );

  // The move the 2026-09-14 customer actually made, and the floor beneath every
  // first purchase, so a new sale can never read as a downgrade.
  assert.ok(
    planCommitmentRank('solo', 'month') > planCommitmentRank('personal', 'month'),
    'personal -> solo is an upgrade',
  );
  assert.equal(planCommitmentRank('free', 'month'), 0);
});


// ---------------------------------------------------------------------------
// Pro capped at 10 and Business priced by mailbox, 2026-10-19.
// ---------------------------------------------------------------------------

test('Pro is capped at ten for a new customer, and the cutover exemption lifts it', () => {
  assert.equal(PRO_INBOX_CAP, 10);
  assert.equal(PLANS.solo.limits.maxInboxes, PRO_INBOX_CAP);
  assert.equal(resolvePlanLimits('solo').maxInboxes, 10);
  assert.equal(resolvePlanLimits('solo', { proUnlimitedInboxes: false }).maxInboxes, 10);
  // A workspace on Pro at the cutover (or every one, kill switch off).
  assert.equal(resolvePlanLimits('solo', { proUnlimitedInboxes: true }).maxInboxes, Infinity);
  // The 2026-08-19 grandfather still lifts Pro's cap on its own.
  assert.equal(resolvePlanLimits('solo', { unlimitedInboxes: true }).maxInboxes, Infinity);
});

test('the Pro exemption widens Pro and nothing else', () => {
  // It is a promise about Pro. A Pro customer who moves to Personal gets
  // Personal's three, and Free stays one: the flag must not travel.
  assert.equal(resolvePlanLimits('free', { proUnlimitedInboxes: true }).maxInboxes, 1);
  assert.equal(resolvePlanLimits('personal', { proUnlimitedInboxes: true }).maxInboxes, 3);
  // It touches the inbox cap only.
  const exempt = resolvePlanLimits('solo', { proUnlimitedInboxes: true });
  assert.equal(exempt.maxMembers, 1);
  assert.equal(exempt.maxMonthlyToolCalls, 100_000);
  assert.equal(exempt.teamRolesEnabled, false);
});

test('Business is $39 with ten mailboxes included and $3 for each extra', () => {
  const business = PLANS.pro;
  assert.equal(business.name, 'Business');
  assert.equal(business.monthlyPriceCents, 3900);
  assert.equal(BUSINESS_INCLUDED_INBOXES, 10);
  assert.equal(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS, 300);
  // Twelve months less exactly 20%, the discount every annual price carries,
  // in the same integer form as Personal's check: x5 = x12 x4.
  assert.equal(business.yearlyPriceCents, 37440);
  assert.equal(business.yearlyPriceCents! * 5, business.monthlyPriceCents * 12 * 4);
  assert.equal(BUSINESS_EXTRA_INBOX_YEARLY_CENTS, 2880);
  assert.equal(BUSINESS_EXTRA_INBOX_YEARLY_CENTS * 5, BUSINESS_EXTRA_INBOX_MONTHLY_CENTS * 12 * 4);
  // People cost nothing: unlimited members with roles.
  assert.equal(business.limits.maxMembers, Infinity);
  assert.equal(business.limits.teamRolesEnabled, true);
  assert.equal(business.limits.maxInboxes, Infinity);
});

test('Business claims only what exists', () => {
  // Team said SSO, audit log, a year of history and priority support. None of
  // it had code behind it. The limits must not carry it either, because a
  // limit set to true is one copy edit away from a claim again.
  const limits = PLANS.pro.limits;
  assert.equal(limits.ssoEnabled, false);
  assert.equal(limits.auditLogEnabled, false);
  assert.equal(limits.supportTier, 'email');
  // Two years, the same as Pro, kept by the per-plan activity_log job
  // (migration 20261020153742) rather than the old flat 90-day delete.
  assert.equal(limits.analyticsRetentionDays, 730);
  for (const plan of Object.values(PLANS)) {
    for (const feature of plan.features) {
      assert.ok(
        !/\b(SSO|SAML|OIDC|audit log|priority support|365|unlimited (connected )?inbox)/i.test(feature),
        `plan ${plan.id} claims something that does not exist: ${feature}`,
      );
    }
  }
});

test('extra mailboxes are the ones above ten, never negative', () => {
  assert.equal(extraMailboxQuantity(0), 0);
  assert.equal(extraMailboxQuantity(10), 0);
  assert.equal(extraMailboxQuantity(11), 1);
  assert.equal(extraMailboxQuantity(25), 15);
  assert.equal(extraMailboxQuantity(-3), 0);
  assert.equal(extraMailboxQuantity(Number.NaN), 0);
});

test('the add-on price is recognised at both intervals and is not a plan', () => {
  process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month_fixture';
  process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year_fixture';
  try {
    assert.equal(mailboxAddonPriceId('month'), 'price_addon_month_fixture');
    assert.equal(mailboxAddonPriceId('year'), 'price_addon_year_fixture');
    assert.equal(isMailboxAddonPriceId('price_addon_month_fixture'), true);
    assert.equal(isMailboxAddonPriceId('price_addon_year_fixture'), true);
    assert.equal(isMailboxAddonPriceId('price_1TcQBFARrgumc6cqmaRTXJ5Q'), false);
    assert.equal(isMailboxAddonPriceId(null), false);
    // The webhook maps a price to a plan; the add-on must never be one.
    assert.equal(getPlanByStripePriceId('price_addon_month_fixture'), null);
  } finally {
    delete process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY;
    delete process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY;
  }
});

test('the base plan item is found whatever order Stripe lists the items in', () => {
  process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month_fixture';
  try {
    const plan = { id: 'si_plan', price: { id: 'price_1TcQBFARrgumc6cqmaRTXJ5Q' } }; // legacy Business
    const addon = { id: 'si_addon', price: { id: 'price_addon_month_fixture' } };
    assert.equal(basePlanItem([plan, addon])?.id, 'si_plan');
    assert.equal(basePlanItem([addon, plan])?.id, 'si_plan');
    assert.equal(mailboxAddonItem([addon, plan])?.id, 'si_addon');
    assert.equal(mailboxAddonItem([plan]), undefined);
    // An unmapped price still comes back, exactly as items[0] did before.
    const unknown = { id: 'si_unknown', price: { id: 'price_unknown' } };
    assert.equal(basePlanItem([addon, unknown])?.id, 'si_unknown');
    assert.equal(basePlanItem([unknown])?.id, 'si_unknown');
    assert.equal(basePlanItem([]), undefined);
    assert.equal(basePlanItem(undefined), undefined);
  } finally {
    delete process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY;
  }
});

test('the retired $79 / $756 Team prices still resolve to Business', async () => {
  // Team had no paying subscriber, but a stray subscription on its price must
  // keep mapping to the plan rather than become an unknown price.
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_team_79_fixture';
  process.env.STRIPE_PRICE_PRO_YEARLY = 'price_team_756_fixture';
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_39_fixture';
  process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_37440_fixture';
  // @ts-expect-error TS2307: runtime cache-buster, not a resolvable path.
  const fresh = (await import('./plans.ts?business-prices')) as typeof import('./plans.ts');
  try {
    assert.equal(fresh.PLANS.pro.stripePriceIdMonthly, 'price_business_39_fixture');
    assert.equal(fresh.PLANS.pro.stripePriceIdYearly, 'price_business_37440_fixture');
    assert.deepEqual(fresh.getPlanByStripePriceId('price_business_39_fixture'), { plan: fresh.PLANS.pro, interval: 'month' });
    assert.deepEqual(fresh.getPlanByStripePriceId('price_team_79_fixture'), { plan: fresh.PLANS.pro, interval: 'month' });
    assert.deepEqual(fresh.getPlanByStripePriceId('price_team_756_fixture'), { plan: fresh.PLANS.pro, interval: 'year' });
  } finally {
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    delete process.env.STRIPE_PRICE_PRO_YEARLY;
    delete process.env.STRIPE_PRICE_BUSINESS_MONTHLY;
    delete process.env.STRIPE_PRICE_BUSINESS_YEARLY;
  }
});
