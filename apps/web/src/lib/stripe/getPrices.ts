/**
 * Server-side helper to fetch live prices from Stripe for all configured plans.
 *
 * Results are ISR-cached for 1 hour via Next.js unstable_cache, so Stripe is
 * not called on every request. When a price ID is missing or Stripe throws,
 * we fall back to the static cent values defined in plans.ts.
 *
 * Import only in Server Components or Route Handlers — never in client bundles.
 */

import { unstable_cache } from 'next/cache';
import { stripe } from '@/lib/stripe/client';
import { PLANS } from '@/lib/stripe/plans';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StripePlanPrices {
  monthlyCents: number | null;
  yearlyCents: number | null;
}

export type StripePricesMap = Record<string, StripePlanPrices>;

// ---------------------------------------------------------------------------
// Internal fetch (un-cached) — called once per cache lifetime
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
          // Fall back to static value — Stripe may be unreachable at build time
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

      result[plan.id] = { monthlyCents, yearlyCents };
    }),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Cached export — revalidates every hour
// ---------------------------------------------------------------------------

export const fetchStripePrices: () => Promise<StripePricesMap> = unstable_cache(
  _fetchStripePrices,
  ['stripe-prices'],
  { revalidate: 3600 },
);
