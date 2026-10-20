// ---------------------------------------------------------------------------
// The card-expiry sweep (POST ?mode=sweep) reads the PLAN's item.
//
// A Business subscription carries the plan's base item and the per-mailbox
// add-on, and Stripe does not promise the base item comes first. The sweep
// used to take items.data[0], so with the add-on first the warning email got
// planId null and the $3 add-on price as the amount. This pins the plan id
// and amount with the add-on listed first.
//
// Only the I/O is stubbed: Stripe, the service-role client and the queue
// helpers, which record the payload they were asked to queue.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/internal/billing-lifecycle/dispatch/route.card-sweep.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.DISPATCH_SECRET = 'dispatch_unit_secret';
process.env.BILLING_LIFECYCLE_EMAILS = 'on';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

// A card that expires at the end of this month: valid through the month, so
// it is always 0 to 31 days out, inside one of the two warning windows.
const now = new Date();
const card = {
  brand: 'visa',
  last4: '4242',
  exp_month: now.getUTCMonth() + 1,
  exp_year: now.getUTCFullYear(),
};

const queued: Array<{ template: string; payload: Record<string, unknown> }> = [];

nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: () => ({}) },
});

nodeMock.module('@/lib/billing/lifecycle-queue', {
  namedExports: {
    resolveUserId: async () => '00000000-0000-4000-8000-0000000011fe',
    resolveRecipient: async () => 'owner@example.test',
    isGrandfathered: async () => false,
    queueCardExpiryWarning: async (options: { template: string; payload: Record<string, unknown> }) => {
      queued.push({ template: options.template, payload: options.payload });
      return 1;
    },
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      subscriptions: {
        list: async () => ({
          data: [
            {
              id: 'sub_business',
              customer: 'cus_1',
              currency: 'usd',
              metadata: {},
              default_payment_method: { id: 'pm_1', card },
              items: {
                data: [
                  { id: 'si_addon', quantity: 4, price: { id: 'price_addon_month', unit_amount: 300 } },
                  { id: 'si_plan', quantity: 1, price: { id: 'price_business_month', unit_amount: 3900 } },
                ],
              },
            },
          ],
        }),
      },
      customers: { retrieve: async () => ({ deleted: false, email: 'owner@example.test' }) },
      paymentMethods: { retrieve: async () => ({ id: 'pm_1', card }) },
    },
  },
});

const { POST } = await import('./route.ts');

test('a Business card-expiry warning carries the plan and its price, with the add-on listed first', async () => {
  const response = await POST(
    new Request('https://mcpemails.test/api/internal/billing-lifecycle/dispatch?mode=sweep', {
      method: 'POST',
      headers: { 'x-dispatch-secret': 'dispatch_unit_secret' },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.planId, 'pro');
  assert.equal(queued[0].payload.amountCents, 3900);
});
