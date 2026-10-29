// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for a renewal the customer's
// bank wants approved (EU SCA / 3DS, decline code authentication_required).
//
// Two properties are pinned here:
//   - invoice.payment_action_required and invoice.payment_failed for the SAME
//     invoice queue one sequence (4 rows), not two (8), in either order, and
//     the confirm-the-payment payload is the one that sticks;
//   - the "no retry scheduled after one attempt" guard skips an ordinary
//     decline but never a bank approval, because no retry can approve it.
//
// Only the I/O is stubbed, as in route.plan-limit-pause.test.ts: Supabase is
// the stateful fake that enforces the (stripe_customer_id, template,
// scope_key) unique index, and Stripe is a stub that answers the decline code.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.sca-dunning.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

// Before anything under test is imported: plans.ts reads price ids at load.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_sca_dunning_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();
/** What the stubbed payment intent says the decline was. */
let intentDeclineCode: string | null = 'authentication_required';

/** `stripe_webhook_events`: a second insert of the same event id is a 23505. */
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

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
      paymentIntents: {
        retrieve: async (id: string) => ({
          id,
          last_payment_error: intentDeclineCode ? { code: intentDeclineCode } : null,
        }),
      },
      customers: {
        retrieve: async (id: string) => ({ id, email: 'sca-owner@example.com' }),
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

const OWNER = '00000000-0000-4000-8000-0000000005ca';
const CUSTOMER = 'cus_sca_dunning';
const HOSTED = 'https://invoice.stripe.com/i/acct_test/test_sca_dunning';

function seed() {
  db = new FakeSupabase();
  ledger = new Set();
  intentDeclineCode = 'authentication_required';
  db.seed('user_billing', [{ user_id: OWNER, stripe_customer_id: CUSTOMER }]);
}

let eventSeq = 0;

/** Deliver one invoice event. */
async function deliver(type: string, invoice: Record<string, unknown> = {}) {
  eventSeq += 1;
  const event = {
    id: `evt_sca_dunning_${eventSeq}`,
    type,
    created: 1_790_000_000 + eventSeq,
    data: {
      object: {
        id: 'in_sca_dunning',
        object: 'invoice',
        customer: CUSTOMER,
        customer_email: 'sca-owner@example.com',
        billing_reason: 'subscription_cycle',
        collection_method: 'charge_automatically',
        amount_due: 900,
        currency: 'usd',
        attempt_count: 1,
        next_payment_attempt: null,
        payment_intent: 'pi_sca_dunning',
        hosted_invoice_url: HOSTED,
        lines: { data: [{ price: { id: 'price_personal_900' } }] },
        ...invoice,
      },
    },
  };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return { status: response.status, body: await response.json() };
}

function queued() {
  return db.table('billing_email_sends');
}

test('action_required then payment_failed on one invoice queues one sequence, not two', async () => {
  seed();
  // A different code on the later event proves the first payload is kept.
  intentDeclineCode = 'insufficient_funds';

  assert.equal((await deliver('invoice.payment_action_required')).status, 200);
  assert.equal(queued().length, 4);

  assert.equal((await deliver('invoice.payment_failed', { next_payment_attempt: 1_790_500_000 })).status, 200);
  const rows = queued();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.template).sort(),
    ['dunning_1', 'dunning_14', 'dunning_3', 'dunning_7'],
  );
  for (const row of rows) {
    assert.equal(row.scope_key, 'in_sca_dunning');
    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.declineCode, 'authentication_required', String(row.template));
    assert.equal(payload.hostedInvoiceUrl, HOSTED);
    assert.equal(payload.planId, 'personal');
  }
});

test('payment_failed then action_required on one invoice also queues one sequence', async () => {
  seed();
  await deliver('invoice.payment_failed');
  await deliver('invoice.payment_action_required');
  const rows = queued();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal((row.payload as Record<string, unknown>).declineCode, 'authentication_required');
  }
});

test('an SCA failure with no retry scheduled after one attempt still queues', async () => {
  seed();
  const result = await deliver('invoice.payment_failed', { next_payment_attempt: null, attempt_count: 1 });
  assert.equal(result.status, 200);
  assert.equal(queued().length, 4);
  assert.equal(
    (queued()[0].payload as Record<string, unknown>).declineCode,
    'authentication_required',
  );
});

test('an ordinary decline with no retry scheduled after one attempt still queues nothing', async () => {
  seed();
  intentDeclineCode = 'insufficient_funds';
  const result = await deliver('invoice.payment_failed', { next_payment_attempt: null, attempt_count: 1 });
  assert.equal(result.status, 200);
  assert.equal(queued().length, 0);
});

test('action_required on a first checkout is not a renewal and queues nothing', async () => {
  seed();
  const result = await deliver('invoice.payment_action_required', { billing_reason: 'subscription_create' });
  assert.equal(result.status, 200);
  assert.equal(queued().length, 0);
});
