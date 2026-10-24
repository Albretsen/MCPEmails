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
import { PLANS } from '@/lib/stripe/plans';
import { eurCentsFor } from '@/lib/stripe/eur-prices';

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
   * The EUR amounts an EU visitor is shown and charged (VAT included), from
   * the Stripe price's `currency_options.eur.unit_amount`. When the price has
   * no EUR option, or Stripe is unreachable, this is the USD cents above: the
   * EUR price has the same digits by decision (src/lib/stripe/eur-prices.ts),
   * so the fallback is the right number, not a guess.
   *
   * Optional in the type so fixtures and callers that predate EUR keep
   * compiling; this helper always sets all four. Absent reads as "no EUR
   * option", and the amount then falls back to the USD digits.
   */
  eurMonthlyCents?: number | null;
  eurYearlyCents?: number | null;
  /**
   * Whether the Stripe price really carries a EUR currency option, which is
   * what lets Checkout charge EUR. Same reasoning as the two flags above: the
   * amount alone cannot say it, because it falls back to the USD digits.
   */
  eurMonthlyConfigured?: boolean;
  eurYearlyConfigured?: boolean;
}

export type StripePricesMap = Record<string, StripePlanPrices>;

// ---------------------------------------------------------------------------
// Internal fetch (un-cached); called once per cache lifetime
// ---------------------------------------------------------------------------

/** What one Stripe price says about its USD and EUR amounts. */
interface RetrievedAmounts {
  usdCents: number | null;
  eurCents: number | null;
}

/**
 * Retrieve a price with its currency options. `currency_options` is not part
 * of the default price object, so without the expand a EUR option would read
 * as absent. Throws like `prices.retrieve`; the caller falls back.
 */
async function retrieveAmounts(priceId: string): Promise<RetrievedAmounts> {
  const price = await stripe.prices.retrieve(priceId, { expand: ['currency_options'] });
  const eur = price.currency_options?.eur?.unit_amount;
  return {
    usdCents: price.unit_amount ?? null,
    eurCents: typeof eur === 'number' ? eur : null,
  };
}

async function _fetchStripePrices(): Promise<StripePricesMap> {
  const result: StripePricesMap = {};

  await Promise.all(
    Object.values(PLANS).map(async (plan) => {
      let monthlyCents: number | null = plan.monthlyPriceCents;
      let yearlyCents: number | null = plan.yearlyPriceCents;
      let eurMonthlyOption: number | null = null;
      let eurYearlyOption: number | null = null;

      // Fetch monthly price from Stripe when a price ID is configured
      if (plan.stripePriceIdMonthly) {
        try {
          const live = await retrieveAmounts(plan.stripePriceIdMonthly);
          monthlyCents = live.usdCents ?? plan.monthlyPriceCents;
          eurMonthlyOption = live.eurCents;
        } catch {
          // Fall back to static value; Stripe may be unreachable at build time
          monthlyCents = plan.monthlyPriceCents;
        }
      }

      // Fetch yearly price from Stripe when a price ID is configured
      if (plan.stripePriceIdYearly) {
        try {
          const live = await retrieveAmounts(plan.stripePriceIdYearly);
          yearlyCents = live.usdCents ?? plan.yearlyPriceCents;
          eurYearlyOption = live.eurCents;
        } catch {
          // Fall back to static value
          yearlyCents = plan.yearlyPriceCents;
        }
      }

      // The static cents are a fallback, which also means a wrong price id in
      // an env var can hide behind them: the page would show the catalogue
      // amount while checkout charges whatever that id really costs. Say so
      // loudly when the two disagree. (Retrieve failures stay silent: those
      // happen at build time without network and are expected.) The EUR
      // option is held to the same digits as the USD amount it sits on.
      for (const [label, live, expected] of [
        ['monthly', monthlyCents, plan.monthlyPriceCents],
        ['yearly', yearlyCents, plan.yearlyPriceCents],
        ['monthly eur', eurMonthlyOption, monthlyCents],
        ['yearly eur', eurYearlyOption, yearlyCents],
      ] as const) {
        if (live != null && expected != null && live !== expected) {
          console.error(
            `[stripe-prices] amount mismatch for ${plan.id} ${label}: Stripe ${live}, expected ${expected}`,
          );
        }
      }

      result[plan.id] = {
        monthlyCents,
        yearlyCents,
        monthlyPriceConfigured: Boolean(plan.stripePriceIdMonthly),
        yearlyPriceConfigured: Boolean(plan.stripePriceIdYearly),
        eurMonthlyCents: eurCentsFor(eurMonthlyOption, monthlyCents),
        eurYearlyCents: eurCentsFor(eurYearlyOption, yearlyCents),
        eurMonthlyConfigured: eurMonthlyOption != null && eurMonthlyOption > 0,
        eurYearlyConfigured: eurYearlyOption != null && eurYearlyOption > 0,
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
  // v3: the four eur* fields.
  ['stripe-prices', 'v3', priceIdFingerprint],
  { revalidate: 3600 },
);
