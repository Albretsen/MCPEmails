// ---------------------------------------------------------------------------
// The Business founder price: the window, the cap, the flag, one per owner,
// the price a checkout or a plan change puts on the plan item, and how the
// founder ids map back to Business on renewal.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/stripe/founder-offer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY = 'price_founder_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY = 'price_founder_year';

const {
  FOUNDER_PLACES,
  FOUNDER_WINDOW_START,
  FOUNDER_WINDOW_END,
  FOUNDER_WINDOW_CLOSED,
  businessPriceFor,
  founderOfferFor,
  founderPlacesLeft,
  founderTermsVisibleFor,
  inFounderWindow,
  pricesWithFounder,
} = await import('./founder-offer.ts');
const { PLANS, founderPriceIdFor, getPlanByStripePriceId, isFounderPriceId, basePlanItem } =
  await import('./plans.ts');
const { founderCapCopy } = await import('../billing/founder-cap-copy.mjs');

const OPEN = new Date('2026-11-20T12:00:00Z');

function offerAt(now: Date, overrides: Partial<Parameters<typeof founderOfferFor>[0]> = {}) {
  return founderOfferFor({
    now,
    placesTaken: 0,
    ownerHasFounderSub: false,
    flagOn: true,
    ...overrides,
  });
}

// ── The window, in UTC ─────────────────────────────────────────────────────

test('window constants are the Oslo instants in UTC', () => {
  assert.equal(FOUNDER_WINDOW_START.toISOString(), '2026-11-08T23:00:00.000Z');
  assert.equal(FOUNDER_WINDOW_END.toISOString(), '2026-12-31T22:59:59.000Z');
  assert.equal(FOUNDER_WINDOW_CLOSED.toISOString(), '2026-12-31T23:00:00.000Z');
  assert.equal(FOUNDER_PLACES, 20);
});

test('closed one millisecond before 2026-11-09 00:00 Oslo, open at it', () => {
  assert.equal(offerAt(new Date('2026-11-08T22:59:59.999Z')), null);
  assert.equal(inFounderWindow(new Date('2026-11-08T22:59:59.999Z')), false);
  assert.ok(offerAt(new Date('2026-11-08T23:00:00.000Z')));
});

test('still open at 2026-12-31 23:59:59 Oslo, closed from 2027-01-01 00:00 Oslo', () => {
  assert.ok(offerAt(new Date('2026-12-31T22:59:59.000Z')));
  assert.ok(offerAt(new Date('2026-12-31T22:59:59.999Z')));
  assert.equal(offerAt(new Date('2026-12-31T23:00:00.000Z')), null);
  assert.equal(offerAt(new Date('2027-03-01T00:00:00Z')), null);
});

test('an invalid date is outside the window', () => {
  assert.equal(inFounderWindow(new Date('not a date')), false);
});

// ── The terms clause ───────────────────────────────────────────────────────

test('terms clause: started offer or an existing founder, never zh', () => {
  const at = (now: string, flagOn: boolean | null, placesTaken: number | null, locale = 'en') =>
    founderTermsVisibleFor({ locale, now: new Date(now), flagOn, placesTaken });
  assert.equal(at('2026-11-20T00:00:00Z', false, 0), false, 'flag off, no rows');
  assert.equal(at('2026-11-08T22:59:59Z', true, 0), false, 'flag on before the start');
  assert.equal(at('2026-11-08T23:00:00Z', true, 0), true, 'flag on at the start');
  assert.equal(at('2027-03-01T00:00:00Z', false, 1), true, 'rows after the window');
  assert.equal(at('2026-11-20T00:00:00Z', true, 5, 'zh'), false, 'never zh');
  assert.equal(at('2026-11-20T00:00:00Z', null, null), false, 'failed reads');
});

// ── The flag, the cap, one per owner ───────────────────────────────────────

test('flag off: no offer, whatever else is true', () => {
  assert.equal(offerAt(OPEN, { flagOn: false }), null);
});

test('the cap: 19 taken leaves 1, 20 or more taken is no offer', () => {
  assert.equal(offerAt(OPEN, { placesTaken: 19 })?.placesLeft, 1);
  assert.equal(offerAt(OPEN, { placesTaken: 20 }), null);
  assert.equal(offerAt(OPEN, { placesTaken: 21 }), null);
});

test('places left is never negative; overflow reads 0', () => {
  assert.equal(founderPlacesLeft(0), 20);
  assert.equal(founderPlacesLeft(14), 6);
  assert.equal(founderPlacesLeft(21), 0);
  assert.equal(founderPlacesLeft(500), 0);
  assert.equal(founderPlacesLeft(-3), 20);
});

test('an unknown count is no offer (never guess)', () => {
  assert.equal(offerAt(OPEN, { placesTaken: null }), null);
});

test('one per owner: an owner with a founder subscription gets no offer', () => {
  assert.equal(offerAt(OPEN, { ownerHasFounderSub: true }), null);
});

test('an unconfigured founder price is no offer', () => {
  assert.equal(offerAt(OPEN, { monthlyPriceId: null }), null);
  assert.equal(offerAt(OPEN, { yearlyPriceId: '' }), null);
});

test('the offer carries the configured ids, the places and the end', () => {
  const offer = offerAt(OPEN, { placesTaken: 6 });
  assert.deepEqual(offer, {
    monthlyPriceId: 'price_founder_month',
    yearlyPriceId: 'price_founder_year',
    placesLeft: 14,
    placesTotal: 20,
    endsAt: '2026-12-31T22:59:59.000Z',
    endsAtLabel: '2026-12-31',
  });
});

// ── The price a checkout or plan change uses ───────────────────────────────

const OFFER = offerAt(OPEN)!;

test('new Business checkout during the offer: founder price for the interval', () => {
  assert.deepEqual(
    businessPriceFor({ planId: 'pro', interval: 'month', normalPriceId: 'price_business_month', offer: OFFER }),
    { priceId: 'price_founder_month', founder: true },
  );
  assert.deepEqual(
    businessPriceFor({ planId: 'pro', interval: 'year', normalPriceId: 'price_business_year', offer: OFFER }),
    { priceId: 'price_founder_year', founder: true },
  );
});

test('new Business checkout without an offer: the normal $39 price', () => {
  assert.deepEqual(
    businessPriceFor({ planId: 'pro', interval: 'month', normalPriceId: 'price_business_month', offer: null }),
    { priceId: 'price_business_month', founder: false },
  );
});

test('other plans never take the founder price', () => {
  for (const planId of ['personal', 'solo'] as const) {
    assert.deepEqual(
      businessPriceFor({ planId, interval: 'month', normalPriceId: 'price_x', offer: OFFER }),
      { priceId: 'price_x', founder: false },
    );
  }
});

test('upgrade from Pro or Personal to Business during the offer: founder price', () => {
  for (const currentPlanId of ['solo', 'personal'] as const) {
    assert.equal(
      businessPriceFor({
        planId: 'pro',
        interval: 'month',
        normalPriceId: 'price_business_month',
        offer: OFFER,
        currentPriceId: 'price_whatever',
        currentPlanId,
      }).priceId,
      'price_founder_month',
    );
  }
});

test('an existing $39 Business subscriber is not moved to the founder price', () => {
  assert.equal(
    businessPriceFor({
      planId: 'pro',
      interval: 'year',
      normalPriceId: 'price_business_year',
      offer: OFFER,
      currentPriceId: 'price_business_month',
      currentPlanId: 'pro',
    }).priceId,
    'price_business_year',
  );
});

test('a founder switching interval AFTER the window keeps the founder pair', () => {
  // No offer (the window has closed), and the subscription is on founder monthly.
  assert.equal(offerAt(new Date('2027-02-01T00:00:00Z')), null);
  assert.deepEqual(
    businessPriceFor({
      planId: 'pro',
      interval: 'year',
      normalPriceId: 'price_business_year',
      offer: null,
      currentPriceId: 'price_founder_month',
      currentPlanId: 'pro',
    }),
    { priceId: 'price_founder_year', founder: true },
  );
  assert.equal(
    businessPriceFor({
      planId: 'pro',
      interval: 'month',
      normalPriceId: 'price_business_month',
      offer: null,
      currentPriceId: 'price_founder_year',
      currentPlanId: 'pro',
    }).priceId,
    'price_founder_month',
  );
});

test('a founder moving down to Pro gets the Pro price', () => {
  assert.equal(
    businessPriceFor({
      planId: 'solo',
      interval: 'month',
      normalPriceId: 'price_solo_month',
      offer: null,
      currentPriceId: 'price_founder_month',
      currentPlanId: 'pro',
    }).priceId,
    'price_solo_month',
  );
});

// ── Renewals map to Business ──────────────────────────────────────────────

test('founder price ids resolve to Business at their interval', () => {
  assert.equal(founderPriceIdFor('month'), 'price_founder_month');
  assert.equal(founderPriceIdFor('year'), 'price_founder_year');
  assert.deepEqual(getPlanByStripePriceId('price_founder_month'), { plan: PLANS.pro, interval: 'month' });
  assert.deepEqual(getPlanByStripePriceId('price_founder_year'), { plan: PLANS.pro, interval: 'year' });
  assert.ok(isFounderPriceId('price_founder_year'));
  assert.equal(isFounderPriceId('price_business_month'), false);
  assert.equal(isFounderPriceId(null), false);
});

test('the founder pair is in Business legacy ids, monthly before yearly', () => {
  const ids = PLANS.pro.legacyStripePriceIds;
  const m = ids.indexOf('price_founder_month');
  assert.ok(m >= 0 && m % 2 === 0, 'monthly id sits on an even (monthly) slot');
  assert.equal(ids[m + 1], 'price_founder_year');
});

test('a founder subscription base item is found by basePlanItem', () => {
  const item = basePlanItem([
    { price: { id: 'price_addon_month' } },
    { price: { id: 'price_founder_month' } },
  ]);
  assert.equal(item?.price?.id, 'price_founder_month');
});

// ── What surfaces render ──────────────────────────────────────────────────

const FOUNDER_DISPLAY = {
  monthlyCents: 2900,
  yearlyCents: 27840,
  addonMonthlyCents: 300,
  placesLeft: 14,
  placesTotal: 20,
};
const PRICES = {
  personal: { monthlyCents: 900, yearlyCents: 8640, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
  pro: {
    monthlyCents: 3900,
    yearlyCents: 37440,
    monthlyPriceConfigured: true,
    yearlyPriceConfigured: true,
    founder: FOUNDER_DISPLAY,
  },
};

test('Business is priced from the founder pair when a founder line is attached', () => {
  const out = pricesWithFounder(PRICES, 'en')!;
  assert.equal(out.pro.monthlyCents, 2900);
  assert.equal(out.pro.yearlyCents, 27840);
  assert.deepEqual(out.pro.founder, FOUNDER_DISPLAY);
  assert.deepEqual(out.personal, PRICES.personal);
});

test('zh keeps the normal $39 and shows no founder line', () => {
  const out = pricesWithFounder(PRICES, 'zh')!;
  assert.equal(out.pro.monthlyCents, 3900);
  assert.equal(out.pro.yearlyCents, 37440);
  assert.equal('founder' in out.pro, false);
});

test('no founder line: the map is returned as it is', () => {
  const plain = { pro: { ...PRICES.pro, founder: undefined } };
  assert.equal(pricesWithFounder(plain, 'en'), plain);
  assert.equal(pricesWithFounder(null, 'en'), null);
});

test('cap copy swaps to founder keys only for Business with a founder line', () => {
  const business = {
    plan: 'pro',
    bodyKey: 'connect.businessCapBody',
    ctaKey: 'connect.businessCapCta',
    noticeBodyKey: 'inboxes.capBodyProCap',
    offers: [{ plan: 'pro', noticeCtaKey: 'inboxes.capCtaBusiness' }],
  };
  const swapped = founderCapCopy(business, PRICES);
  assert.equal(swapped.founder, FOUNDER_DISPLAY);
  assert.equal(swapped.bodyKey, 'connect.businessCapBodyFounder');
  assert.equal(swapped.ctaKey, 'connect.businessCapCtaFounder');
  assert.equal(swapped.noticeBodyKey, 'inboxes.capBodyProCapFounder');
  assert.equal(swapped.noticeCtaKey, 'inboxes.capCtaBusinessFounder');

  const plain = founderCapCopy(business, { pro: {} });
  assert.equal(plain.founder, null);
  assert.equal(plain.bodyKey, 'connect.businessCapBody');
  assert.equal(plain.noticeCtaKey, 'inboxes.capCtaBusiness');

  const pro = founderCapCopy({ ...business, plan: 'solo', bodyKey: 'connect.upgradeBody' }, PRICES);
  assert.equal(pro.founder, null);
  assert.equal(pro.bodyKey, 'connect.upgradeBody');
});
