/**
 * The Business founder price: who may buy it, and at which price id.
 *
 * Pure. No Stripe, no database, no clock of its own: every input is passed in,
 * so the window edges and the cap are tested as plain values. The server side
 * that reads the flag, the place count and the owner's own row is
 * founder-offer-server.ts.
 *
 * The offer: Business at $29 a month or $278.40 a year (two separate Stripe
 * prices, not a coupon), for the first FOUNDER_PLACES Business subscriptions
 * or until the end of 2026 Oslo time, whichever comes first. The price is kept
 * for as long as that subscription stays active, including monthly <-> yearly
 * switches. Mailbox add-ons stay at their normal price.
 *
 * THREE INDEPENDENT LOCKS, any one of which ends it:
 *
 *   1. The time window below, in UTC. Forgetting to switch the flag off cannot
 *      extend the offer past 2026-12-31 23:59:59 Oslo time.
 *   2. The runtime flag `pricing_switches.business_founder_price`, so it can be
 *      stopped early without a deploy.
 *   3. The place cap: at FOUNDER_PLACES rows in business_founder_places the
 *      offer is gone.
 *
 * What survives all three: an existing founder subscription switching between
 * monthly and yearly stays on the founder pair forever (`businessPriceFor`).
 */

import {
  founderPriceIdFor,
  isFounderPriceId,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';
import type { StripePricesMap } from '@/lib/stripe/getPrices';

/** Places on offer. Public copy says "the first 20 companies". */
export const FOUNDER_PLACES = 20;

/** 2026-11-09 00:00 Europe/Oslo (CET, UTC+1). */
export const FOUNDER_WINDOW_START = new Date('2026-11-08T23:00:00Z');

/**
 * 2026-12-31 23:59:59 Europe/Oslo, inclusive. The offer is still open at this
 * instant and closed from FOUNDER_WINDOW_CLOSED on.
 */
export const FOUNDER_WINDOW_END = new Date('2026-12-31T22:59:59Z');

/** The first instant the offer is closed: 2027-01-01 00:00 Oslo. */
export const FOUNDER_WINDOW_CLOSED = new Date('2026-12-31T23:00:00Z');

/** The `priceValidUntil` date in the /pricing structured data. */
export const FOUNDER_VALID_UNTIL = '2026-12-31';

/** The cohort tag on every founder subscription, under FOUNDER_METADATA_KEY. */
export const FOUNDER_OFFER_TAG = 'founder2026';

/**
 * The Stripe metadata key the cohort tag is written under. Its own key, not
 * the shared `offer` key the Black Week offer writes `bw2026` to, so neither
 * tag can ever overwrite the other.
 */
export const FOUNDER_METADATA_KEY = 'founder_offer';

/** The `pricing_switches` key of the runtime flag. */
export const FOUNDER_FLAG_KEY = 'business_founder_price';

export interface FounderOffer {
  monthlyPriceId: string;
  yearlyPriceId: string;
  /** Places still open. Never negative, and above zero whenever there is an offer. */
  placesLeft: number;
  placesTotal: number;
  /** The inclusive end instant, ISO 8601 in UTC. */
  endsAt: string;
  /** The last day of the offer as a date, for `priceValidUntil`. */
  endsAtLabel: string;
}

export interface FounderOfferInput {
  now: Date;
  /** Rows in business_founder_places. Null when the count could not be read. */
  placesTaken: number | null;
  /** The owner already holds (or held) a founder subscription. One per owner. */
  ownerHasFounderSub: boolean;
  /** `pricing_switches.business_founder_price`. */
  flagOn: boolean;
  /** Defaults to the configured founder price ids. */
  monthlyPriceId?: string | null;
  yearlyPriceId?: string | null;
}

/** Whether `now` falls inside the founder window, edges included. */
export function inFounderWindow(now: Date): boolean {
  const t = now.getTime();
  if (!Number.isFinite(t)) return false;
  return t >= FOUNDER_WINDOW_START.getTime() && t < FOUNDER_WINDOW_CLOSED.getTime();
}

/** Places left for a count, never negative. Overflow (a 21st) reads as 0. */
export function founderPlacesLeft(placesTaken: number): number {
  const taken = Number.isFinite(placesTaken) ? Math.max(0, Math.floor(placesTaken)) : FOUNDER_PLACES;
  return Math.max(0, FOUNDER_PLACES - taken);
}

/**
 * The founder offer open to this buyer right now, or null.
 *
 * Null when the flag is off, outside the window, when the place count is
 * unknown (never guess), when every place is taken, when the owner already
 * has a founder subscription, or when either founder price is not configured.
 */
export function founderOfferFor(input: FounderOfferInput): FounderOffer | null {
  if (!input.flagOn) return null;
  if (!inFounderWindow(input.now)) return null;
  if (input.ownerHasFounderSub) return null;
  if (input.placesTaken == null) return null;

  const monthlyPriceId =
    input.monthlyPriceId !== undefined ? input.monthlyPriceId : founderPriceIdFor('month');
  const yearlyPriceId =
    input.yearlyPriceId !== undefined ? input.yearlyPriceId : founderPriceIdFor('year');
  if (!monthlyPriceId || !yearlyPriceId) return null;

  const placesLeft = founderPlacesLeft(input.placesTaken);
  if (placesLeft <= 0) return null;

  return {
    monthlyPriceId,
    yearlyPriceId,
    placesLeft,
    placesTotal: FOUNDER_PLACES,
    endsAt: FOUNDER_WINDOW_END.toISOString(),
    endsAtLabel: FOUNDER_VALID_UNTIL,
  };
}

/**
 * Whether the terms may print the founder clause (5.8).
 *
 * Never in zh (frozen; it would fall back to the English clause). Otherwise
 * when the offer has been switched on and has started, or when at least one
 * founder subscription exists, so the clause stays for existing founders after
 * the window closes. A failed read arrives as null and counts as "no".
 */
export function founderTermsVisibleFor(input: {
  locale: string | null | undefined;
  now: Date;
  flagOn: boolean | null;
  placesTaken: number | null;
}): boolean {
  if (input.locale === 'zh') return false;
  const started =
    input.flagOn === true && input.now.getTime() >= FOUNDER_WINDOW_START.getTime();
  const founderExists = input.placesTaken != null && input.placesTaken > 0;
  return started || founderExists;
}

/**
 * The price map a surface renders: Business priced from the founder pair when
 * a founder line is attached (`attachFounder`, founder-display.ts), so every
 * card, interval choice and buy button quotes what checkout charges.
 *
 * zh is frozen and keeps the normal price: the founder line is dropped and
 * the amounts are left as they were. With no founder line attached the map is
 * returned as it is.
 */
export function pricesWithFounder<T extends StripePricesMap | null | undefined>(
  prices: T,
  locale: string | null | undefined,
): T {
  const pro = prices?.pro;
  if (!prices || !pro?.founder) return prices;
  if (locale === 'zh') {
    const { founder: _dropped, ...normal } = pro;
    void _dropped;
    return { ...prices, pro: normal };
  }
  return {
    ...prices,
    pro: {
      ...pro,
      monthlyCents: pro.founder.monthlyCents,
      yearlyCents: pro.founder.yearlyCents,
      // EU visitors see the same digits in EUR, like every other price
      // (eur-prices.ts), so the EUR card shows 29 too, not 39.
      eurMonthlyCents: pro.founder.monthlyCents,
      eurYearlyCents: pro.founder.yearlyCents,
      monthlyPriceConfigured: true,
      yearlyPriceConfigured: true,
    },
  };
}

/**
 * The price id a checkout or an in-place change should put on the plan item.
 *
 *   - Not Business: the plan's normal price, always.
 *   - The subscription is already on a founder price: the founder price for
 *     the requested interval, with or without an open offer. A founder who
 *     switches monthly <-> yearly after the window has ended keeps $29.
 *   - An offer is open and the buyer is not already on Business: the founder
 *     price (a new subscription, or an upgrade from Personal or Pro). An
 *     existing $39 Business subscriber is not moved: the offer is for new
 *     Business subscriptions.
 *   - Otherwise: the normal Business price.
 */
export function businessPriceFor(args: {
  planId: PlanId;
  interval: BillingInterval;
  normalPriceId: string;
  offer: FounderOffer | null;
  /** The base item's price on the buyer's current subscription, if any. */
  currentPriceId?: string | null;
  /** The plan that price resolves to, if any. */
  currentPlanId?: PlanId | null;
}): { priceId: string; founder: boolean } {
  const normal = { priceId: args.normalPriceId, founder: false };
  if (args.planId !== 'pro') return normal;

  if (isFounderPriceId(args.currentPriceId)) {
    const kept = founderPriceIdFor(args.interval);
    return kept ? { priceId: kept, founder: true } : normal;
  }

  if (args.offer && args.currentPlanId !== 'pro') {
    return {
      priceId: args.interval === 'year' ? args.offer.yearlyPriceId : args.offer.monthlyPriceId,
      founder: true,
    };
  }

  return normal;
}
