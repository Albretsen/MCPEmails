// ---------------------------------------------------------------------------
// The entitlement guards in front of Stripe Checkout.
//
// These pin the 2026-09-07 correction. Until that day `runCheckout` answered a
// 409 `grandfathered_personal` to any {planId:'personal'} from a user holding
// `user_usage_entitlements.unlimited_inboxes`, on the theory that Personal's
// three inboxes were a paid DOWNGRADE from unlimited. The theory was wrong on
// three counts, each of which is asserted below:
//
//   1. The grant lifts `maxInboxes` and nothing else (resolvePlanLimits).
//   2. It survives onto a paid plan, so a buyer keeps unlimited inboxes.
//   3. Personal raises four other limits, so it is a strict UPGRADE for them.
//
// The refusal was therefore turning away every remaining grandfathered account
// at the cheapest paid tier. What it must NOT do is take the comped guard with
// it: a comped grant resolves to Pro with no action ceiling, so for that cohort
// Personal genuinely is less than they already hold for nothing. The last four
// tests exist to stop a future cleanup from deleting both together.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/stripe/checkout-core.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Set before anything under test is imported: plans.ts reads the price ids at
// module load, and the real Stripe client throws on a missing secret key.
process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_core_unit';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_year';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
// Every tier needs a price here: the unconfigured-price check runs BEFORE the
// entitlement guards, so a missing env var would mask a guard test with a
// `price_not_configured` that looks like a pass.
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_month';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_year';

const USER_ID = '00000000-0000-0000-0000-0000000000a1';
const WORKSPACE_ID = '00000000-0000-0000-0000-0000000000b1';
const SESSION_URL = 'https://checkout.stripe.com/c/pay/test_session';

type EntitlementRow = {
  kind: string;
  expires_at: string | null;
  unlimited_inboxes?: boolean;
} | null;

type BillingRow = {
  plan: string;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
} | null;

/**
 * A Supabase stub with exactly the surface `runCheckout` touches: one auth
 * call and three `.from()` reads. Hand-rolled to match the house style in
 * check-inbox-limit.test.ts, and deliberately strict about which table it is
 * asked for, so a future read of a table this stub does not model fails loudly
 * instead of silently resolving to null and skipping a guard.
 */
function fakeSupabase(opts: { entitlement: EntitlementRow; billing?: BillingRow }) {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: USER_ID, email: 'buyer@example.com' } },
        error: null,
      }),
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        is: chain,
        order: chain,
        limit: chain,
        single: async () => {
          assert.equal(table, 'workspaces');
          return {
            data: { id: WORKSPACE_ID, display_name: 'Test Workspace' },
            error: null,
          };
        },
        maybeSingle: async () => {
          if (table === 'user_billing') {
            return { data: opts.billing ?? null, error: null };
          }
          assert.equal(table, 'user_usage_entitlements');
          return { data: opts.entitlement, error: null };
        },
      });
      return builder;
    },
  };
}

/**
 * `runCheckout` reaches its collaborators through module imports rather than
 * arguments, so the seams are the modules themselves. `mock.module` needs the
 * `--experimental-test-module-mocks` flag (see the `test:checkout` script).
 *
 * The @types/node pinned in this repo predates `mock.module`, so it is reached
 * through a narrow local type. Widening the whole file to `any` would give up
 * type checking on the assertions, which are the part worth checking.
 */
const nodeMock = mock as unknown as {
  module(specifier: string, options: { namedExports: Record<string, unknown> }): void;
};

/** Records every funnel write so a test can assert the OUTCOME, not just the return. */
const funnelCalls: Array<string | undefined> = [];

/** The Stripe calls a successful checkout makes, so a test can prove one happened. */
const sessionsCreated: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    billingTarget: (planId: string, interval: string) => `${planId}_${interval}`,
    recordCheckoutStarted: async (
      _workspaceId: string,
      _target: string,
      failure?: string,
    ) => {
      funnelCalls.push(failure);
    },
  },
});

nodeMock.module('@/lib/stripe/customer', {
  namedExports: {
    getOrCreateStripeCustomer: async () => ({ customerId: 'cus_test_grandfathered' }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            sessionsCreated.push(params);
            return { url: SESSION_URL };
          },
        },
      },
    },
  },
});

let currentSupabase: ReturnType<typeof fakeSupabase>;
nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => currentSupabase },
});

const { runCheckout } = await import('./checkout-core.ts');
const { PLANS, resolvePlanLimits } = await import('./plans.ts');

/** Run one checkout against a freshly stubbed database, and report what it did. */
async function checkout(opts: {
  planId: unknown;
  interval?: unknown;
  entitlement: EntitlementRow;
  billing?: BillingRow;
}) {
  currentSupabase = fakeSupabase({ entitlement: opts.entitlement, billing: opts.billing });
  funnelCalls.length = 0;
  sessionsCreated.length = 0;
  const outcome = await runCheckout({
    planId: opts.planId,
    interval: opts.interval ?? 'month',
  });
  return { outcome, funnelCalls: [...funnelCalls], sessionsCreated: [...sessionsCreated] };
}

/** The grandfathered cohort: a plain entitlement row carrying the inbox grant. */
const GRANDFATHERED: EntitlementRow = {
  kind: 'standard',
  expires_at: null,
  unlimited_inboxes: true,
};

// ---------------------------------------------------------------------------
// 1. The refusal is gone.
// ---------------------------------------------------------------------------

test('a grandfathered user can start a Personal checkout', async () => {
  // The whole point of the 2026-09-07 change. This returned a 409
  // `grandfathered_personal` for every one of these accounts, which is the
  // cheapest paid tier refusing the only cohort that had already proven it
  // would stay. If this ever returns an error again, revenue is being turned
  // away: read the note above the entitlement lookup in checkout-core.ts
  // before "fixing" this test.
  const { outcome, sessionsCreated } = await checkout({
    planId: 'personal',
    entitlement: GRANDFATHERED,
  });

  assert.equal(outcome.kind, 'checkout');
  assert.equal(outcome.kind === 'checkout' ? outcome.url : null, SESSION_URL);

  // Not merely "did not error": a real Stripe session was opened, at the
  // Personal price, for this user.
  assert.equal(sessionsCreated.length, 1);
  assert.equal(
    (sessionsCreated[0].line_items as Array<{ price: string }>)[0].price,
    'price_personal_month',
  );
});

test('the grandfathered Personal attempt is recorded as a started checkout, not a failure', async () => {
  // The old refusal recorded `subscription_exists`, which is what made the
  // loss invisible: it filed 27 blocked buyers under "already a customer" and
  // no growth surface ever showed a refusal. A success must record no failure
  // reason at all.
  const { funnelCalls } = await checkout({
    planId: 'personal',
    entitlement: GRANDFATHERED,
  });

  assert.deepEqual(funnelCalls, [undefined]);
});

test('a grandfathered user can still buy the tiers above Personal', async () => {
  // These were never refused, and must not become collateral damage of the
  // change. `solo` is sold as "Pro".
  for (const interval of ['month', 'year'] as const) {
    const { outcome } = await checkout({
      planId: 'solo',
      interval,
      entitlement: GRANDFATHERED,
    });
    assert.equal(outcome.kind, 'checkout', `solo/${interval} must remain purchasable`);
  }
});

test('the yearly Personal price is reachable for a grandfathered user too', async () => {
  const { sessionsCreated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: GRANDFATHERED,
  });

  assert.equal(
    (sessionsCreated[0].line_items as Array<{ price: string }>)[0].price,
    'price_personal_year',
  );
});

// ---------------------------------------------------------------------------
// 2. Why it is safe: the grant follows them onto the plan they bought.
// ---------------------------------------------------------------------------

test('the grant still resolves to unlimited inboxes while on Personal', async () => {
  // This is the load-bearing fact. Nothing clears `unlimited_inboxes` when a
  // subscription activates (the only writes to the column anywhere are the two
  // grandfather migrations, and the Stripe webhook never touches
  // user_usage_entitlements), and `effective_workspace_plan` returns it
  // regardless of plan. So the buyer resolves to Personal's limits with the
  // inbox cap still lifted, and gives up nothing by paying.
  const onPersonal = resolvePlanLimits('personal', { unlimitedInboxes: true });
  assert.equal(onPersonal.maxInboxes, Infinity);

  // If this ever becomes 3, the refusal was right after all and the guard
  // must come back. It is the single assertion that licenses the change.
  assert.notEqual(onPersonal.maxInboxes, PLANS.personal.limits.maxInboxes);
});

test('Personal is a strict upgrade for a grandfathered account on all four other limits', async () => {
  // The grant is inbox-only, so a grandfathered user lives under Free's other
  // limits. Naming each one here means a future edit to either plan that turns
  // Personal into a real downgrade fails loudly rather than quietly recreating
  // the situation the 409 was written for.
  const grandfatheredFree = resolvePlanLimits('free', { unlimitedInboxes: true });
  const grandfatheredPersonal = resolvePlanLimits('personal', { unlimitedInboxes: true });

  assert.equal(grandfatheredFree.maxMonthlyToolCalls, 5_000);
  assert.equal(grandfatheredPersonal.maxMonthlyToolCalls, 25_000);

  assert.equal(grandfatheredFree.maxRequestsPerMinute, 60);
  assert.equal(grandfatheredPersonal.maxRequestsPerMinute, 120);

  assert.equal(grandfatheredFree.billingPortalEnabled, false);
  assert.equal(grandfatheredPersonal.billingPortalEnabled, true);

  assert.equal(grandfatheredFree.supportTier, 'community');
  assert.equal(grandfatheredPersonal.supportTier, 'email');

  // Nothing is surrendered in exchange: the one thing the grant provides is
  // the one thing Personal cannot take back.
  assert.equal(grandfatheredFree.maxInboxes, Infinity);
  assert.equal(grandfatheredPersonal.maxInboxes, Infinity);
});

// ---------------------------------------------------------------------------
// 3. The comped guard is a different case and stays.
// ---------------------------------------------------------------------------

test('the comped guard still refuses Personal', async () => {
  // A comped grant resolves to Pro with an uncapped action ceiling, so for
  // these users Personal really is less than they already hold at no charge.
  // Deleting this alongside the grandfather refusal would start billing people
  // who were given the product.
  const { outcome } = await checkout({
    planId: 'personal',
    entitlement: { kind: 'comped_scale', expires_at: null, unlimited_inboxes: true },
  });

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'comped');
  assert.equal(outcome.status, 409);
  assert.equal(outcome.errorCode, 'subscription_not_self_service');
});

test('the comped guard refuses every tier, not only Personal', async () => {
  for (const planId of ['personal', 'solo', 'pro'] as const) {
    const { outcome, sessionsCreated } = await checkout({
      planId,
      entitlement: { kind: 'comped_scale', expires_at: null },
    });
    assert.equal(outcome.kind, 'error', `${planId} must be refused for a comped account`);
    assert.equal(outcome.kind === 'error' ? outcome.reason : null, 'comped');
    assert.equal(sessionsCreated.length, 0, 'no Stripe session may be opened');
  }
});

test('an EXPIRED comped grant does not refuse anything', async () => {
  // The guard is narrow by design: it protects a live grant, not a lapsed one.
  // A user whose comp has run out is an ordinary buyer.
  const { outcome } = await checkout({
    planId: 'personal',
    entitlement: {
      kind: 'comped_scale',
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      unlimited_inboxes: true,
    },
  });

  assert.equal(outcome.kind, 'checkout');
});

test('an account with no entitlement row at all is unaffected', async () => {
  const { outcome } = await checkout({ planId: 'personal', entitlement: null });
  assert.equal(outcome.kind, 'checkout');
});
