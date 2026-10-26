// ---------------------------------------------------------------------------
// The 3-month Personal pass, end to end through the Stripe webhook and the
// expiry route.
//
// What is pinned here, all against stored state rather than call counts:
//   - a paid pass Checkout records one pass and projects Personal onto every
//     owned workspace, writes `pass_checkout_completed` and never
//     `checkout_completed`, and leaves user_billing.plan alone;
//   - a replay (same event id, or a second event for the same session) adds
//     nothing; an unpaid session grants nothing;
//   - an old subscription deleted during a pass cannot take the pass away;
//   - a full refund ends the pass at once, a partial one changes nothing, and a
//     refund of a subscription charge is not a pass at all;
//   - expiry, with and without a subscription, and a stacked pass taking over;
//   - the code shipped before its migration: purchases retry, everything else
//     behaves as if nobody holds a pass.
//
// Same harness as route.plan-limit-pause.test.ts: only I/O is stubbed, and the
// Supabase stand-in keeps state (src/lib/billing/fake-supabase.ts).
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.personal-pass.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

// Before anything under test is imported: plans.ts reads price ids at load.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_personal_pass_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';
process.env.DISPATCH_SECRET = 'dispatch_secret_personal_pass_unit';
// The kill switch is OFF on purpose: a payment that reached us is honoured,
// and a pass already sold expires, whatever the switch says.
process.env.PERSONAL_PASS_ENABLED = 'off';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();

/** `stripe_webhook_events` with its one property: a repeated event id is a 23505. */
function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = {
    data: null,
    error: null,
  };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'not', 'gt', 'limit', 'delete']) {
    builder[name] = () => builder;
  }
  builder.insert = (row: { event_id: string }) => {
    if (ledger.has(row.event_id)) {
      outcome = { data: null, error: { code: '23505', message: 'duplicate key' } };
    } else {
      ledger.add(row.event_id);
      outcome = { data: { event_id: row.event_id }, error: null };
    }
    return builder;
  };
  builder.maybeSingle = async () => outcome;
  builder.then = (resolve: (value: unknown) => unknown) => resolve(outcome);
  return builder;
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => (table === 'stripe_webhook_events' ? ledgerTable() : db.from(table)),
    }),
  },
});

/**
 * The Stripe reads and writes the pass paths make. Charges and subscriptions
 * not set up by a test are "No such ..." errors, as before these stubs.
 */
const stripeState: {
  charges: Map<string, Record<string, unknown>>;
  subscriptions: Map<string, Record<string, unknown>>;
  updates: Array<{ id: string; params: Record<string, unknown> }>;
  failUpdate: boolean;
} = { charges: new Map(), subscriptions: new Map(), updates: [], failUpdate: false };

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
      paymentIntents: {
        retrieve: async (id: string) => {
          const charge = stripeState.charges.get(id);
          if (!charge) throw new Error(`No such payment_intent: ${id}`);
          return { id, latest_charge: charge };
        },
      },
      subscriptions: {
        retrieve: async (id: string) => {
          const sub = stripeState.subscriptions.get(id);
          if (!sub) throw new Error(`No such subscription: ${id}`);
          return sub;
        },
        update: async (id: string, params: Record<string, unknown>) => {
          if (stripeState.failUpdate) throw new Error('Stripe is down');
          stripeState.updates.push({ id, params });
          const sub = stripeState.subscriptions.get(id) ?? {};
          return { ...sub, id };
        },
      },
    },
  },
});

nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
    after: () => undefined,
  },
});

const { POST } = await import('./route.ts');
const expiry = await import('../../internal/pass-expiry/route.ts');
const { passEndsAt } = await import('@/lib/billing/pass');

const BUYER = '00000000-0000-4000-8000-00000000b0b0';
const SOMEONE_ELSE = '00000000-0000-4000-8000-00000000e15e';
const CUSTOMER = 'cus_personal_pass';
const DAY = 24 * 60 * 60 * 1000;

function seed(options: { billing?: Record<string, unknown> } = {}) {
  db = new FakeSupabase();
  ledger = new Set();
  stripeState.charges = new Map();
  stripeState.subscriptions = new Map();
  stripeState.updates = [];
  stripeState.failUpdate = false;
  db.seed('workspaces', [
    { id: 'ws-buyer-1', owner_id: BUYER, plan: 'free', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'ws-buyer-2', owner_id: BUYER, plan: 'free', deleted_at: null, created_at: '2026-02-01T00:00:00Z' },
    { id: 'ws-stranger', owner_id: SOMEONE_ELSE, plan: 'free', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
  ]);
  if (options.billing) {
    db.seed('user_billing', [{ user_id: BUYER, stripe_customer_id: CUSTOMER, ...options.billing }]);
  }
}

function plans(ownerId = BUYER) {
  return db.table('workspaces').filter((w) => w.owner_id === ownerId).map((w) => w.plan);
}

function passes() {
  return db.table('user_passes').filter((p) => p.user_id === BUYER);
}

function stages() {
  return db.table('product_funnel_events').map((row) => `${row.stage}:${row.outcome}:${row.category}`);
}

function seedPass(id: string, startOffsetDays: number, endOffsetDays: number, status: string) {
  const now = Date.now();
  db.seed('user_passes', [
    {
      id,
      user_id: BUYER,
      product: 'personal_pass_3m',
      plan: 'personal',
      stripe_checkout_session_id: `cs_${id}`,
      stripe_payment_intent_id: `pi_${id}`,
      amount_minor: 2900,
      currency: 'usd',
      starts_at: new Date(now + startOffsetDays * DAY).toISOString(),
      ends_at: new Date(now + endOffsetDays * DAY).toISOString(),
      status,
      reminder_queued_at: null,
      expired_at: null,
      refunded_at: null,
    },
  ]);
}

let eventSeq = 0;

async function deliver(type: string, object: Record<string, unknown>, id?: string) {
  eventSeq += 1;
  const event = {
    id: id ?? `evt_personal_pass_${eventSeq}`,
    type,
    created: 1_790_000_000 + eventSeq,
    data: { object },
  };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return { id: event.id, status: response.status, body: await response.json() };
}

function passSession(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    customer: CUSTOMER,
    client_reference_id: BUYER,
    payment_intent: `pi_for_${sessionId}`,
    amount_total: 2900,
    currency: 'usd',
    metadata: {
      user_id: BUYER,
      workspace_id: 'ws-buyer-1',
      product: 'personal_pass_3m',
      plan_id: 'personal',
      experiment_arm: 'treatment',
      surface: 'checkout_return',
    },
    ...overrides,
  };
}

function refundCharge(paymentIntent: string, amountRefunded = 2900) {
  return {
    id: `ch_for_${paymentIntent}`,
    object: 'charge',
    customer: CUSTOMER,
    payment_intent: paymentIntent,
    amount: 2900,
    amount_refunded: amountRefunded,
    refunded: amountRefunded >= 2900,
  };
}

function subscription(status = 'active') {
  return {
    id: 'sub_old',
    customer: CUSTOMER,
    status,
    metadata: { user_id: BUYER },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: 'price_personal_900' },
          current_period_start: 1_790_000_000,
          current_period_end: 1_792_600_000,
        },
      ],
    },
  };
}

async function runExpiry(secret = process.env.DISPATCH_SECRET ?? '') {
  const response = await expiry.POST(
    new Request('https://mcpemails.test/api/internal/pass-expiry', {
      method: 'POST',
      headers: { 'x-dispatch-secret': secret },
      body: '{}',
    }),
  );
  return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

test('a paid pass records one active pass and puts every owned workspace on Personal', async () => {
  seed();
  const before = new Date();

  const result = await deliver('checkout.session.completed', passSession('cs_pass_1'));

  assert.equal(result.status, 200);
  assert.deepEqual(plans(), ['personal', 'personal']);
  assert.deepEqual(plans(SOMEONE_ELSE), ['free']);
  const [pass] = passes();
  assert.equal(passes().length, 1);
  assert.equal(pass.status, 'active');
  assert.equal(pass.stripe_checkout_session_id, 'cs_pass_1');
  assert.equal(pass.stripe_payment_intent_id, 'pi_for_cs_pass_1');
  assert.equal(pass.amount_minor, 2900);
  const startsAt = new Date(String(pass.starts_at));
  assert.ok(startsAt >= before && startsAt.getTime() - before.getTime() < 5_000);
  assert.equal(pass.ends_at, passEndsAt(startsAt).toISOString());
  assert.deepEqual(stages(), ['pass_checkout_completed:success:personal_pass_3m']);
  assert.equal(db.table('user_billing').length, 0, 'a pass writes no subscription state');
});

test('a replayed event, and a second event for the same session, record nothing more', async () => {
  seed();
  const first = await deliver('checkout.session.completed', passSession('cs_pass_1'));
  const replay = await deliver('checkout.session.completed', passSession('cs_pass_1'), first.id);
  assert.equal(replay.body.duplicate, true);
  const again = await deliver('checkout.session.completed', passSession('cs_pass_1'));
  assert.equal(again.status, 200);
  assert.equal(passes().length, 1);
  assert.deepEqual(stages(), ['pass_checkout_completed:success:personal_pass_3m']);
});

test('an unpaid session, or a payment for some other product, grants nothing', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_unpaid', { payment_status: 'unpaid' }));
  await deliver(
    'checkout.session.completed',
    passSession('cs_other', { metadata: { user_id: BUYER, product: 'something_else' } }),
  );
  assert.equal(passes().length, 0);
  assert.deepEqual(plans(), ['free', 'free']);
  assert.deepEqual(stages(), []);
});

test('a subscriber who somehow pays for a pass keeps their subscription plan', async () => {
  seed({ billing: { plan: 'solo', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'solo';
  await deliver('checkout.session.completed', passSession('cs_pass_1'));
  assert.equal(passes().length, 1, 'the money is honoured as a pass');
  assert.deepEqual(plans(), ['solo', 'solo'], 'and never downgrades a Pro subscriber');
});

test('a second pass bought during the first is stacked after it', async () => {
  seed();
  seedPass('first', -10, 80, 'active');
  await deliver('checkout.session.completed', passSession('cs_pass_2'));
  const stacked = passes().find((p) => p.stripe_checkout_session_id === 'cs_pass_2');
  const first = passes().find((p) => p.id === 'first');
  assert.ok(stacked && first);
  assert.equal(stacked.status, 'scheduled');
  assert.equal(stacked.starts_at, first.ends_at);
  assert.equal(stacked.ends_at, passEndsAt(new Date(String(first.ends_at))).toISOString());
  assert.deepEqual(plans(), ['personal', 'personal']);
});

// ---------------------------------------------------------------------------
// Subscriptions during a pass
// ---------------------------------------------------------------------------

test('an old subscription deleted during a pass cannot take the pass away', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  seedPass('running', -10, 80, 'active');

  const result = await deliver('customer.subscription.deleted', subscription('canceled'));

  assert.equal(result.status, 200);
  assert.deepEqual(plans(), ['personal', 'personal']);
  const billing = db.table('user_billing').find((row) => row.user_id === BUYER);
  assert.equal(billing?.plan, 'free', 'user_billing keeps the subscription truth');
  assert.equal(billing?.subscription_status, 'canceled');
});

test('without a pass the same deletion still goes to Free', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  seedPass('over', -100, -10, 'expired');
  seedPass('refunded', -5, 85, 'refunded');

  await deliver('customer.subscription.deleted', subscription('canceled'));
  assert.deepEqual(plans(), ['free', 'free']);
});

test('a failing pass read fails the webhook so Stripe retries, rather than projecting Free', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  seedPass('running', -10, 80, 'active');
  db.failOnce('user_passes', { message: 'connection reset' });

  const result = await deliver('customer.subscription.deleted', subscription('canceled'));
  assert.equal(result.status, 500);
  assert.deepEqual(plans(), ['personal', 'personal']);
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

test('a full refund ends the pass at once and goes back to Free', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_pass_1'));

  const result = await deliver('charge.refunded', refundCharge('pi_for_cs_pass_1'));

  assert.equal(result.status, 200);
  const [pass] = passes();
  assert.equal(pass.status, 'refunded');
  assert.ok(pass.refunded_at);
  assert.deepEqual(plans(), ['free', 'free']);
  assert.deepEqual(stages(), [
    'pass_checkout_completed:success:personal_pass_3m',
    'pass_refunded:success:personal_pass_3m',
  ]);

  // A second delivery of the refund (new event id) changes nothing.
  await deliver('charge.refunded', refundCharge('pi_for_cs_pass_1'));
  assert.equal(stages().length, 2);
});

test('a partial refund changes nothing', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_pass_1'));
  await deliver('charge.refunded', refundCharge('pi_for_cs_pass_1', 1000));
  assert.equal(passes()[0].status, 'active');
  assert.deepEqual(plans(), ['personal', 'personal']);
});

test('a refunded subscription charge is not a pass and moves nothing', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  const result = await deliver('charge.refunded', refundCharge('pi_subscription_invoice'));
  assert.equal(result.status, 200);
  assert.deepEqual(plans(), ['personal', 'personal']);
  assert.deepEqual(stages(), []);
});

test('a refund during a subscription keeps the subscription plan', async () => {
  seed({ billing: { plan: 'solo', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'solo';
  seedPass('running', -3, 87, 'active');
  await deliver('charge.refunded', refundCharge('pi_running'));
  assert.equal(passes()[0].status, 'refunded');
  assert.deepEqual(plans(), ['solo', 'solo']);
});

test('refunding the running pass starts the stacked one today, with its full three months', async () => {
  seed();
  seedPass('running', -3, 87, 'active');
  seedPass('stacked', 87, 177, 'scheduled');
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  const before = new Date();

  await deliver('charge.refunded', refundCharge('pi_running'));

  const stacked = passes().find((p) => p.id === 'stacked');
  assert.equal(stacked?.status, 'active');
  const startsAt = new Date(String(stacked?.starts_at));
  assert.ok(startsAt >= before && startsAt.getTime() - before.getTime() < 5_000);
  assert.equal(stacked?.ends_at, passEndsAt(startsAt).toISOString());
  assert.deepEqual(plans(), ['personal', 'personal']);
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test('the expiry route refuses a caller without the dispatch secret', async () => {
  seed();
  seedPass('over', -91, -1, 'active');
  const result = await runExpiry('wrong');
  assert.equal(result.status, 403);
  assert.equal(passes()[0].status, 'active');
});

test('an ended pass without a subscription expires and the workspaces go back to Free', async () => {
  seed();
  seedPass('over', -91, -1, 'active');
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';

  const result = await runExpiry();

  assert.equal(result.status, 200);
  assert.equal(result.body.expired, 1);
  assert.equal(passes()[0].status, 'expired');
  assert.ok(passes()[0].expired_at);
  assert.deepEqual(plans(), ['free', 'free']);
  assert.deepEqual(plans(SOMEONE_ELSE), ['free']);
  assert.deepEqual(stages(), ['pass_expired:success:personal_pass_3m']);

  // A second run finds nothing to do and records nothing.
  const again = await runExpiry();
  assert.equal(again.body.expired, 0);
  assert.equal(stages().length, 1);
});

test('an ended pass with a subscription expires and the subscription plan stays', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'trialing', stripe_subscription_id: 'sub_new' } });
  seedPass('over', -91, -1, 'active');
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';

  await runExpiry();

  assert.equal(passes()[0].status, 'expired');
  assert.deepEqual(plans(), ['personal', 'personal']);
});

test('when the first pass ends the stacked pass takes over without a day on Free', async () => {
  seed();
  seedPass('first', -91, -1, 'active');
  seedPass('second', -1, 89, 'scheduled');
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';

  const result = await runExpiry();

  assert.equal(result.body.expired, 1);
  assert.equal(result.body.started, 1);
  assert.equal(passes().find((p) => p.id === 'first')?.status, 'expired');
  assert.equal(passes().find((p) => p.id === 'second')?.status, 'active');
  assert.deepEqual(plans(), ['personal', 'personal']);
});

test('a failed projection leaves the pass for the next run instead of stranding it', async () => {
  seed();
  seedPass('over', -91, -1, 'active');
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  db.failOnce('user_billing', { message: 'timeout' });

  const failed = await runExpiry();
  assert.equal(failed.status, 500);
  assert.equal(passes()[0].status, 'active', 'not flipped, so the next tick finds it');

  const retried = await runExpiry();
  assert.equal(retried.status, 200);
  assert.equal(passes()[0].status, 'expired');
  assert.deepEqual(plans(), ['free', 'free']);
});

// ---------------------------------------------------------------------------
// Deployed before the migration
// ---------------------------------------------------------------------------

test('before the migration: a purchase is retried, a deletion still goes to Free, the sweep is a no-op', async () => {
  const missing = { code: 'PGRST205', message: "Could not find the table 'public.user_passes' in the schema cache" };

  seed();
  db.failOnce('user_passes', missing);
  const purchase = await deliver('checkout.session.completed', passSession('cs_pass_1'));
  assert.equal(purchase.status, 500, 'Stripe retries until the table exists');

  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_old' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  db.failOnce('user_passes', missing);
  const deletion = await deliver('customer.subscription.deleted', subscription('canceled'));
  assert.equal(deletion.status, 200);
  assert.deepEqual(plans(), ['free', 'free']);

  seed();
  db.failOnce('user_passes', missing);
  const sweep = await runExpiry();
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.tableMissing, true);
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

test('a delayed payment grants the pass when it clears, once', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_delayed', { payment_status: 'unpaid' }));
  assert.equal(passes().length, 0, 'nothing granted while unpaid');

  const cleared = await deliver('checkout.session.async_payment_succeeded', passSession('cs_delayed'));
  assert.equal(cleared.status, 200);
  assert.equal(passes().length, 1);
  assert.equal(passes()[0].status, 'active');
  assert.deepEqual(plans(), ['personal', 'personal']);

  await deliver('checkout.session.async_payment_succeeded', passSession('cs_delayed'));
  assert.equal(passes().length, 1);
  assert.deepEqual(stages(), ['pass_checkout_completed:success:personal_pass_3m']);
});

test('the pass starts when the charge was made, not when the webhook ran', async () => {
  seed();
  const chargedAt = Math.floor((Date.now() - 2 * DAY) / 1000);
  stripeState.charges.set('pi_for_cs_late', { id: 'ch_late', created: chargedAt, amount: 2900, amount_refunded: 0, refunded: false });

  await deliver('checkout.session.completed', passSession('cs_late'));

  const [pass] = passes();
  assert.equal(pass.starts_at, new Date(chargedAt * 1000).toISOString());
  assert.equal(pass.ends_at, passEndsAt(new Date(chargedAt * 1000)).toISOString());
});

test('without a charge time, the session creation time is used', async () => {
  seed();
  const created = Math.floor((Date.now() - DAY) / 1000);
  await deliver('checkout.session.completed', passSession('cs_created', { created }));
  assert.equal(passes()[0].starts_at, new Date(created * 1000).toISOString());
});

test('a payment refunded before it was recorded is stored as refunded and grants nothing', async () => {
  seed();
  stripeState.charges.set('pi_for_cs_gone', {
    id: 'ch_gone', created: Math.floor(Date.now() / 1000), amount: 2900, amount_refunded: 2900, refunded: true,
  });
  // The refund event came first and found no pass.
  await deliver('charge.refunded', refundCharge('pi_for_cs_gone'));

  const result = await deliver('checkout.session.completed', passSession('cs_gone'));

  assert.equal(result.status, 200);
  assert.equal(passes().length, 1);
  assert.equal(passes()[0].status, 'refunded');
  assert.ok(passes()[0].refunded_at);
  assert.deepEqual(plans(), ['free', 'free']);
  assert.deepEqual(stages(), []);
});

function waitingSubscription(id: string, fields: Record<string, unknown>) {
  stripeState.subscriptions.set(id, {
    ...subscription(String(fields.status ?? 'active')),
    id,
    ...fields,
  });
}

test('refunding a pass ends the free start of a Personal subscription that waited for it', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'trialing', stripe_subscription_id: 'sub_waiting' } });
  for (const ws of db.table('workspaces')) if (ws.owner_id === BUYER) ws.plan = 'personal';
  seedPass('running', -3, 87, 'active');
  const passEnd = Math.floor(Date.parse(String(passes()[0].ends_at)) / 1000);
  waitingSubscription('sub_waiting', { status: 'trialing', trial_end: passEnd, billing_cycle_anchor: passEnd });

  const result = await deliver('charge.refunded', refundCharge('pi_running'));

  assert.equal(result.status, 200);
  assert.deepEqual(stripeState.updates, [{ id: 'sub_waiting', params: { trial_end: 'now' } }]);
  assert.deepEqual(plans(), ['personal', 'personal'], 'the subscription carries on');

  // A second delivery of the refund changes nothing more.
  await deliver('charge.refunded', refundCharge('pi_running'));
  assert.equal(stripeState.updates.length, 1);
});

test('an anchored subscription is re-anchored to now, with no proration', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_anchored' } });
  seedPass('running', -60, 30, 'active');
  const passEnd = Math.floor(Date.parse(String(passes()[0].ends_at)) / 1000);
  waitingSubscription('sub_anchored', { status: 'active', trial_end: null, billing_cycle_anchor: passEnd });

  await deliver('charge.refunded', refundCharge('pi_running'));

  assert.deepEqual(stripeState.updates, [
    { id: 'sub_anchored', params: { billing_cycle_anchor: { type: 'now' }, proration_behavior: 'none' } },
  ]);
});

test('with a stacked pass still running, the first charge moves to that pass end instead', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'trialing', stripe_subscription_id: 'sub_waiting' } });
  seedPass('running', -3, 87, 'active');
  seedPass('stacked', 87, 177, 'scheduled');
  const coverEnd = Math.floor(Date.parse(String(passes().find((p) => p.id === 'stacked')?.ends_at)) / 1000);
  waitingSubscription('sub_waiting', { status: 'trialing', trial_end: coverEnd, billing_cycle_anchor: coverEnd });

  await deliver('charge.refunded', refundCharge('pi_running'));

  const stacked = passes().find((p) => p.id === 'stacked');
  assert.equal(stacked?.status, 'active', 'the stacked pass started today');
  assert.deepEqual(stripeState.updates, [
    {
      id: 'sub_waiting',
      params: { trial_end: Math.floor(Date.parse(String(stacked?.ends_at)) / 1000), proration_behavior: 'none' },
    },
  ]);
});

test('an ordinary subscription already charging, or a higher tier, is never touched by a pass refund', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'active', stripe_subscription_id: 'sub_plain' } });
  seedPass('running', -3, 87, 'active');
  waitingSubscription('sub_plain', { status: 'active', trial_end: null, billing_cycle_anchor: Math.floor(Date.now() / 1000) - 3 * 86_400 });
  await deliver('charge.refunded', refundCharge('pi_running'));
  assert.equal(stripeState.updates.length, 0);

  seed({ billing: { plan: 'solo', subscription_status: 'trialing', stripe_subscription_id: 'sub_pro' } });
  seedPass('running', -3, 87, 'active');
  await deliver('charge.refunded', refundCharge('pi_running'));
  assert.equal(stripeState.updates.length, 0);
});

test('a Stripe failure moving the first charge never fails the refund', async () => {
  seed({ billing: { plan: 'personal', subscription_status: 'trialing', stripe_subscription_id: 'sub_waiting' } });
  seedPass('running', -3, 87, 'active');
  const passEnd = Math.floor(Date.parse(String(passes()[0].ends_at)) / 1000);
  waitingSubscription('sub_waiting', { status: 'trialing', trial_end: passEnd, billing_cycle_anchor: passEnd });
  stripeState.failUpdate = true;

  const result = await deliver('charge.refunded', refundCharge('pi_running'));

  assert.equal(result.status, 200);
  assert.equal(passes()[0].status, 'refunded');
});
