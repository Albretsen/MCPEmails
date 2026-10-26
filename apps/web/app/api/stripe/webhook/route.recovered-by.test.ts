// ---------------------------------------------------------------------------
// The Stripe webhook's measurement writes for /admin/growth/dunning, end to
// end through POST:
//
//   - recovered_by on a dunning sequence closed by invoice.payment_succeeded:
//     a different payment method or a 3-D Secure charge is 'customer', the
//     same method is 'retry', and anything Stripe cannot tell us (including a
//     Stripe error) is 'unknown', never a thrown webhook;
//   - cancellation_reason on the ledger row of customer.subscription.deleted,
//     best effort.
//
// Only the I/O is stubbed, as in route.sca-dunning.test.ts.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.recovered-by.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_recovered_by_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();
let ledgerUpdates: Array<{ eventId: unknown; patch: Record<string, unknown> }> = [];
let ledgerUpdateFails = false;

function ledgerTable() {
  let outcome: { data: unknown; error: { code?: string; message: string } | null } = {
    data: null,
    error: null,
  };
  let patch: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'neq', 'not', 'gt', 'limit', 'delete']) {
    builder[name] = () => builder;
  }
  builder.update = (p: Record<string, unknown>) => {
    patch = p;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    if (patch && column === 'event_id') {
      if (ledgerUpdateFails) {
        outcome = { data: null, error: { code: '42703', message: 'column "cancellation_reason" does not exist' } };
      } else {
        ledgerUpdates.push({ eventId: value, patch });
        outcome = { data: null, error: null };
      }
    }
    return builder;
  };
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

/** What Stripe answers. */
const stripeState = {
  failedPaymentMethod: 'pm_old' as string | null,
  paidPaymentMethod: 'pm_old',
  threeDSecure: null as null | { result: string },
  recoveryLookupThrows: false,
  recoveryLookups: 0,
};

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
      paymentIntents: {
        retrieve: async (id: string) => ({
          id,
          last_payment_error: {
            decline_code: 'insufficient_funds',
            payment_method: stripeState.failedPaymentMethod ? { id: stripeState.failedPaymentMethod } : null,
          },
        }),
      },
      invoices: {
        retrieve: async (id: string, params?: { expand?: string[] }) => {
          const recovery = params?.expand?.includes('payments.data.payment.payment_intent.latest_charge');
          if (!recovery) return { id, status: 'open' };
          stripeState.recoveryLookups += 1;
          if (stripeState.recoveryLookupThrows) throw new Error('Stripe API unavailable');
          return {
            id,
            status: 'paid',
            payments: {
              data: [
                {
                  payment: {
                    payment_intent: {
                      status: 'succeeded',
                      payment_method: stripeState.paidPaymentMethod,
                      latest_charge: {
                        payment_method: stripeState.paidPaymentMethod,
                        payment_method_details: { card: { three_d_secure: stripeState.threeDSecure } },
                      },
                    },
                  },
                },
              ],
            },
          };
        },
      },
      subscriptions: {
        retrieve: async (id: string) => ({ id, status: 'active' }),
      },
      customers: {
        retrieve: async (id: string) => ({ id, email: 'owner@recovered-by.invalid' }),
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

const OWNER = '00000000-0000-4000-8000-000000000b01';
const CUSTOMER = 'cus_recovered_by';
const INVOICE = 'in_recovered_by';

function seed() {
  db = new FakeSupabase();
  ledger = new Set();
  ledgerUpdates = [];
  ledgerUpdateFails = false;
  stripeState.failedPaymentMethod = 'pm_old';
  stripeState.paidPaymentMethod = 'pm_old';
  stripeState.threeDSecure = null;
  stripeState.recoveryLookupThrows = false;
  stripeState.recoveryLookups = 0;
  db.seed('user_billing', [
    { user_id: OWNER, stripe_customer_id: CUSTOMER, plan: 'personal', subscription_status: 'active', last_decline_code: null },
  ]);
  db.seed('workspaces', [
    { id: 'ws-rb', owner_id: OWNER, plan: 'personal', deleted_at: null, payment_issue_since: null, payment_issue_kind: null },
  ]);
}

let seq = 0;

async function deliver(type: string, object: Record<string, unknown>) {
  seq += 1;
  const event = { id: `evt_recovered_by_${seq}`, type, created: 1_790_000_000 + seq, data: { object } };
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

function failedInvoice() {
  return {
    id: INVOICE,
    object: 'invoice',
    customer: CUSTOMER,
    customer_email: 'owner@recovered-by.invalid',
    billing_reason: 'subscription_cycle',
    collection_method: 'charge_automatically',
    amount_due: 900,
    currency: 'usd',
    attempt_count: 1,
    next_payment_attempt: 1_790_500_000,
    payment_intent: 'pi_recovered_by',
    lines: { data: [{ price: { id: 'price_personal_900' } }] },
  };
}

function sequence() {
  return db.table('billing_email_sends').filter((r) => r.scope_key === INVOICE);
}

async function declineThenPay() {
  assert.equal((await deliver('invoice.payment_failed', failedInvoice())).status, 200);
  assert.equal(sequence().length, 4, 'a dunning sequence was queued');
  return deliver('invoice.payment_succeeded', { id: INVOICE, customer: CUSTOMER });
}

test('the failed attempt\'s payment method is kept in the dunning payload', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  for (const row of sequence()) {
    assert.equal((row.payload as Record<string, unknown>).failedPaymentMethodId, 'pm_old');
  }
});

test('paid with a different payment method: the customer fixed it', async () => {
  seed();
  stripeState.paidPaymentMethod = 'pm_new';
  const paid = await declineThenPay();
  assert.equal(paid.status, 200);
  for (const row of sequence()) {
    assert.equal(row.cancel_reason, 'payment_recovered');
    assert.equal(row.recovered_by, 'customer', String(row.template));
  }
});

test('paid on the same payment method with no 3-D Secure: a silent retry', async () => {
  seed();
  await declineThenPay();
  for (const row of sequence()) assert.equal(row.recovered_by, 'retry');
});

test('a 3-D Secure charge on the same method is still the customer', async () => {
  seed();
  stripeState.threeDSecure = { result: 'authenticated' };
  await declineThenPay();
  for (const row of sequence()) assert.equal(row.recovered_by, 'customer');
});

test('no stored failed payment method: unknown, not a guess', async () => {
  seed();
  stripeState.failedPaymentMethod = null;
  stripeState.paidPaymentMethod = 'pm_new';
  await declineThenPay();
  for (const row of sequence()) assert.equal(row.recovered_by, 'unknown');
});

test('a Stripe error on the lookup is unknown, and the webhook still acks', async () => {
  seed();
  stripeState.recoveryLookupThrows = true;
  const paid = await declineThenPay();
  assert.equal(paid.status, 200);
  assert.equal(ledger.has(paid.id), true, 'the ledger row was not rolled back');
  assert.equal(stripeState.recoveryLookups, 1);
  for (const row of sequence()) {
    assert.equal(row.cancel_reason, 'payment_recovered');
    assert.equal(row.recovered_by, 'unknown');
  }
});

test('a failing recovered_by write never fails the webhook', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  // The cancel succeeds; the read and the stamp both fail.
  const paid = await (async () => {
    const realFrom = db.from.bind(db);
    let calls = 0;
    db.from = ((table: string) => {
      if (table === 'billing_email_sends') {
        calls += 1;
        if (calls > 1) throw new Error('connection reset');
      }
      return realFrom(table);
    }) as typeof db.from;
    return deliver('invoice.payment_succeeded', { id: INVOICE, customer: CUSTOMER });
  })();
  assert.equal(paid.status, 200);
});

test('a payment on an invoice that was never dunned makes no Stripe lookup', async () => {
  seed();
  const paid = await deliver('invoice.payment_succeeded', { id: 'in_never_dunned', customer: CUSTOMER });
  assert.equal(paid.status, 200);
  assert.equal(stripeState.recoveryLookups, 0);
});

function deletedSubscription(reason: string | null) {
  return {
    id: 'sub_recovered_by',
    customer: CUSTOMER,
    status: 'canceled',
    metadata: { user_id: OWNER },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: 1_790_000_000,
    cancellation_details: { reason, comment: null, feedback: null },
    items: { data: [{ price: { id: 'price_personal_900' }, current_period_end: 1_790_000_000 }] },
  };
}

test('customer.subscription.deleted records Stripe\'s cancellation reason on its ledger row', async () => {
  seed();
  const result = await deliver('customer.subscription.deleted', deletedSubscription('payment_failed'));
  assert.deepEqual(ledgerUpdates, [{ eventId: result.id, patch: { cancellation_reason: 'payment_failed' } }]);
});

test('a deletion with no reason is recorded as none', async () => {
  seed();
  const result = await deliver('customer.subscription.deleted', deletedSubscription(null));
  assert.deepEqual(ledgerUpdates, [{ eventId: result.id, patch: { cancellation_reason: 'none' } }]);
});

test('a missing cancellation_reason column never fails the deletion', async () => {
  seed();
  ledgerUpdateFails = true;
  const result = await deliver('customer.subscription.deleted', deletedSubscription('cancellation_requested'));
  assert.equal(result.status, 200);
  assert.equal(ledgerUpdates.length, 0);
});

test('other events never write a cancellation reason', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  assert.equal(ledgerUpdates.length, 0);
});
