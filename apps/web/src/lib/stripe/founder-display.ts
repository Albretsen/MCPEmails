/**
 * The Business founder line as the pages print it. Server only.
 *
 * Kept apart from founder-offer-server.ts so checkout does not load the
 * Next price cache: this module is for pages (/pricing and the dashboard).
 */

import {
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  basePlanItem,
  founderPriceIdFor,
  isFounderPriceId,
} from '@/lib/stripe/plans';
import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
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

/**
 * Whether this owner's live subscription is on a founder price. Only asked for
 * an owner already on Business, and only when the founder prices exist, so it
 * costs one Stripe read for a handful of accounts. A failed read is "no".
 */
export async function ownerIsOnFounderPrice(userId: string): Promise<boolean> {
  if (!founderPriceIdFor('month') || !founderPriceIdFor('year')) return false;
  try {
    const { data } = await createServiceRoleClient()
      .from('user_billing')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .maybeSingle();
    const subscriptionId = data?.stripe_subscription_id;
    if (!subscriptionId) return false;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return isFounderPriceId(basePlanItem(subscription.items.data)?.price?.id ?? null);
  } catch (err) {
    console.error(
      '[founder-display] founder subscriber check failed',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * The price map for an owner who already pays the founder price: Business is
 * priced from the founder pair ($29 / $278.40), which is what they are billed,
 * with no founder line (there is nothing left to offer them). Unchanged when
 * the founder amounts cannot be read.
 */
export async function withFounderSubscriberPrices(
  prices: StripePricesMap,
): Promise<StripePricesMap> {
  const founder = await fetchFounderPrices();
  if (!founder?.monthlyCents || !founder.yearlyCents || !prices.pro) return prices;
  return {
    ...prices,
    pro: {
      ...prices.pro,
      monthlyCents: founder.monthlyCents,
      yearlyCents: founder.yearlyCents,
      founderSubscriber: true,
    },
  };
}
