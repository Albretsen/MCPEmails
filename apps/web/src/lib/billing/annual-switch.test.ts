// Monthly-to-annual card eligibility (annual-switch.ts) and the notice's
// dismissal rule. Pure: Stripe is a pair of stub functions.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/billing/annual-switch.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_m';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_y';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_m';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_y';

const {
  annualSwitchMode,
  mayOfferAnnualSwitch,
  annualSwitchFromFacts,
  countPaidInvoices,
  resolveAnnualSwitch,
  annualNoticeVisible,
} = await import('./annual-switch.ts');
type Input = Parameters<typeof mayOfferAnnualSwitch>[0];
type Sub = Parameters<typeof annualSwitchFromFacts>[1] & object;

const NOW = new Date('2026-11-12T10:00:00Z');

function input(overrides: Partial<Input> = {}): Input {
  return {
    mode: 'on',
    now: NOW,
    plan: 'personal',
    isOwner: true,
    compedScale: false,
    onPass: false,
    subscriptionStatus: 'active',
    paymentIssueSince: null,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    ...overrides,
  };
}

function sub(overrides: Partial<Sub> = {}, priceId = 'price_personal_m'): Sub {
  return {
    id: 'sub_1',
    status: 'active',
    currency: 'usd',
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    metadata: {},
    items: { data: [{ price: { id: priceId } }] },
    ...overrides,
  };
}

test('the flag is off unless it says on', () => {
  assert.equal(annualSwitchMode({}), 'off');
  assert.equal(annualSwitchMode({ ANNUAL_SWITCH_CARD_ENABLED: 'true' }), 'off');
  assert.equal(annualSwitchMode({ ANNUAL_SWITCH_CARD_ENABLED: ' ON ' }), 'on');
});

test('an owner on current monthly Personal with two paid invoices gets the card', () => {
  assert.deepEqual(annualSwitchFromFacts(input(), sub(), 2), { planId: 'personal', currency: 'usd' });
});

test('Business is offered on its current monthly price when a yearly price exists', () => {
  assert.deepEqual(
    annualSwitchFromFacts(input({ plan: 'pro' }), sub({ currency: 'eur' }, 'price_business_m'), 3),
    { planId: 'pro', currency: 'eur' },
  );
});

test('the cheap pre-check refuses every excluded account without Stripe', () => {
  assert.equal(mayOfferAnnualSwitch(input()), true);
  for (const bad of [
    { mode: 'off' as const },
    { isOwner: false },
    { compedScale: true },
    { onPass: true },
    { plan: 'free' },
    { plan: 'enterprise' },
    { subscriptionStatus: 'past_due' },
    { subscriptionStatus: 'trialing' },
    { paymentIssueSince: '2026-11-01T00:00:00Z' },
    { stripeSubscriptionId: null },
    { stripeCustomerId: '' },
  ]) {
    assert.equal(mayOfferAnnualSwitch(input(bad)), false, JSON.stringify(bad));
  }
});

test('Black Week window hides the card for everyone (the seasonal card wins)', () => {
  assert.equal(mayOfferAnnualSwitch(input({ now: new Date('2026-11-28T12:00:00Z') })), false);
  assert.equal(mayOfferAnnualSwitch(input({ now: new Date('2026-12-01T22:59:59Z') })), false);
  assert.equal(mayOfferAnnualSwitch(input({ now: new Date('2026-12-02T00:00:00Z') })), true);
});

test('fewer than two paid invoices, a cancel, a pause or a booked downgrade: no card', () => {
  assert.equal(annualSwitchFromFacts(input(), sub(), 1), null);
  assert.equal(annualSwitchFromFacts(input(), sub({ cancel_at: 1800000000 }), 5), null);
  assert.equal(annualSwitchFromFacts(input(), sub({ cancel_at_period_end: true }), 5), null);
  assert.equal(annualSwitchFromFacts(input(), sub({ pause_collection: { behavior: 'void' } }), 5), null);
  assert.equal(
    annualSwitchFromFacts(input(), sub({ metadata: { mcpe_downgrade_effective_at: String(Math.floor(NOW.getTime() / 1000) + 3600) } }), 5),
    null,
  );
  assert.equal(annualSwitchFromFacts(input(), sub({ status: 'past_due' }), 5), null);
});

test('annual, retired or another plan’s price: no card', () => {
  assert.equal(annualSwitchFromFacts(input(), sub({}, 'price_personal_y'), 5), null);
  assert.equal(annualSwitchFromFacts(input(), sub({}, 'price_unknown'), 5), null);
  // The subscription's price is Business while the workspace says Personal.
  assert.equal(annualSwitchFromFacts(input(), sub({}, 'price_business_m'), 5), null);
  // Not the subscription on file.
  assert.equal(annualSwitchFromFacts(input(), sub({ id: 'sub_other' }), 5), null);
});

test('only invoices that took money count', () => {
  assert.equal(
    countPaidInvoices([
      { status: 'paid', amount_paid: 900 },
      { status: 'paid', amount_paid: 0 },
      { status: 'open', amount_paid: 0 },
      { status: 'paid', amount_paid: 900 },
    ]),
    2,
  );
});

test('the resolver reads Stripe only past the pre-check, and a failure is no card', async () => {
  let calls = 0;
  const deps = {
    retrieveSubscription: async () => { calls += 1; return sub(); },
    listPaidInvoices: async () => [{ status: 'paid', amount_paid: 900 }, { status: 'paid', amount_paid: 900 }],
  };
  assert.equal(await resolveAnnualSwitch(input({ isOwner: false }), deps), null);
  assert.equal(calls, 0);
  assert.deepEqual(await resolveAnnualSwitch(input(), deps), { planId: 'personal', currency: 'usd' });
  assert.equal(calls, 1);
  const failing = { ...deps, retrieveSubscription: async () => { throw new Error('boom'); } };
  assert.equal(await resolveAnnualSwitch(input(), failing), null);
  const slow = { ...deps, retrieveSubscription: () => new Promise<Sub>(() => {}), timeoutMs: 10 };
  assert.equal(await resolveAnnualSwitch(input(), slow), null);
});

test('a dismissed notice returns once after 60 days, then never', () => {
  const day = 24 * 60 * 60 * 1000;
  const at = (days: number) => new Date(NOW.getTime() - days * day).toISOString();
  assert.equal(annualNoticeVisible({ dismissedAt: null, dismissCount: 0, now: NOW }), true);
  assert.equal(annualNoticeVisible({ dismissedAt: at(59), dismissCount: 1, now: NOW }), false);
  assert.equal(annualNoticeVisible({ dismissedAt: at(60), dismissCount: 1, now: NOW }), true);
  assert.equal(annualNoticeVisible({ dismissedAt: at(400), dismissCount: 2, now: NOW }), false);
  assert.equal(annualNoticeVisible({ dismissedAt: null, dismissCount: 1, now: NOW }), false);
});
