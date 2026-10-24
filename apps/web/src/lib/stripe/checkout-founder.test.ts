// ---------------------------------------------------------------------------
// runCheckout with the Business founder price: which price lands on the plan
// item for a new checkout, an in-place upgrade and an interval switch, and
// that the founder checkout carries no promotion codes and the cohort tag.
//
// The offer lookup itself (flag, count, owner) is tested in
// founder-places.test.ts; here it is a switch.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/stripe/checkout-founder.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_founder_unit';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_MONTHLY = 'price_founder_month';
process.env.STRIPE_PRICE_BUSINESS_FOUNDER_YEARLY = 'price_founder_year';

const USER_ID = '00000000-0000-0000-0000-0000000000a1';
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1';

const nodeMock = mock as unknown as {
  module(specifier: string, options: { namedExports: Record<string, unknown> }): void;
};

/** Whether the mocked offer lookup says the founder price is open. */
let offerOpen = false;
const offerLookups: Array<{ ownerId?: string | null; fresh?: boolean }> = [];
let billingRow: { plan: string; subscription_status: string | null; stripe_subscription_id: string | null } | null =
  null;
let currentPrice = 'price_solo_month';
const sessionsCreated: Array<Record<string, unknown>> = [];
const subscriptionsUpdated: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/stripe/founder-offer-server', {
  namedExports: {
    currentFounderOffer: async (opts: { ownerId?: string | null }) => {
      offerLookups.push(opts);
      return offerOpen
        ? {
            monthlyPriceId: 'price_founder_month',
            yearlyPriceId: 'price_founder_year',
            placesLeft: 14,
            placesTotal: 20,
            endsAt: '2026-12-31T22:59:59.000Z',
            endsAtLabel: '2026-12-31',
          }
        : null;
    },
  },
});

nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    billingTarget: (planId: string, interval: string) => `${planId}_${interval}`,
    planCategory: (plan: string | null | undefined) =>
      plan === 'personal' || plan === 'solo' || plan === 'pro' ? plan : 'free',
    recordCheckoutStarted: async () => {},
    recordPlanChange: async () => {},
    primaryWorkspaceId: async () => WORKSPACE_ID,
    recordPassEvent: async () => {},
  },
});

nodeMock.module('@/lib/stripe/customer', {
  namedExports: { getOrCreateStripeCustomer: async () => ({ customerId: 'cus_test' }) },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            sessionsCreated.push(params);
            return { url: 'https://checkout.stripe.com/c/pay/test' };
          },
        },
      },
      subscriptions: {
        retrieve: async (id: string) => ({
          id,
          customer: 'cus_test',
          items: { data: [{ id: 'si_plan', price: { id: currentPrice }, current_period_end: 1 }] },
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          subscriptionsUpdated.push({ id, ...params });
          return { pending_update: null, latest_invoice: { amount_paid: 1, currency: 'usd' } };
        },
      },
      invoices: {
        createPreview: async () => ({ currency: 'usd', amount_due: 1, lines: { data: [] } }),
      },
      prices: { retrieve: async () => ({ unit_amount: 2900 }) },
    },
  },
});

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: 'buyer@example.com' } }, error: null }) },
      from(table: string) {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: chain,
          eq: chain,
          is: chain,
          order: chain,
          limit: chain,
          single: async () => ({ data: { id: WORKSPACE_ID, display_name: 'WS' }, error: null }),
          maybeSingle: async () =>
            table === 'user_billing' ? { data: billingRow, error: null } : { data: null, error: null },
        });
        return builder;
      },
    }),
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from(table: string) {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: chain,
          eq: chain,
          in: chain,
          is: () =>
            Promise.resolve(
              table === 'workspaces' ? { data: [{ id: WORKSPACE_ID }], error: null } : { count: 0, error: null },
            ),
        });
        return builder;
      },
    }),
  },
});

const { runCheckout } = await import('./checkout-core.ts');

function reset(opts: { open: boolean; billing?: typeof billingRow; price?: string }) {
  offerOpen = opts.open;
  billingRow = opts.billing ?? null;
  currentPrice = opts.price ?? 'price_solo_month';
  offerLookups.length = 0;
  sessionsCreated.length = 0;
  subscriptionsUpdated.length = 0;
}

const ACTIVE = (plan: string) => ({ plan, subscription_status: 'active', stripe_subscription_id: 'sub_1' });

function planItemPrice(update: Record<string, unknown>): string {
  return (update.items as Array<{ id?: string; price?: string }>).find((i) => i.id === 'si_plan')!.price!;
}

test('new Business checkout during the offer: founder price, no promotion codes, tagged', async () => {
  reset({ open: true });
  const outcome = await runCheckout({ planId: 'pro', interval: 'year' });
  assert.equal(outcome.kind, 'checkout');
  const session = sessionsCreated[0];
  assert.deepEqual((session.line_items as unknown[])[0], { price: 'price_founder_year', quantity: 1 });
  assert.equal('allow_promotion_codes' in session, false);
  const subMeta = (session.subscription_data as { metadata: Record<string, string> }).metadata;
  assert.equal(subMeta.founder_offer, 'founder2026');
  assert.equal('offer' in subMeta, false, 'the shared seasonal key is left alone');
  assert.equal((session.metadata as Record<string, string>).founder_offer, 'founder2026');
  assert.match(String(session.success_url), /&interval=year&offer=founder$/);
  // The place count is read uncached when a price is decided.
  assert.deepEqual(offerLookups, [{ ownerId: USER_ID, fresh: true }]);
});

test('new Business checkout with no offer: $39 price and promotion codes as before', async () => {
  reset({ open: false });
  await runCheckout({ planId: 'pro', interval: 'month' });
  const session = sessionsCreated[0];
  assert.deepEqual((session.line_items as unknown[])[0], { price: 'price_business_month', quantity: 1 });
  assert.equal(session.allow_promotion_codes, true);
  assert.equal('founder_offer' in (session.subscription_data as { metadata: object }).metadata, false);
  assert.doesNotMatch(String(session.success_url), /offer=/);
});

test('a Pro checkout never looks up the offer and keeps promotion codes', async () => {
  reset({ open: true });
  await runCheckout({ planId: 'solo', interval: 'month' });
  assert.equal(offerLookups.length, 0);
  assert.deepEqual((sessionsCreated[0].line_items as unknown[])[0], { price: 'price_solo_month', quantity: 1 });
  assert.equal(sessionsCreated[0].allow_promotion_codes, true);
});

test('upgrade Pro -> Business during the offer swaps onto the founder price', async () => {
  reset({ open: true, billing: ACTIVE('solo'), price: 'price_solo_month' });
  const outcome = await runCheckout({ planId: 'pro', interval: 'month', confirmChange: true });
  assert.equal(outcome.kind, 'changed');
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_founder_month');
});

test('upgrade Personal -> Business with no offer swaps onto $39', async () => {
  reset({ open: false, billing: ACTIVE('personal'), price: 'price_personal_month' });
  await runCheckout({ planId: 'pro', interval: 'year', confirmChange: true });
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_business_year');
});

test('a founder switching to yearly after the window stays on the founder pair', async () => {
  reset({ open: false, billing: ACTIVE('pro'), price: 'price_founder_month' });
  const outcome = await runCheckout({ planId: 'pro', interval: 'year', confirmChange: true });
  assert.equal(outcome.kind, 'changed');
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_founder_year');
  // Already on Business: the offer is not even consulted.
  assert.equal(offerLookups.length, 0);
});

test('a founder asking for the interval they already have is the no-op', async () => {
  reset({ open: false, billing: ACTIVE('pro'), price: 'price_founder_month' });
  const outcome = await runCheckout({ planId: 'pro', interval: 'month', confirmChange: true });
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.kind === 'error' && outcome.reason, 'already_on_plan_interval');
  assert.equal(subscriptionsUpdated.length, 0);
});

test('a $39 Business subscriber switching interval during the offer stays at $39', async () => {
  reset({ open: true, billing: ACTIVE('pro'), price: 'price_business_month' });
  await runCheckout({ planId: 'pro', interval: 'year', confirmChange: true });
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_business_year');
});

// ── Quote and charge must be the same price ─────────────────────────────

test('the quote carries the price it was priced with', async () => {
  reset({ open: true, billing: ACTIVE('solo'), price: 'price_solo_month' });
  const quote = await runCheckout({ planId: 'pro', interval: 'month' });
  assert.equal(quote.kind, 'confirmation_required');
  assert.equal(quote.kind === 'confirmation_required' && quote.quotedPriceId, 'price_founder_month');
  assert.equal(subscriptionsUpdated.length, 0);
});

test('offer gone between quote and confirm: nothing is charged, a fresh $39 quote comes back', async () => {
  // Quoted at the founder price while the offer was open...
  reset({ open: true, billing: ACTIVE('solo'), price: 'price_solo_month' });
  const quote = await runCheckout({ planId: 'pro', interval: 'month' });
  assert.equal(quote.kind, 'confirmation_required');
  const quotedPriceId = quote.kind === 'confirmation_required' ? quote.quotedPriceId : '';
  // ...and confirmed after it closed (window, cap or flag).
  reset({ open: false, billing: ACTIVE('solo'), price: 'price_solo_month' });
  const outcome = await runCheckout({ planId: 'pro', interval: 'month', confirmChange: true, quotedPriceId });
  assert.equal(outcome.kind, 'confirmation_required');
  if (outcome.kind !== 'confirmation_required') return;
  assert.equal(outcome.priceChanged, true);
  assert.equal(outcome.quotedPriceId, 'price_business_month');
  assert.equal(subscriptionsUpdated.length, 0, 'no swap, no charge');
  // Confirming the fresh quote goes through at the price it named.
  const second = await runCheckout({
    planId: 'pro',
    interval: 'month',
    confirmChange: true,
    quotedPriceId: outcome.quotedPriceId,
  });
  assert.equal(second.kind, 'changed');
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_business_month');
});

test('a confirm with the quoted price that still applies charges as before', async () => {
  reset({ open: true, billing: ACTIVE('solo'), price: 'price_solo_month' });
  const outcome = await runCheckout({
    planId: 'pro',
    interval: 'month',
    confirmChange: true,
    quotedPriceId: 'price_founder_month',
  });
  assert.equal(outcome.kind, 'changed');
  assert.equal(planItemPrice(subscriptionsUpdated[0]), 'price_founder_month');
});
