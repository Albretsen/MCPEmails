// ---------------------------------------------------------------------------
// The entitlement guards in front of Stripe Checkout, and the funnel row every
// checkout attempt is supposed to leave behind (section 4, added 2026-09-09).
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
// Personal genuinely is less than they already hold for nothing. The tests in
// section 3 exist to stop a future cleanup from deleting both together.
//
// Section 5 pins the second refusal of the same kind, removed on 2026-09-14:
// `already_on_plan`, which refused a monthly subscriber the annual price of the
// plan they were already on. Its header carries the full story, including the
// two things that had to survive it: the real no-op refusal, and the consent
// gate in front of every in-place swap.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/stripe/checkout-core.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Set before anything under test is imported: plans.ts reads the price ids at
// module load, and the real Stripe client throws on a missing secret key.
process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_core_unit';
// Personal is sold on the _V2 variables since the 2026-09-29 repricing; the
// unsuffixed pair holds the retired $5 / $48 prices existing subscribers keep.
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_month';
process.env.STRIPE_PRICE_PERSONAL_YEARLY_V2 = 'price_personal_year';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_month_500';
process.env.STRIPE_PRICE_PERSONAL_YEARLY = 'price_personal_year_4800';
process.env.STRIPE_PRICE_SOLO_MONTHLY = 'price_solo_month';
process.env.STRIPE_PRICE_SOLO_YEARLY = 'price_solo_year';
// Every tier needs a price here: the unconfigured-price check runs BEFORE the
// entitlement guards, so a missing env var would mask a guard test with a
// `price_not_configured` that looks like a pass.
// Since 2026-10-19 these two hold the RETIRED $79 / $756 Team prices, read as
// Business legacy ids; Business itself sells on the _BUSINESS_ variables, plus
// the per-mailbox add-on above ten.
process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_month';
process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_year';
process.env.STRIPE_PRICE_BUSINESS_MONTHLY = 'price_business_month';
process.env.STRIPE_PRICE_BUSINESS_YEARLY = 'price_business_year';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = 'price_addon_month';
process.env.STRIPE_PRICE_BUSINESS_MAILBOX_YEARLY = 'price_addon_year';

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
function fakeSupabase(opts: {
  entitlement: EntitlementRow;
  billing?: BillingRow;
  /** false models a lapsed or absent session: `getUser` returns no user. */
  signedIn?: boolean;
  /** false models an authenticated user who owns no workspace (PGRST116). */
  hasWorkspace?: boolean;
}) {
  const signedIn = opts.signedIn !== false;
  const hasWorkspace = opts.hasWorkspace !== false;
  return {
    auth: {
      getUser: async () =>
        signedIn
          ? {
              data: { user: { id: USER_ID, email: 'buyer@example.com' } },
              error: null,
            }
          : { data: { user: null }, error: { message: 'Auth session missing!' } },
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
          if (!hasWorkspace) {
            // Exactly what PostgREST answers `.single()` with when the filter
            // matched nothing. Not a thrown error: the client returns it.
            return {
              data: null,
              error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
            };
          }
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

/**
 * Records every funnel write so a test can assert the OUTCOME, not just the
 * return. The target is kept alongside the failure because the two validation
 * refusals are recorded against `unknown` rather than a plan+interval, and a
 * row filed under the wrong target is worse than no row.
 */
const funnelRows: Array<{ target: string; failure: string | undefined }> = [];

/**
 * The `entryPoint` each `checkout_started` row was written with, kept apart
 * from `funnelRows` so the older deepEqual assertions on that list stay as
 * they are. Undefined for every cookie-path row; 'chat_link' for the link.
 */
const funnelEntryPoints: Array<string | undefined> = [];

/**
 * The plan-change rows, kept apart from the checkout rows on purpose.
 *
 * They are a different stage in a different part of the funnel, and the whole
 * point of the 2026-09-14 fix is that a plan change must not land in the
 * checkout bucket. A single combined list would let a regression that puts it
 * back there pass.
 */
const planChangeRows: Array<{
  direction: string;
  target: string;
  outcome: string;
  failure: string | undefined;
}> = [];

/** The Stripe calls a successful checkout makes, so a test can prove one happened. */
const sessionsCreated: Array<Record<string, unknown>> = [];

/** The subscription id every plan-change fixture below points at. */
const SUBSCRIPTION_ID = 'sub_test_existing';

/**
 * Every `invoices.createPreview` call, so a test can prove the QUOTE prices the
 * same swap the confirmation performs. A preview taken against different
 * parameters would quote one number and charge another.
 */
const previewsRequested: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    billingTarget: (planId: string, interval: string) => `${planId}_${interval}`,
    planCategory: (plan: string | null | undefined) =>
      plan === 'personal' || plan === 'solo' || plan === 'pro' ? plan : 'free',
    recordCheckoutStarted: async (
      workspaceId: string | null,
      target: string,
      failure?: string,
      entryPoint?: string,
    ) => {
      // Mirrors the real helper, which no-ops on a null workspace id. Without
      // that, a test could "prove" a row was written for a user who has no
      // workspace to write it against.
      if (!workspaceId) return;
      assert.equal(workspaceId, WORKSPACE_ID, 'a row must land on the buyer\'s own workspace');
      funnelRows.push({ target, failure });
      funnelEntryPoints.push(entryPoint);
    },
    recordPlanChange: async (args: {
      workspaceId: string | null;
      direction: string;
      target: string;
      outcome: string;
      failure?: string;
    }) => {
      if (!args.workspaceId) return;
      assert.equal(args.workspaceId, WORKSPACE_ID);
      planChangeRows.push({
        direction: args.direction,
        target: args.target,
        outcome: args.outcome,
        failure: args.failure,
      });
    },
  },
});

nodeMock.module('@/lib/stripe/customer', {
  namedExports: {
    getOrCreateStripeCustomer: async () => ({ customerId: 'cus_test_grandfathered' }),
  },
});

/**
 * How the stubbed Stripe should answer the in-place price swap.
 *
 * `applied` is the ordinary paid upgrade. `pending` is Stripe holding the swap
 * because the invoice was not paid (3DS or a decline), which leaves the
 * customer on the plan they had. `throws` is the 500 path.
 */
let swapBehaviour: 'applied' | 'pending' | 'throws' = 'applied';

/** The subscription the stub says the user is currently on. */
let currentSubscriptionPrice = 'price_personal_month';

/** The per-mailbox add-on item on the current subscription, when it has one. */
let currentAddon: { id: string; price: { id: string }; quantity: number } | null = null;

/** Inboxes across the buyer's owned workspaces, for the Business add-on count. */
let ownedInboxes = 0;

/** Every `subscriptions.update` call, so a test can prove the swap happened. */
const subscriptionsUpdated: Array<Record<string, unknown>> = [];

/**
 * Black Week 2026. What `getActiveSeasonalOffers` answers (empty by default,
 * so every older test runs exactly as before), the customer's subscriptions
 * as `subscriptions.list` reports them (for the one-redemption rule), and the
 * current subscription's metadata and discounts.
 */
let activeOffers: Record<string, unknown> = {};
let customerSubscriptions: Array<{ metadata: Record<string, string> }> = [];
let listThrows = false;
let currentMetadata: Record<string, string> = {};
let currentDiscounts: string[] = [];

nodeMock.module('@/lib/stripe/seasonal-offer-server', {
  namedExports: {
    getActiveSeasonalOffers: async () => activeOffers,
  },
});

/**
 * Every `subscriptions.retrieve` call. The chat link must refuse an existing
 * subscriber before the subscription is even read, which only this can show.
 */
const subscriptionsRetrieved: string[] = [];

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            sessionsCreated.push(params);
            return { url: SESSION_URL, id: 'cs_test_core_session' };
          },
        },
      },
      subscriptions: {
        list: async () => {
          if (listThrows) throw new Error('stripe_list_down');
          return { data: customerSubscriptions };
        },
        retrieve: async (id: string) => (subscriptionsRetrieved.push(id), {
          id,
          customer: 'cus_test_subscriber',
          metadata: currentMetadata,
          discounts: currentDiscounts,
          items: {
            data: [
              // The add-on FIRST when present: Stripe does not promise the
              // plan's item leads, and the code must not assume it.
              ...(currentAddon ? [currentAddon] : []),
              {
                id: 'si_test_item',
                price: { id: currentSubscriptionPrice },
                current_period_end: 1_760_000_000,
              },
            ],
          },
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          subscriptionsUpdated.push({ id, ...params });
          if (swapBehaviour === 'throws') throw new Error('card_declined_hard');
          return {
            pending_update: swapBehaviour === 'pending' ? { expires_at: 1 } : null,
            latest_invoice: {
              amount_paid: swapBehaviour === 'pending' ? 0 : 1041,
              currency: 'usd',
              hosted_invoice_url: 'https://invoice.stripe.com/test',
            },
          };
        },
      },
      // Only reached on the unconfirmed pass, to quote the change. A failure
      // here is not a refusal in the real code either, so the stub is allowed
      // to be thin.
      invoices: {
        createPreview: async (params: Record<string, unknown>) => {
          previewsRequested.push(params);
          return {
            currency: 'usd',
            amount_due: params.discounts ? 5441 : 1041,
            lines: { data: [{ amount: -459 }] },
            total_discount_amounts: params.discounts ? [{ amount: 2740, discount: 'di_bw' }] : [],
          };
        },
      },
      prices: {
        retrieve: async (id: string) => ({ unit_amount: id.startsWith('price_addon') ? 300 : 1500 }),
      },
    },
  },
});

let currentSupabase: ReturnType<typeof fakeSupabase>;
nodeMock.module('@/lib/supabase/server', {
  namedExports: { createClient: async () => currentSupabase },
});

// The service-role reads `countOwnedInboxes` makes for a Business change: the
// owner's workspaces, then a head count of their live inboxes.
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
          // The identity entry point (the chat checkout link) reads user_billing
          // and user_usage_entitlements through the service-role client. Same
          // fixtures as the cookie client, so both paths see the same buyer.
          maybeSingle: () =>
            (currentSupabase.from(table) as unknown as { maybeSingle: () => Promise<unknown> })
              .maybeSingle(),
          is: () =>
            Promise.resolve(
              table === 'workspaces'
                ? { data: [{ id: WORKSPACE_ID }], error: null }
                : { count: ownedInboxes, error: null },
            ),
        });
        return builder;
      },
    }),
  },
});

const { runCheckout, runCheckoutForIdentity } = await import('./checkout-core.ts');
const { FREE_ACTION_ALLOWANCE, PLANS, resolvePlanLimits } = await import('./plans.ts');

/** Run one checkout against a freshly stubbed database, and report what it did. */
async function checkout(opts: {
  planId: unknown;
  interval?: unknown;
  entitlement: EntitlementRow;
  billing?: BillingRow;
  signedIn?: boolean;
  hasWorkspace?: boolean;
  /** The second half of the two-call consent gate. Defaults to the quote. */
  confirmChange?: unknown;
  /** The price the existing subscription is on, for the plan-change path. */
  currentPrice?: string;
  swap?: 'applied' | 'pending' | 'throws';
  /** An existing add-on quantity on the subscription (Business only). */
  addonQuantity?: number;
  /** Inboxes the buyer owns across workspaces. */
  inboxes?: number;
  /** The buyer's language, as a caller hands it over. Omitted when undefined. */
  locale?: unknown;
  /** The expired session an abandoned-checkout reminder linked from. */
  recoveredFrom?: unknown;
  /** The seasonal offer id the confirmed quote carried. */
  quotedOffer?: unknown;
}) {
  currentSupabase = fakeSupabase({
    entitlement: opts.entitlement,
    billing: opts.billing,
    signedIn: opts.signedIn,
    hasWorkspace: opts.hasWorkspace,
  });
  funnelRows.length = 0;
  funnelEntryPoints.length = 0;
  planChangeRows.length = 0;
  sessionsCreated.length = 0;
  subscriptionsUpdated.length = 0;
  previewsRequested.length = 0;
  swapBehaviour = opts.swap ?? 'applied';
  currentSubscriptionPrice = opts.currentPrice ?? 'price_personal_month';
  currentAddon =
    opts.addonQuantity != null
      ? { id: 'si_addon', price: { id: 'price_addon_month' }, quantity: opts.addonQuantity }
      : null;
  ownedInboxes = opts.inboxes ?? 0;
  const outcome = await runCheckout({
    planId: opts.planId,
    interval: opts.interval ?? 'month',
    confirmChange: opts.confirmChange,
    ...('locale' in opts ? { locale: opts.locale } : {}),
    ...('recoveredFrom' in opts ? { recoveredFrom: opts.recoveredFrom } : {}),
    ...('quotedOffer' in opts ? { quotedOffer: opts.quotedOffer } : {}),
  });
  return {
    outcome,
    funnelRows: [...funnelRows],
    // The failure-reason-only view the older tests are written against.
    funnelCalls: funnelRows.map((row) => row.failure),
    planChangeRows: [...planChangeRows],
    sessionsCreated: [...sessionsCreated],
    subscriptionsUpdated: [...subscriptionsUpdated],
    previewsRequested: [...previewsRequested],
  };
}

/**
 * Run something with console.warn / console.error captured.
 *
 * Two checkout exits cannot be funnel rows at all (no workspace to hang one
 * off), so their log line IS the trace. That makes the log an assertable part
 * of the behaviour rather than noise, and capturing it also keeps the test
 * output clean.
 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  const collect = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  console.warn = collect;
  console.error = collect;
  try {
    return { result: await fn(), logs };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
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

  // Free's ceiling became the public 150-action allowance on 2026-09-12, so
  // this reads the constant rather than a number that now moves with pricing
  // copy. In practice this cohort is never metered against it: every workspace
  // that existed before that date is exempt for good
  // (workspaces.free_action_cap_exempt). Personal's 25,000 stays a silent
  // abuse ceiling and is never quoted to a customer.
  assert.equal(grandfatheredFree.maxMonthlyToolCalls, FREE_ACTION_ALLOWANCE);
  assert.equal(grandfatheredPersonal.maxMonthlyToolCalls, 100_000);

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

// ---------------------------------------------------------------------------
// 4. Every exit the funnel can represent leaves exactly one row (D5, 2026-09-09).
//
// Before this, four terminal returns sat ABOVE the recording latch and wrote
// nothing: `unauthenticated`, `invalid_plan`, `invalid_interval` and
// `workspace_not_found`. That made "zero checkout_started rows" permanently
// ambiguous between nobody clicking and everybody being bounced, which cost a
// full day of audit work. Two of the four are now rows. The other two cannot
// be: `product_funnel_events.workspace_id` is NOT NULL and neither case has a
// workspace, so their trace is a log line, and these tests pin that too.
//
// What must NOT change is what the caller sees. Each test below asserts the
// reason, the status and the message alongside the recording, because both
// entry points (the dashboard's JSON POST and the buy button's 303 GET) key
// their behaviour off exactly those.
// ---------------------------------------------------------------------------

test('an invalid plan id is recorded as one validation failure', async () => {
  const { outcome, funnelRows, sessionsCreated } = await checkout({
    planId: 'enterprise',
    entitlement: null,
  });

  // Recorded against `unknown`: `billingTarget` cannot name a plan that is not
  // a plan, and the caller's own string must not reach a bounded column.
  assert.deepEqual(funnelRows, [{ target: 'unknown', failure: 'validation_failed' }]);
  assert.equal(sessionsCreated.length, 0, 'no Stripe session may be opened');

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'invalid_plan');
  assert.equal(outcome.status, 400);
  // The exact legacy string the dashboard has always shown. Spelled out rather
  // than rebuilt from PURCHASABLE_PLAN_IDS, so that adding a tier is a visible
  // decision here instead of a silently rewritten error message.
  assert.equal(
    outcome.message,
    'planId must be one of: "personal", "solo", "pro".',
  );
});

test('an invalid interval is recorded as one validation failure', async () => {
  const { outcome, funnelRows, sessionsCreated } = await checkout({
    planId: 'personal',
    interval: 'week',
    entitlement: null,
  });

  // `unknown` again, not `personal_week` and not `personal_month`: the plan is
  // valid but the interval is not, and filling in the missing half would file
  // the attempt under a price nobody asked for.
  assert.deepEqual(funnelRows, [{ target: 'unknown', failure: 'validation_failed' }]);
  assert.equal(sessionsCreated.length, 0);

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'invalid_interval');
  assert.equal(outcome.status, 400);
  assert.equal(outcome.message, 'interval must be "month" or "year".');
});

test('a successful checkout still records exactly one success row', async () => {
  // The regression this guards: recording the validation failures introduced a
  // second call site for the latch. If the latch ever stops being a latch, the
  // happy path is where it shows up, as two rows for one buyer.
  const { outcome, funnelRows, sessionsCreated } = await checkout({
    planId: 'personal',
    entitlement: null,
  });

  assert.equal(outcome.kind, 'checkout');
  assert.equal(sessionsCreated.length, 1);
  assert.deepEqual(funnelRows, [{ target: 'personal_month', failure: undefined }]);
});

test('an unauthenticated attempt writes no row and says so in the log', async () => {
  // NOT RECORDABLE by construction: no user means no workspace, and
  // workspace_id is NOT NULL. The log is the only trace, so it is asserted.
  const { result, logs } = await captureLogs(() =>
    checkout({ planId: 'personal', entitlement: null, signedIn: false }),
  );

  assert.deepEqual(result.funnelRows, []);
  assert.equal(result.sessionsCreated.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[checkout\] unauthenticated attempt/);
  // No user id, no email: there is no session to identify, and this log must
  // not become the one place a person is named.
  assert.doesNotMatch(logs[0], /buyer@example\.com/);

  // The 401 the POST route turns into `{ error: 'Unauthorized' }` and the GET
  // route turns into a 303 to /login, unchanged.
  assert.equal(result.outcome.kind, 'error');
  if (result.outcome.kind !== 'error') return;
  assert.equal(result.outcome.reason, 'unauthenticated');
  assert.equal(result.outcome.status, 401);
  assert.equal(result.outcome.message, 'Unauthorized');
});

test('a buyer with no workspace writes no row and says so in the log', async () => {
  // Authenticated, but owns nothing to hang a funnel row off. Inventing a
  // workspace id here would put fabricated attempts in the column every funnel
  // number is grouped by, so this one stays a log line too.
  const { result, logs } = await captureLogs(() =>
    checkout({ planId: 'personal', entitlement: null, hasWorkspace: false }),
  );

  assert.deepEqual(result.funnelRows, []);
  assert.equal(result.sessionsCreated.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[checkout\] workspace not found/);
  // The shape of the failure has to be in there: PGRST116 is "this user owns
  // no workspace", anything else is the database in trouble.
  assert.match(logs[0], /PGRST116/);
  assert.doesNotMatch(logs[0], new RegExp(USER_ID));

  assert.equal(result.outcome.kind, 'error');
  if (result.outcome.kind !== 'error') return;
  assert.equal(result.outcome.reason, 'workspace_not_found');
  assert.equal(result.outcome.status, 404);
  assert.equal(result.outcome.message, 'Workspace not found.');
});

test('validation still outranks a missing workspace', async () => {
  // The workspace read now happens BEFORE validation, so that a validation
  // failure has an id to record against. Its RESULT is still acted on after,
  // which is what keeps this case answering exactly what it always did: a bad
  // plan id from a user with no workspace is a 400, not a 404.
  const { result, logs } = await captureLogs(() =>
    checkout({ planId: 'enterprise', entitlement: null, hasWorkspace: false }),
  );

  assert.equal(result.outcome.kind, 'error');
  if (result.outcome.kind !== 'error') return;
  assert.equal(result.outcome.reason, 'invalid_plan');
  assert.equal(result.outcome.status, 400);

  // Nothing to record it against, so nothing is recorded: `recordCheckoutStarted`
  // no-ops on a null workspace id rather than writing a row that cannot exist.
  assert.deepEqual(result.funnelRows, []);
  assert.deepEqual(logs, [], 'a validation refusal is a row, not a log line');
});

// ---------------------------------------------------------------------------
// 5. The in-place plan change (added 2026-09-14).
//
// An existing subscriber who changes plan never sees a Stripe Checkout page:
// the price is swapped on the live subscription and the proration is invoiced
// on the spot. Until today this path recorded
//
//     checkout_started / failure / subscription_exists
//
// one line above the call that performs the swap, so the funnel's only trace of
// a paid upgrade said the checkout had failed. It happened to a real customer
// on 2026-09-14: workspace dbed58c7 bought Personal at 10:21, hit the
// three-inbox ceiling at 10:46 connecting a fourth mailbox, upgraded to Pro
// (`solo`), and Stripe collected the money at 10:46:33Z. Expansion revenue was
// invisible and the board's only real "checkout failure" was a sale.
//
// These tests pin BOTH halves: no checkout row of any outcome, and a
// plan-change row in the right direction at every exit.
// ---------------------------------------------------------------------------

/** A live Personal subscriber, which is what the 2026-09-14 customer was. */
const PERSONAL_SUBSCRIBER: BillingRow = {
  plan: 'personal',
  subscription_status: 'active',
  stripe_subscription_id: 'sub_test_personal',
};

test('the confirmed upgrade records an upgrade, not a failed checkout', async () => {
  const { outcome, funnelRows, planChangeRows, subscriptionsUpdated } = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    confirmChange: true,
  });

  // The swap really happened, at the Pro price, on the existing subscription.
  assert.equal(outcome.kind, 'changed');
  assert.equal(subscriptionsUpdated.length, 1);
  assert.deepEqual(subscriptionsUpdated[0].items, [
    { id: 'si_test_item', price: 'price_solo_month' },
  ]);

  // THE REGRESSION GUARD. Not "no failure row" but no checkout row at all: a
  // success row would be just as wrong, because the view reads a started
  // checkout with no completion as an abandonment on Stripe's page, and this
  // customer never saw one.
  assert.deepEqual(funnelRows, []);

  assert.deepEqual(planChangeRows, [
    { direction: 'upgrade', target: 'solo_month', outcome: 'success', failure: undefined },
  ]);
});

test('a downgrade is recorded as a downgrade, so it cannot read as a sale', async () => {
  // The reason the direction is decided in the application rather than left for
  // a report to guess: `category` names the plan the change landed ON, and
  // `solo_month` on its own looks exactly like a Pro purchase.
  const { outcome, funnelRows, planChangeRows } = await checkout({
    planId: 'personal',
    entitlement: null,
    billing: { plan: 'solo', subscription_status: 'active', stripe_subscription_id: 'sub_x' },
    currentPrice: 'price_solo_month',
    confirmChange: true,
  });

  assert.equal(outcome.kind, 'changed');
  assert.deepEqual(funnelRows, []);
  assert.deepEqual(planChangeRows, [
    { direction: 'downgrade', target: 'personal_month', outcome: 'success', failure: undefined },
  ]);
});

test('a cheaper tier bought for a year is still a downgrade', async () => {
  // Team monthly to Pro annual. The two halves point in opposite directions:
  // by tier this is a step down, by interval a step up. Tier wins, which is
  // what `planCommitmentRank` encodes by doubling the tier index so an interval
  // can never reach across a tier boundary.
  const { planChangeRows } = await checkout({
    planId: 'solo',
    interval: 'year',
    entitlement: null,
    billing: { plan: 'pro', subscription_status: 'active', stripe_subscription_id: 'sub_x' },
    currentPrice: 'price_pro_month',
    confirmChange: true,
  });

  assert.deepEqual(planChangeRows, [
    { direction: 'downgrade', target: 'solo_year', outcome: 'success', failure: undefined },
  ]);
});

test('the quote itself records nothing at all', async () => {
  // The first half of the consent gate. Asking what a change costs is not an
  // attempt to make one, and a row here would count every person who opened the
  // dialog and closed it as an upgrade in progress.
  const { outcome, funnelRows, planChangeRows, subscriptionsUpdated } = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
  });

  assert.equal(outcome.kind, 'confirmation_required');
  assert.equal(subscriptionsUpdated.length, 0, 'nothing may be swapped without a confirmation');
  assert.deepEqual(funnelRows, []);
  assert.deepEqual(planChangeRows, []);
});

test('a change Stripe holds unpaid is started, never a completed upgrade', async () => {
  // `pending_if_incomplete`: the swap is accepted but the subscription stays on
  // the price it has until the invoice is paid. Recording this as a success
  // would book expansion revenue that has not arrived.
  const { outcome, planChangeRows } = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    confirmChange: true,
    swap: 'pending',
  });

  assert.equal(outcome.kind, 'payment_required');
  assert.deepEqual(planChangeRows, [
    { direction: 'upgrade', target: 'solo_month', outcome: 'started', failure: undefined },
  ]);
});

test('a plan change that throws is recorded, where before it vanished', async () => {
  // The single `checkout_started` write used to sit INSIDE the try, below the
  // throw, so a subscriber who confirmed an amount and got a 500 left no row of
  // any stage. That is the most expensive failure on this path.
  const { result } = await captureLogs(() =>
    checkout({
      planId: 'solo',
      entitlement: null,
      billing: PERSONAL_SUBSCRIBER,
      confirmChange: true,
      swap: 'throws',
    }),
  );

  assert.equal(result.outcome.kind, 'error');
  if (result.outcome.kind !== 'error') return;
  assert.equal(result.outcome.reason, 'plan_change_failed');
  assert.deepEqual(result.funnelRows, []);
  assert.deepEqual(result.planChangeRows, [
    { direction: 'upgrade', target: 'solo_month', outcome: 'failure', failure: 'stripe_error' },
  ]);
});

test('asking for the price you already hold is no longer a checkout failure', async () => {
  // Nothing was attempted and nothing was refused, so this belongs in neither
  // bucket: the growth board captions its failure count "our bug, not a change
  // of mind", and a no-op click is neither.
  //
  // The refusal it asserts moved on the same day. This case used to answer
  // `already_on_plan`, decided from `user_billing.plan` before anything looked
  // at the interval, which also refused every monthly-to-annual switch (see
  // section 6). The no-op is now decided where it always should have been, on
  // the price the live subscription is actually on, and this request is one:
  // Personal monthly, asking for Personal monthly.
  const { outcome, funnelRows, planChangeRows } = await checkout({
    planId: 'personal',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
    confirmChange: true,
  });

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'already_on_plan_interval');
  assert.equal(outcome.status, 409);
  assert.deepEqual(funnelRows, []);
  assert.deepEqual(planChangeRows, []);
});

test('a buyer we turn away IS still a checkout failure', async () => {
  // The other side of the same line, and the reason the failure bucket is not
  // simply emptied: a comped account clicking buy is somebody who wanted to pay
  // us and could not, which is exactly what that bucket is for.
  const { funnelRows } = await checkout({
    planId: 'solo',
    entitlement: { kind: 'comped_scale', expires_at: null },
  });

  assert.deepEqual(funnelRows, [{ target: 'solo_month', failure: 'subscription_exists' }]);
});

// ---------------------------------------------------------------------------
// 6. The interval switch (2026-09-14, the second change of that day).
//
// `runCheckout` answered a 409 `already_on_plan` to any request naming the plan
// the subscriber already held, decided from `user_billing.plan` alone and taken
// BEFORE anything looked at the interval. `user_billing` records the tier, not
// the price, so that check could not tell "already paying for exactly this"
// from "paying monthly, asking for annual", and refused both. Annual is sold at
// the paywall and on the pricing page; every existing customer who clicked it
// was told they were already on the plan and nothing happened.
//
// The genuine no-op is a PRICE comparison against the live subscription, and it
// is still made (`already_on_plan_interval`, section 5). These tests pin the
// difference between the two, and pin that the consent gate did not come off
// with the refusal: an interval switch charges a card with no hosted Stripe
// page in front of it, so it must quote first, exactly like a tier change.
// ---------------------------------------------------------------------------

test('a Personal monthly subscriber asking for annual is QUOTED, not refused', async () => {
  // The whole point of the change. This was a 409 with the message "You are
  // already on the Personal plan."
  const { outcome, subscriptionsUpdated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
  });

  assert.equal(outcome.kind, 'confirmation_required');
  if (outcome.kind !== 'confirmation_required') return;
  assert.equal(outcome.planId, 'personal');
  assert.equal(outcome.interval, 'year');

  // Quoted from Stripe's own preview, so the dialog can state a real number.
  assert.equal(outcome.preview?.amountDueNowCents, 1041);
  assert.equal(outcome.preview?.creditCents, 459);
  assert.equal(outcome.preview?.recurringCents, 1500);

  // And nothing was charged on the way to the quote.
  assert.deepEqual(subscriptionsUpdated, [], 'a quote must not touch the subscription');
});

test('annual to monthly is reachable too', async () => {
  // The refusal was symmetric, so the fix has to be. A customer who took annual
  // and wants to go back must not be trapped on it.
  const { outcome } = await checkout({
    planId: 'personal',
    interval: 'month',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_year',
  });

  assert.equal(outcome.kind, 'confirmation_required');
  assert.equal(
    outcome.kind === 'confirmation_required' ? outcome.interval : null,
    'month',
  );
});

test('the confirmed interval switch swaps to the annual price', async () => {
  const { outcome, subscriptionsUpdated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
    confirmChange: true,
  });

  assert.equal(outcome.kind, 'changed');
  assert.equal(outcome.kind === 'changed' ? outcome.interval : null, 'year');

  assert.equal(subscriptionsUpdated.length, 1);
  assert.deepEqual(subscriptionsUpdated[0].items, [
    { id: 'si_test_item', price: 'price_personal_year' },
  ]);
  // Charged now, and held rather than applied if the card needs 3DS. Both are
  // what keep an unpaid switch from granting anything.
  assert.equal(subscriptionsUpdated[0].proration_behavior, 'always_invoice');
  assert.equal(subscriptionsUpdated[0].payment_behavior, 'pending_if_incomplete');
});

test('an interval move is recorded with a direction, not as a checkout', async () => {
  // The two halves of the same day meeting. `planCommitmentRank` orders tier
  // first and interval second, which is the only reason a same-tier move HAS a
  // direction at all: monthly to annual is expansion (a year committed up
  // front), annual to monthly is contraction. Neither is a checkout, so neither
  // may leave a checkout row.
  const up = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
    confirmChange: true,
  });
  assert.deepEqual(up.planChangeRows, [
    { direction: 'upgrade', target: 'personal_year', outcome: 'success', failure: undefined },
  ]);
  assert.deepEqual(up.funnelRows, []);

  const down = await checkout({
    planId: 'personal',
    interval: 'month',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_year',
    confirmChange: true,
  });
  assert.deepEqual(down.planChangeRows, [
    { direction: 'downgrade', target: 'personal_month', outcome: 'success', failure: undefined },
  ]);
  assert.deepEqual(down.funnelRows, []);
});

test('the quote prices the same swap the confirmation performs', async () => {
  // A preview taken against different parameters would quote one number and
  // charge another. The two calls must agree on item, price and proration.
  const quote = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
  });
  const confirmed = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
    confirmChange: true,
  });

  const previewed = quote.previewsRequested[0].subscription_details as {
    items: Array<{ id: string; price: string }>;
    proration_behavior: string;
  };
  assert.deepEqual(previewed.items, confirmed.subscriptionsUpdated[0].items);
  assert.equal(
    previewed.proration_behavior,
    confirmed.subscriptionsUpdated[0].proration_behavior,
  );
});

test('the consent gate still stands in front of an interval switch', async () => {
  // The refusal that came off was the only thing between a GET and a re-priced
  // subscription for this case. If `confirmChange` ever stops being required
  // here, one link unfurl or one back button re-prices a live subscription.
  for (const confirmChange of [undefined, false, 'true', 1, {}]) {
    const { outcome, subscriptionsUpdated, funnelRows, planChangeRows } = await checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: PERSONAL_SUBSCRIBER,
      currentPrice: 'price_personal_month',
      confirmChange,
    });

    assert.equal(
      outcome.kind,
      'confirmation_required',
      `confirmChange=${JSON.stringify(confirmChange)} must only quote`,
    );
    assert.deepEqual(subscriptionsUpdated, [], 'no card may be charged without a confirmation');
    // Asking the price is not an attempt, and not a change either.
    assert.deepEqual(funnelRows, []);
    assert.deepEqual(planChangeRows, []);
  }
});

test('a tier change is unaffected by the removal', async () => {
  // `solo` is sold as "Pro". This path was always reachable and must stay
  // exactly as it was, quote first and all.
  const { outcome } = await checkout({
    planId: 'solo',
    interval: 'month',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
  });

  assert.equal(outcome.kind, 'confirmation_required');
  assert.equal(outcome.kind === 'confirmation_required' ? outcome.planId : null, 'solo');
});

test('an interval switch never opens a second subscription', async () => {
  // The reason this branch exists at all: a Stripe Checkout session here would
  // leave the customer paying for two subscriptions at once.
  for (const confirmChange of [false, true]) {
    const { sessionsCreated } = await checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: PERSONAL_SUBSCRIBER,
      currentPrice: 'price_personal_month',
      confirmChange,
    });
    assert.equal(sessionsCreated.length, 0);
  }
});

test('a manually seeded plan is still not self-service', async () => {
  // Entitled with no subscription id: comped or hand-seeded. There is no
  // subscription to read an interval off, so this stays a refusal. It answers
  // `plan_not_self_service` where it used to answer `already_on_plan`, which is
  // the honest answer: the plan is not ours to re-price from a button. It is
  // also a buyer we turned away, so unlike the no-op it IS a checkout failure.
  const { outcome, subscriptionsUpdated, funnelRows } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: null },
  });

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'plan_not_self_service');
  assert.equal(outcome.status, 409);
  assert.equal(outcome.errorCode, 'subscription_not_self_service');
  assert.deepEqual(subscriptionsUpdated, []);
  assert.deepEqual(funnelRows, [
    { target: 'personal_year', failure: 'subscription_exists' },
  ]);
});

test('a comped account cannot reach the swap by asking for another interval', async () => {
  // The comped guard runs above all of this and must keep running: these users
  // hold more than any plan they could be sold.
  const { outcome, subscriptionsUpdated, sessionsCreated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: { kind: 'comped_scale', expires_at: null },
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month',
    confirmChange: true,
  });

  assert.equal(outcome.kind === 'error' ? outcome.reason : null, 'comped');
  assert.deepEqual(subscriptionsUpdated, []);
  assert.equal(sessionsCreated.length, 0);
});

test('a lapsed subscription still buys through Stripe Checkout, not the swap', async () => {
  // `canceled` is not an entitled status, so this user has no live subscription
  // to re-price and must get a hosted page. Falling into the swap here would
  // try to update a subscription that is gone.
  const { outcome, sessionsCreated, subscriptionsUpdated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: {
      plan: 'personal',
      subscription_status: 'canceled',
      stripe_subscription_id: SUBSCRIPTION_ID,
    },
  });

  assert.equal(outcome.kind, 'checkout');
  assert.equal(sessionsCreated.length, 1);
  assert.equal(
    (sessionsCreated[0].line_items as Array<{ price: string }>)[0].price,
    'price_personal_year',
  );
  assert.deepEqual(subscriptionsUpdated, []);
});

// ---------------------------------------------------------------------------
// 7. Grandfathered prices are kept (2026-09-29, Personal $5 -> $9).
//
// Every Personal subscriber before the repricing bills on the retired $5 / $48
// prices. The no-op used to be a pure price-id comparison, so one of them
// asking for "Personal monthly" (a stale tab, a ?upgrade= link, the paywall)
// did not match the new $9 id and was QUOTED a same-plan move onto the higher
// price. That is a re-price nobody asked for; it is refused as the no-op it
// is. Moving to another interval or tier still reaches the quote, at the
// current price, behind the same consent gate.
// ---------------------------------------------------------------------------

test('a $5 Personal subscriber asking for Personal monthly is not re-priced to $9', async () => {
  const { outcome, subscriptionsUpdated, previewsRequested, planChangeRows } = await checkout({
    planId: 'personal',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month_500',
    confirmChange: true,
  });

  assert.equal(outcome.kind, 'error');
  if (outcome.kind !== 'error') return;
  assert.equal(outcome.reason, 'already_on_plan_interval');
  assert.equal(outcome.status, 409);
  assert.deepEqual(subscriptionsUpdated, [], 'a grandfathered price must never be swapped');
  assert.deepEqual(previewsRequested, []);
  assert.deepEqual(planChangeRows, []);
});

test('a $48 Personal annual subscriber asking for Personal annual is not re-priced either', async () => {
  const { outcome, subscriptionsUpdated } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_year_4800',
    confirmChange: true,
  });

  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.kind === 'error' ? outcome.reason : null, 'already_on_plan_interval');
  assert.deepEqual(subscriptionsUpdated, []);
});

test('a $5 Personal subscriber can still move to annual, quoted at the current price', async () => {
  const { outcome, previewsRequested } = await checkout({
    planId: 'personal',
    interval: 'year',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month_500',
  });

  assert.equal(outcome.kind, 'confirmation_required');
  assert.equal(previewsRequested.length, 1);
  assert.match(JSON.stringify(previewsRequested[0]), /price_personal_year"/);
});

test('a $5 Personal subscriber upgrading to Pro is an upgrade, not a no-op', async () => {
  const { outcome } = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: PERSONAL_SUBSCRIBER,
    currentPrice: 'price_personal_month_500',
  });

  assert.equal(outcome.kind, 'confirmation_required');
});


// ---------------------------------------------------------------------------
// Business, billed per mailbox above ten (2026-10-19).
// ---------------------------------------------------------------------------

const ACTIVE_PRO: BillingRow = {
  plan: 'solo',
  subscription_status: 'active',
  stripe_subscription_id: SUBSCRIPTION_ID,
};

test('a first Business checkout bills the mailboxes past ten on the hosted page', async () => {
  const { outcome, sessionsCreated } = await checkout({ planId: 'pro', entitlement: null, inboxes: 15 });
  assert.equal(outcome.kind, 'checkout');
  assert.deepEqual(sessionsCreated[0].line_items, [
    { price: 'price_business_month', quantity: 1 },
    { price: 'price_addon_month', quantity: 5 },
  ]);
});

test('a first Business checkout at ten or fewer mailboxes has no add-on line', async () => {
  const { sessionsCreated } = await checkout({ planId: 'pro', interval: 'year', entitlement: null, inboxes: 10 });
  assert.deepEqual(sessionsCreated[0].line_items, [{ price: 'price_business_year', quantity: 1 }]);
});

test('a Business checkout refuses when the per-mailbox price is not configured', async () => {
  const saved = process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY;
  delete process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY;
  try {
    const { outcome, sessionsCreated, funnelCalls } = await checkout({ planId: 'pro', entitlement: null, inboxes: 3 });
    assert.equal(outcome.kind, 'error');
    assert.equal(outcome.kind === 'error' ? outcome.reason : null, 'price_not_configured');
    assert.equal(sessionsCreated.length, 0);
    assert.deepEqual(funnelCalls, ['price_not_configured']);
  } finally {
    process.env.STRIPE_PRICE_BUSINESS_MAILBOX_MONTHLY = saved;
  }
});

test('Pro to Business quotes the add-on, and the confirmation sends exactly what was quoted', async () => {
  const quote = await checkout({
    planId: 'pro',
    entitlement: null,
    billing: ACTIVE_PRO,
    currentPrice: 'price_solo_month',
    inboxes: 14,
  });
  assert.equal(quote.outcome.kind, 'confirmation_required');
  assert.equal(quote.subscriptionsUpdated.length, 0, 'the quote must change nothing');
  const expectedItems = [
    { id: 'si_test_item', price: 'price_business_month' },
    { price: 'price_addon_month', quantity: 4 },
  ];
  const details = quote.previewsRequested[0].subscription_details as { items: unknown };
  assert.deepEqual(details.items, expectedItems);
  if (quote.outcome.kind === 'confirmation_required') {
    // Base (stub 1500) plus four mailboxes at 300.
    assert.equal(quote.outcome.preview?.recurringCents, 1500 + 4 * 300);
    assert.equal(quote.outcome.preview?.extraMailboxes, 4);
  }

  const confirmed = await checkout({
    planId: 'pro',
    entitlement: null,
    billing: ACTIVE_PRO,
    currentPrice: 'price_solo_month',
    inboxes: 14,
    confirmChange: true,
  });
  assert.equal(confirmed.outcome.kind, 'changed');
  assert.deepEqual(confirmed.subscriptionsUpdated[0].items, expectedItems);
});

test('Business to Pro removes the add-on and swaps the PLAN item, not the add-on', async () => {
  const confirmed = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: { plan: 'pro', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    currentPrice: 'price_business_month',
    addonQuantity: 3,
    inboxes: 13,
    confirmChange: true,
  });
  assert.equal(confirmed.outcome.kind, 'changed');
  assert.deepEqual(confirmed.subscriptionsUpdated[0].items, [
    { id: 'si_test_item', price: 'price_solo_month' },
    { id: 'si_addon', deleted: true },
  ]);
});

test('Business monthly to annual re-prices the add-on to its yearly price', async () => {
  const confirmed = await checkout({
    planId: 'pro',
    interval: 'year',
    entitlement: null,
    billing: { plan: 'pro', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    currentPrice: 'price_business_month',
    addonQuantity: 2,
    inboxes: 12,
    confirmChange: true,
  });
  assert.equal(confirmed.outcome.kind, 'changed');
  assert.deepEqual(confirmed.subscriptionsUpdated[0].items, [
    { id: 'si_test_item', price: 'price_business_year' },
    { id: 'si_addon', price: 'price_addon_year', quantity: 2 },
  ]);
});

test('a Business subscriber asking for Business at the same interval is a no-op, add-on or not', async () => {
  const { outcome, subscriptionsUpdated } = await checkout({
    planId: 'pro',
    entitlement: null,
    billing: { plan: 'pro', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    currentPrice: 'price_business_month',
    addonQuantity: 2,
    inboxes: 12,
    confirmChange: true,
  });
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.kind === 'error' ? outcome.reason : null, 'already_on_plan_interval');
  assert.equal(subscriptionsUpdated.length, 0);
});

// ---------------------------------------------------------------------------
// Adaptive Pricing: local-currency checkout, prices still in USD.
// ---------------------------------------------------------------------------

const { adaptivePricingEnabled, adaptivePricingParam } = await import('./adaptive-pricing.ts');

test('every new checkout session asks Stripe for Adaptive Pricing by default', async () => {
  const previous = process.env.STRIPE_ADAPTIVE_PRICING;
  delete process.env.STRIPE_ADAPTIVE_PRICING;
  try {
    const { outcome, sessionsCreated } = await checkout({ planId: 'personal', entitlement: null });
    assert.equal(outcome.kind, 'checkout');
    assert.equal(sessionsCreated.length, 1);
    assert.deepEqual(sessionsCreated[0].adaptive_pricing, { enabled: true });
    // Converting the amount must not change the presentation language or the
    // subscription mode; both are pinned for their own reasons.
    assert.equal(sessionsCreated[0].locale, 'en');
    assert.equal(sessionsCreated[0].mode, 'subscription');
  } finally {
    if (previous === undefined) delete process.env.STRIPE_ADAPTIVE_PRICING;
    else process.env.STRIPE_ADAPTIVE_PRICING = previous;
  }
});

test('STRIPE_ADAPTIVE_PRICING=false sends an explicit opt-out, not the dashboard default', async () => {
  const previous = process.env.STRIPE_ADAPTIVE_PRICING;
  process.env.STRIPE_ADAPTIVE_PRICING = 'false';
  try {
    const { sessionsCreated } = await checkout({ planId: 'solo', entitlement: null });
    assert.equal(sessionsCreated.length, 1);
    assert.deepEqual(sessionsCreated[0].adaptive_pricing, { enabled: false });
  } finally {
    if (previous === undefined) delete process.env.STRIPE_ADAPTIVE_PRICING;
    else process.env.STRIPE_ADAPTIVE_PRICING = previous;
  }
});

test('the Adaptive Pricing flag defaults on and only explicit off-values disable it', () => {
  assert.equal(adaptivePricingEnabled({}), true);
  assert.equal(adaptivePricingEnabled({ STRIPE_ADAPTIVE_PRICING: 'true' }), true);
  assert.equal(adaptivePricingEnabled({ STRIPE_ADAPTIVE_PRICING: '' }), true);
  assert.equal(adaptivePricingEnabled({ STRIPE_ADAPTIVE_PRICING: 'yes' }), true);
  for (const off of ['false', 'FALSE', ' off ', '0', 'no']) {
    assert.equal(adaptivePricingEnabled({ STRIPE_ADAPTIVE_PRICING: off }), false, off);
  }
  assert.deepEqual(adaptivePricingParam({}), { enabled: true });
  assert.deepEqual(adaptivePricingParam({ STRIPE_ADAPTIVE_PRICING: 'off' }), { enabled: false });
});

// ---------------------------------------------------------------------------
// Checkout language: German buyers get Stripe's German page, everyone else
// keeps the English pin.
//
// The point is the button. In subscription mode its label follows `locale`
// and nothing else, and only under 'de' does Stripe write "Zahlungspflichtig
// abonnieren", the wording §312j BGB asks for. The custom_text beside it must
// be German too, or the page reads in two languages exactly where the buyer
// commits to pay.
// ---------------------------------------------------------------------------

const { checkoutLocale } = await import('./checkout-core.ts');

type SubmitText = { submit: { message: string }; after_submit: { message: string } };

test('a German buyer gets a German hosted page with German text beside the button', async () => {
  const { outcome, sessionsCreated } = await checkout({ planId: 'personal', entitlement: null, locale: 'de' });
  assert.equal(outcome.kind, 'checkout');
  assert.equal(sessionsCreated.length, 1);
  assert.equal(sessionsCreated[0].locale, 'de');
  const text = sessionsCreated[0].custom_text as SubmitText;
  assert.match(text.submit.message, /^Mit dem Abonnieren verpflichten Sie sich, den angezeigten Preis/);
  // Formal Sie, never du.
  assert.doesNotMatch(text.submit.message, /\b(du|dich|dein)\b/i);
  // The German consumer-law pages, still as working Markdown links.
  assert.match(text.submit.message, /\[mcpemails\.com\/de\/cancel\]\(http[^)]*\/de\/cancel\)/);
  assert.match(text.submit.message, /\[Widerrufsrecht\]\(http[^)]*\/de\/withdrawal\)/);
  assert.match(text.submit.message, /14 Tagen/);
  assert.match(text.submit.message, /hello@mcpemails\.com/);
  assert.match(text.after_submit.message, /^Sie werden zu mcpemails\.com zurückgeleitet/);
  for (const message of [text.submit.message, text.after_submit.message]) {
    assert.doesNotMatch(message, /\u2014/, 'no em dashes');
    assert.doesNotMatch(message, /[<>]/);
  }
});

test('the language changes nothing about what is sold', async () => {
  const en = await checkout({ planId: 'solo', interval: 'year', entitlement: null });
  const de = await checkout({ planId: 'solo', interval: 'year', entitlement: null, locale: 'de' });
  const strip = (params: Record<string, unknown>) => {
    const { locale: _locale, custom_text: _text, metadata, ...rest } = params;
    // metadata.lang only records the language, for the reminder email.
    const { lang: _lang, ...meta } = metadata as Record<string, unknown>;
    return { ...rest, metadata: meta };
  };
  assert.deepEqual(strip(de.sessionsCreated[0]), strip(en.sessionsCreated[0]));
  assert.deepEqual(de.funnelRows, en.funnelRows);
});

test('a buyer with no language, or any other language, keeps the English page', async () => {
  for (const locale of [undefined, null, 'en', 'nb', 'fr', 'es', 'zh', '', 'DE', 'de-AT', ['de'], 42]) {
    const { sessionsCreated } = await checkout({ planId: 'personal', entitlement: null, locale });
    assert.equal(sessionsCreated[0].locale, 'en', JSON.stringify(locale));
    const text = sessionsCreated[0].custom_text as SubmitText;
    assert.match(text.submit.message, /^By subscribing you agree to pay the price shown/);
    assert.match(text.submit.message, /\(http[^)]*\/cancel\)/);
    assert.doesNotMatch(text.submit.message, /\/de\//);
    assert.equal(text.after_submit.message, 'Taking you back to mcpemails.com to connect your inboxes.');
  }
});

test('the locale allow-list maps exactly "de" to German and everything else to English', () => {
  assert.equal(checkoutLocale('de'), 'de');
  for (const value of [undefined, null, 'en', 'nb', 'DE', ' de', 'de-DE', ['de'], { de: true }, 1]) {
    assert.equal(checkoutLocale(value), 'en', JSON.stringify(value));
  }
});

test('a German subscriber asking for a plan change still only gets a quote', async () => {
  // The in-place swap creates no hosted page, so the language has nowhere to
  // go; it must not open a checkout session or skip the consent gate either.
  const { outcome, sessionsCreated, subscriptionsUpdated } = await checkout({
    planId: 'solo',
    entitlement: null,
    billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    locale: 'de',
  });
  assert.equal(outcome.kind, 'confirmation_required');
  assert.equal(sessionsCreated.length, 0);
  assert.equal(subscriptionsUpdated.length, 0);
});

// ---------------------------------------------------------------------------
// 9. Black Week 2026 first-year offer
//
// New annual checkouts get the coupon server side (no promotion-code field,
// since Stripe refuses both together) and the cohort tag; a monthly Personal
// or Pro subscriber switching to annual gets the coupon on the swap, quoted
// first; anyone who already redeemed it, existing annual subscribers and
// Business get nothing.
// ---------------------------------------------------------------------------

/** The fields the offer tests read off a session or update call. */
type OfferParams = {
  discounts?: unknown;
  allow_promotion_codes?: unknown;
  metadata: Record<string, string | undefined>;
  subscription_data: { metadata: Record<string, string | undefined> };
  payment_behavior?: unknown;
  proration_behavior?: unknown;
};

const PERSONAL_OFFER = {
  offerId: 'bw2026',
  planId: 'personal',
  interval: 'year',
  couponId: 'BW2026_PERSONAL_Y1',
  normalYearlyCents: 8640,
  firstYearCents: 5900,
  savingCents: 2740,
  endsAt: '2026-12-01T22:59:59.000Z',
};
const PRO_OFFER = {
  ...PERSONAL_OFFER,
  planId: 'solo',
  couponId: 'BW2026_PRO_Y1',
  normalYearlyCents: 14400,
  firstYearCents: 9900,
  savingCents: 4500,
};

async function withOffers<T>(
  setup: {
    offers?: Record<string, unknown>;
    customerSubs?: Array<{ metadata: Record<string, string> }>;
    listThrows?: boolean;
    metadata?: Record<string, string>;
    discounts?: string[];
  },
  fn: () => Promise<T>,
): Promise<T> {
  activeOffers = setup.offers ?? { personal: PERSONAL_OFFER, solo: PRO_OFFER };
  customerSubscriptions = setup.customerSubs ?? [];
  listThrows = setup.listThrows ?? false;
  currentMetadata = setup.metadata ?? {};
  currentDiscounts = setup.discounts ?? [];
  try {
    return await fn();
  } finally {
    activeOffers = {};
    customerSubscriptions = [];
    listThrows = false;
    currentMetadata = {};
    currentDiscounts = [];
  }
}

const MONTHLY_PERSONAL: BillingRow = {
  plan: 'personal',
  subscription_status: 'active',
  stripe_subscription_id: SUBSCRIPTION_ID,
};

test('offer: a new annual Personal checkout carries the coupon and the cohort tag', async () => {
  const run = await withOffers({}, () =>
    checkout({ planId: 'personal', interval: 'year', entitlement: null }),
  );
  assert.equal(run.outcome.kind, 'checkout');
  const params = run.sessionsCreated[0] as OfferParams;
  assert.deepEqual(params.discounts, [{ coupon: 'BW2026_PERSONAL_Y1' }]);
  assert.equal('allow_promotion_codes' in params, false);
  assert.equal(params.metadata.offer, 'bw2026');
  assert.equal(params.subscription_data.metadata.offer, 'bw2026');
  assert.equal(params.subscription_data.metadata.user_id, USER_ID);
});

test('offer: a new annual Pro checkout uses the Pro coupon', async () => {
  const run = await withOffers({}, () =>
    checkout({ planId: 'solo', interval: 'year', entitlement: null }),
  );
  const params = run.sessionsCreated[0] as OfferParams;
  assert.deepEqual(params.discounts, [{ coupon: 'BW2026_PRO_Y1' }]);
});

test('offer: monthly and Business checkouts are untouched', async () => {
  for (const [planId, interval] of [
    ['personal', 'month'],
    ['solo', 'month'],
    ['pro', 'year'],
  ]) {
    const run = await withOffers({}, () => checkout({ planId, interval, entitlement: null }));
    const params = run.sessionsCreated[0] as OfferParams;
    assert.equal(params.discounts, undefined, `${planId}/${interval}`);
    assert.equal(params.allow_promotion_codes, true);
    assert.equal(params.metadata.offer, undefined);
    assert.equal(params.subscription_data.metadata.offer, undefined);
  }
});

test('offer: no live offer (window closed or coupon killed) keeps the old session exactly', async () => {
  const run = await withOffers({ offers: {} }, () =>
    checkout({ planId: 'personal', interval: 'year', entitlement: null }),
  );
  const params = run.sessionsCreated[0] as OfferParams;
  assert.equal(params.discounts, undefined);
  assert.equal(params.allow_promotion_codes, true);
});

test('offer: one redemption per customer', async () => {
  const run = await withOffers({ customerSubs: [{ metadata: { offer: 'bw2026' } }] }, () =>
    checkout({ planId: 'personal', interval: 'year', entitlement: null }),
  );
  const params = run.sessionsCreated[0] as OfferParams;
  assert.equal(params.discounts, undefined);
  assert.equal(params.allow_promotion_codes, true);
  assert.equal(params.metadata.offer, undefined);
});

test('offer: a failed redemption check fails closed (normal price, never a surprise)', async () => {
  const { result: run } = await captureLogs(() =>
    withOffers({ listThrows: true }, () =>
      checkout({ planId: 'personal', interval: 'year', entitlement: null }),
    ),
  );
  assert.equal(run.outcome.kind, 'checkout');
  const params = run.sessionsCreated[0] as OfferParams;
  assert.equal(params.discounts, undefined);
});

test('offer: a monthly Personal subscriber switching to annual is quoted WITH the coupon', async () => {
  const run = await withOffers({ discounts: ['di_existing'] }, () =>
    checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
    }),
  );
  assert.equal(run.outcome.kind, 'confirmation_required');
  assert.equal(run.subscriptionsUpdated.length, 0, 'the quote changes nothing');
  assert.ok(run.outcome.kind === 'confirmation_required');
  const preview = run.outcome.preview!;
  assert.equal(preview.seasonalOffer?.couponId, 'BW2026_PERSONAL_Y1');
  assert.equal(preview.discountCents, 2740);
  assert.equal(preview.amountDueNowCents, 5441);
  assert.deepEqual(run.previewsRequested[0].discounts, [
    { discount: 'di_existing' },
    { coupon: 'BW2026_PERSONAL_Y1' },
  ]);
});

test('offer: the confirmed switch applies the coupon and tags the subscription', async () => {
  const run = await withOffers({}, () =>
    checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
    }),
  );
  assert.equal(run.outcome.kind, 'changed');
  const update = run.subscriptionsUpdated[0] as OfferParams;
  assert.deepEqual(update.discounts, [{ coupon: 'BW2026_PERSONAL_Y1' }]);
  assert.deepEqual(update.metadata, { offer: 'bw2026' });
  assert.equal(update.payment_behavior, 'pending_if_incomplete');
  assert.equal(update.proration_behavior, 'always_invoice');
});

test('offer: a quote WITH the offer confirmed after it ended charges nothing and re-quotes', async () => {
  // Quoted at 23:58 on 1 December, clicked at 00:01: the offer is gone.
  const run = await withOffers({ offers: {} }, () =>
    checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
      quotedOffer: 'bw2026',
    }),
  );
  assert.equal(run.subscriptionsUpdated.length, 0, 'no swap, no charge');
  assert.equal(run.outcome.kind, 'confirmation_required');
  assert.ok(run.outcome.kind === 'confirmation_required');
  assert.equal(run.outcome.offerEnded, true);
  assert.equal(run.outcome.preview?.seasonalOffer, null);
  assert.equal(run.outcome.preview?.discountCents, 0);
  assert.equal(run.previewsRequested[0].discounts, undefined);
  assert.equal(run.planChangeRows.length, 0, 'a re-quote is not a completed decision');
});

test('offer: a quote WITH the offer confirmed while it is live still swaps', async () => {
  const run = await withOffers({}, () =>
    checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
      quotedOffer: 'bw2026',
    }),
  );
  assert.equal(run.outcome.kind, 'changed');
  assert.deepEqual((run.subscriptionsUpdated[0] as OfferParams).discounts, [
    { coupon: 'BW2026_PERSONAL_Y1' },
  ]);
});

test('offer: a confirm without a quoted offer is unaffected when no offer is live', async () => {
  const run = await withOffers({ offers: {} }, () =>
    checkout({
      planId: 'personal',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
    }),
  );
  assert.equal(run.outcome.kind, 'changed');
  assert.equal((run.subscriptionsUpdated[0] as OfferParams).discounts, undefined);
});

test('offer: monthly Personal to annual Pro gets the Pro coupon', async () => {
  const run = await withOffers({}, () =>
    checkout({
      planId: 'solo',
      interval: 'year',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
    }),
  );
  const update = run.subscriptionsUpdated[0] as OfferParams;
  assert.deepEqual(update.discounts, [{ coupon: 'BW2026_PRO_Y1' }]);
});

test('offer: no coupon for annual subscribers, retired prices, Business, or a repeat', async () => {
  const cases: Array<{ label: string; planId: string; currentPrice: string; plan: string; setup?: object }> = [
    { label: 'annual Personal to annual Pro', planId: 'solo', currentPrice: 'price_personal_year', plan: 'personal' },
    { label: 'retired $5 Personal', planId: 'personal', currentPrice: 'price_personal_month_500', plan: 'personal' },
    { label: 'Business monthly to Pro annual', planId: 'solo', currentPrice: 'price_business_month', plan: 'pro' },
    {
      label: 'already tagged subscription',
      planId: 'personal',
      currentPrice: 'price_personal_month',
      plan: 'personal',
      setup: { metadata: { offer: 'bw2026' } },
    },
    {
      label: 'redeemed on an earlier subscription',
      planId: 'personal',
      currentPrice: 'price_personal_month',
      plan: 'personal',
      setup: { customerSubs: [{ metadata: { offer: 'bw2026' } }] },
    },
  ];
  for (const c of cases) {
    const run = await withOffers(c.setup ?? {}, () =>
      checkout({
        planId: c.planId,
        interval: 'year',
        entitlement: null,
        billing: { plan: c.plan, subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
        currentPrice: c.currentPrice,
        confirmChange: true,
      }),
    );
    const update = run.subscriptionsUpdated[0] as OfferParams | undefined;
    assert.ok(update, c.label);
    assert.equal(update.discounts, undefined, c.label);
    assert.equal(update.metadata, undefined, c.label);
  }
});

test('offer: a switch to MONTHLY never carries the coupon', async () => {
  const run = await withOffers({}, () =>
    checkout({
      planId: 'solo',
      interval: 'month',
      entitlement: null,
      billing: MONTHLY_PERSONAL,
      currentPrice: 'price_personal_month',
      confirmChange: true,
    }),
  );
  const update = run.subscriptionsUpdated[0] as OfferParams;
  assert.equal(update.discounts, undefined);
});

// ---------------------------------------------------------------------------
// Abandoned-checkout reminder metadata: the buyer's language and the expired
// session a reminder linked from. Neither changes what is sold.
// ---------------------------------------------------------------------------

test('metadata records the app language for the reminder, English adds nothing', async () => {
  for (const [locale, expected] of [['fr', 'fr'], ['nb', 'nb'], ['de', 'de'], ['es', 'es'], ['en', undefined], ['zh', undefined], ['xx', undefined], [undefined, undefined]] as const) {
    const { sessionsCreated } = await checkout({ planId: 'personal', entitlement: null, locale });
    const meta = sessionsCreated[0].metadata as Record<string, unknown>;
    assert.equal(meta.lang, expected, String(locale));
  }
});

test('a valid recovered_from lands in metadata, anything else is dropped', async () => {
  const ok = await checkout({ planId: 'solo', interval: 'year', entitlement: null, recoveredFrom: 'cs_live_a1B2c3D4e5F6g7H8' });
  assert.equal((ok.sessionsCreated[0].metadata as Record<string, unknown>).recovered_from, 'cs_live_a1B2c3D4e5F6g7H8');
  for (const bad of ['', 'cs_live_<x>', 'pi_123', 42, ['cs_live_a1B2c3D4e5F6g7H8']]) {
    const { sessionsCreated } = await checkout({ planId: 'solo', entitlement: null, recoveredFrom: bad });
    assert.equal('recovered_from' in (sessionsCreated[0].metadata as Record<string, unknown>), false, JSON.stringify(bad));
  }
  const plain = await checkout({ planId: 'solo', interval: 'year', entitlement: null });
  const strip = (params: Record<string, unknown>) => {
    const { metadata, ...rest } = params;
    const { recovered_from: _r, ...meta } = metadata as Record<string, unknown>;
    return { ...rest, metadata: meta };
  };
  assert.deepEqual(strip(ok.sessionsCreated[0]), strip(plain.sessionsCreated[0]));
});

// ---------------------------------------------------------------------------
// 7. The identity entry point: the chat checkout link (app/u/[token]).
//
// `runCheckoutForIdentity` is the third caller of the one core. It has no
// cookie session, so the owner arrives as an identity resolved with the
// service-role client from a checkout_links row. Two things are pinned here:
// it runs every guard the cookie path runs (it is the same function past the
// identity), and it can NEVER reach the in-place price swap, not even its
// quote, because a bearer link in a chat transcript must not be able to touch
// a card on file.
// ---------------------------------------------------------------------------

const LINK_ID = '11111111-2222-4333-8444-555555555555';

async function linkCheckout(opts: {
  entitlement: EntitlementRow;
  billing?: BillingRow;
  planId?: unknown;
  interval?: unknown;
  extraMetadata?: Record<string, string>;
  /** Smuggled past the type, to prove the core ignores it. */
  confirmChange?: unknown;
}) {
  currentSupabase = fakeSupabase({ entitlement: opts.entitlement, billing: opts.billing });
  funnelRows.length = 0;
  funnelEntryPoints.length = 0;
  planChangeRows.length = 0;
  sessionsCreated.length = 0;
  subscriptionsUpdated.length = 0;
  subscriptionsRetrieved.length = 0;
  previewsRequested.length = 0;
  swapBehaviour = 'applied';
  currentSubscriptionPrice = 'price_solo_month';
  currentAddon = null;
  ownedInboxes = 0;
  const input = {
    planId: opts.planId ?? 'personal',
    interval: opts.interval ?? 'month',
    locale: 'en',
    ...('confirmChange' in opts ? { confirmChange: opts.confirmChange } : {}),
  };
  const outcome = await runCheckoutForIdentity(
    { userId: USER_ID, email: 'owner@example.com', workspaceId: WORKSPACE_ID, displayName: 'Test Workspace' },
    input,
    {
      successUrl: 'https://mcpemails.test/upgrade/done?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://mcpemails.test/pricing?from=chat_link',
      entryPoint: 'chat_link',
      extraMetadata: opts.extraMetadata ?? { checkout_link_id: LINK_ID },
      sessionExpiresAt: 1_900_000_000,
    },
  );
  return {
    outcome,
    funnelRows: [...funnelRows],
    funnelEntryPoints: [...funnelEntryPoints],
    planChangeRows: [...planChangeRows],
    sessionsCreated: [...sessionsCreated],
    subscriptionsUpdated: [...subscriptionsUpdated],
    subscriptionsRetrieved: [...subscriptionsRetrieved],
    previewsRequested: [...previewsRequested],
  };
}

test('a link checkout for a Free owner opens Stripe with the link URLs, expiry and metadata', async () => {
  const r = await linkCheckout({ entitlement: null });
  assert.equal(r.outcome.kind, 'checkout');
  if (r.outcome.kind !== 'checkout') return;
  assert.equal(r.outcome.url, SESSION_URL);
  assert.equal(r.outcome.sessionId, 'cs_test_core_session');
  assert.equal(r.sessionsCreated.length, 1);
  const params = r.sessionsCreated[0];
  assert.equal(params.success_url, 'https://mcpemails.test/upgrade/done?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'https://mcpemails.test/pricing?from=chat_link');
  assert.equal(params.expires_at, 1_900_000_000);
  assert.equal(params.customer, 'cus_test_grandfathered');
  assert.deepEqual(params.line_items, [{ price: 'price_personal_month', quantity: 1 }]);
  assert.deepEqual(params.metadata, {
    checkout_link_id: LINK_ID,
    user_id: USER_ID,
    plan_id: 'personal',
    interval: 'month',
  });
  assert.deepEqual(params.subscription_data, { metadata: { user_id: USER_ID } });
});

test('a link checkout records exactly one checkout_started row, tagged chat_link', async () => {
  const r = await linkCheckout({ entitlement: null });
  assert.deepEqual(r.funnelRows, [{ target: 'personal_month', failure: undefined }]);
  assert.deepEqual(r.funnelEntryPoints, ['chat_link']);
});

test('the cookie path is unchanged: dashboard URLs, Stripe default expiry, no link metadata or entry point', async () => {
  const { sessionsCreated, funnelRows: rows } = await checkout({ planId: 'personal', entitlement: null });
  const params = sessionsCreated[0];
  assert.equal(params.success_url, 'http://localhost:3000/dashboard?checkout=success&plan=personal&interval=month');
  assert.equal(params.cancel_url, 'http://localhost:3000/dashboard?checkout=cancelled');
  assert.equal('expires_at' in params, false);
  assert.deepEqual(params.metadata, { user_id: USER_ID, plan_id: 'personal', interval: 'month' });
  assert.equal(rows.length, 1);
  assert.deepEqual(funnelEntryPoints, [undefined]);
});

test('extra metadata can never replace the keys the webhook trusts', async () => {
  const r = await linkCheckout({
    entitlement: null,
    extraMetadata: { checkout_link_id: LINK_ID, user_id: 'attacker', plan_id: 'pro', interval: 'year' },
  });
  const meta = r.sessionsCreated[0].metadata as Record<string, unknown>;
  assert.equal(meta.user_id, USER_ID);
  assert.equal(meta.plan_id, 'personal');
  assert.equal(meta.interval, 'month');
});

test('an existing subscriber is refused before the swap: no read, no quote, no change', async () => {
  const r = await linkCheckout({
    entitlement: null,
    billing: { plan: 'solo', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
  });
  assert.equal(r.outcome.kind, 'error');
  if (r.outcome.kind !== 'error') return;
  assert.equal(r.outcome.reason, 'subscription_exists');
  assert.equal(r.outcome.status, 409);
  assert.deepEqual(r.subscriptionsRetrieved, []);
  assert.deepEqual(r.previewsRequested, []);
  assert.deepEqual(r.subscriptionsUpdated, []);
  assert.deepEqual(r.sessionsCreated, []);
  assert.deepEqual(r.planChangeRows, []);
  assert.deepEqual(r.funnelRows, [{ target: 'personal_month', failure: 'subscription_exists' }]);
});

test('a smuggled confirmChange: true still cannot reach the swap from a link', async () => {
  const r = await linkCheckout({
    entitlement: null,
    billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    confirmChange: true,
  });
  assert.equal(r.outcome.kind, 'error');
  assert.deepEqual(r.subscriptionsUpdated, []);
  assert.deepEqual(r.subscriptionsRetrieved, []);
});

test('the same subscriber on the cookie path still gets the quote, so the refusal is link-only', async () => {
  const { outcome } = await checkout({
    planId: 'personal',
    entitlement: null,
    billing: { plan: 'solo', subscription_status: 'active', stripe_subscription_id: SUBSCRIPTION_ID },
    currentPrice: 'price_solo_month',
  });
  assert.equal(outcome.kind, 'confirmation_required');
});

test('the comped guard refuses a link checkout too', async () => {
  const r = await linkCheckout({ entitlement: { kind: 'comped_scale', expires_at: null } });
  assert.equal(r.outcome.kind, 'error');
  if (r.outcome.kind !== 'error') return;
  assert.equal(r.outcome.reason, 'comped');
  assert.deepEqual(r.sessionsCreated, []);
});

test('a lapsed subscription buys through Checkout from a link, like on the cookie path', async () => {
  const r = await linkCheckout({
    entitlement: null,
    billing: { plan: 'personal', subscription_status: 'canceled', stripe_subscription_id: SUBSCRIPTION_ID },
  });
  assert.equal(r.outcome.kind, 'checkout');
  assert.deepEqual(r.subscriptionsUpdated, []);
});

test('the purchasable allowlist still applies to a link', async () => {
  const bad = await linkCheckout({ entitlement: null, planId: 'enterprise' });
  assert.equal(bad.outcome.kind, 'error');
  if (bad.outcome.kind === 'error') assert.equal(bad.outcome.reason, 'invalid_plan');
  const badInterval = await linkCheckout({ entitlement: null, interval: 'week' });
  assert.equal(badInterval.outcome.kind, 'error');
  if (badInterval.outcome.kind === 'error') assert.equal(badInterval.outcome.reason, 'invalid_interval');
  assert.deepEqual(badInterval.sessionsCreated, []);
});
