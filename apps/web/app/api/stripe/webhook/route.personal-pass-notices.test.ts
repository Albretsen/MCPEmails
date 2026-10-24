// ---------------------------------------------------------------------------
// The 3-month pass's two service notices and `pass_renewed`, through the
// Stripe webhook, with lifecycle queueing ON (queue_only):
//   - a purchase queues pass_ending_7d and pass_ended, once;
//   - a full refund cancels both;
//   - a stacked pass cancels the earlier pass's notices and is a renewal;
//   - a Personal subscription bought during a pass cancels the notices and is
//     a renewal (personal_month), and a holder never gets the cancellation
//     or win-back series when an old subscription is deleted.
//
// Same harness as route.personal-pass.test.ts (only I/O is stubbed, the
// Supabase stand-in keeps state).
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.personal-pass-notices.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_personal_pass_notices_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';
process.env.PERSONAL_PASS_ENABLED = 'holdout';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();

function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'gt', 'limit', 'delete']) builder[name] = () => builder;
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

const SUBSCRIPTION = {
  id: 'sub_new',
  customer: 'cus_pass_notices',
  status: 'active',
  metadata: { user_id: '00000000-0000-4000-8000-00000000b0b0' },
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: 1_790_000_000,
  currency: 'usd',
  items: {
    data: [
      {
        price: { id: 'price_personal_900', unit_amount: 900 },
        current_period_start: 1_790_000_000,
        current_period_end: 1_792_600_000,
      },
    ],
  },
};

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')) },
      subscriptions: { retrieve: async () => SUBSCRIPTION },
      customers: { retrieve: async () => ({ id: 'cus_pass_notices', email: 'buyer@example.test' }) },
    },
  },
});

nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
    after: () => undefined,
  },
});

const { POST } = await import('./route.ts');

const BUYER = '00000000-0000-4000-8000-00000000b0b0';
const CUSTOMER = 'cus_pass_notices';
const DAY = 24 * 60 * 60 * 1000;

function seed() {
  db = new FakeSupabase();
  ledger = new Set();
  db.seed('workspaces', [
    { id: 'ws-buyer-1', owner_id: BUYER, plan: 'free', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('users', [{ id: BUYER, email: 'buyer@example.test' }]);
  db.seed('user_billing', [{ user_id: BUYER, stripe_customer_id: CUSTOMER, plan: 'free', subscription_status: null }]);
}

let seq = 0;
async function deliver(type: string, object: Record<string, unknown>) {
  seq += 1;
  const event = { id: `evt_pass_notices_${seq}`, type, created: 1_790_000_000 + seq, data: { object } };
  const response = await POST(
    new Request('https://mcpemails.test/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=stub' },
      body: JSON.stringify(event),
    }) as unknown as Parameters<typeof POST>[0],
  );
  return response.status;
}

function passSession(id: string) {
  return {
    id,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    customer: CUSTOMER,
    client_reference_id: BUYER,
    payment_intent: `pi_${id}`,
    amount_total: 2900,
    currency: 'usd',
    metadata: { user_id: BUYER, workspace_id: 'ws-buyer-1', product: 'personal_pass_3m', plan_id: 'personal' },
  };
}

function sends() {
  return db.table('billing_email_sends');
}
function open(passId?: string) {
  return sends().filter((r) => r.cancelled_at == null && r.sent_at == null && (!passId || r.scope_key === passId));
}
function stage(name: string) {
  return db.table('product_funnel_events').filter((r) => r.stage === name);
}

test('a purchase queues exactly pass_ending_7d and pass_ended for that pass, keyed on it', async () => {
  seed();
  assert.equal(await deliver('checkout.session.completed', passSession('cs_n1')), 200);
  const [pass] = db.table('user_passes');
  const rows = sends();
  assert.deepEqual(rows.map((r) => r.template).sort(), ['pass_ended', 'pass_ending_7d']);
  assert.ok(rows.every((r) => r.scope_key === pass.id && r.stripe_customer_id === CUSTOMER));
  const ending = rows.find((r) => r.template === 'pass_ending_7d')!;
  assert.equal(Date.parse(pass.ends_at as string) - Date.parse(ending.send_after as string), 7 * DAY);
  const ended = rows.find((r) => r.template === 'pass_ended')!;
  assert.equal(ended.send_after, pass.ends_at);
  // A first pass is not a renewal.
  assert.equal(stage('pass_renewed').length, 0);
});

test('a full refund cancels both notices', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_n2'));
  await deliver('charge.refunded', {
    id: 'ch_n2',
    object: 'charge',
    customer: CUSTOMER,
    payment_intent: 'pi_cs_n2',
    amount: 2900,
    amount_refunded: 2900,
    refunded: true,
  });
  assert.equal(open().length, 0);
  assert.ok(sends().every((r) => r.cancel_reason === 'pass_refunded'));
});

test('a stacked pass cancels the first pass notices, queues its own two, and is a renewal', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_n3a'));
  await deliver('checkout.session.completed', passSession('cs_n3b'));
  const [first, second] = db.table('user_passes');
  assert.equal(second.status, 'scheduled');
  assert.equal(open(first.id as string).length, 0);
  assert.equal(open(second.id as string).length, 2);
  const renewed = stage('pass_renewed');
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].category, 'pass');
});

test('a Personal subscription during a pass cancels the notices and is a personal_month renewal', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_n4'));
  await deliver('checkout.session.completed', {
    id: 'cs_sub_n4',
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'no_payment_required',
    customer: CUSTOMER,
    subscription: 'sub_new',
    amount_total: 0,
    currency: 'usd',
    metadata: { user_id: BUYER, plan_id: 'personal', interval: 'month' },
  });
  assert.equal(open().length, 0);
  assert.ok(sends().every((r) => r.cancel_reason === 'subscription_started'));
  const renewed = stage('pass_renewed');
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].category, 'personal_month');
});

test('a holder never enters the cancellation or win-back series', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_n5'));
  await deliver('customer.subscription.deleted', { ...SUBSCRIPTION, id: 'sub_old', status: 'canceled' });
  const series = sends().filter((r) => ['cancel_ask', 'winback_14', 'winback_30'].includes(r.template as string));
  assert.equal(series.length, 0);
  // And the pass notices are still open.
  assert.equal(open().length, 2);
});

test('without a pass the deletion still queues the cancellation series', async () => {
  seed();
  await deliver('customer.subscription.deleted', { ...SUBSCRIPTION, id: 'sub_old', status: 'canceled' });
  const series = sends().filter((r) => r.template === 'cancel_ask');
  assert.equal(series.length, 1);
});

// ---------------------------------------------------------------------------
// Notices that become true again, and notices whose dates move
// ---------------------------------------------------------------------------

function refund(paymentIntent: string) {
  return {
    id: `ch_${paymentIntent}`,
    object: 'charge',
    customer: CUSTOMER,
    payment_intent: paymentIntent,
    amount: 2900,
    amount_refunded: 2900,
    refunded: true,
  };
}

test('refunding the stacked pass puts the running pass notices back, with its end date', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_r1a'));
  await deliver('checkout.session.completed', passSession('cs_r1b'));
  const [first] = db.table('user_passes');
  assert.equal(open(first.id as string).length, 0, 'cancelled while the stacked pass followed');

  await deliver('charge.refunded', refund('pi_cs_r1b'));

  const restored = open(first.id as string);
  assert.deepEqual(restored.map((r) => r.template).sort(), ['pass_ended', 'pass_ending_7d']);
  const ended = restored.find((r) => r.template === 'pass_ended')!;
  assert.equal(ended.send_after, first.ends_at);
  assert.equal((ended.payload as { periodEnd: string }).periodEnd, first.ends_at);
  assert.equal(ended.cancel_reason, null);
});

test('refunding the running pass moves the stacked pass notices to its new dates', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_r2a'));
  await deliver('checkout.session.completed', passSession('cs_r2b'));

  await deliver('charge.refunded', refund('pi_cs_r2a'));

  const [first, second] = db.table('user_passes');
  assert.equal(first.status, 'refunded');
  assert.equal(second.status, 'active');
  const rows = open(second.id as string);
  assert.equal(rows.length, 2);
  const ending = rows.find((r) => r.template === 'pass_ending_7d')!;
  const ended = rows.find((r) => r.template === 'pass_ended')!;
  assert.equal(ended.send_after, second.ends_at);
  assert.equal((ended.payload as { periodEnd: string }).periodEnd, second.ends_at);
  assert.equal(Date.parse(second.ends_at as string) - Date.parse(ending.send_after as string), 7 * DAY);
  assert.equal((ending.payload as { periodEnd: string }).periodEnd, second.ends_at);
  // The refunded pass's own rows stay cancelled.
  assert.equal(open(first.id as string).length, 0);
});

test('a subscription that ends while the pass runs puts the pass notices back', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_r3'));
  await deliver('checkout.session.completed', {
    id: 'cs_sub_r3',
    object: 'checkout.session',
    mode: 'subscription',
    payment_status: 'no_payment_required',
    customer: CUSTOMER,
    subscription: 'sub_new',
    amount_total: 0,
    currency: 'usd',
    metadata: { user_id: BUYER, plan_id: 'personal', interval: 'month' },
  });
  assert.equal(open().length, 0, 'cancelled when the subscription started');

  await deliver('customer.subscription.deleted', { ...SUBSCRIPTION, status: 'canceled' });

  const [pass] = db.table('user_passes');
  const rows = open(pass.id as string);
  assert.deepEqual(rows.map((r) => r.template).sort(), ['pass_ended', 'pass_ending_7d']);
  assert.ok(rows.every((r) => r.cancel_reason == null));
});

test('a refund cancellation is never undone', async () => {
  seed();
  await deliver('checkout.session.completed', passSession('cs_r4'));
  await deliver('charge.refunded', refund('pi_cs_r4'));
  await deliver('customer.subscription.deleted', { ...SUBSCRIPTION, id: 'sub_old', status: 'canceled' });
  const passRows = sends().filter((r) => String(r.template).startsWith('pass_'));
  assert.equal(passRows.length, 2);
  assert.ok(passRows.every((r) => r.cancelled_at != null && r.cancel_reason === 'pass_refunded'));
});
