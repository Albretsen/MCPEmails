/**
 * The Business founder line as the pages print it. Server only.
 *
 * Kept apart from founder-offer-server.ts so checkout does not load the
 * Next price cache: this module is for pages (/pricing and the dashboard).
 */

import { BUSINESS_EXTRA_INBOX_MONTHLY_CENTS } from '@/lib/stripe/plans';
import {
  fetchFounderPrices,
  type FounderDisplay,
  type StripePricesMap,
} from '@/lib/stripe/getPrices';
import { currentFounderOffer } from '@/lib/stripe/founder-offer-server';

/**
 * The founder line for a surface, or null when nothing may be shown.
 *
 * zh is frozen and keeps the normal $39 (the copy exists in en, nb, de, fr
 * and es only). The amounts are the founder prices as Stripe holds them,
 * the same prices checkout charges.
 */
export async function founderDisplayFor(opts: {
  ownerId?: string | null;
  locale?: string | null;
  now?: Date;
}): Promise<FounderDisplay | null> {
  if (opts.locale === 'zh') return null;
  const offer = await currentFounderOffer({ ownerId: opts.ownerId, now: opts.now });
  if (!offer) return null;
  const prices = await fetchFounderPrices();
  if (!prices?.monthlyCents || !prices.yearlyCents) return null;
  return {
    monthlyCents: prices.monthlyCents,
    yearlyCents: prices.yearlyCents,
    addonMonthlyCents: BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
    placesLeft: offer.placesLeft,
    placesTotal: offer.placesTotal,
  };
}

/**
 * The price map with the founder line attached to Business. The amounts are
 * left alone here; `pricesWithFounder` (founder-offer.ts) swaps them in for
 * the viewer's locale, on the server for /pricing and in the browser for the
 * dashboard, whose language is only known client-side.
 */
export function attachFounder(
  prices: StripePricesMap,
  founder: FounderDisplay | null,
): StripePricesMap {
  if (!founder || !prices.pro) return prices;
  return { ...prices, pro: { ...prices.pro, founder } };
}
