/**
 * Seasonal first-year offers on annual plans. Today: Black Week 2026.
 *
 * WHAT IT IS. During a fixed window, annual Personal and annual Pro (internal
 * id `solo`) are sold at a lower price for the FIRST YEAR only, applied as a
 * `duration: once` Stripe coupon. The renewal is the normal annual price.
 * Monthly, Business and every retired price are never discounted.
 *
 * PURE AND CLIENT-SAFE. Nothing here reads process.env or calls Stripe. The
 * server half (seasonal-offer-server.ts) reads the live yearly price and the
 * coupon from Stripe and feeds them in; this file only decides.
 *
 * THREE GUARDS, all of which must hold for an offer to exist:
 *
 *   1. The time window, as UTC instants. Outside it the offer is null whatever
 *      Stripe says, so forgetting to switch anything off cannot extend it.
 *   2. The legal guard. The live yearly unit_amount must equal the normal
 *      amount below. If the price moved, the "normal price" this offer is
 *      measured against is no longer the one buyers have been paying, and the
 *      offer is null for that plan (EU 30-day lowest-price rule).
 *   3. The coupon is valid (the kill switch). Deleting or invalidating the
 *      coupon in Stripe hides the offer everywhere within the server cache TTL.
 *
 * The saving a surface prints is COMPUTED from the live yearly price minus the
 * first-year price, never written down in copy.
 */

export type SeasonalPlanId = 'personal' | 'solo';

export interface SeasonalPlanTerms {
  couponId: string;
  normalYearlyCents: number;
  firstYearCents: number;
}

export const BLACK_WEEK_2026: {
  id: 'bw2026';
  startsAt: string;
  endsAt: string;
  redeemBy: string;
  plans: Record<SeasonalPlanId, SeasonalPlanTerms>;
} = {
  id: 'bw2026',
  // 27 Nov 2026 00:00 Oslo (CET, UTC+1).
  startsAt: '2026-11-26T23:00:00.000Z',
  // 1 Dec 2026 23:59:59 Oslo. The window is open through the whole last second.
  endsAt: '2026-12-01T22:59:59.000Z',
  // Stripe-side end of the coupons: a few hours past the public end so a
  // Checkout page opened at 23:58 can still be paid.
  redeemBy: '2026-12-02T06:00:00.000Z',
  plans: {
    personal: { couponId: 'BW2026_PERSONAL_Y1', normalYearlyCents: 8640, firstYearCents: 5900 },
    solo: { couponId: 'BW2026_PRO_Y1', normalYearlyCents: 14400, firstYearCents: 9900 },
  },
};

export interface SeasonalOffer {
  offerId: 'bw2026';
  planId: SeasonalPlanId;
  interval: 'year';
  couponId: string;
  normalYearlyCents: number;
  firstYearCents: number;
  savingCents: number;
  /** ISO instant of the last second of the window. */
  endsAt: string;
}

export type SeasonalOffers = Partial<Record<SeasonalPlanId, SeasonalOffer>>;

/** The metadata key and value every offer session and subscription carries. */
export const SEASONAL_OFFER_METADATA_KEY = 'offer';

const START_MS = Date.parse(BLACK_WEEK_2026.startsAt);
// Exclusive upper bound: one second after the last open second.
const END_EXCLUSIVE_MS = Date.parse(BLACK_WEEK_2026.endsAt) + 1000;

export function isSeasonalPlanId(value: unknown): value is SeasonalPlanId {
  return value === 'personal' || value === 'solo';
}

/** True from 27 Nov 2026 00:00:00 Oslo through 1 Dec 2026 23:59:59.999 Oslo. */
export function isSeasonalWindowOpen(now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && t >= START_MS && t < END_EXCLUSIVE_MS;
}

/**
 * The offer for one plan and interval, or null.
 *
 * `yearlyPriceCents` is the LIVE unit_amount of the plan's yearly Stripe
 * price. `couponValid` is whether that plan's coupon exists, is valid and
 * matches the terms (the server checks the amounts).
 */
export function seasonalOfferFor(input: {
  planId: string;
  interval: string;
  yearlyPriceCents: number | null | undefined;
  now: Date;
  couponValid: boolean;
}): SeasonalOffer | null {
  if (input.interval !== 'year') return null;
  if (!isSeasonalPlanId(input.planId)) return null;
  if (input.couponValid !== true) return null;
  if (!isSeasonalWindowOpen(input.now)) return null;

  const terms = BLACK_WEEK_2026.plans[input.planId];
  const live = input.yearlyPriceCents;
  // The legal guard: only against the exact price buyers have been paying.
  if (typeof live !== 'number' || !Number.isFinite(live) || live !== terms.normalYearlyCents) {
    return null;
  }
  const savingCents = live - terms.firstYearCents;
  if (!(savingCents > 0)) return null;

  return {
    offerId: BLACK_WEEK_2026.id,
    planId: input.planId,
    interval: 'year',
    couponId: terms.couponId,
    normalYearlyCents: live,
    firstYearCents: terms.firstYearCents,
    savingCents,
    endsAt: BLACK_WEEK_2026.endsAt,
  };
}
