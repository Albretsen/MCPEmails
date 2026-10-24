/**
 * Server-side helper to fetch live prices from Stripe for all configured plans.
 *
 * Results are ISR-cached for 1 hour via Next.js unstable_cache, so Stripe is
 * not called on every request. When a price ID is missing or Stripe throws,
 * we fall back to the static cent values defined in plans.ts.
 *
 * Import only in Server Components or Route Handlers; never in client bundles.
 */

import { unstable_cache } from 'next/cache';
import { stripe } from '@/lib/stripe/client';
import { PLANS, founderPriceIdFor } from '@/lib/stripe/plans';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StripePlanPrices {
  monthlyCents: number | null;
  yearlyCents: number | null;
  /**
   * Whether a Stripe price ID is configured for that interval, which is the
   * only thing that decides whether checkout can actually sell it.
   *
   * The cent amounts above CANNOT answer that question: when an ID is missing
   * this helper falls back to the static catalogue value, so `yearlyCents` is a
   * real number for a plan that has no yearly price to buy. A surface that
   * offered an interval on the strength of the amount alone would render a buy
   * button whose only possible outcome is `price_not_configured`, which is the
   * exact failure /pricing shipped once already.
   *
   * Both flags are computed from PLANS, the same source `runCheckout` resolves
   * the price from, so a button that is shown is a button that can be paid.
   */
  monthlyPriceConfigured: boolean;
  yearlyPriceConfigured: boolean;
  /**
   * Business only, and only while the founder offer is open to the viewer:
   * the amounts above are then the founder pair, and this carries what the
   * founder line prints. Absent everywhere else. Set by `withFounderPrices`.
   */
  founder?: FounderDisplay;
}

/** What a surface needs to print the founder line. */
export interface FounderDisplay {
  monthlyCents: number;
  yearlyCents: number;
  /** The normal per-mailbox price above the included ten, per month. */
  addonMonthlyCents: number;
  placesLeft: number;
  placesTotal: number;
}

export type StripePricesMap = Record<string, StripePlanPrices>;

// ---------------------------------------------------------------------------
// Internal fetch (un-cached); called once per cache lifetime
// ---------------------------------------------------------------------------

async function _fetchStripePrices(): Promise<StripePricesMap> {
  const result: StripePricesMap = {};

  await Promise.all(
    Object.values(PLANS).map(async (plan) => {
      let monthlyCents: number | null = plan.monthlyPriceCents;
      let yearlyCents: number | null = plan.yearlyPriceCents;

      // Fetch monthly price from Stripe when a price ID is configured
      if (plan.stripePriceIdMonthly) {
        try {
          const price = await stripe.prices.retrieve(plan.stripePriceIdMonthly);
          monthlyCents = price.unit_amount ?? plan.monthlyPriceCents;
        } catch {
          // Fall back to static value; Stripe may be unreachable at build time
          monthlyCents = plan.monthlyPriceCents;
        }
      }

      // Fetch yearly price from Stripe when a price ID is configured
      if (plan.stripePriceIdYearly) {
        try {
          const price = await stripe.prices.retrieve(plan.stripePriceIdYearly);
          yearlyCents = price.unit_amount ?? plan.yearlyPriceCents;
        } catch {
          // Fall back to static value
          yearlyCents = plan.yearlyPriceCents;
        }
      }

      // The static cents are a fallback, which also means a wrong price id in
      // an env var can hide behind them: the page would show the catalogue
      // amount while checkout charges whatever that id really costs. Say so
      // loudly when the two disagree. (Retrieve failures stay silent: those
      // happen at build time without network and are expected.)
      for (const [label, live, expected] of [
        ['monthly', monthlyCents, plan.monthlyPriceCents],
        ['yearly', yearlyCents, plan.yearlyPriceCents],
      ] as const) {
        if (live != null && expected != null && live !== expected) {
          console.error(
            `[stripe-prices] amount mismatch for ${plan.id} ${label}: Stripe ${live}, catalogue ${expected}`,
          );
        }
      }

      result[plan.id] = {
        monthlyCents,
        yearlyCents,
        monthlyPriceConfigured: Boolean(plan.stripePriceIdMonthly),
        yearlyPriceConfigured: Boolean(plan.stripePriceIdYearly),
      };
    }),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Cached export; revalidates every hour
//
// The cache key includes every configured price ID, not just a constant. The
// 2026-08-19 repricing repointed STRIPE_PRICE_* at new prices, and because the
// key used to be a bare 'stripe-prices' the cache kept serving the retired
// amounts: the page rendered the old $12 and $49 next to new copy quoting $29.
// Deriving the key from the IDs means repointing a price invalidates the entry
// on the next request instead of up to an hour later.
// ---------------------------------------------------------------------------

const priceIdFingerprint = Object.values(PLANS)
  .map(
    (plan) =>
      `${plan.id}:${plan.stripePriceIdMonthly ?? '-'}:${plan.stripePriceIdYearly ?? '-'}`,
  )
  .join('|');

export const fetchStripePrices: () => Promise<StripePricesMap> = unstable_cache(
  _fetchStripePrices,
  // 'v2' is a SHAPE version, not a price version. The entries cached before
  // the two `*PriceConfigured` flags existed are still valid amounts, and an
  // undefined flag reads as "not purchasable", so without bumping the key an
  // annual option could stay hidden for up to an hour after a deploy for no
  // reason a reader of this file could see. Bump it whenever a field is added.
  ['stripe-prices', 'v2', priceIdFingerprint],
  { revalidate: 3600 },
);

// ---------------------------------------------------------------------------
// The Business founder pair ($29 / $278.40), fetched the same way.
//
// Null when either founder price id is not configured: no surface may show a
// founder amount that checkout could not charge. The static fallback is only
// for a Stripe outage, never for a missing id.
// ---------------------------------------------------------------------------

/** Static fallback for the founder pair, in USD cents. */
export const FOUNDER_MONTHLY_FALLBACK_CENTS = 2900;
export const FOUNDER_YEARLY_FALLBACK_CENTS = 27840;

async function _fetchFounderPrices(
  monthlyId: string,
  yearlyId: string,
): Promise<StripePlanPrices> {
  const amount = async (id: string, fallback: number): Promise<number> => {
    try {
      const price = await stripe.prices.retrieve(id);
      return price.unit_amount ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [monthlyCents, yearlyCents] = await Promise.all([
    amount(monthlyId, FOUNDER_MONTHLY_FALLBACK_CENTS),
    amount(yearlyId, FOUNDER_YEARLY_FALLBACK_CENTS),
  ]);
  return { monthlyCents, yearlyCents, monthlyPriceConfigured: true, yearlyPriceConfigured: true };
}

export async function fetchFounderPrices(): Promise<StripePlanPrices | null> {
  const monthlyId = founderPriceIdFor('month');
  const yearlyId = founderPriceIdFor('year');
  if (!monthlyId || !yearlyId) return null;
  return unstable_cache(
    () => _fetchFounderPrices(monthlyId, yearlyId),
    ['stripe-founder-prices', 'v1', monthlyId, yearlyId],
    { revalidate: 3600 },
  )();
}
