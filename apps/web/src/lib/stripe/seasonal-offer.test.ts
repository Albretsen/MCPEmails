// ---------------------------------------------------------------------------
// Black Week 2026 first-year offer: the window, the legal guard, the kill
// switch, and the server reader's cache and failure handling.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/seasonal-offer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLACK_WEEK_2026,
  isSeasonalWindowOpen,
  seasonalOfferFor,
} from './seasonal-offer.ts';
import {
  couponMatchesTerms,
  createSeasonalOfferReader,
  previewNow,
  type CouponFacts,
} from './seasonal-offer-server.ts';

const INSIDE = new Date('2026-11-28T12:00:00Z');

function base(overrides: Partial<Parameters<typeof seasonalOfferFor>[0]> = {}) {
  return {
    planId: 'personal',
    interval: 'year',
    yearlyPriceCents: 8640,
    now: INSIDE,
    couponValid: true,
    ...overrides,
  };
}

test('window boundaries are the Oslo instants, inclusive of the last second', () => {
  assert.equal(isSeasonalWindowOpen(new Date('2026-11-26T22:59:59.999Z')), false);
  assert.equal(isSeasonalWindowOpen(new Date('2026-11-26T23:00:00.000Z')), true);
  assert.equal(isSeasonalWindowOpen(new Date('2026-12-01T22:59:59.000Z')), true);
  assert.equal(isSeasonalWindowOpen(new Date('2026-12-01T22:59:59.999Z')), true);
  assert.equal(isSeasonalWindowOpen(new Date('2026-12-01T23:00:00.000Z')), false);
  assert.equal(isSeasonalWindowOpen(new Date('invalid')), false);
});

test('before, inside and after the window', () => {
  assert.equal(seasonalOfferFor(base({ now: new Date('2026-11-26T22:59:59Z') })), null);
  assert.equal(seasonalOfferFor(base({ now: new Date('2026-12-01T23:00:00Z') })), null);
  assert.equal(seasonalOfferFor(base({ now: new Date('2027-11-28T12:00:00Z') })), null);
  const offer = seasonalOfferFor(base({ now: new Date('2026-11-26T23:00:00Z') }));
  assert.ok(offer);
});

test('Personal and Pro: first-year price and computed saving', () => {
  const personal = seasonalOfferFor(base())!;
  assert.equal(personal.offerId, 'bw2026');
  assert.equal(personal.couponId, 'BW2026_PERSONAL_Y1');
  assert.equal(personal.firstYearCents, 5900);
  assert.equal(personal.normalYearlyCents, 8640);
  assert.equal(personal.savingCents, 2740);
  assert.equal(personal.endsAt, BLACK_WEEK_2026.endsAt);
  assert.equal(personal.interval, 'year');

  const pro = seasonalOfferFor(base({ planId: 'solo', yearlyPriceCents: 14400 }))!;
  assert.equal(pro.couponId, 'BW2026_PRO_Y1');
  assert.equal(pro.firstYearCents, 9900);
  assert.equal(pro.savingCents, 4500);
});

test('monthly is never discounted', () => {
  assert.equal(seasonalOfferFor(base({ interval: 'month' })), null);
  assert.equal(seasonalOfferFor(base({ planId: 'solo', interval: 'month', yearlyPriceCents: 14400 })), null);
});

test('Business, Free and unknown plans are never discounted', () => {
  assert.equal(seasonalOfferFor(base({ planId: 'pro', yearlyPriceCents: 37440 })), null);
  assert.equal(seasonalOfferFor(base({ planId: 'free' })), null);
  assert.equal(seasonalOfferFor(base({ planId: 'enterprise' })), null);
});

test('legal guard: a changed live yearly price turns the offer off', () => {
  assert.equal(seasonalOfferFor(base({ yearlyPriceCents: 9000 })), null);
  assert.equal(seasonalOfferFor(base({ yearlyPriceCents: 4800 })), null); // retired $48
  assert.equal(seasonalOfferFor(base({ yearlyPriceCents: null })), null);
  assert.equal(seasonalOfferFor(base({ planId: 'solo', yearlyPriceCents: 18240 })), null);
});

test('kill switch: an invalid coupon turns the offer off', () => {
  assert.equal(seasonalOfferFor(base({ couponValid: false })), null);
});

// ── coupon terms ────────────────────────────────────────────────────────────

function coupon(over: Partial<CouponFacts> = {}): CouponFacts {
  return { id: 'BW2026_PERSONAL_Y1', valid: true, amount_off: 2740, percent_off: null, currency: 'usd', ...over };
}

test('a coupon counts only when it lands on exactly the first-year price', () => {
  assert.equal(couponMatchesTerms(coupon(), 8640, 5900), true);
  assert.equal(couponMatchesTerms(coupon({ amount_off: 2700 }), 8640, 5900), false);
  assert.equal(couponMatchesTerms(coupon({ currency: 'eur' }), 8640, 5900), false);
  assert.equal(couponMatchesTerms(coupon({ valid: false }), 8640, 5900), false);
  assert.equal(couponMatchesTerms(coupon({ deleted: true }), 8640, 5900), false);
  assert.equal(couponMatchesTerms(null, 8640, 5900), false);
  // Pro: 31.25% of $144 is exactly $45.
  assert.equal(couponMatchesTerms(coupon({ amount_off: null, percent_off: 31.25, currency: null }), 14400, 9900), true);
  assert.equal(couponMatchesTerms(coupon({ amount_off: null, percent_off: 30, currency: null }), 14400, 9900), false);
});

// ── server reader ───────────────────────────────────────────────────────────

function reader(opts: {
  prices?: Record<string, number | null>;
  coupons?: Record<string, CouponFacts | null>;
  throwPrice?: boolean;
  clock?: { t: number };
  calls?: { n: number };
}) {
  const prices = opts.prices ?? { price_personal_y: 8640, price_solo_y: 14400 };
  const coupons = opts.coupons ?? {
    BW2026_PERSONAL_Y1: coupon(),
    BW2026_PRO_Y1: coupon({ id: 'BW2026_PRO_Y1', amount_off: 4500 }),
  };
  return createSeasonalOfferReader({
    retrievePriceCents: async (id) => {
      if (opts.calls) opts.calls.n += 1;
      if (opts.throwPrice) throw new Error('stripe down');
      return prices[id] ?? null;
    },
    retrieveCoupon: async (id) => coupons[id] ?? null,
    yearlyPriceId: (planId) => (planId === 'personal' ? 'price_personal_y' : 'price_solo_y'),
    clockMs: opts.clock ? () => opts.clock!.t : undefined,
  });
}

test('server: both plans inside the window, nothing outside it (and no Stripe call)', async () => {
  const calls = { n: 0 };
  const read = reader({ calls });
  const offers = await read(INSIDE);
  assert.equal(offers.personal?.firstYearCents, 5900);
  assert.equal(offers.solo?.firstYearCents, 9900);

  const calls2 = { n: 0 };
  const read2 = reader({ calls: calls2 });
  assert.deepEqual(await read2(new Date('2026-11-26T22:59:59Z')), {});
  assert.deepEqual(await read2(new Date('2026-12-01T23:00:00Z')), {});
  assert.equal(calls2.n, 0);
});

test('server: price changed hides only that plan', async () => {
  const read = reader({ prices: { price_personal_y: 9000, price_solo_y: 14400 } });
  const offers = await read(INSIDE);
  assert.equal(offers.personal, undefined);
  assert.equal(offers.solo?.couponId, 'BW2026_PRO_Y1');
});

test('server: a missing or invalid coupon is the kill switch', async () => {
  const read = reader({
    coupons: { BW2026_PERSONAL_Y1: null, BW2026_PRO_Y1: coupon({ id: 'BW2026_PRO_Y1', amount_off: 4500, valid: false }) },
  });
  assert.deepEqual(await read(INSIDE), {});
});

test('server: never throws, Stripe failure means no offer', async () => {
  const read = reader({ throwPrice: true });
  assert.deepEqual(await read(INSIDE), {});
});

test('server: Stripe facts are cached for at most 60 seconds', async () => {
  const clock = { t: 1_000_000 };
  const calls = { n: 0 };
  const read = reader({ clock, calls });
  await read(INSIDE);
  await read(INSIDE);
  assert.equal(calls.n, 2); // one per plan, once
  clock.t += 59_000;
  await read(INSIDE);
  assert.equal(calls.n, 2);
  clock.t += 2_000;
  await read(INSIDE);
  assert.equal(calls.n, 4);
});

test('dev preview clock is ignored in production', () => {
  assert.equal(previewNow({ NODE_ENV: 'production', SEASONAL_OFFER_PREVIEW_NOW: '2026-11-28T00:00:00Z' }), null);
  assert.equal(
    previewNow({ NODE_ENV: 'development', SEASONAL_OFFER_PREVIEW_NOW: '2026-11-28T00:00:00Z' })?.toISOString(),
    '2026-11-28T00:00:00.000Z',
  );
  assert.equal(previewNow({ NODE_ENV: 'development' }), null);
  assert.equal(previewNow({ NODE_ENV: 'test', SEASONAL_OFFER_PREVIEW_NOW: 'nonsense' }), null);
});
