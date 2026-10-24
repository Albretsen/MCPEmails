// ---------------------------------------------------------------------------
// POST /api/billing/pause and POST /api/billing/downgrade, end to end through
// the handlers.
//
// Pinned: auth; the flags (off = 404, internal accounts always see it);
// ownership (a subscription id on the row that belongs to another customer
// or names another user is refused); the two-call handshake (no Stripe write
// without `confirm: true`, the boolean); the exact Stripe parameters; the
// pause emails (receipt + reminder, the reminder moved on extend and cancelled
// on resume); clearing a scheduled cancel and its emails; the keep order.
//
// Only I/O is stubbed: both Supabase clients (one stateful fake), Stripe and
// next/server.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/billing/plan-change-routes.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { PRICES, setPlanChangeTestPrices, subscriptionFixture } from '@/lib/billing/plan-change-fixtures';

setPlanChangeTestPrices();
process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const INBOX_A = '00000000-0000-4000-8000-00000000000a';
const INBOX_B = '00000000-0000-4000-8000-00000000000b';

let db = new FakeSupabase();
let user: { id: string; email: string } | null = null;
let current: ReturnType<typeof subscriptionFixture>;
let updates: Array<{ id: string; params: Record<string, unknown> }> = [];

function client() {
  return {
    auth: { getUser: async () => ({ data: { user }, error: user ? null : { message: 'no session' } }) },
    from: (table: string) => db.from(table),
    rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args),
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => client() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client() } });
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      subscriptions: {
        retrieve: async () => current,
        update: async (id: string, params: Record<string, unknown>) => {
          updates.push({ id, params });
          // Apply what the tests read back.
          const next = structuredClone(current) as typeof current & Record<string, unknown>;
          const meta = (params.metadata ?? {}) as Record<string, string>;
          next.metadata = Object.fromEntries(
            Object.entries({ ...next.metadata, ...meta }).filter(([, v]) => v !== ''),
          ) as typeof next.metadata;
          if ('pause_collection' in params) {
            next.pause_collection = params.pause_collection === '' ? null : (params.pause_collection as typeof next.pause_collection);
          }
          if (params.cancel_at === '') {
            next.cancel_at = null;
            next.cancel_at_period_end = false;
          }
          if (params.cancel_at_period_end === true) next.cancel_at_period_end = true;
          if (Array.isArray(params.items)) next.items.data[0].price.id = (params.items[0] as { price: string }).price;
          current = next;
          return next;
        },
      },
    },
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const pauseRoute = await import('./pause/route.ts');
const downgradeRoute = await import('./downgrade/route.ts');

/** A Pro monthly subscription whose period ends in 10 days. */
function proSub(overrides: Parameters<typeof subscriptionFixture>[0] = {}) {
  const now = Math.floor(Date.now() / 1000);
  return subscriptionFixture({
    periodStart: new Date((now - 20 * 86_400) * 1000).toISOString(),
    periodEnd: new Date((now + 10 * 86_400) * 1000).toISOString(),
    ...overrides,
    metadata: { user_id: OWNER, ...(overrides.metadata ?? {}) },
  });
}

function seed(options: { email?: string; pause?: string; downgrade?: string } = {}) {
  db = new FakeSupabase();
  updates = [];
  user = { id: OWNER, email: options.email ?? 'owner@example.test' };
  if (options.pause === undefined) process.env.BILLING_PAUSE_ENABLED = 'true';
  else process.env.BILLING_PAUSE_ENABLED = options.pause;
  if (options.downgrade === undefined) process.env.BILLING_DOWNGRADE_ENABLED = 'true';
  else process.env.BILLING_DOWNGRADE_ENABLED = options.downgrade;
  current = proSub();
  db.seed('user_billing', [
    { user_id: OWNER, plan: 'solo', subscription_status: 'active', stripe_customer_id: 'cus_test', stripe_subscription_id: 'sub_test', inbox_keep_order: null },
  ]);
  db.seed('workspaces', [{ id: 'ws-owner', owner_id: OWNER, deleted_at: null, created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('inboxes', [
    { id: INBOX_A, workspace_id: 'ws-owner', email_address: 'a@example.test', created_at: '2026-01-02T00:00:00Z', parked_at: null, deleted_at: null },
    { id: INBOX_B, workspace_id: 'ws-owner', email_address: 'b@example.test', created_at: '2026-01-01T00:00:00Z', parked_at: null, deleted_at: null },
  ]);
  db.onRpc('workspace_inbox_activity', () => ({ data: [{ inbox_id: INBOX_A, calls: 9, last_success_at: null }], error: null }));
}

async function call(route: typeof pauseRoute, body: unknown) {
  const request = new Request('https://mcpemails.test/api/billing/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await route.POST(request as unknown as Parameters<typeof route.POST>[0]);
  return { status: response.status, body: await response.json() };
}

function emails() {
  return db.table('billing_email_sends').map((r) => `${r.template}:${r.cancelled_at ? 'cancelled' : 'open'}`);
}

// ── Auth, flags, ownership ──────────────────────────────────────────────────

test('signed out is 401 on both routes', async () => {
  seed();
  user = null;
  assert.equal((await call(pauseRoute, { action: 'quote' })).status, 401);
  assert.equal((await call(downgradeRoute, { action: 'quote' })).status, 401);
});

test('flags off: 404 for a customer, open for an internal account', async () => {
  seed({ pause: '', downgrade: '' });
  assert.equal((await call(pauseRoute, { action: 'quote' })).status, 404);
  assert.equal((await call(downgradeRoute, { action: 'quote' })).status, 404);
  seed({ pause: '', downgrade: '', email: 'staff@mcpemails.com' });
  assert.equal((await call(pauseRoute, { action: 'quote' })).status, 200);
  assert.equal((await call(downgradeRoute, { action: 'quote' })).status, 200);
});

test('a subscription of another customer, or naming another user, is refused', async () => {
  seed();
  current = proSub({ customer: 'cus_someone_else' });
  assert.equal((await call(pauseRoute, { action: 'pause', months: 1, confirm: true })).status, 403);
  current = proSub({ metadata: { user_id: 'another-user' } });
  assert.equal((await call(downgradeRoute, { action: 'confirm', confirm: true })).status, 403);
  assert.equal(updates.length, 0);
});

test('no subscription on the row is a 409', async () => {
  seed();
  db.table('user_billing')[0].stripe_subscription_id = null;
  assert.equal((await call(pauseRoute, { action: 'quote' })).body.error_code, 'no_subscription');
});

// ── Pause ───────────────────────────────────────────────────────────────────

test('pause: the quote, then nothing without confirm === true, then the update', async () => {
  seed();
  const quote = await call(pauseRoute, { action: 'quote' });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.canPause, true);
  assert.deepEqual(quote.body.pauseOptions.map((o: { months: number }) => o.months), [1, 2, 3]);
  assert.equal(quote.body.amountCents, 1500);
  assert.equal(quote.body.inboxes.cap, 1);
  assert.deepEqual(quote.body.inboxes.inboxes.filter((i: { keep: boolean }) => i.keep).map((i: { id: string }) => i.id), [INBOX_A]);

  const unconfirmed = await call(pauseRoute, { action: 'pause', months: 2 });
  assert.equal(unconfirmed.body.confirmation_required, true);
  const truthy = await call(pauseRoute, { action: 'pause', months: 2, confirm: 'true' });
  assert.equal(truthy.body.confirmation_required, true, 'only the boolean confirms');
  assert.equal(updates.length, 0);

  const done = await call(pauseRoute, { action: 'pause', months: 2, keepInboxIds: [INBOX_B], confirm: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.changed, true);
  assert.equal(updates.length, 1);
  const params = updates[0].params as { pause_collection: { behavior: string; resumes_at: number }; metadata: Record<string, string> };
  assert.equal(params.pause_collection.behavior, 'void');
  assert.equal(params.metadata.mcpe_pause_months, '2');
  assert.equal('cancel_at' in params, false);
  assert.deepEqual(db.table('user_billing')[0].inbox_keep_order, [INBOX_B]);
  assert.deepEqual(emails().sort(), ['pause_ending_3:open', 'pause_started:open']);
  const reminder = db.table('billing_email_sends').find((r) => r.template === 'pause_ending_3')!;
  const billsAt = params.pause_collection.resumes_at + 3600;
  assert.equal(reminder.scope_key, `sub_test:${billsAt}`);
  assert.equal(new Date(String(reminder.send_after)).getTime(), (billsAt - 3 * 86_400) * 1000);
  assert.ok(db.table('product_funnel_events').some((r) => r.stage === 'pause_started' && r.category === 'solo'));
});

test('pause from a scheduled cancel clears it and cancels the cancellation emails', async () => {
  seed();
  current = proSub({ cancelAtPeriodEnd: true });
  db.seed('billing_email_sends', [
    { stripe_customer_id: 'cus_test', template: 'cancel_ask', scope_key: 'sub_test:1', recipient: 'x', send_after: new Date().toISOString(), sent_at: null, cancelled_at: null },
    { stripe_customer_id: 'cus_test', template: 'winback_14', scope_key: 'sub_test:1', recipient: 'x', send_after: new Date().toISOString(), sent_at: null, cancelled_at: null },
  ]);
  await call(pauseRoute, { action: 'pause', months: 1, confirm: true });
  assert.equal(updates[0].params.cancel_at, '');
  assert.ok(emails().includes('cancel_ask:cancelled'));
  assert.ok(emails().includes('winback_14:cancelled'));
  const receipt = db.table('billing_email_sends').find((r) => r.template === 'pause_started')!;
  assert.equal((receipt.payload as { replacedCancel: boolean }).replacedCancel, true);
});

test('annual and Business subscriptions cannot pause', async () => {
  seed();
  current = proSub({ price: PRICES.proYear });
  const annual = await call(pauseRoute, { action: 'pause', months: 1, confirm: true });
  assert.equal(annual.status, 409);
  assert.equal(annual.body.error_code, 'not_monthly');
  current = proSub({ price: PRICES.businessMonth });
  assert.equal((await call(pauseRoute, { action: 'quote' })).body.pauseRefusal, 'plan_not_eligible');
  assert.equal(updates.length, 0);
});

test('extend moves the reminder; resume early cancels it', async () => {
  seed();
  await call(pauseRoute, { action: 'pause', months: 1, confirm: true });
  const first = db.table('billing_email_sends').find((r) => r.template === 'pause_ending_3')!.scope_key;

  const extended = await call(pauseRoute, { action: 'extend', months: 2, confirm: true });
  assert.equal(extended.status, 200);
  const reminders = db.table('billing_email_sends').filter((r) => r.template === 'pause_ending_3');
  assert.equal(reminders.length, 2);
  assert.ok(reminders.find((r) => r.scope_key === first)!.cancelled_at, 'the old date is cancelled');
  assert.equal(reminders.filter((r) => !r.cancelled_at).length, 1);
  assert.equal((updates[1].params.metadata as Record<string, string>).mcpe_pause_months, '3');

  // The cap: 3 months used, nothing left to extend.
  assert.equal((await call(pauseRoute, { action: 'extend', months: 1, confirm: true })).status, 409);

  const resumed = await call(pauseRoute, { action: 'resume_early', confirm: true });
  assert.equal(resumed.status, 200);
  assert.equal(updates.at(-1)!.params.pause_collection, '', 'a pause that has not started is removed');
  assert.equal(db.table('billing_email_sends').filter((r) => r.template === 'pause_ending_3' && !r.cancelled_at).length, 0);
  assert.ok(db.table('product_funnel_events').some((r) => r.stage === 'pause_resumed' && r.category === 'early'));
});

test('an unknown action is a 400', async () => {
  seed();
  assert.equal((await call(pauseRoute, { action: 'delete_everything' })).status, 400);
});

// ── Downgrade ───────────────────────────────────────────────────────────────

test('downgrade: quote, handshake, then the swap with proration none', async () => {
  seed();
  const quote = await call(downgradeRoute, { action: 'quote' });
  assert.equal(quote.body.canDowngrade, true);
  assert.equal(quote.body.downgrade.toPlan, 'personal');
  assert.equal(quote.body.downgrade.amountCents, 900);
  assert.equal(quote.body.inboxes.cap, 3);
  assert.equal(quote.body.inboxes.overCap, false);

  assert.equal((await call(downgradeRoute, { action: 'confirm' })).body.confirmation_required, true);
  assert.equal(updates.length, 0);

  const done = await call(downgradeRoute, { action: 'confirm', keepInboxIds: [INBOX_A], confirm: true });
  assert.equal(done.status, 200);
  assert.deepEqual(updates[0].params.items, [{ id: 'si_plan', price: PRICES.personalMonth }]);
  assert.equal(updates[0].params.proration_behavior, 'none');
  assert.equal((updates[0].params.metadata as Record<string, string>).mcpe_downgrade_from, 'solo');
  assert.ok(done.body.pending, 'the response shows the booked switch');
  assert.ok(db.table('product_funnel_events').some((r) => r.stage === 'downgrade_scheduled'));
  assert.ok(db.table('product_funnel_events').some((r) => r.stage === 'plan_downgraded' && r.outcome === 'started'));

  const undo = await call(downgradeRoute, { action: 'undo', confirm: true });
  assert.equal(undo.status, 200);
  assert.deepEqual(updates[1].params.items, [{ id: 'si_plan', price: PRICES.proMonth }]);
  assert.equal(updates[1].params.proration_behavior, 'none');
  assert.ok(db.table('product_funnel_events').some((r) => r.stage === 'downgrade_undone'));
});

test('a Personal subscription cannot switch to Personal', async () => {
  seed();
  current = proSub({ price: PRICES.personalMonth });
  const result = await call(downgradeRoute, { action: 'confirm', confirm: true });
  assert.equal(result.status, 409);
  assert.equal(result.body.error_code, 'plan_not_eligible');
});

test('switch to Free is a cancel at period end, marked for the cancel email', async () => {
  seed();
  const result = await call(downgradeRoute, { action: 'switch_free', confirm: true });
  assert.equal(result.status, 200);
  assert.equal(updates[0].params.cancel_at_period_end, true);
  const end = current.items.data[0].current_period_end;
  assert.equal((updates[0].params.metadata as Record<string, string>).mcpe_switch_free, String(end));
  assert.equal((await call(downgradeRoute, { action: 'switch_free', confirm: true })).status, 409, 'already stopping');
});
