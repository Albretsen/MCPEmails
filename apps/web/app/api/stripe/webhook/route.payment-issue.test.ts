// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for the failed-payment state
// (src/lib/billing/payment-issue.ts): user_billing.last_decline_code and the
// workspaces.payment_issue_* projection that feed the dashboard banner and the
// once-a-day MCP note.
//
// Pins: a declined renewal marks every owned workspace (and nobody else's)
// with lifecycle email OFF; a retry keeps the first `since`; the SCA code
// gives the 'confirm' kind; success, recovery to active and deletion clear it;
// a late redelivered decline on a paid invoice writes nothing; a same-second
// `active` sibling does not clear a live past_due; and a failing write never
// costs Stripe its 200.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.payment-issue.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_payment_issue_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
// The state must not depend on the email flag.
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();
type LedgerRow = { event_id: string; event_type: string; event_created: string; stripe_customer_id: string | null };
let ledgerRows: LedgerRow[] = [];

/**
 * `stripe_webhook_events` with the two properties the route relies on: a
 * repeated event id is a 23505, and the out-of-order guard's newer-event
 * query (eq customer, neq id, not event_type in (...), gt created) really
 * filters the stored rows.
 */
function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = {
    data: null,
    error: null,
  };
  const filters: ((row: LedgerRow) => boolean)[] = [];
  let querying = false;
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'limit', 'delete']) {
    builder[name] = () => builder;
  }
  builder.eq = (column: keyof LedgerRow, value: unknown) => {
    querying = true;
    filters.push((row) => row[column] === value);
    return builder;
  };
  builder.neq = (column: keyof LedgerRow, value: unknown) => {
    filters.push((row) => row[column] !== value);
    return builder;
  };
  builder.gt = (column: keyof LedgerRow, value: string) => {
    filters.push((row) => String(row[column]) > value);
    return builder;
  };
  builder.not = (column: keyof LedgerRow, operator: string, value: string) => {
    assert.equal(operator, 'in');
    const list = value.replace(/^\(|\)$/g, '').split(',');
    filters.push((row) => row[column] !== null && !list.includes(String(row[column])));
    return builder;
  };
  builder.insert = (row: LedgerRow) => {
    if (ledger.has(row.event_id)) {
      outcome = { data: null, error: { code: '23505', message: 'duplicate key' } };
    } else {
      ledger.add(row.event_id);
      ledgerRows.push(row);
      outcome = { data: { event_id: row.event_id }, error: null };
    }
    return builder;
  };
  builder.maybeSingle = async () => {
    if (!querying) return outcome;
    const hit = ledgerRows.find((row) => filters.every((f) => f(row)));
    return { data: hit ? { event_id: hit.event_id } : null, error: null };
  };
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

/** What Stripe answers for a live re-read. */
const live = {
  invoiceStatus: 'open' as string,
  declineCode: 'insufficient_funds' as string | null,
  subscriptionStatus: 'active' as string,
};

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
      invoices: {
        retrieve: async (id: string) => ({
          id,
          status: live.invoiceStatus,
          payments: {
            data: [
              {
                payment: {
                  payment_intent: {
                    last_payment_error: live.declineCode ? { decline_code: live.declineCode } : null,
                  },
                },
              },
            ],
          },
        }),
      },
      subscriptions: {
        retrieve: async (id: string) => ({ id, status: live.subscriptionStatus }),
      },
      customers: {
        retrieve: async (id: string) => ({ id, email: 'owner@payment-issue.invalid' }),
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

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const STRANGER = '00000000-0000-4000-8000-0000000000bb';
const CUSTOMER = 'cus_payment_issue';

function seed() {
  db = new FakeSupabase();
  ledger = new Set();
  ledgerRows = [];
  live.invoiceStatus = 'open';
  live.declineCode = 'insufficient_funds';
  live.subscriptionStatus = 'active';
  db.seed('user_billing', [
    {
      user_id: OWNER,
      stripe_customer_id: CUSTOMER,
      plan: 'personal',
      subscription_status: 'active',
      last_decline_code: null,
    },
  ]);
  db.seed('workspaces', [
    { id: 'ws-1', owner_id: OWNER, plan: 'personal', deleted_at: null, payment_issue_since: null, payment_issue_kind: null, payment_notice_shown_on: null },
    { id: 'ws-2', owner_id: OWNER, plan: 'personal', deleted_at: null, payment_issue_since: null, payment_issue_kind: null, payment_notice_shown_on: null },
    { id: 'ws-gone', owner_id: OWNER, plan: 'personal', deleted_at: '2026-01-01T00:00:00Z', payment_issue_since: null, payment_issue_kind: null, payment_notice_shown_on: null },
    { id: 'ws-stranger', owner_id: STRANGER, plan: 'free', deleted_at: null, payment_issue_since: null, payment_issue_kind: null, payment_notice_shown_on: null },
  ]);
}

function ws(id: string) {
  const row = db.table('workspaces').find((r) => r.id === id);
  assert.ok(row, `workspace ${id} is seeded`);
  return row;
}

function billing() {
  const row = db.table('user_billing').find((r) => r.user_id === OWNER);
  assert.ok(row);
  return row;
}

let seq = 0;

async function deliver(
  type: string,
  object: Record<string, unknown>,
  options: { id?: string; created?: number } = {},
) {
  seq += 1;
  const event = {
    id: options.id ?? `evt_payment_issue_${seq}`,
    type,
    created: options.created ?? 1_790_000_000 + seq,
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

function failedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_payment_issue',
    customer: CUSTOMER,
    billing_reason: 'subscription_cycle',
    collection_method: 'charge_automatically',
    amount_due: 900,
    attempt_count: 1,
    next_payment_attempt: 1_790_100_000,
    ...overrides,
  };
}

function subscription(status: string) {
  return {
    id: 'sub_payment_issue',
    customer: CUSTOMER,
    status,
    metadata: { user_id: OWNER },
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

test('a declined renewal marks every live workspace the owner owns, with email off', async () => {
  seed();
  const result = await deliver('invoice.payment_failed', failedInvoice());

  assert.equal(result.status, 200);
  assert.equal(billing().last_decline_code, 'insufficient_funds');
  for (const id of ['ws-1', 'ws-2']) {
    assert.equal(typeof ws(id).payment_issue_since, 'string', id);
    assert.equal(ws(id).payment_issue_kind, 'declined', id);
  }
  assert.equal(ws('ws-gone').payment_issue_since, null, 'deleted workspaces are not projected');
  assert.equal(ws('ws-stranger').payment_issue_since, null, 'other owners are untouched');
  assert.equal(ws('ws-1').plan, 'personal', 'no entitlement change');
});

test('a retry keeps the first since; an SCA decline turns the kind to confirm', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  ws('ws-1').payment_issue_since = '2026-10-20T00:00:00.000Z';

  live.declineCode = 'authentication_required';
  await deliver('invoice.payment_failed', failedInvoice({ attempt_count: 2, next_payment_attempt: null }));

  assert.equal(ws('ws-1').payment_issue_since, '2026-10-20T00:00:00.000Z');
  assert.equal(ws('ws-1').payment_issue_kind, 'confirm');
  assert.equal(billing().last_decline_code, 'authentication_required');
});

test('an SCA decline with no retry scheduled is still recorded', async () => {
  seed();
  live.declineCode = 'authentication_required';
  await deliver('invoice.payment_failed', failedInvoice({ next_payment_attempt: null, attempt_count: 1 }));
  assert.equal(ws('ws-1').payment_issue_kind, 'confirm');
});

test('invoice.payment_action_required records the confirm kind, with email off', async () => {
  seed();
  // The bank-approval event carries no decline code of its own; the handler
  // forces authentication_required whatever the payment intent says.
  live.declineCode = null;
  const result = await deliver(
    'invoice.payment_action_required',
    failedInvoice({ next_payment_attempt: null, attempt_count: 1 }),
  );
  assert.equal(result.status, 200);
  assert.equal(ws('ws-1').payment_issue_kind, 'confirm');
  assert.equal(ws('ws-2').payment_issue_kind, 'confirm');
  assert.equal(billing().last_decline_code, 'authentication_required');
});

test('a checkout decline (subscription_create) records nothing', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice({ billing_reason: 'subscription_create' }));
  assert.equal(ws('ws-1').payment_issue_since, null);
  assert.equal(billing().last_decline_code, null);
});

test('a redelivered decline on an invoice that is already paid records nothing', async () => {
  seed();
  live.invoiceStatus = 'paid';
  await deliver('invoice.payment_failed', failedInvoice());
  assert.equal(ws('ws-1').payment_issue_since, null);
});

test('invoice.payment_succeeded clears everything, notice day included', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  ws('ws-1').payment_notice_shown_on = '2026-10-24';

  const result = await deliver('invoice.payment_succeeded', { id: 'in_payment_issue', customer: CUSTOMER });

  assert.equal(result.status, 200);
  assert.equal(billing().last_decline_code, null);
  for (const id of ['ws-1', 'ws-2']) {
    assert.equal(ws(id).payment_issue_since, null, id);
    assert.equal(ws(id).payment_issue_kind, null, id);
    assert.equal(ws(id).payment_notice_shown_on, null, id);
  }
});

test('subscription back to active clears it; past_due does not', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());

  live.subscriptionStatus = 'past_due';
  await deliver('customer.subscription.updated', subscription('past_due'));
  assert.equal(ws('ws-1').payment_issue_kind, 'declined', 'past_due keeps the state');

  live.subscriptionStatus = 'active';
  await deliver('customer.subscription.updated', subscription('active'));
  assert.equal(ws('ws-1').payment_issue_since, null);
  assert.equal(billing().last_decline_code, null);
});

test('an active sibling event does not clear while the live subscription is past_due', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  live.subscriptionStatus = 'past_due';

  await deliver('customer.subscription.updated', subscription('active'));

  assert.equal(ws('ws-1').payment_issue_kind, 'declined');
});

test('customer.subscription.deleted clears it', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  await deliver('customer.subscription.deleted', subscription('canceled'));
  assert.equal(ws('ws-1').payment_issue_since, null);
  assert.equal(ws('ws-2').payment_issue_kind, null);
});

test('a failing state write never fails the webhook', async () => {
  seed();
  db.failTimes('user_billing', { message: 'connection reset' }, 5);
  const result = await deliver('invoice.payment_failed', failedInvoice());
  assert.equal(result.status, 200);
  assert.equal(ledger.has(result.id), true, 'the ledger row was not rolled back');

  db.failTimes('workspaces', { message: 'timeout' }, 5);
  const cleared = await deliver('invoice.payment_succeeded', { id: 'in_payment_issue', customer: CUSTOMER });
  assert.equal(cleared.status, 200);
});

// ---------------------------------------------------------------------------
// Staging E2E bugs B1 and B2 (2026-10-26)
// ---------------------------------------------------------------------------

test('B1: a past_due update processed after its sibling payment_failed is not stale', async () => {
  seed();
  // Stripe: subscription.updated (past_due) at T, invoice.payment_failed at
  // T+1, and the invoice event is processed first.
  const t = 1_795_000_000;
  live.subscriptionStatus = 'past_due';
  await deliver('invoice.payment_failed', failedInvoice(), { created: t + 1 });
  const result = await deliver('customer.subscription.updated', subscription('past_due'), { created: t });

  assert.equal(result.status, 200);
  assert.notEqual(result.body.stale, true, 'the invoice event does not make it stale');
  assert.equal(billing().subscription_status, 'past_due');
  assert.equal(ws('ws-1').payment_issue_kind, 'declined', 'the marker stays while past_due');
});

test('B1: a newer subscription event still makes an older one stale', async () => {
  seed();
  const t = 1_795_100_000;
  await deliver('customer.subscription.updated', subscription('active'), { created: t + 5 });
  const result = await deliver('customer.subscription.updated', subscription('past_due'), { created: t });
  assert.equal(result.body.stale, true);
  assert.equal(billing().subscription_status, 'active');
});

function invoiceOfSubscription(overrides: Record<string, unknown> = {}) {
  return failedInvoice({
    parent: { subscription_details: { subscription: 'sub_payment_issue' } },
    attempt_count: 4,
    next_payment_attempt: null,
    ...overrides,
  });
}

test('B2: a late payment_failed after the deletion leaves no marker', async () => {
  seed();
  const t = 1_795_200_000;
  await deliver('invoice.payment_failed', invoiceOfSubscription({ attempt_count: 1 }), { created: t });
  assert.equal(typeof ws('ws-1').payment_issue_since, 'string');

  live.subscriptionStatus = 'canceled';
  await deliver('customer.subscription.deleted', subscription('canceled'), { created: t + 101 });
  assert.equal(ws('ws-1').payment_issue_since, null, 'the deletion cleared it');

  // The last decline, emitted a second before the deletion, processed after it.
  const result = await deliver('invoice.payment_failed', invoiceOfSubscription(), { created: t + 100 });
  assert.equal(result.status, 200);
  for (const id of ['ws-1', 'ws-2']) {
    assert.equal(ws(id).payment_issue_since, null, id);
    assert.equal(ws(id).payment_issue_kind, null, id);
  }
  assert.equal(billing().last_decline_code, null);
  assert.equal(billing().subscription_status, 'canceled');
});

test('B2: a decline on an ended subscription clears a marker the deletion missed', async () => {
  seed();
  await deliver('invoice.payment_failed', invoiceOfSubscription({ attempt_count: 1 }));
  assert.equal(ws('ws-1').payment_issue_kind, 'declined');

  live.subscriptionStatus = 'canceled';
  await deliver('invoice.payment_failed', invoiceOfSubscription());
  assert.equal(ws('ws-1').payment_issue_since, null);
  assert.equal(billing().last_decline_code, null);
});

test('B2: a decline on a live past_due subscription is still recorded', async () => {
  seed();
  live.subscriptionStatus = 'past_due';
  await deliver('invoice.payment_failed', invoiceOfSubscription({ attempt_count: 1 }));
  assert.equal(ws('ws-1').payment_issue_kind, 'declined');
});

test('B2: an ended old subscription does not clear a newer failing one', async () => {
  seed();
  await deliver('invoice.payment_failed', failedInvoice());
  billing().stripe_subscription_id = 'sub_newer';
  billing().subscription_status = 'past_due';

  live.subscriptionStatus = 'canceled';
  await deliver('invoice.payment_failed', invoiceOfSubscription());
  assert.equal(ws('ws-1').payment_issue_kind, 'declined');
});
