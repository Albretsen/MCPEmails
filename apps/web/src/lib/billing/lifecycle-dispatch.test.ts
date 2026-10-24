// ---------------------------------------------------------------------------
// The shared billing lifecycle dispatcher: the claim is exclusive.
//
// A row due now is dispatched twice over: by the immediate kick (by id, after
// the response that queued it) and by the five-minute cron (a full sweep).
// Both may run at the same moment. These tests pin that only one of them can
// claim the row, so the customer gets one email.
//
// The fake answers `claim_billing_emails` with the SQL function's predicate,
// and its conditional UPDATE re-checks every filter at write time, as Postgres
// re-checks a WHERE after waiting on a row lock.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs src/lib/billing/lifecycle-dispatch.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase, asClient } from '@/lib/billing/fake-supabase';

process.env.BILLING_LIFECYCLE_EMAILS = 'on';
process.env.RESEND_API_KEY = 're_unit_test';
process.env.DISPATCH_SECRET = 'dispatch_unit_secret';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let sent: Array<{ to: string; subject: string }> = [];
nodeMock.module('resend', {
  namedExports: {
    Resend: class {
      emails = {
        send: async (message: { to: string; subject: string }) => {
          // Yield, so a second dispatcher really does run while this one sends.
          await new Promise((resolve) => setTimeout(resolve, 5));
          sent.push({ to: message.to, subject: message.subject });
          return { data: { id: `re_${sent.length}` }, error: null };
        },
      };
    },
  },
});

const { claimRowsById, dispatchBillingEmails } = await import('./lifecycle-dispatch.ts');

const stripe = {
  subscriptions: { retrieve: async () => ({ status: 'canceled', cancel_at_period_end: false, cancel_at: null }) },
  invoices: { retrieve: async () => ({ status: 'open', amount_remaining: 900 }) },
  paymentMethods: { retrieve: async () => ({ customer: null }) },
};

const LEASE_MS = 15 * 60 * 1000;

/** The fake plus claim_billing_emails() and the auth read the dispatcher makes. */
function setup(overrides: Record<string, unknown> = {}) {
  sent = [];
  const fake = new FakeSupabase();
  fake.seed('billing_email_sends', [
    {
      stripe_customer_id: 'cus_1',
      workspace_id: null,
      period_start: null,
      user_id: null,
      recipient: 'person@example.test',
      template: 'cancel_ask',
      category: 'transactional',
      scope_key: 'sub_1:1790000000',
      payload: { planId: 'personal', amountCents: 900, currency: 'usd', periodEnd: '2026-11-19T00:00:00.000Z' },
      send_after: new Date(Date.now() - 1000).toISOString(),
      attempts: 0,
      claimed_at: null,
      sent_at: null,
      cancelled_at: null,
      cancel_reason: null,
      ...overrides,
    },
  ]);
  // Mirrors 20260902130000_billing_lifecycle_emails.sql: one statement that
  // claims and returns, skipping claimed rows (FOR UPDATE SKIP LOCKED).
  fake.onRpc('claim_billing_emails', () => {
    const now = Date.now();
    const due = fake
      .table('billing_email_sends')
      .filter(
        (r) =>
          r.sent_at == null &&
          r.cancelled_at == null &&
          Date.parse(String(r.send_after)) <= now &&
          Number(r.attempts) < 5 &&
          (r.claimed_at == null || Date.parse(String(r.claimed_at)) < now - LEASE_MS),
      );
    for (const r of due) {
      r.claimed_at = new Date(now).toISOString();
      r.attempts = Number(r.attempts) + 1;
    }
    return { data: due.map((r) => ({ ...r })), error: null };
  });
  const db = Object.assign(fake, {
    auth: { admin: { getUserById: async () => ({ data: { user: { banned_until: null, app_metadata: {} } }, error: null }) } },
  });
  return { fake, db: asClient(db) };
}

function only(fake: FakeSupabase) {
  const [row] = fake.table('billing_email_sends');
  return row;
}

test('two narrow claims of the same row: exactly one wins', async () => {
  const { fake, db } = setup();
  const id = Number(only(fake).id);

  const [a, b] = await Promise.all([claimRowsById(db, [id]), claimRowsById(db, [id])]);

  assert.equal(a.length + b.length, 1);
  assert.equal(only(fake).attempts, 1);
});

test('a kick and the cron at once: one claim, one email', async () => {
  const { fake, db } = setup();
  const id = Number(only(fake).id);

  const [kick, cron] = await Promise.all([
    dispatchBillingEmails({ db, stripe, ids: [id] }),
    dispatchBillingEmails({ db, stripe }),
  ]);

  assert.ok(kick.ok && 'claimed' in kick);
  assert.ok(cron.ok && 'claimed' in cron);
  assert.equal(kick.claimed + cron.claimed, 1);
  assert.equal(sent.length, 1);
  assert.ok(only(fake).sent_at);
});

test('two kicks for the same row send it once', async () => {
  const { fake, db } = setup();
  const id = Number(only(fake).id);

  await Promise.all([
    dispatchBillingEmails({ db, stripe, ids: [id] }),
    dispatchBillingEmails({ db, stripe, ids: [id] }),
  ]);

  assert.equal(sent.length, 1);
});

test('a kick does not take a row that is not due, already claimed, sent, or out of attempts', async () => {
  const future = setup({ send_after: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  assert.deepEqual(await claimRowsById(future.db, [Number(only(future.fake).id)]), []);

  const claimed = setup({ claimed_at: new Date().toISOString() });
  assert.deepEqual(await claimRowsById(claimed.db, [Number(only(claimed.fake).id)]), []);

  const done = setup({ sent_at: new Date().toISOString() });
  assert.deepEqual(await claimRowsById(done.db, [Number(only(done.fake).id)]), []);

  const spent = setup({ attempts: 5 });
  assert.deepEqual(await claimRowsById(spent.db, [Number(only(spent.fake).id)]), []);
});

test('the kill switch: off claims nothing, queue_only sends nothing and releases the claim', async () => {
  const { fake, db } = setup();
  const id = Number(only(fake).id);

  process.env.BILLING_LIFECYCLE_EMAILS = 'off';
  try {
    const off = await dispatchBillingEmails({ db, stripe, ids: [id] });
    assert.ok('skipped' in off);
    assert.equal(only(fake).attempts, 0);

    process.env.BILLING_LIFECYCLE_EMAILS = 'queue_only';
    const dry = await dispatchBillingEmails({ db, stripe, ids: [id] });
    assert.ok(dry.ok && 'dryRun' in dry);
    assert.equal(dry.dryRun, 1);
    assert.equal(sent.length, 0);
    assert.equal(only(fake).claimed_at, null);
    assert.equal(only(fake).attempts, 0);
  } finally {
    process.env.BILLING_LIFECYCLE_EMAILS = 'on';
  }
});

test('a failed claim read is reported, never thrown', async () => {
  const { fake, db } = setup();
  fake.failOnce('billing_email_sends', { message: 'boom' });

  const outcome = await dispatchBillingEmails({ db, stripe, ids: [Number(only(fake).id)] });

  assert.deepEqual(outcome, { ok: false, error: 'claim_failed' });
  assert.equal(sent.length, 0);
});
