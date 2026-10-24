// Who sees the Black Week "switch to annual" card on the billing page.
// Run with: npm run test:seasonal-switch
//
// Env first: PLANS reads the price ids at module load, so the module under
// test is imported dynamically after they are set.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_month_500';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_year_4800';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';

const {
  mayOfferSeasonalSwitch,
  resolveSeasonalSwitch,
  seasonalSwitchFromSubscriptions,
} = await import('./seasonal-switch.ts');

const ENDS = '2026-12-01T22:59:59.000Z';
const OFFERS = {
  personal: { offerId: 'bw2026', planId: 'personal', interval: 'year', couponId: 'BW2026_PERSONAL_Y1', normalYearlyCents: 8640, firstYearCents: 5900, savingCents: 2740, endsAt: ENDS },
  solo: { offerId: 'bw2026', planId: 'solo', interval: 'year', couponId: 'BW2026_PRO_Y1', normalYearlyCents: 14400, firstYearCents: 9900, savingCents: 4500, endsAt: ENDS },
} as const;

function input(over: Record<string, unknown> = {}) {
  return {
    offers: OFFERS,
    plan: 'personal',
    isOwner: true,
    compedScale: false,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    ...over,
  } as Parameters<typeof seasonalSwitchFromSubscriptions>[0];
}

function sub(priceId: string, over: Record<string, unknown> = {}) {
  return { id: 'sub_1', status: 'active', metadata: {}, items: { data: [{ price: { id: priceId } }] }, ...over };
}

test('monthly Personal on the current price gets the Personal offer', () => {
  assert.equal(seasonalSwitchFromSubscriptions(input(), [sub('price_personal_month')])?.firstYearCents, 5900);
});

test('monthly Pro gets the Pro offer', () => {
  assert.equal(
    seasonalSwitchFromSubscriptions(input({ plan: 'solo' }), [sub('price_solo_month')])?.couponId,
    'BW2026_PRO_Y1',
  );
});

test('annual subscribers get nothing', () => {
  assert.equal(seasonalSwitchFromSubscriptions(input(), [sub('price_personal_year')]), null);
  assert.equal(seasonalSwitchFromSubscriptions(input({ plan: 'solo' }), [sub('price_solo_year')]), null);
});

test('Business and legacy prices get nothing', () => {
  assert.equal(seasonalSwitchFromSubscriptions(input({ plan: 'pro' }), [sub('price_business_month')]), null);
  // The retired Personal $5 monthly resolves to Personal/month but is not the current price.
  assert.equal(seasonalSwitchFromSubscriptions(input(), [sub('price_personal_month_500')]), null);
});

test('anyone who already redeemed the offer, on any subscription, gets nothing', () => {
  const redeemed = { ...sub('price_personal_year', { id: 'sub_0', status: 'canceled' }), metadata: { offer: 'bw2026' } };
  assert.equal(seasonalSwitchFromSubscriptions(input(), [redeemed, sub('price_personal_month')]), null);
});

test('no card outside the window, for a member, a comp, or a dead subscription', () => {
  assert.equal(seasonalSwitchFromSubscriptions(input({ offers: {} }), [sub('price_personal_month')]), null);
  assert.equal(seasonalSwitchFromSubscriptions(input({ isOwner: false }), [sub('price_personal_month')]), null);
  assert.equal(seasonalSwitchFromSubscriptions(input({ compedScale: true }), [sub('price_personal_month')]), null);
  assert.equal(seasonalSwitchFromSubscriptions(input(), [sub('price_personal_month', { status: 'canceled' })]), null);
  assert.equal(seasonalSwitchFromSubscriptions(input({ stripeSubscriptionId: null }), [sub('price_personal_month')]), null);
});

test('the pre-check skips Stripe for every account that could not qualify', () => {
  assert.equal(mayOfferSeasonalSwitch(input()), true);
  assert.equal(mayOfferSeasonalSwitch(input({ plan: 'free' })), false);
  assert.equal(mayOfferSeasonalSwitch(input({ plan: 'pro' })), false);
  assert.equal(mayOfferSeasonalSwitch(input({ offers: {} })), false);
});

test('a Stripe failure or a slow answer means no card, never a throw', async () => {
  let calls = 0;
  assert.equal(
    await resolveSeasonalSwitch(input(), { listSubscriptions: async () => { calls++; throw new Error('down'); } }),
    null,
  );
  assert.equal(
    await resolveSeasonalSwitch(input(), {
      listSubscriptions: () => new Promise((resolve) => setTimeout(() => resolve([sub('price_personal_month')]), 200)),
      timeoutMs: 20,
    }),
    null,
  );
  assert.equal(
    (await resolveSeasonalSwitch(input(), { listSubscriptions: async () => [sub('price_personal_month')] }))?.planId,
    'personal',
  );
  // No call at all when the pre-check fails.
  await resolveSeasonalSwitch(input({ plan: 'free' }), { listSubscriptions: async () => { calls++; return []; } });
  assert.equal(calls, 1);
});
