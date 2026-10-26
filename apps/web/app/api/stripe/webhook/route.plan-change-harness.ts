/**
 * TEST SUPPORT ONLY. The Stripe webhook end to end through POST, for the
 * pause and downgrade tests (route.pause.test.ts, route.downgrade.test.ts).
 * Same approach as route.plan-limit-pause.test.ts: only I/O is stubbed, the
 * Supabase stand-in keeps state, and the ledger enforces the unique event id.
 *
 * Import this module FIRST in a test file: it sets the environment and
 * registers the module mocks before the route is loaded.
 */
import { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { PRICES, setPlanChangeTestPrices, subscriptionFixture, type FixtureOptions } from '@/lib/billing/plan-change-fixtures';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plan_change_unit';
delete process.env.QUEUEY_SIGNING_SECRET;
process.env.BILLING_LIFECYCLE_EMAILS = 'off';
setPlanChangeTestPrices();

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

export const state: {
  db: FakeSupabase;
  ledger: Set<string>;
  retrieve: Record<string, unknown> | null;
} = { db: new FakeSupabase(), ledger: new Set(), retrieve: null };

function ledgerTable() {
  let outcome: { data: unknown; error: { code: string; message: string } | null } = { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'neq', 'not', 'gt', 'limit', 'delete']) builder[name] = () => builder;
  builder.insert = (row: { event_id: string }) => {
    if (state.ledger.has(row.event_id)) {
      outcome = { data: null, error: { code: '23505', message: 'duplicate key' } };
    } else {
      state.ledger.add(row.event_id);
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
      from: (table: string) => (table === 'stripe_webhook_events' ? ledgerTable() : state.db.from(table)),
      rpc: (name: string, args: Record<string, unknown>) => state.db.rpc(name, args),
    }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString('utf8')) },
      subscriptions: { retrieve: async () => state.retrieve },
      customers: { retrieve: async () => ({ id: 'cus_test', email: 'owner@example.test' }) },
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

export const { POST } = await import('./route.ts');

export const OWNER = '00000000-0000-4000-8000-0000000000aa';
export const INBOX = {
  a: '00000000-0000-4000-8000-00000000000a',
  b: '00000000-0000-4000-8000-00000000000b',
  c: '00000000-0000-4000-8000-00000000000c',
  d: '00000000-0000-4000-8000-00000000000d',
};
export { PRICES };

/** One owner, one workspace, four inboxes (a most used), a Pro subscription row. */
export function seed(billing: Record<string, unknown> = {}) {
  state.db = new FakeSupabase();
  state.ledger = new Set();
  state.retrieve = null;
  const db = state.db;
  db.seed('workspaces', [
    { id: 'ws-owner', owner_id: OWNER, plan: 'solo', deleted_at: null, created_at: '2026-01-01T00:00:00Z', pro_unlimited_inboxes_exempt: false },
    { id: 'ws-stranger', owner_id: 'someone-else', plan: 'free', deleted_at: null, created_at: '2026-01-01T00:00:00Z', pro_unlimited_inboxes_exempt: false },
  ]);
  db.seed('inboxes', [
    { id: INBOX.a, workspace_id: 'ws-owner', email_address: 'a@example.test', created_at: '2026-01-04T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
    { id: INBOX.b, workspace_id: 'ws-owner', email_address: 'b@example.test', created_at: '2026-01-01T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
    { id: INBOX.c, workspace_id: 'ws-owner', email_address: 'c@example.test', created_at: '2026-01-02T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
    { id: INBOX.d, workspace_id: 'ws-owner', email_address: 'd@example.test', created_at: '2026-01-03T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
    { id: 'stranger-inbox', workspace_id: 'ws-stranger', email_address: 's@example.test', created_at: '2026-01-01T00:00:00Z', parked_at: null, parked_reason: null, deleted_at: null },
  ]);
  db.seed('user_billing', [
    {
      user_id: OWNER,
      plan: 'solo',
      subscription_status: 'active',
      stripe_customer_id: 'cus_test',
      stripe_subscription_id: 'sub_test',
      paused_from: null,
      pause_resumes_at: null,
      pending_plan: null,
      pending_plan_effective_at: null,
      inbox_keep_order: null,
      pause_history: [],
      ...billing,
    },
  ]);
  db.onRpc('workspace_inbox_activity', () => ({ data: [{ inbox_id: INBOX.a, calls: 50, last_success_at: null }], error: null }));
}

let seq = 0;

/** Seconds from now. */
export function inSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

export const DAY = 86_400;

export function sub(options: FixtureOptions) {
  return subscriptionFixture({ customer: 'cus_test', ...options, metadata: { user_id: OWNER, ...(options.metadata ?? {}) } });
}

/** Deliver one event. `id` reuses an event id to model a redelivery. */
export async function deliver(type: string, object: unknown, id?: string) {
  seq += 1;
  const event = { id: id ?? `evt_plan_change_${seq}`, type, created: 1_790_000_000 + seq, data: { object } };
  const request = new Request('https://mcpemails.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=stub' },
    body: JSON.stringify(event),
  });
  const response = await POST(request as unknown as Parameters<typeof POST>[0]);
  return { id: event.id, status: response.status, body: await response.json() };
}

export function billingRow() {
  return state.db.table('user_billing').find((r) => r.user_id === OWNER)!;
}

export function ownerPlan() {
  return state.db.table('workspaces').find((w) => w.id === 'ws-owner')!.plan;
}

export function parkedIds() {
  return state.db
    .table('inboxes')
    .filter((i) => i.workspace_id === 'ws-owner' && i.parked_at)
    .map((i) => i.id)
    .sort();
}

export function funnelStages() {
  return state.db.table('product_funnel_events').map((r) => `${r.stage}:${r.category}`);
}
