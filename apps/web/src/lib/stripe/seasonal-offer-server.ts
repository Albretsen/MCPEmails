/**
 * Server half of the seasonal first-year offer (see seasonal-offer.ts).
 *
 * Reads, per plan, the LIVE unit_amount of the yearly Stripe price and the
 * coupon, and hands both to the pure `seasonalOfferFor`. Server only: it needs
 * the STRIPE_PRICE_* ids and the Stripe secret key.
 *
 *   - Cached for at most 60 seconds per process, so deleting the coupon in the
 *     Stripe dashboard (the kill switch) reaches every surface within a minute.
 *     Only the Stripe facts are cached; the window is evaluated on every call.
 *   - NEVER THROWS. Any failure (Stripe down, no key, unknown coupon) resolves
 *     to "no offer" for that plan, and the surface renders exactly what it
 *     rendered before this feature existed.
 *   - Outside the window it makes no Stripe call at all.
 *   - A coupon counts as valid only when Stripe says `valid: true`, it is not
 *     deleted, and its amount takes the normal price to exactly the first-year
 *     price. A coupon edited to a different amount turns the offer off rather
 *     than charging something the page did not say.
 *
 * DEV PREVIEW. Outside production, SEASONAL_OFFER_PREVIEW_NOW (an ISO instant)
 * replaces the clock when no `now` is passed, so the offer can be looked at in
 * the browser before the window opens. It is ignored when NODE_ENV is
 * 'production'.
 */

import { PLANS } from '@/lib/stripe/plans';
import {
  BLACK_WEEK_2026,
  isSeasonalWindowOpen,
  seasonalOfferFor,
  type SeasonalOffers,
  type SeasonalPlanId,
} from '@/lib/stripe/seasonal-offer';

export const SEASONAL_CACHE_TTL_MS = 60_000;

/** The parts of a Stripe coupon this module reads. */
export interface CouponFacts {
  id: string;
  valid: boolean;
  deleted?: boolean;
  amount_off: number | null;
  percent_off: number | null;
  currency: string | null;
}

export interface SeasonalOfferDeps {
  /** Live unit_amount of a price, in cents. */
  retrievePriceCents: (priceId: string) => Promise<number | null>;
  /** The coupon, or null when it does not exist. */
  retrieveCoupon: (couponId: string) => Promise<CouponFacts | null>;
  /** Yearly Stripe price id per plan; null when not configured. */
  yearlyPriceId: (planId: SeasonalPlanId) => string | null;
  /** Monotonic-enough clock for the cache. */
  clockMs?: () => number;
}

interface PlanFacts {
  yearlyPriceCents: number | null;
  couponValid: boolean;
}

/** Does this coupon take `normal` to exactly `firstYear`? */
export function couponMatchesTerms(
  coupon: CouponFacts | null,
  normalCents: number,
  firstYearCents: number,
): boolean {
  if (!coupon || coupon.deleted || coupon.valid !== true) return false;
  if (typeof coupon.amount_off === 'number' && coupon.amount_off > 0) {
    return (
      (coupon.currency ?? '').toLowerCase() === 'usd' &&
      normalCents - coupon.amount_off === firstYearCents
    );
  }
  if (typeof coupon.percent_off === 'number' && coupon.percent_off > 0) {
    // Stripe rounds the discount to the nearest cent.
    const discount = Math.round((normalCents * coupon.percent_off) / 100);
    return normalCents - discount === firstYearCents;
  }
  return false;
}

/** Outside production, the preview clock; otherwise null. */
export function previewNow(env: Record<string, string | undefined> = process.env): Date | null {
  if (env.NODE_ENV === 'production') return null;
  const raw = env.SEASONAL_OFFER_PREVIEW_NOW;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

const PLAN_IDS: SeasonalPlanId[] = ['personal', 'solo'];

/**
 * Build a reader with its own cache. The exported `getActiveSeasonalOffers`
 * is one of these wired to the real Stripe client; tests build their own.
 */
export function createSeasonalOfferReader(deps: SeasonalOfferDeps) {
  const clock = deps.clockMs ?? (() => Date.now());
  let cache: { at: number; key: string; facts: Record<SeasonalPlanId, PlanFacts> } | null = null;

  async function readPlan(planId: SeasonalPlanId): Promise<PlanFacts> {
    const terms = BLACK_WEEK_2026.plans[planId];
    const priceId = deps.yearlyPriceId(planId);
    if (!priceId) return { yearlyPriceCents: null, couponValid: false };
    const [cents, coupon] = await Promise.all([
      deps.retrievePriceCents(priceId).catch(() => null),
      deps.retrieveCoupon(terms.couponId).catch(() => null),
    ]);
    return {
      yearlyPriceCents: typeof cents === 'number' ? cents : null,
      couponValid: couponMatchesTerms(coupon, terms.normalYearlyCents, terms.firstYearCents),
    };
  }

  async function facts(): Promise<Record<SeasonalPlanId, PlanFacts>> {
    const key = PLAN_IDS.map((id) => deps.yearlyPriceId(id) ?? '-').join('|');
    const t = clock();
    if (cache && cache.key === key && t - cache.at < SEASONAL_CACHE_TTL_MS) return cache.facts;
    const [personal, solo] = await Promise.all(PLAN_IDS.map(readPlan));
    const next = { personal, solo };
    cache = { at: t, key, facts: next };
    return next;
  }

  return async function getOffers(now?: Date): Promise<SeasonalOffers> {
    try {
      const at = now ?? previewNow() ?? new Date();
      if (!isSeasonalWindowOpen(at)) return {};
      const f = await facts();
      const out: SeasonalOffers = {};
      for (const planId of PLAN_IDS) {
        const offer = seasonalOfferFor({
          planId,
          interval: 'year',
          yearlyPriceCents: f[planId].yearlyPriceCents,
          now: at,
          couponValid: f[planId].couponValid,
        });
        if (offer) out[planId] = offer;
      }
      return out;
    } catch (err) {
      console.error(
        '[seasonal-offer] read failed, no offer:',
        err instanceof Error ? err.message : String(err),
      );
      return {};
    }
  };
}

// The real Stripe client throws at import when STRIPE_SECRET_KEY is unset, so
// it is loaded lazily: importing this module must never be able to fail.
async function stripeClient() {
  const mod = await import('@/lib/stripe/client');
  return mod.stripe;
}

const defaultReader = createSeasonalOfferReader({
  retrievePriceCents: async (priceId) => {
    const price = await (await stripeClient()).prices.retrieve(priceId);
    return price.unit_amount ?? null;
  },
  retrieveCoupon: async (couponId) => {
    try {
      const c = await (await stripeClient()).coupons.retrieve(couponId);
      return {
        id: c.id,
        valid: c.valid,
        deleted: (c as { deleted?: boolean }).deleted === true,
        amount_off: c.amount_off,
        percent_off: c.percent_off,
        currency: c.currency,
      };
    } catch {
      return null;
    }
  },
  yearlyPriceId: (planId) => PLANS[planId].stripePriceIdYearly,
});

/** Live offers by plan. `{}` outside the window, on any error, or when killed. */
export async function getActiveSeasonalOffers(now?: Date): Promise<SeasonalOffers> {
  return defaultReader(now);
}
