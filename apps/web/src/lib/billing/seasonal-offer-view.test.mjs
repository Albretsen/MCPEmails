// What a screen shows for a seasonal first-year offer (Black Week 2026).
// Run with: npm run test:seasonal-offer-ui
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveSeasonalOffer,
  seasonalEndParts,
  seasonalOfferForPlan,
  seasonalOfferValues,
  shouldFetchSeasonalOffers,
  withSeasonalOffers,
} from './seasonal-offer-view.mjs';

const ENDS = '2026-12-01T22:59:59.000Z';
const WINDOW = { startsAt: '2026-11-26T23:00:00.000Z', endsAt: ENDS };
const INSIDE = Date.parse('2026-11-28T12:00:00Z');

/** Deliberately odd amounts, so a typed $59 or $86.40 anywhere would show. */
function offer(planId, firstYearCents, normalYearlyCents) {
  return {
    offerId: 'bw2026', planId, interval: 'year', couponId: `C_${planId}`,
    normalYearlyCents, firstYearCents, savingCents: normalYearlyCents - firstYearCents, endsAt: ENDS,
  };
}

test('every amount in the sentence comes from the offer object', () => {
  assert.deepEqual(seasonalOfferValues(offer('personal', 5900, 8640), 'en', INSIDE), {
    firstYear: '59', renewal: '86.40', saving: '27.40', date: '1 December 2026', time: '23:59',
  });
  const odd = seasonalOfferValues(offer('solo', 1234, 5678), 'en', INSIDE);
  assert.equal(odd.firstYear, '12.34');
  assert.equal(odd.renewal, '56.78');
  assert.equal(odd.saving, '44.44');
});

test('amounts use the reader decimal separator; the end is stated in Oslo time', () => {
  const nb = seasonalOfferValues(offer('personal', 5900, 8640), 'nb', INSIDE);
  assert.equal(nb.renewal, '86,40');
  assert.equal(nb.time, '23:59');
  assert.match(nb.date, /^1\. desember 2026$/);
  assert.match(seasonalEndParts(ENDS, 'de').date, /^1\. Dezember 2026$/);
  assert.equal(seasonalEndParts(ENDS, 'fr').date, '1 décembre 2026');
  assert.equal(seasonalEndParts(ENDS, 'es').date, '1 de diciembre de 2026');
});

test('hidden after the end, on the reader clock, even if a cached copy says otherwise', () => {
  const o = offer('personal', 5900, 8640);
  assert.ok(liveSeasonalOffer(o, Date.parse(ENDS)));
  assert.equal(liveSeasonalOffer(o, Date.parse(ENDS) + 1), null);
  assert.equal(seasonalOfferValues(o, 'en', Date.parse('2026-12-02T00:00:00Z')), null);
});

test('never for Business, monthly, or a malformed or non-discount offer', () => {
  assert.equal(liveSeasonalOffer({ ...offer('personal', 5900, 8640), planId: 'pro' }, INSIDE), null);
  assert.equal(liveSeasonalOffer({ ...offer('personal', 5900, 8640), interval: 'month' }, INSIDE), null);
  assert.equal(liveSeasonalOffer(offer('solo', 14400, 14400), INSIDE), null);
  assert.equal(liveSeasonalOffer({ ...offer('solo', 9900, 14400), endsAt: 'soon' }, INSIDE), null);
  assert.equal(liveSeasonalOffer(null, INSIDE), null);
  assert.equal(seasonalOfferForPlan({ pro: offer('personal', 1, 2) }, 'pro', INSIDE), null);
  assert.equal(seasonalOfferForPlan(null, 'personal', INSIDE), null);
});

test('withSeasonalOffers attaches to Personal and Pro only, and is a no-op without offers', () => {
  const prices = {
    personal: { monthlyCents: 900, yearlyCents: 8640, yearlyPriceConfigured: true },
    solo: { monthlyCents: 1500, yearlyCents: 14400, yearlyPriceConfigured: true },
    pro: { monthlyCents: 3900, yearlyCents: 37440, yearlyPriceConfigured: true },
  };
  assert.equal(withSeasonalOffers(prices, {}), prices);
  assert.equal(withSeasonalOffers(prices, null), prices);
  const merged = withSeasonalOffers(prices, {
    personal: offer('personal', 5900, 8640),
    pro: offer('personal', 1, 2),
  });
  assert.equal(merged.personal.seasonalOffer.firstYearCents, 5900);
  assert.equal(merged.personal.yearlyCents, 8640);
  assert.equal(merged.solo, prices.solo);
  assert.equal(merged.pro.seasonalOffer, undefined);
});

test('/pricing asks for offers only around the window (or always in development)', () => {
  assert.equal(shouldFetchSeasonalOffers(WINDOW, Date.parse('2026-10-24T12:00:00Z')), false);
  assert.equal(shouldFetchSeasonalOffers(WINDOW, INSIDE), true);
  assert.equal(shouldFetchSeasonalOffers(WINDOW, Date.parse('2026-11-26T20:00:00Z')), true);
  assert.equal(shouldFetchSeasonalOffers(WINDOW, Date.parse('2026-12-03T12:00:00Z')), false);
  assert.equal(shouldFetchSeasonalOffers(WINDOW, Date.parse('2026-10-24T12:00:00Z'), 'development'), true);
  assert.equal(shouldFetchSeasonalOffers(null, INSIDE), false);
});
