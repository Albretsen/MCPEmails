// ---------------------------------------------------------------------------
// The in-product paywall sold monthly and only monthly: both cap CTAs called
// `checkoutStartHref(plan, false)`. These tests pin the three things that made
// fixing that safe rather than merely profitable.
//
//   1. The DEFAULT is still monthly. Nobody's click changes price.
//   2. Choosing annual reaches Stripe as the yearly price AND reaches the
//      funnel as `<plan>_year`, or the experiment cannot be measured.
//   3. A plan with no configured yearly price ID offers no annual button.
//      /pricing once advertised a tier whose live price did not exist; the
//      checkout threw before any Stripe call and recorded nothing.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/annual-offer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  annualOffer,
  annualOfferFromPlan,
  annualOfferFromPrices,
  formatPriceCents,
} from './annual-offer.ts';
import { PLANS } from './plans.ts';
import { checkoutStartHref } from '../billing/upgrade-intent.mjs';
import { billingTarget } from '../analytics/billing-funnel.ts';

/** A plan whose yearly price IS configured, which is the sellable case. */
function sellable(monthlyPriceCents: number, yearlyPriceCents: number) {
  return { monthlyPriceCents, yearlyPriceCents, yearlyPriceConfigured: true };
}

test('the saving is computed from the two prices, never written down', () => {
  // Personal: $5/mo vs $48/yr. Pro (internal id `solo`): $15/mo vs $144/yr.
  // Both are 20% today, and both have been repriced before, which is exactly
  // why neither number may be typed into copy.
  assert.equal(annualOffer({ ...sellable(500, 4800) })!.savingPercent, 20);
  assert.equal(annualOffer({ ...sellable(1500, 14400) })!.savingPercent, 20);

  // Team: $79/mo vs $756/yr rounds to 20 as well, from 20.25.
  assert.equal(annualOffer({ ...sellable(7900, 75600) })!.savingPercent, 20);

  // A repricing the copy has not caught up with still tells the truth.
  assert.equal(annualOffer({ ...sellable(1000, 6000) })!.savingPercent, 50);
});

test('the per-month figure is the annual price divided, not the monthly one', () => {
  const offer = annualOffer({ ...sellable(500, 4800) })!;
  assert.equal(offer.yearlyPerMonthCents, 400);
  assert.equal(offer.yearlyPriceCents, 4800);
  // The amount that actually leaves the card is kept whole, so the surface can
  // state it before the click instead of leaving it to Stripe's page.
  assert.equal(formatPriceCents(offer.yearlyPriceCents), '$48');
  assert.equal(formatPriceCents(offer.yearlyPerMonthCents), '$4');
  // Fractional prices keep their cents rather than being rounded into a number
  // nobody is charged.
  assert.equal(formatPriceCents(499), '$4.99');
});

test('an unconfigured yearly price ID offers no annual option at all', () => {
  // THE INCIDENT GUARD. The amount looks perfectly sensible here: it is the
  // catalogue fallback. Only the price ID says whether Stripe can sell it.
  assert.equal(
    annualOffer({
      monthlyPriceCents: 500,
      yearlyPriceCents: 4800,
      yearlyPriceConfigured: false,
    }),
    null,
  );
  assert.equal(
    annualOffer({
      monthlyPriceCents: 500,
      yearlyPriceCents: 4800,
      yearlyPriceConfigured: undefined,
    }),
    null,
  );
  // The same through the shape the dashboard actually receives, including the
  // case where no price map reached the surface at all.
  assert.equal(annualOfferFromPrices(null), null);
  assert.equal(annualOfferFromPrices(undefined), null);
  assert.equal(
    annualOfferFromPrices({
      monthlyCents: 500,
      yearlyCents: 4800,
      monthlyPriceConfigured: true,
      yearlyPriceConfigured: false,
    }),
    null,
  );
});

test('a missing or nonsensical amount offers no annual option either', () => {
  for (const bad of [null, undefined, 0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      annualOffer({ monthlyPriceCents: 500, yearlyPriceCents: bad, yearlyPriceConfigured: true }),
      null,
      `yearly ${String(bad)} must not be sellable`,
    );
    assert.equal(
      annualOffer({ monthlyPriceCents: bad, yearlyPriceCents: 4800, yearlyPriceConfigured: true }),
      null,
      `monthly ${String(bad)} cannot anchor a saving`,
    );
  }
});

test('a yearly price that saves nothing is offered without a saving claim', () => {
  // Twelve months for the price of twelve months is still a real, buyable
  // option. It just does not get to call itself a discount.
  const flat = annualOffer({ ...sellable(500, 6000) })!;
  assert.notEqual(flat, null);
  assert.equal(flat.savingPercent, null);

  const worse = annualOffer({ ...sellable(500, 7000) })!;
  assert.equal(worse.savingPercent, null);

  // A rounding-to-zero saving is no saving: 0.4% must not print as "Save 0%".
  const trivial = annualOffer({ ...sellable(10000, 119500) })!;
  assert.equal(trivial.savingPercent, null);
});

test('the catalogue itself only offers annual where a yearly price ID exists', () => {
  // In this environment no STRIPE_PRICE_* variables are set, so the catalogue
  // resolves every price ID to null. Nothing may be offered on those terms,
  // whatever the cent amounts beside them say.
  for (const plan of [PLANS.personal, PLANS.solo, PLANS.pro]) {
    if (plan.stripePriceIdYearly) {
      assert.notEqual(annualOfferFromPlan(plan), null);
    } else {
      assert.equal(annualOfferFromPlan(plan), null);
    }
  }
  // Free has no yearly price ID and no price to save on.
  assert.equal(annualOfferFromPlan(PLANS.free), null);
});

test('the default is monthly: an untouched paywall buys what it always bought', () => {
  // `checkoutStartHref(plan, annual)` is the CTA's whole contract, and the
  // paywall passes `interval === 'year'` from a state that starts at 'month'.
  // The exact expression both CTAs render, with the state they start in.
  const ctaHref = (interval: 'month' | 'year') =>
    checkoutStartHref('personal', interval === 'year');

  assert.equal(ctaHref('month'), '/api/stripe/checkout/start?plan=personal&interval=month');
  assert.equal(ctaHref('year'), '/api/stripe/checkout/start?plan=personal&interval=year');
});

test('choosing annual reaches Stripe as yearly and the funnel as <plan>_year', () => {
  // The full path a click takes: the CTA href, the query the start route reads
  // off it, and the category `runCheckout` records through `billingTarget`.
  // If this drifts, the interval choice is invisible in `checkout_started` and
  // the whole change becomes unmeasurable.
  for (const planId of ['personal', 'solo'] as const) {
    const href = checkoutStartHref(planId, true);
    const url = new URL(href, 'https://mcpemails.com');
    assert.equal(url.pathname, '/api/stripe/checkout/start');
    assert.equal(url.searchParams.get('plan'), planId);
    assert.equal(url.searchParams.get('interval'), 'year');

    const interval = url.searchParams.get('interval') as 'month' | 'year';
    assert.equal(billingTarget(planId, interval), `${planId}_year`);

    // And the monthly half of the same contract, unchanged.
    const monthly = new URL(checkoutStartHref(planId, false), 'https://mcpemails.com');
    assert.equal(monthly.searchParams.get('interval'), 'month');
    assert.equal(
      billingTarget(planId, monthly.searchParams.get('interval') as 'month' | 'year'),
      `${planId}_month`,
    );
  }
});

test('the annual price the CTA quotes is the price the interval buys', () => {
  // The label reads "Upgrade to Pro, $144 a year" only because this amount and
  // the yearly price ID come from the same catalogue entry. A CTA that said
  // "$15/mo" while opening a $144 charge is the dark pattern this avoids.
  const solo = annualOffer({ ...sellable(PLANS.solo.monthlyPriceCents, PLANS.solo.yearlyPriceCents!) })!;
  assert.equal(formatPriceCents(solo.yearlyPriceCents), '$144');
  const personal = annualOffer({
    ...sellable(PLANS.personal.monthlyPriceCents, PLANS.personal.yearlyPriceCents!),
  })!;
  assert.equal(formatPriceCents(personal.yearlyPriceCents), '$48');
});
