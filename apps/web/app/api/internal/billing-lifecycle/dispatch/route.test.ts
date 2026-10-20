// ---------------------------------------------------------------------------
// The billing lifecycle dispatcher, end to end through POST, for recipients
// who deleted their account.
//
// A subscription cancelled from the Stripe dashboard on an account that was
// already deleted carries no 'account_deleted' comment, so the webhook queued
// cancel_ask (transactional, due at once) plus both win-backs to someone who
// had deleted everything. The dispatcher now cancels every such row before it
// sends, whatever the template. This file pins that at the route: nothing
// reaches Resend for a deleted account, a live account still gets its mail,
// and a failed auth read leaves the row for the next tick rather than guessing.
//
// Only the I/O is stubbed: Supabase is the in-memory fake from
// src/lib/billing/fake-supabase.ts plus the claim RPC and auth.admin, Stripe is
// the one call the freshness check makes, and Resend records what it was
// asked to send.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/internal/billing-lifecycle/dispatch/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';

process.env.DISPATCH_SECRET = 'dispatch_unit_secret';
process.env.BILLING_LIFECYCLE_EMAILS = 'on';
process.env.RESEND_API_KEY = 're_unit_test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const LIVE = '00000000-0000-4000-8000-0000000011fe';
const DELETED = '00000000-0000-4000-8000-00000000de1e';
const BANNED = '00000000-0000-4000-8000-00000000ba11';
const FLAKY = '00000000-0000-4000-8000-00000000f1a4';

let db = new FakeSupabase();
let sent: Array<{ to: string; subject: string }> = [];

const authUsers: Record<string, { banned_until: string | null; app_metadata: Record<string, unknown> }> = {
  [LIVE]: { banned_until: null, app_metadata: {} },
  [DELETED]: { banned_until: '2126-10-19T00:00:00.000Z', app_metadata: { deleted_at: '2026-10-01T00:00:00.000Z' } },
  [BANNED]: { banned_until: '2126-10-19T00:00:00.000Z', app_metadata: {} },
};

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => db.from(table),
      rpc: async (fn: string) => {
        assert.equal(fn, 'claim_billing_emails');
        return { data: db.table('billing_email_sends').filter((r) => !r.sent_at && !r.cancelled_at), error: null };
      },
      auth: {
        admin: {
          getUserById: async (id: string) => {
            if (id === FLAKY) return { data: { user: null }, error: { message: 'timeout', status: 500 } };
            const user = authUsers[id];
            return user
              ? { data: { user }, error: null }
              : { data: { user: null }, error: { message: 'User not found', status: 404 } };
          },
        },
      },
    }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      // Every subscription in this file has ended, so the freshness check
      // always says send. Only the account question can stop a row here.
      subscriptions: { retrieve: async () => ({ status: 'canceled', cancel_at_period_end: false, cancel_at: null }) },
      invoices: { retrieve: async () => ({ status: 'open', amount_remaining: 900 }) },
      paymentMethods: { retrieve: async () => ({ customer: null }) },
    },
  },
});

nodeMock.module('resend', {
  namedExports: {
    Resend: class {
      emails = {
        send: async (message: { to: string; subject: string }) => {
          sent.push({ to: message.to, subject: message.subject });
          return { data: { id: `re_${sent.length}` }, error: null };
        },
      };
    },
  },
});

const { POST } = await import('./route.ts');

let rowSeq = 0;

function row(userId: string | null, template: string, overrides: Record<string, unknown> = {}) {
  rowSeq += 1;
  return {
    id: rowSeq,
    stripe_customer_id: `cus_${rowSeq}`,
    workspace_id: null,
    period_start: null,
    user_id: userId,
    recipient: `person${rowSeq}@example.test`,
    template,
    category: template.startsWith('winback_') ? 'marketing' : 'transactional',
    scope_key: `sub_${rowSeq}`,
    payload: { planId: 'personal', amountCents: 900, currency: 'usd', periodEnd: '2026-10-19T00:00:00.000Z' },
    attempts: 1,
    sent_at: null,
    cancelled_at: null,
    cancel_reason: null,
    ...overrides,
  };
}

function seed(rows: Array<ReturnType<typeof row>>) {
  db = new FakeSupabase();
  sent = [];
  db.seed('billing_email_sends', rows);
  db.seed('users', [LIVE, DELETED, BANNED, FLAKY].map((id) => ({
    id,
    unsubscribed_at: null,
    unsubscribed_categories: [],
    unsubscribe_token: `tok_${id.slice(-4)}`,
  })));
}

async function dispatch() {
  const request = new Request('https://mcpemails.test/api/internal/billing-lifecycle/dispatch', {
    method: 'POST',
    headers: { 'x-dispatch-secret': 'dispatch_unit_secret' },
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}

function stored(id: number) {
  const found = db.table('billing_email_sends').find((r) => r.id === id);
  assert.ok(found, `row ${id} is seeded`);
  return found;
}

test('a deleted account gets none of the cancellation series, transactional included', async () => {
  const rows = [row(DELETED, 'cancel_ask'), row(DELETED, 'winback_14'), row(DELETED, 'winback_30')];
  seed(rows);

  const result = await dispatch();

  assert.equal(result.status, 200);
  assert.equal(result.body.cancelled, 3);
  assert.equal(result.body.sent, 0);
  assert.deepEqual(sent, []);
  for (const r of rows) {
    assert.equal(stored(r.id).cancel_reason, 'account_deleted', r.template);
    assert.ok(stored(r.id).cancelled_at, r.template);
    assert.equal(stored(r.id).sent_at, null, r.template);
  }
});

test('a ban alone is enough, and so is an auth user that is gone', async () => {
  const banned = row(BANNED, 'dunning_1', { scope_key: 'in_banned' });
  const gone = row('00000000-0000-4000-8000-00000000901e', 'cancel_ask');
  seed([banned, gone]);

  await dispatch();

  assert.deepEqual(sent, []);
  assert.equal(stored(banned.id).cancel_reason, 'account_deleted');
  assert.equal(stored(gone.id).cancel_reason, 'account_deleted');
});

test('a row queued without a user id is checked through its Stripe customer', async () => {
  const orphan = row(null, 'cancel_ask', { stripe_customer_id: 'cus_deleted_owner' });
  seed([orphan]);
  db.seed('user_billing', [{ user_id: DELETED, stripe_customer_id: 'cus_deleted_owner' }]);

  await dispatch();

  assert.deepEqual(sent, []);
  assert.equal(stored(orphan.id).cancel_reason, 'account_deleted');
});

test('a live account still gets its cancellation question', async () => {
  const live = row(LIVE, 'cancel_ask');
  seed([live]);

  const result = await dispatch();

  assert.equal(result.body.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, live.recipient);
  assert.ok(stored(live.id).sent_at);
  assert.equal(stored(live.id).cancel_reason, null);
});

test('a failed auth read sends nothing and cancels nothing; the next tick asks again', async () => {
  const flaky = row(FLAKY, 'cancel_ask');
  seed([flaky]);

  const result = await dispatch();

  assert.deepEqual(sent, []);
  assert.equal(result.body.cancelled, 0);
  assert.equal(stored(flaky.id).cancelled_at, null);
  assert.equal(stored(flaky.id).sent_at, null);
});
