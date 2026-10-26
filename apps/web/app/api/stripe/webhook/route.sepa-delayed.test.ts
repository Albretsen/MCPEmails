// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for delayed SEPA Direct Debit
// payments (added 2026-10-24 for the EUR launch).
//
// Stripe makes a SEPA subscription `active` while its first debit is still
// processing, for up to six business days. The decision is PROVISIONAL ACCESS:
// the buyer gets the plan at once. These tests pin both halves of that:
//
//   1. active-while-processing grants the plan, with no extra Stripe calls;
//   2. the access ends when the money never arrives: on
//      checkout.session.async_payment_failed, and on a past_due / unpaid
//      subscription that is SEPA and has never had a paid invoice (the first
//      invoice failing);
//   3. everyone else keeps today's dunning grace exactly: a card subscriber in
//      past_due stays entitled, and so does a SEPA subscriber who has paid
//      before, or whose payment history Stripe could not tell us (fail open).
//
// Plus the dispute log line, which must fire for SEPA only and change nothing.
//
// Only the I/O is stubbed, as in route.personal-reprice.test.ts: the Stripe
// client, the service-role Supabase client, the billing funnel, and
// `next/server`. The ledger, the staleness guard, the plan resolution and
// applyUserPlan all run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.sepa-delayed.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

// Before anything under test is imported: plans.ts reads price ids at load.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_sepa_delayed_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER_ID = '00000000-0000-0000-0000-000000005e9a';
const SUB_ID = 'sub_sepa_delayed';

type Write = { table: string; op: 'upsert' | 'update'; values: Record<string, unknown> };
const writes: Write[] = [];

/** Same chainable stand-in as route.personal-reprice.test.ts. */
function fakeServiceClient() {
  return {
    from(table: string) {
      let inserted = false;
      const result = () =>
        table === 'stripe_webhook_events' && inserted
          ? { data: { event_id: 'evt' }, error: null }
          : { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'neq', 'not', 'gt', 'is', 'limit', 'delete', 'order', 'in']) {
        builder[name] = () => builder;
      }
      builder.insert = () => {
        inserted = true;
        return builder;
      };
      builder.upsert = (values: Record<string, unknown>) => {
        writes.push({ table, op: 'upsert', values });
        return builder;
      };
      builder.update = (values: Record<string, unknown>) => {
        writes.push({ table, op: 'update', values });
        return builder;
      };
      builder.maybeSingle = async () => result();
      builder.single = async () => result();
      builder.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: fakeServiceClient },
});

// ── The Stripe world each test sets up ──────────────────────────────────────

/** The subscription `subscriptions.retrieve` answers with. */
let liveSubscription: Record<string, unknown> = {};
/** Payment method id -> type, for `paymentMethods.retrieve`. */
const paymentMethodTypes: Record<string, string> = {
  pm_sepa: 'sepa_debit',
  pm_card: 'card',
};
/** What `invoices.list({ status: 'paid' })` finds, or 'throws'. */
let paidInvoices: number | 'throws' = 0;
/** Charge id -> payment method type, for `charges.retrieve`. */
const chargeTypes: Record<string, string> = { ch_sepa: 'sepa_debit', ch_card: 'card' };

/** Every Stripe read, so a test can prove the common path makes none. */
const stripeCalls: string[] = [];

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: {
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
      subscriptions: {
        retrieve: async (id: string) => {
          stripeCalls.push(`subscriptions.retrieve ${id}`);
          return { id, ...liveSubscription };
        },
      },
      paymentMethods: {
        retrieve: async (id: string) => {
          stripeCalls.push(`paymentMethods.retrieve ${id}`);
          return { id, type: paymentMethodTypes[id] };
        },
      },
      invoices: {
        list: async (params: Record<string, unknown>) => {
          stripeCalls.push(`invoices.list ${JSON.stringify(params)}`);
          if (paidInvoices === 'throws') throw new Error('stripe is down');
          return { data: Array.from({ length: paidInvoices }, (_, i) => ({ id: `in_${i}` })) };
        },
      },
      charges: {
        retrieve: async (id: string) => {
          stripeCalls.push(`charges.retrieve ${id}`);
          return { id, customer: 'cus_sepa', payment_method_details: { type: chargeTypes[id] } };
        },
      },
      customers: {
        retrieve: async (id: string) => ({ id, email: null }),
      },
    },
  },
});

/** Funnel rows from checkout.session.completed; async success must add none. */
const funnelRows: string[] = [];
nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    billingTarget: (plan: string, interval: string) => `${plan}_${interval}`,
    primaryWorkspaceId: async () => 'ws_sepa',
    recordCheckoutCompleted: async (_ws: string, target: string) => {
      funnelRows.push(target);
    },
    // src/lib/billing/pass.ts imports it; no pass is bought on these paths.
    recordPassEvent: async () => {},
  },
});

/** No buyer here holds a 3-month pass, so applyUserPlan projects as before. */
nodeMock.module('@/lib/billing/pass', {
  namedExports: {
    getActivePass: async () => null,
    // Everything else the route's imports read from the module, inert.
    personalPassMode: () => 'off',
    passCheckoutOpen: () => false,
    passEndsAt: (d: Date) => d,
    passSubscriptionStart: () => null,
    activeFromLive: () => null,
    canQueueAnotherPass: () => true,
    planPassWindow: () => null,
    ENTITLED_SUBSCRIPTION_STATUSES: ['active', 'trialing', 'past_due', 'unpaid'],
    hasEntitledSubscription: (b: { subscription_status?: string | null } | null | undefined) =>
      ['active', 'trialing', 'past_due', 'unpaid'].includes(b?.subscription_status ?? ''),
    passEligibility: () => ({ eligible: false }),
    effectivePlan: (input: { subscriptionPlan?: string }) => input.subscriptionPlan ?? 'free',
    reprojectUserPlan: async () => null,
    passNoticesFor: () => [],
    sweepPassExpiry: async () => ({ expired: 0, started: 0 }),
    recordPassPurchase: async () => {
      throw new Error('no pass is bought in the SEPA tests');
    },
    refundPass: async () => ({ kind: 'not_a_pass' }),
  },
});

/** The purchase emails the route asked for, once its after() work has run. */
const purchaseEmails: Array<Record<string, unknown>> = [];
nodeMock.module('@/lib/email/purchase-confirmation', {
  namedExports: {
    sendPurchaseConfirmationEmail: async (input: Record<string, unknown>) => {
      purchaseEmails.push(input);
    },
    // billing-lifecycle.ts imports it; never reached on these paths.
    formatAmount: () => '',
  },
});
nodeMock.module('@/lib/email/abandoned-checkout-send', {
  namedExports: {
    creditAbandonedCheckout: async () => {},
    remindAbandonedCheckout: async () => {},
  },
});

/** Post-response work (purchase email, reminder credit) scheduled with after(). */
let afterCalls = 0;
const afterWork: Array<() => unknown> = [];
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
    after: (fn: () => unknown) => {
      afterCalls += 1;
      afterWork.push(fn);
    },
  },
});

const { POST } = await import('./route.ts');
const { isNeverPaidSepa } = await import('@/lib/stripe/sepa-entitlement');

/** Logs, captured, so the dispute line can be asserted and output stays clean. */
const errors: string[] = [];
const originalError = console.error;
const originalLog = console.log;
const originalInfo = console.info;

beforeEach(() => {
  writes.length = 0;
  stripeCalls.length = 0;
  funnelRows.length = 0;
  errors.length = 0;
  afterCalls = 0;
  afterWork.length = 0;
  purchaseEmails.length = 0;
  paidInvoices = 0;
  liveSubscription = {};
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = () => {};
  console.info = () => {};
});

test.after(() => {
  console.error = originalError;
  console.log = originalLog;
  console.info = originalInfo;
});

let eventSeq = 0;

async function deliver(type: string, object: Record<string, unknown>) {
  eventSeq += 1;
  const event = {
    id: `evt_sepa_delayed_${eventSeq}`,
    type,
    created: 1_795_000_000 + eventSeq,
    data: { object },
  };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return response.status;
}

/** The plan written to user_billing and the workspaces, or undefined if none. */
function planWritten() {
  const billing = writes.find((w) => w.table === 'user_billing' && w.op === 'upsert');
  const workspace = writes.find((w) => w.table === 'workspaces' && w.op === 'update');
  return {
    billingPlan: billing?.values.plan,
    workspacePlan: workspace?.values.plan,
    status: billing?.values.subscription_status,
    wrote: Boolean(billing),
  };
}

function subscription(status: string, paymentMethod: string | null) {
  return {
    id: SUB_ID,
    customer: 'cus_sepa',
    status,
    default_payment_method: paymentMethod,
    metadata: { user_id: USER_ID },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    items: {
      data: [
        {
          price: { id: 'price_personal_900' },
          current_period_start: 1_795_000_000,
          current_period_end: 1_797_600_000,
        },
      ],
    },
  };
}

function checkoutSession(paymentStatus: string) {
  return {
    id: 'cs_sepa_delayed',
    mode: 'subscription',
    customer: 'cus_sepa',
    subscription: SUB_ID,
    payment_status: paymentStatus,
    metadata: { user_id: USER_ID, plan_id: 'personal', interval: 'month' },
    customer_details: { email: 'buyer@example.test' },
    amount_total: 900,
    currency: 'eur',
  };
}

// ── The pure rule ───────────────────────────────────────────────────────────

test('the never-paid rule: only past_due / unpaid, only SEPA, only with no paid invoice', () => {
  const base = { status: 'past_due', paymentMethodType: 'sepa_debit', hasPaidInvoice: false };
  assert.equal(isNeverPaidSepa(base), true);
  assert.equal(isNeverPaidSepa({ ...base, status: 'unpaid' }), true);
  assert.equal(isNeverPaidSepa({ ...base, status: 'active' }), false, 'provisional access');
  assert.equal(isNeverPaidSepa({ ...base, status: 'trialing' }), false);
  assert.equal(isNeverPaidSepa({ ...base, paymentMethodType: 'card' }), false);
  assert.equal(isNeverPaidSepa({ ...base, paymentMethodType: null }), false, 'unknown method fails open');
  assert.equal(isNeverPaidSepa({ ...base, hasPaidInvoice: true }), false);
  assert.equal(isNeverPaidSepa({ ...base, hasPaidInvoice: null }), false, 'unknown history fails open');
});

// ── 1. Active while processing ──────────────────────────────────────────────

test('a SEPA checkout whose debit is still processing grants the plan at once', async () => {
  liveSubscription = subscription('active', 'pm_sepa');
  const status = await deliver('checkout.session.completed', checkoutSession('unpaid'));
  assert.equal(status, 200);
  const written = planWritten();
  assert.equal(written.billingPlan, 'personal');
  assert.equal(written.workspacePlan, 'personal');
  assert.equal(written.status, 'active');
  assert.deepEqual(funnelRows, ['personal_month'], 'the purchase counts now, not in six days');
  assert.ok(afterCalls >= 1, 'the purchase email is scheduled');
  for (const fn of afterWork) await fn();
  assert.equal(purchaseEmails.length, 1);
  assert.equal(purchaseEmails[0].paymentStatus, 'unpaid', 'the email says the debit is processing');
  assert.deepEqual(stripeCalls, [`subscriptions.retrieve ${SUB_ID}`], 'no payment history lookup for an active sub');
});

test('a subscription.updated that is active on SEPA keeps the plan and asks Stripe nothing', async () => {
  const status = await deliver('customer.subscription.updated', subscription('active', 'pm_sepa'));
  assert.equal(status, 200);
  assert.equal(planWritten().billingPlan, 'personal');
  assert.deepEqual(stripeCalls, []);
});

// ── 2. The first invoice fails ──────────────────────────────────────────────

test('SEPA past_due with no paid invoice ever: provisional access ends', async () => {
  paidInvoices = 0;
  const status = await deliver('customer.subscription.updated', subscription('past_due', 'pm_sepa'));
  assert.equal(status, 200);
  const written = planWritten();
  assert.equal(written.billingPlan, 'free');
  assert.equal(written.workspacePlan, 'free');
  assert.equal(written.status, 'past_due', 'the raw status is kept for the banner');
  assert.ok(
    stripeCalls.some((c) => c.startsWith('invoices.list') && c.includes('"status":"paid"') && c.includes('"limit":1')),
    'one paid-invoice lookup, limit 1',
  );
});

test('SEPA unpaid with no paid invoice ever is not entitled either', async () => {
  await deliver('customer.subscription.updated', subscription('unpaid', 'pm_sepa'));
  assert.equal(planWritten().billingPlan, 'free');
});

test('SEPA past_due with an earlier paid invoice keeps the normal dunning grace', async () => {
  paidInvoices = 1;
  await deliver('customer.subscription.updated', subscription('past_due', 'pm_sepa'));
  const written = planWritten();
  assert.equal(written.billingPlan, 'personal');
  assert.equal(written.status, 'past_due');
});

test('a card subscriber in past_due keeps the plan exactly as today, with no lookup', async () => {
  await deliver('customer.subscription.updated', subscription('past_due', 'pm_card'));
  assert.equal(planWritten().billingPlan, 'personal');
  assert.equal(stripeCalls.some((c) => c.startsWith('invoices.list')), false);
});

test('a past_due subscription with no default payment method keeps the plan (fail open)', async () => {
  await deliver('customer.subscription.updated', subscription('past_due', null));
  assert.equal(planWritten().billingPlan, 'personal');
  assert.deepEqual(stripeCalls, []);
});

test('if Stripe cannot list the invoices, a SEPA past_due keeps the plan (fail open)', async () => {
  paidInvoices = 'throws';
  const status = await deliver('customer.subscription.updated', subscription('past_due', 'pm_sepa'));
  assert.equal(status, 200);
  assert.equal(planWritten().billingPlan, 'personal');
});

// ── 3. checkout.session.async_payment_failed ────────────────────────────────

test('async payment failed on a sub that never paid: downgrade to free', async () => {
  liveSubscription = subscription('past_due', 'pm_sepa');
  paidInvoices = 0;
  const status = await deliver('checkout.session.async_payment_failed', checkoutSession('unpaid'));
  assert.equal(status, 200);
  const written = planWritten();
  assert.equal(written.billingPlan, 'free');
  assert.equal(written.workspacePlan, 'free');
  assert.equal(written.status, 'past_due');
  assert.ok(errors.some((e) => e.includes('async_payment_failed') && e.includes('cs_sepa_delayed')));
});

test('async payment failed while Stripe still says active: still free, the debit did not land', async () => {
  liveSubscription = subscription('active', 'pm_sepa');
  await deliver('checkout.session.async_payment_failed', checkoutSession('unpaid'));
  assert.equal(planWritten().billingPlan, 'free');
});

test('async payment failed but the buyer has since paid another way: plan kept, nothing written', async () => {
  liveSubscription = subscription('active', 'pm_sepa');
  paidInvoices = 1;
  const status = await deliver('checkout.session.async_payment_failed', checkoutSession('unpaid'));
  assert.equal(status, 200);
  assert.equal(planWritten().wrote, false);
});

test('async payment failed with no answer from Stripe: 500, so Stripe redelivers', async () => {
  liveSubscription = subscription('past_due', 'pm_sepa');
  paidInvoices = 'throws';
  const status = await deliver('checkout.session.async_payment_failed', checkoutSession('unpaid'));
  assert.equal(status, 500);
  assert.equal(planWritten().wrote, false);
});

// ── 4. checkout.session.async_payment_succeeded ─────────────────────────────

test('async payment succeeded re-syncs the plan, with no second funnel row or email', async () => {
  liveSubscription = subscription('active', 'pm_sepa');
  const status = await deliver('checkout.session.async_payment_succeeded', checkoutSession('paid'));
  assert.equal(status, 200);
  const written = planWritten();
  assert.equal(written.billingPlan, 'personal');
  assert.equal(written.status, 'active');
  assert.deepEqual(funnelRows, []);
  assert.equal(afterCalls, 0, 'no purchase email the second time');
});

// ── 5. charge.dispute.created ───────────────────────────────────────────────

test('a SEPA dispute logs one loud line and changes no plan', async () => {
  const status = await deliver('charge.dispute.created', {
    id: 'du_sepa',
    charge: 'ch_sepa',
    amount: 900,
    currency: 'eur',
    reason: 'general',
  });
  assert.equal(status, 200);
  assert.equal(planWritten().wrote, false);
  const line = errors.find((e) => e.includes('SEPA DISPUTE'));
  assert.ok(line, 'the dispute is logged');
  assert.match(line!, /du_sepa/);
  assert.match(line!, /ch_sepa/);
  assert.match(line!, /900 eur/);
});

test('a card dispute is left to the dashboard: no log line, no plan change', async () => {
  await deliver('charge.dispute.created', {
    id: 'du_card',
    charge: 'ch_card',
    amount: 900,
    currency: 'usd',
    reason: 'fraudulent',
  });
  assert.equal(errors.some((e) => e.includes('SEPA DISPUTE')), false);
  assert.equal(planWritten().wrote, false);
});

test('a dispute that names a card method on itself needs no charge lookup', async () => {
  await deliver('charge.dispute.created', {
    id: 'du_card_direct',
    charge: 'ch_card',
    amount: 900,
    currency: 'usd',
    reason: 'fraudulent',
    payment_method_details: { type: 'card' },
  });
  assert.deepEqual(stripeCalls, []);
});
