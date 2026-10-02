// ---------------------------------------------------------------------------
// The Stripe webhook, end to end through POST, for automations that the Free
// action allowance paused.
//
// When a Free workspace runs out of allowance the triage dispatcher pauses each
// rule until the END of the allowance period (paused_reason = 'plan_limit').
// Nothing lifted that pause when the owner paid, so a customer who bought
// Personal on the 1st kept every automation paused until the 1st of the next
// month. applyUserPlan now lifts it as part of projecting the plan, and this
// file pins that at the route: the upgrade resumes the rules, nobody else's
// rules move, a replay or a later renewal does nothing, and a failure in the
// lift never costs the customer their plan or Stripe a 200.
//
// Only the I/O is stubbed, as in route.personal-reprice.test.ts. The difference
// is the Supabase stand-in: this one keeps STATE (the in-memory fake from
// src/lib/billing/fake-supabase.ts, plus a ledger that enforces the unique
// event id), because every property here is about what a row looks like after
// the second delivery, not about which calls were made.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/webhook/route.plan-limit-pause.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

// Before anything under test is imported: plans.ts reads price ids at load.
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plan_limit_pause_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
process.env.STRIPE_PRICE_PERSONAL_MONTHLY_V2 = 'price_personal_900';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
let ledger = new Set<string>();

/**
 * `stripe_webhook_events`, with the one property the route relies on: a second
 * insert of the same event id is a 23505. Every other table goes to the fake.
 */
function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = {
    data: null,
    error: null,
  };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'gt', 'limit', 'delete']) {
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
        // The signature itself is Stripe's code, not ours; the event is the input.
        constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')),
      },
    },
  },
});

// Plain Node cannot resolve `next/server` outside the Next toolchain.
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

const BUYER = '00000000-0000-4000-8000-00000000b0b0';
const SOMEONE_ELSE = '00000000-0000-4000-8000-00000000e15e';
const PERIOD_END = '2026-11-01T00:00:00.000Z';

function pausedRule(id: string, workspaceId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: workspaceId,
    enabled: true,
    deleted_at: null,
    disabled_reason: null,
    consecutive_failures: 0,
    paused_reason: 'plan_limit',
    paused_until: PERIOD_END,
    next_run_at: PERIOD_END,
    ...overrides,
  };
}

/** A Free owner with two workspaces of paused rules, and a Free stranger with one. */
function seed() {
  db = new FakeSupabase();
  ledger = new Set();
  db.seed('workspaces', [
    { id: 'ws-buyer-1', owner_id: BUYER, plan: 'free', deleted_at: null },
    { id: 'ws-buyer-2', owner_id: BUYER, plan: 'free', deleted_at: null },
    { id: 'ws-stranger', owner_id: SOMEONE_ELSE, plan: 'free', deleted_at: null },
  ]);
  db.seed('triage_rules', [
    pausedRule('buyer-rule-1', 'ws-buyer-1'),
    pausedRule('buyer-rule-2', 'ws-buyer-2'),
    pausedRule('buyer-other-reason', 'ws-buyer-1', { paused_reason: 'owner_request' }),
    pausedRule('stranger-rule', 'ws-stranger'),
  ]);
}

function rule(id: string) {
  const row = db.table('triage_rules').find((r) => r.id === id);
  assert.ok(row, `rule ${id} is seeded`);
  return row;
}

function plans(ownerId: string) {
  return db.table('workspaces').filter((w) => w.owner_id === ownerId).map((w) => w.plan);
}

let eventSeq = 0;

/** Deliver one subscription event for BUYER. `id` is reused to model a redelivery. */
async function deliver(type: string, options: { id?: string; status?: string } = {}) {
  eventSeq += 1;
  const event = {
    id: options.id ?? `evt_plan_limit_pause_${eventSeq}`,
    type,
    created: 1_790_000_000 + eventSeq,
    data: {
      object: {
        id: 'sub_plan_limit_pause',
        customer: 'cus_plan_limit_pause',
        status: options.status ?? 'active',
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
      },
    },
  };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  // The route types its argument as NextRequest but only reads the Request API.
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return { id: event.id, status: response.status, body: await response.json() };
}

test('buying a plan lifts the plan-limit pause on every workspace the buyer owns', async () => {
  seed();
  const before = Date.now();

  const result = await deliver('customer.subscription.created');

  assert.equal(result.status, 200);
  assert.deepEqual(plans(BUYER), ['personal', 'personal']);
  for (const id of ['buyer-rule-1', 'buyer-rule-2']) {
    const row = rule(id);
    assert.equal(row.paused_reason, null, id);
    assert.equal(row.paused_until, null, id);
    const dueInMs = new Date(String(row.next_run_at)).getTime() - before;
    assert.ok(dueInMs >= 0 && dueInMs < 15 * 60_000, `${id} is due within the resume window`);
    assert.equal(row.enabled, true);
    assert.equal(row.consecutive_failures, 0);
  }
});

test('the upgrade leaves other owners and other pause reasons exactly as they were', async () => {
  seed();
  const stranger = { ...rule('stranger-rule') };
  const otherReason = { ...rule('buyer-other-reason') };

  await deliver('customer.subscription.created');

  assert.deepEqual(plans(SOMEONE_ELSE), ['free']);
  assert.deepEqual(rule('stranger-rule'), stranger);
  assert.deepEqual(rule('buyer-other-reason'), otherReason);
});

test('a redelivered event is a no-op, and a later renewal lifts nothing', async () => {
  seed();
  const first = await deliver('customer.subscription.created');
  const afterUpgrade = db.table('triage_rules').map((row) => ({ ...row }));

  // 1. Stripe redelivers the same event id: the ledger acks it untouched.
  const replay = await deliver('customer.subscription.created', { id: first.id });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual(db.table('triage_rules'), afterUpgrade);

  // 2. The paid workspace later exhausts its own (much larger) allowance and
  //    the dispatcher pauses a rule again. A renewal is not a transition, so
  //    the webhook must not un-pause it.
  Object.assign(rule('buyer-rule-1'), {
    paused_reason: 'plan_limit',
    paused_until: PERIOD_END,
    next_run_at: PERIOD_END,
  });
  const renewal = await deliver('customer.subscription.updated');
  assert.equal(renewal.status, 200);
  assert.equal(rule('buyer-rule-1').paused_reason, 'plan_limit');
  assert.equal(rule('buyer-rule-1').next_run_at, PERIOD_END);
  assert.equal(rule('buyer-rule-2').next_run_at, afterUpgrade[1].next_run_at, 'not rescheduled');
});

test('a failing un-pause does not fail the webhook or the plan write', async () => {
  seed();
  db.failOnce('triage_rules', { message: 'connection reset' });

  const result = await deliver('customer.subscription.created');

  assert.equal(result.status, 200, 'Stripe is acked, so the plan write is not retried');
  assert.deepEqual(plans(BUYER), ['personal', 'personal'], 'the customer has what they paid for');
  assert.equal(ledger.has(result.id), true, 'the ledger row was not rolled back');
  assert.equal(rule('buyer-rule-1').paused_reason, 'plan_limit', 'the lift itself did fail');
});

test('a failing transition read does not fail the webhook or the plan write either', async () => {
  seed();
  // The first `workspaces` query is the read of which workspaces are changing.
  db.failOnce('workspaces', { message: 'timeout' });

  const result = await deliver('customer.subscription.created');

  assert.equal(result.status, 200);
  assert.deepEqual(plans(BUYER), ['personal', 'personal']);
});

test('a cancellation back to Free neither pauses nor un-pauses anything', async () => {
  seed();
  await deliver('customer.subscription.created');
  const paid = db.table('triage_rules').map((row) => ({ ...row }));

  const result = await deliver('customer.subscription.deleted');

  assert.equal(result.status, 200);
  assert.deepEqual(plans(BUYER), ['free', 'free']);
  assert.deepEqual(db.table('triage_rules'), paid, 'the dispatcher, not the webhook, pauses');
});
