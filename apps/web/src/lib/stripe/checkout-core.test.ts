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

/** The Stripe calls a successful checkout makes, so a test can prove one happened. */
const sessionsCreated: Array<Record<string, unknown>> = [];

nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    billingTarget: (planId: string, interval: string) => `${planId}_${interval}`,
    recordCheckoutStarted: async (
      workspaceId: string | null,
      target: string,
      failure?: string,
    ) => {
      // Mirrors the real helper, which no-ops on a null workspace id. Without
      // that, a test could "prove" a row was written for a user who has no
      // workspace to write it against.
      if (!workspaceId) return;
      assert.equal(workspaceId, WORKSPACE_ID, 'a row must land on the buyer\'s own workspace');
      funnelRows.push({ target, failure });
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
  signedIn?: boolean;
  hasWorkspace?: boolean;
}) {
  currentSupabase = fakeSupabase({
    entitlement: opts.entitlement,
    billing: opts.billing,
    signedIn: opts.signedIn,
    hasWorkspace: opts.hasWorkspace,
  });
  funnelRows.length = 0;
  sessionsCreated.length = 0;
  const outcome = await runCheckout({
    planId: opts.planId,
    interval: opts.interval ?? 'month',
  });
  return {
    outcome,
    funnelRows: [...funnelRows],
    // The failure-reason-only view the older tests are written against.
    funnelCalls: funnelRows.map((row) => row.failure),
    sessionsCreated: [...sessionsCreated],
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
