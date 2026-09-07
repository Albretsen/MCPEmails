/**
 * The annual half of an upgrade offer: whether it can be sold, and what it saves.
 *
 * WHY THIS EXISTS. Every in-product upsell (the connect modal's cap panel, the
 * inbox-cap notice on the Inboxes page, the sidebar) sold MONTHLY and only
 * monthly: both paywall CTAs called `checkoutStartHref(plan, false)`. Annual is
 * 43% of committed revenue and the largest sale in the product's history was an
 * annual one, bought from /pricing after two monthly checkouts were abandoned,
 * so the highest-commitment option was invisible at the highest-intent moment.
 *
 * TWO RULES, both of which are the reason this is a module and not an inline
 * ternary in a component:
 *
 *  1. A saving is COMPUTED, never written down. The catalogue has been
 *     repriced twice (Pro $29 -> $15 on 2026-09-01), and the "save ~20%" in the
 *     message catalogue survived both because it is prose. A percentage derived
 *     from the two amounts cannot go stale, and it is derived from the SAME
 *     numbers the buyer is about to be charged.
 *  2. An interval with no configured Stripe price ID is NOT offered. /pricing
 *     once advertised a tier whose live price did not exist yet; checkout threw
 *     before it ever reached Stripe, and the blast radius was unmeasurable
 *     afterwards. `annualOffer` returns null for that case, and every caller
 *     renders nothing rather than a button that can only fail.
 *
 * Nothing here reads `process.env`, so it is safe in a client bundle. The
 * amounts and the two configured flags arrive from the server (fetchStripePrices
 * -> the dashboard page -> props), which is the only side that can see the
 * STRIPE_PRICE_* variables.
 */

import type { Plan } from './plans';
import type { StripePlanPrices } from './getPrices';

/** What a surface needs to know before it may show an annual choice. */
export interface AnnualOfferInput {
  monthlyPriceCents: number | null | undefined;
  yearlyPriceCents: number | null | undefined;
  /** True ONLY when a Stripe price ID exists for the yearly interval. */
  yearlyPriceConfigured: boolean | null | undefined;
}

/** A sellable annual option. Every amount is in USD cents. */
export interface AnnualOffer {
  /** What twelve monthly charges cost, for the comparison the buyer makes. */
  monthlyPriceCents: number;
  /** The single amount that leaves the card today on the annual option. */
  yearlyPriceCents: number;
  /** The annual price expressed per month, for the like-for-like number. */
  yearlyPerMonthCents: number;
  /**
   * Whole-percent saving against twelve monthly charges.
   *
   * Null when annual saves nothing (a mispriced or deliberately flat yearly
   * price). The option is still offered in that case, because it is real and
   * buyable, but it is offered WITHOUT a saving claim rather than with a
   * rounded-to-zero one.
   */
  savingPercent: number | null;
}

function positiveCents(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Resolve an annual option, or null when annual must not be offered at all.
 *
 * Null means exactly one thing to a caller: render no annual choice and leave
 * the monthly behaviour that shipped before this exactly as it was.
 */
export function annualOffer(input: AnnualOfferInput): AnnualOffer | null {
  // The guard that matters. An unconfigured price ID makes the plan unbuyable
  // on that interval no matter how sensible the amount beside it looks.
  if (input.yearlyPriceConfigured !== true) return null;

  const monthlyPriceCents = positiveCents(input.monthlyPriceCents);
  const yearlyPriceCents = positiveCents(input.yearlyPriceCents);
  if (monthlyPriceCents === null || yearlyPriceCents === null) return null;

  const twelveMonths = monthlyPriceCents * 12;
  const rawSaving = 1 - yearlyPriceCents / twelveMonths;
  const savingPercent = rawSaving > 0 ? Math.round(rawSaving * 100) : null;

  return {
    monthlyPriceCents,
    yearlyPriceCents,
    yearlyPerMonthCents: Math.round(yearlyPriceCents / 12),
    savingPercent: savingPercent === 0 ? null : savingPercent,
  };
}

/**
 * The same answer from a live price map, as the dashboard receives it.
 *
 * `StripePlanPrices` carries Stripe's own amounts, so the percentage a buyer
 * reads is computed from the prices they are about to be charged rather than
 * from the catalogue's fallback copy of them.
 */
export function annualOfferFromPrices(
  prices: StripePlanPrices | null | undefined,
): AnnualOffer | null {
  if (!prices) return null;
  return annualOffer({
    monthlyPriceCents: prices.monthlyCents,
    yearlyPriceCents: prices.yearlyCents,
    yearlyPriceConfigured: prices.yearlyPriceConfigured,
  });
}

/**
 * The same answer straight from the catalogue. Server-side only in practice:
 * the price IDs it reads live on `process.env`.
 */
export function annualOfferFromPlan(plan: Plan): AnnualOffer | null {
  return annualOffer({
    monthlyPriceCents: plan.monthlyPriceCents,
    yearlyPriceCents: plan.yearlyPriceCents,
    yearlyPriceConfigured: Boolean(plan.stripePriceIdYearly),
  });
}

/**
 * Render a cent amount as the price the copy around it already speaks.
 *
 * Whole dollars print as "$48", not "$48.00": every price on these surfaces is
 * whole today ($5, $15, $48, $144) and the neighbouring sentences write them
 * that way. A fractional amount keeps its cents rather than being rounded into
 * a number nobody is charged.
 */
export function formatPriceCents(cents: number, locale = 'en-US'): string {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    // A runtime that rejects the locale must still produce a price, not a gap
    // in a sentence that reads "Billed  once a year".
    return whole ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
  }
}
