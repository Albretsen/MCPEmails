/**
 * Business billed per person, as the pages print it. Server only.
 *
 * Kept apart from business-seats.ts so checkout and the webhook do not load
 * the Next price cache: this module is for pages (the dashboard, and /pricing
 * once its copy is written).
 */

import { unstable_cache } from 'next/cache';
import { stripe } from '@/lib/stripe/client';
import {
  BUSINESS_MIN_SEATS,
  BUSINESS_SEAT_MONTHLY_CENTS,
  BUSINESS_SEAT_YEARLY_CENTS,
  businessSeatPriceId,
} from '@/lib/stripe/plans';
import { businessSeatPricingOn } from '@/lib/stripe/business-seats';
import type { StripePricesMap } from '@/lib/stripe/getPrices';

async function _fetchSeatAmounts(
  monthlyId: string | null,
  yearlyId: string | null,
): Promise<{ monthlyCents: number; yearlyCents: number }> {
  const amount = async (id: string | null, fallback: number): Promise<number> => {
    if (!id) return fallback;
    try {
      const price = await stripe.prices.retrieve(id);
      return price.unit_amount ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [monthlyCents, yearlyCents] = await Promise.all([
    amount(monthlyId, BUSINESS_SEAT_MONTHLY_CENTS),
    amount(yearlyId, BUSINESS_SEAT_YEARLY_CENTS),
  ]);
  return { monthlyCents, yearlyCents };
}

/**
 * The price map with Business priced per person, when the switch is on.
 * Unchanged when it is off (or its read fails), so production renders
 * exactly what it did. The founder line is dropped: the offer is closed
 * while per-person pricing is on (founder-offer-server.ts).
 *
 * Pure apart from the reads; `seatOn` and `amounts` let a test skip them.
 */
export async function withBusinessSeatPrices(
  prices: StripePricesMap,
  opts?: { seatOn?: boolean; amounts?: { monthlyCents: number; yearlyCents: number } },
): Promise<StripePricesMap> {
  const pro = prices.pro;
  if (!pro) return prices;
  const seatOn = opts?.seatOn ?? (await businessSeatPricingOn());
  if (!seatOn) return prices;
  const monthlyId = businessSeatPriceId('month');
  const yearlyId = businessSeatPriceId('year');
  const amounts =
    opts?.amounts ??
    (await unstable_cache(
      () => _fetchSeatAmounts(monthlyId, yearlyId),
      ['stripe-business-seat-prices', 'v1', monthlyId ?? '-', yearlyId ?? '-'],
      { revalidate: 3600 },
    )());
  const { founder: _dropped, founderSubscriber: _sub, ...rest } = pro;
  void _dropped;
  void _sub;
  return {
    ...prices,
    pro: {
      ...rest,
      monthlyCents: amounts.monthlyCents,
      yearlyCents: amounts.yearlyCents,
      // Same digits in EUR, the rule every price follows (eur-prices.ts).
      eurMonthlyCents: amounts.monthlyCents,
      eurYearlyCents: amounts.yearlyCents,
      monthlyPriceConfigured: Boolean(monthlyId),
      yearlyPriceConfigured: Boolean(yearlyId),
      perPerson: { minPeople: BUSINESS_MIN_SEATS },
    },
  };
}
