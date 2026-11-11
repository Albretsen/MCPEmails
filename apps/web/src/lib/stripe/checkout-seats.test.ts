// ---------------------------------------------------------------------------
// Business billed per person at checkout (`pricing_switches.business_seat_pricing`).
//
// What costs a customer money if it breaks:
//   1. Switch off: Business sells the flat price at quantity 1, as before.
//   2. Switch on: one seat line, quantity = max(2, people billable now), the
//      rule the sync keeps, so no credit follows a purchase; no founder price.
//   3. Company-wide mailboxes only count toward the ten on a per-person sale.
//   4. A legacy flat Business subscriber switching interval stays flat.
//   5. Leaving a per-person price sets the plan item back to quantity 1.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/stripe/checkout-seats.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_seats_unit';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';
process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY = 'price_seat_month';
process.env.STRIPE_PRICE_BUSINESS_SEAT_YEARLY = 'price_seat_year';

const USER_ID = '00000000-0000-0000-0000-0000000000a1';
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1';

const nodeMock = mock as unknown as {
  module(specifier: string, options: { namedExports: Record<string, unknown> }): void;
};

// ── Fixture state ───────────────────────────────────────────────────────────
let seatSwitchOn = true;
let billing: { plan: string; subscription_status: string | null; stripe_subscription_id: string | null } | null = null;
let members: Array<{ workspace_id: string; user_id: string; role: string }> = [];
let inboxOwners: Array<{ workspace_id: string; owner_user_id: string | null }> = [];
let allInboxes = 0;
let companyInboxes = 0;
let currentPrice = 'price_personal_month';
let currentQuantity = 1;
const sessions: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const previews: Array<Record<string, unknown>> = [];

function reset(opts: Partial<{
  seat: boolean;
  billing: typeof billing;
  members: typeof members;
  inboxOwners: typeof inboxOwners;
  allInboxes: number;
  companyInboxes: number;
  currentPrice: string;
  currentQuantity: number;
}> = {}) {
  seatSwitchOn = opts.seat ?? true;
  billing = opts.billing ?? null;
  members = opts.members ?? [];
  inboxOwners = opts.inboxOwners ?? [];
  allInboxes = opts.allInboxes ?? 0;
  companyInboxes = opts.companyInboxes ?? 0;
  currentPrice = opts.currentPrice ?? 'price_personal_month';
  currentQuantity = opts.currentQuantity ?? 1;
  sessions.length = 0;
  updates.length = 0;
  previews.length = 0;
}

/** One stub for both clients: every read the checkout makes, by table. */
function db() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, email: 'owner@example.com' } }, error: null }),
    },
    from(table: string) {
      let key: unknown = null;
      let visibility: unknown = null;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        in: chain,
        is: chain,
        not: chain,
        order: chain,
        limit: chain,
        eq: (col: string, value: unknown) => {
          if (col === 'key') key = value;
          if (col === 'visibility') visibility = value;
          return builder;
        },
        single: async () => ({ data: { id: WORKSPACE_ID, display_name: 'Acme' }, error: null }),
        maybeSingle: async () => {
          if (table === 'pricing_switches') {
            return { data: { enabled: key === 'business_seat_pricing' ? seatSwitchOn : false }, error: null };
          }
          if (table === 'user_billing') return { data: billing, error: null };
          return { data: null, error: null };
        },
        range: async () =>
          table === 'workspace_members'
            ? { data: members, error: null }
            : { data: inboxOwners, error: null },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: [{ id: WORKSPACE_ID }], error: null }
              : table === 'user_passes'
                ? { data: [], error: null }
                : { count: visibility === 'company' ? companyInboxes : allInboxes, error: null },
          ).then(resolve, reject),
      });
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => db() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db() } });
nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    primaryWorkspaceId: async () => WORKSPACE_ID,
    billingTarget: (planId: string, interval: string) => `${planId}_${interval}`,
    planCategory: (plan: string | null | undefined) => plan ?? 'free',
    recordCheckoutStarted: async () => {},
    recordPassEvent: async () => {},
    recordPlanChange: async () => {},
    recordAnnualSwitchCompleted: async () => {},
    recordAnnualSwitchSeen: async () => {},
  },
});
nodeMock.module('@/lib/stripe/customer', {
  namedExports: { getOrCreateStripeCustomer: async () => ({ customerId: 'cus_seats' }) },
});
nodeMock.module('@/lib/stripe/seasonal-offer-server', {
  namedExports: { getActiveSeasonalOffers: async () => ({}) },
});
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            sessions.push(params);
            return { url: 'https://checkout.stripe.com/c/pay/seats', id: 'cs_seats' };
          },
        },
      },
      subscriptions: {
        list: async () => ({ data: [] }),
        retrieve: async (id: string) => ({
          id,
          customer: 'cus_seats',
          metadata: {},
          discounts: [],
          items: {
            data: [
              { id: 'si_base', price: { id: currentPrice }, quantity: currentQuantity, current_period_end: 1_760_000_000 },
            ],
          },
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updates.push({ id, ...params });
          return { pending_update: null, latest_invoice: { amount_paid: 1900, currency: 'usd' } };
        },
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => {
          previews.push(params);
          return { currency: 'usd', amount_due: 1900, lines: { data: [] }, total_discount_amounts: [] };
        },
      },
      prices: {
        retrieve: async (id: string) => ({ unit_amount: id.startsWith('price_seat') ? 1900 : 300 }),
      },
    },
  },
});

const { runCheckout } = await import('./checkout-core.ts');
const { resetBusinessSeatSwitchCache } = await import('./business-seats.ts');

async function buy(input: Record<string, unknown>) {
  resetBusinessSeatSwitchCache();
  return runCheckout({ planId: 'pro', interval: 'month', locale: 'en', ...input });
}

const SUBSCRIBED = (plan: string) => ({
  plan,
  subscription_status: 'active',
  stripe_subscription_id: 'sub_seats',
});

// ── New subscriptions ───────────────────────────────────────────────────────

test('switch off: Business sells the flat price at quantity 1', async () => {
  reset({ seat: false });
  const outcome = await buy({});
  assert.equal(outcome.kind, 'checkout');
  assert.deepEqual(sessions[0].line_items, [{ price: 'price_business_month', quantity: 1 }]);
  assert.equal('business_people' in (sessions[0].metadata as object), false);
});

test('switch on: one seat line at the two-person minimum when only the owner is billable', async () => {
  reset();
  await buy({});
  assert.deepEqual(sessions[0].line_items, [{ price: 'price_seat_month', quantity: 2 }]);
  assert.equal((sessions[0].metadata as Record<string, string>).business_people, '2');
  reset();
  await buy({ interval: 'year', people: 9 });
  assert.deepEqual(sessions[0].line_items, [{ price: 'price_seat_year', quantity: 2 }], 'a people count in the request is ignored');
});

test('switch on: quantity = the people billable now', async () => {
  reset({
    members: [
      { workspace_id: WORKSPACE_ID, user_id: 'u-member', role: 'member' },
      { workspace_id: WORKSPACE_ID, user_id: 'u-admin', role: 'admin' },
      { workspace_id: WORKSPACE_ID, user_id: 'u-free-admin', role: 'admin' },
    ],
    inboxOwners: [
      { workspace_id: WORKSPACE_ID, owner_user_id: 'u-member' },
      { workspace_id: WORKSPACE_ID, owner_user_id: 'u-admin' },
    ],
  });
  await buy({});
  // Owner + member + admin with a mailbox; the admin without one is free.
  assert.deepEqual(sessions[0].line_items, [{ price: 'price_seat_month', quantity: 3 }]);
});

test('switch on: only company-wide mailboxes count toward the ten', async () => {
  reset({ allInboxes: 30, companyInboxes: 12 });
  await buy({});
  assert.deepEqual(sessions[0].line_items, [
    { price: 'price_seat_month', quantity: 2 },
    { price: 'price_addon_month', quantity: 2 },
  ]);
  reset({ seat: false, allInboxes: 12, companyInboxes: 0 });
  await buy({});
  assert.deepEqual(sessions[0].line_items, [
    { price: 'price_business_month', quantity: 1 },
    { price: 'price_addon_month', quantity: 2 },
  ], 'switch off: every mailbox counts, as before');
});

test('switch on, seat price not configured: price_not_configured, no session', async () => {
  reset();
  const saved = process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY;
  delete process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY;
  try {
    const outcome = await buy({});
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.kind === 'error' && outcome.reason, 'price_not_configured');
    assert.equal(sessions.length, 0);
  } finally {
    process.env.STRIPE_PRICE_BUSINESS_SEAT_MONTHLY = saved;
  }
});

test('Personal and Pro checkouts are untouched by the switch, paperwork on every session', async () => {
  reset();
  await runCheckout({ planId: 'solo', interval: 'month', locale: 'en' });
  assert.deepEqual(sessions[0].line_items, [{ price: 'price_solo_month', quantity: 1 }]);
  assert.deepEqual(sessions[0].tax_id_collection, { enabled: true });
  assert.deepEqual(sessions[0].customer_update, { name: 'auto', address: 'auto' }, 'tax off: Stripe still needs the address with tax ID collection');
  assert.equal('automatic_tax' in sessions[0], false, 'tax calculation still follows its own switch');
});

// ── In-place changes ────────────────────────────────────────────────────────

const FOUR_PEOPLE = {
  members: [
    { workspace_id: WORKSPACE_ID, user_id: 'a', role: 'member' },
    { workspace_id: WORKSPACE_ID, user_id: 'b', role: 'member' },
    { workspace_id: WORKSPACE_ID, user_id: 'c', role: 'admin' },
  ],
  inboxOwners: [
    { workspace_id: WORKSPACE_ID, owner_user_id: 'a' },
    { workspace_id: WORKSPACE_ID, owner_user_id: 'b' },
    { workspace_id: WORKSPACE_ID, owner_user_id: 'c' },
  ],
};

test('Pro -> Business with the switch on: seat price at the billable count, quoted then charged', async () => {
  reset({ billing: SUBSCRIBED('solo'), currentPrice: 'price_solo_month', ...FOUR_PEOPLE });
  const quote = await buy({});
  assert.equal(quote.kind, 'confirmation_required');
  assert.equal(quote.kind === 'confirmation_required' && quote.quotedPriceId, 'price_seat_month');
  assert.equal(quote.kind === 'confirmation_required' && quote.preview?.people, 4);
  assert.equal(quote.kind === 'confirmation_required' && quote.preview?.recurringCents, 4 * 1900);
  const previewItems = (previews[0].subscription_details as { items: unknown[] }).items;
  assert.deepEqual(previewItems[0], { id: 'si_base', price: 'price_seat_month', quantity: 4 });

  reset({ billing: SUBSCRIBED('solo'), currentPrice: 'price_solo_month', ...FOUR_PEOPLE });
  const done = await buy({ confirmChange: true, quotedPriceId: 'price_seat_month' });
  assert.equal(done.kind, 'changed');
  assert.deepEqual((updates[0].items as unknown[])[0], { id: 'si_base', price: 'price_seat_month', quantity: 4 });
});

test('a flat $39 Business subscriber switching to yearly stays flat with the switch on', async () => {
  reset({ billing: SUBSCRIBED('pro'), currentPrice: 'price_business_month' });
  await buy({ interval: 'year', confirmChange: true });
  assert.equal(updates.length, 1);
  assert.deepEqual((updates[0].items as unknown[])[0], { id: 'si_base', price: 'price_business_year' });
});

test('a per-person subscriber switching to yearly keeps per-person pricing and its people', async () => {
  reset({
    billing: SUBSCRIBED('pro'),
    currentPrice: 'price_seat_month',
    currentQuantity: 3,
    members: [{ workspace_id: WORKSPACE_ID, user_id: 'u-m', role: 'member' }],
    inboxOwners: [{ workspace_id: WORKSPACE_ID, owner_user_id: 'u-m' }],
  });
  await buy({ interval: 'year', confirmChange: true });
  assert.deepEqual((updates[0].items as unknown[])[0], { id: 'si_base', price: 'price_seat_year', quantity: 2 });
});

test('switch off: a per-person subscriber switching interval stays on seat prices, never the flat price', async () => {
  reset({
    seat: false,
    billing: SUBSCRIBED('pro'),
    currentPrice: 'price_seat_month',
    currentQuantity: 3,
    ...FOUR_PEOPLE,
  });
  await buy({ interval: 'year', confirmChange: true });
  assert.equal(updates.length, 1);
  assert.deepEqual((updates[0].items as unknown[])[0], { id: 'si_base', price: 'price_seat_year', quantity: 4 });
});

test('leaving a per-person price sets the plan item back to quantity 1', async () => {
  reset({ billing: SUBSCRIBED('pro'), currentPrice: 'price_seat_month', currentQuantity: 3 });
  await runCheckout({ planId: 'solo', interval: 'month', locale: 'en', confirmChange: true });
  assert.deepEqual((updates[0].items as unknown[])[0], { id: 'si_base', price: 'price_solo_month', quantity: 1 });
});
