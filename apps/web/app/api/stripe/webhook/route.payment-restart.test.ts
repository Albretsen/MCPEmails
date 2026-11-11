// ---------------------------------------------------------------------------
// customer.subscription.deleted after a card failure, end to end through POST:
//
//   - PAYMENT_RESTART_EMAIL_ENABLED=on, reason payment_failed, a successful
//     call in the last 7 days: one payment_failed_restart row, due now, with
//     the plan, interval and whether the old price is kept; the unsent final
//     dunning notice is cancelled and no cancel_ask is queued (win-backs are);
//   - the flag off, dry_run, another reason, or no recent use: no restart row,
//     and the old behaviour (cancel_ask, dunning_14 brought forward saying the
//     subscription closed).
//
// Only the I/O is stubbed, as in route.recovered-by.test.ts.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.payment-restart.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_payment_restart_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY = 'price_personal_500';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();

function ledgerTable() {
  let outcome: { data: unknown; error: { code?: string; message: string } | null } = { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'neq', 'not', 'gt', 'limit', 'delete', 'update', 'eq']) {
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

const OWNER = '00000000-0000-4000-8000-000000000c01';
const CUSTOMER = 'cus_payment_restart';
const SUB = 'sub_payment_restart';
const NOW_S = Math.floor(Date.now() / 1000);

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => (table === 'stripe_webhook_events' ? ledgerTable() : db.from(table)),
      auth: {
        admin: {
          getUserById: async (id: string) => ({ data: { user: { id, app_metadata: {} } }, error: null }),
        },
      },
    }),
  },
});

let currentSubscription: Record<string, unknown> = {};

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')) },
      invoices: { retrieve: async (id: string) => ({ id, status: 'open' }) },
      subscriptions: { retrieve: async () => currentSubscription },
      prices: {
        retrieve: async (id: string) => ({
          id,
          active: true,
          currency: 'usd',
          unit_amount: id === 'price_personal_500' ? 500 : 900,
        }),
      },
      customers: { retrieve: async (id: string) => ({ id, email: 'owner@payment-restart.invalid' }) },
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

function seed(options: { recentCall?: boolean } = {}) {
  db = new FakeSupabase();
  ledger = new Set();
  db.seed('user_billing', [
    { user_id: OWNER, stripe_customer_id: CUSTOMER, plan: 'personal', subscription_status: 'past_due', last_decline_code: 'insufficient_funds' },
  ]);
  db.seed('workspaces', [
    { id: 'ws-pr', owner_id: OWNER, plan: 'personal', deleted_at: null, payment_issue_since: null, payment_issue_kind: null },
  ]);
  db.seed('activity_log', [
    {
      id: 1,
      workspace_id: 'ws-pr',
      status: 'success',
      created_at: new Date(Date.now() - (options.recentCall === false ? 9 : 1) * 86_400_000).toISOString(),
    },
  ]);
  // A dunning sequence in flight, its final notice not yet sent.
  for (const template of ['dunning_1', 'dunning_3', 'dunning_7']) {
    db.table('billing_email_sends').push({
      id: db.table('billing_email_sends').length + 1,
      stripe_customer_id: CUSTOMER,
      user_id: OWNER,
      recipient: 'owner@payment-restart.invalid',
      template,
      scope_key: 'in_pr',
      send_after: new Date(Date.now() - 86_400_000).toISOString(),
      sent_at: new Date(Date.now() - 86_400_000).toISOString(),
      cancelled_at: null,
      payload: { planId: 'personal' },
    });
  }
  db.table('billing_email_sends').push({
    id: 4,
    stripe_customer_id: CUSTOMER,
    user_id: OWNER,
    recipient: 'owner@payment-restart.invalid',
    template: 'dunning_14',
    scope_key: 'in_pr',
    send_after: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    sent_at: null,
    cancelled_at: null,
    payload: { planId: 'personal' },
  });
}

function deletedSubscription(reason: string | null, priceId = 'price_personal_500') {
  currentSubscription = {
    id: SUB,
    customer: CUSTOMER,
    status: 'canceled',
    ended_at: NOW_S,
    cancellation_details: { reason },
    items: { data: [{ price: { id: priceId } }] },
  };
  return {
    id: SUB,
    customer: CUSTOMER,
    status: 'canceled',
    currency: 'usd',
    metadata: { user_id: OWNER },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: NOW_S,
    ended_at: NOW_S,
    cancellation_details: { reason, comment: null, feedback: null },
    items: { data: [{ price: { id: priceId, unit_amount: priceId === 'price_personal_500' ? 500 : 900 }, current_period_end: NOW_S }] },
  };
}

let seq = 0;
async function deliver(type: string, object: Record<string, unknown>) {
  seq += 1;
  const event = { id: `evt_payment_restart_${seq}`, type, created: NOW_S + seq, data: { object } };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  const originalError = console.error;
  const originalLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const response = await POST(request as unknown as Parameters<typeof POST>[0]);
    return { id: event.id, status: response.status };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

function rows(template: string) {
  return db.table('billing_email_sends').filter((r) => r.template === template);
}

test('flag on: a card-failure cancel on an account in use queues the restart email instead of the final note and the question', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed();
  const result = await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  assert.equal(result.status, 200);

  const restart = rows('payment_failed_restart');
  assert.equal(restart.length, 1);
  assert.equal(restart[0].scope_key, SUB);
  assert.ok(Date.parse(String(restart[0].send_after)) <= Date.now());
  const payload = restart[0].payload as Record<string, unknown>;
  assert.equal(payload.planId, 'personal');
  assert.equal(payload.restartInterval, 'month');
  assert.equal(payload.restartKeepsPrice, true, 'the $5 price is active and cheaper than today, so it is kept');
  assert.equal(payload.amountCents, 500);
  assert.equal(payload.restartFromSubscriptionId, SUB);

  const final = rows('dunning_14')[0];
  assert.ok(final.cancelled_at, 'no final dunning note on top of the restart email');
  assert.equal(rows('cancel_ask').length, 0, '"You cancelled" is not true of a card that ran out of retries');
  assert.equal(rows('winback_14').length, 1, 'the win-backs still follow');
});

test('a redelivered deletion queues nothing twice', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed();
  const object = deletedSubscription('payment_failed');
  await deliver('customer.subscription.deleted', object);
  await deliver('customer.subscription.deleted', object);
  assert.equal(rows('payment_failed_restart').length, 1);
});

test('flag off: no restart email, and the old close-out (question, final note brought forward as closed)', async () => {
  delete process.env.PAYMENT_RESTART_EMAIL_ENABLED;
  seed();
  await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  assert.equal(rows('payment_failed_restart').length, 0);
  assert.equal(rows('cancel_ask').length, 1);
  const final = rows('dunning_14')[0];
  assert.equal(final.cancelled_at, null);
  assert.ok(Date.parse(String(final.send_after)) <= Date.now());
  assert.equal((final.payload as Record<string, unknown>).subscriptionClosed, true);
});

test('dry_run queues nothing', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'dry_run';
  seed();
  await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  assert.equal(rows('payment_failed_restart').length, 0);
  assert.equal(rows('cancel_ask').length, 1);
});

test('no successful call in the last 7 days: no restart email', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed({ recentCall: false });
  await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  assert.equal(rows('payment_failed_restart').length, 0);
});

test('a cancel the customer asked for never gets the restart email', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed();
  await deliver('customer.subscription.deleted', deletedSubscription('cancellation_requested'));
  assert.equal(rows('payment_failed_restart').length, 0);
});

test('a subscription already on today\'s price restarts at it and says so', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed();
  await deliver('customer.subscription.deleted', deletedSubscription('payment_failed', 'price_personal_900'));
  const payload = rows('payment_failed_restart')[0].payload as Record<string, unknown>;
  assert.equal(payload.restartKeepsPrice, true);
  assert.equal(payload.amountCents, 900);
});

test('a later successful charge cancels the unsent restart email and the win-backs as reactivated', async () => {
  process.env.PAYMENT_RESTART_EMAIL_ENABLED = 'on';
  seed();
  await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  await deliver('invoice.payment_succeeded', { id: 'in_restart_first', customer: CUSTOMER, billing_reason: 'subscription_create' });
  for (const template of ['payment_failed_restart', 'winback_14', 'winback_30']) {
    const row = rows(template)[0];
    assert.equal(row.cancel_reason, 'subscription_reactivated', template);
  }
});
