// ---------------------------------------------------------------------------
// /api/billing/feedback end to end through the exported handlers, every method.
//
// Stubbed: the Supabase SDK (one in-memory database behind both the service
// client and the feedback client), the cookie session and the rate limiter.
// The token, validation, the upsert with its conflict target and the funnel
// row run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/billing/feedback/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'cd'.repeat(32);
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const writes: Array<{ table: string; op: string; row: Row; onConflict?: string }> = [];
let sessionUser: string | null = null;
let rateLimited = false;
let failUpsert = false;

function reset() {
  for (const key of Object.keys(tables)) delete tables[key];
  writes.length = 0;
  sessionUser = null;
  rateLimited = false;
  failUpsert = false;
  tables.user_billing = [
    {
      user_id: 'u-email',
      stripe_customer_id: 'cus_Email1',
      stripe_subscription_id: 'sub_Email1',
      current_period_end: '2026-11-10T00:00:00+00:00',
    },
    {
      user_id: 'u-card',
      stripe_customer_id: 'cus_Card1',
      stripe_subscription_id: 'sub_Card1',
      current_period_end: '2026-12-01T12:00:00+00:00',
    },
    { user_id: 'u-free', stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null },
  ];
  tables.workspaces = [
    { id: 'ws-email', owner_id: 'u-email', deleted_at: null, created_at: '2026-01-01' },
    { id: 'ws-card', owner_id: 'u-card', deleted_at: null, created_at: '2026-01-01' },
  ];
  tables.cancellation_feedback = [];
  tables.product_funnel_events = [];
}

function fakeDb() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {};
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.insert = (row: Row) => {
        writes.push({ table, op: 'insert', row });
        (tables[table] ??= []).push(row);
        return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) };
      };
      b.upsert = (row: Row, opts: { onConflict?: string }) => {
        writes.push({ table, op: 'upsert', row, onConflict: opts?.onConflict });
        if (failUpsert) {
          return { then: (resolve: (v: unknown) => unknown) => resolve({ error: { code: '23514', message: 'check' } }) };
        }
        const keys = (opts?.onConflict ?? '').split(',');
        const list = (tables[table] ??= []);
        const existing = list.find((r) => keys.every((k) => (r[k] ?? null) === (row[k] ?? null)));
        if (existing) Object.assign(existing, row);
        else list.push({ id: `fb${list.length + 1}`, ...row });
        return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) };
      };
      return b;
    },
  };
}

nodeMock.module('@supabase/supabase-js', { namedExports: { createClient: () => fakeDb() } });
nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: sessionUser ? { id: sessionUser } : null }, error: null }) },
    }),
  },
});
nodeMock.module('@/lib/rate-limit', { namedExports: { checkRateLimit: async () => rateLimited } });

const route = await import('./route.ts');
const { issueFeedbackToken } = await import('@/lib/billing/feedback-token');

const URL = 'https://mcpemails.com/api/billing/feedback';
const EMAIL_SCOPE = { subscriptionId: 'sub_Email1', customerId: 'cus_Email1', periodEnd: 1_794_268_800 };

function post(body: unknown) {
  return route.POST(
    new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

test('every method other than POST is a 405 naming POST and writes nothing', async () => {
  reset();
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const res = await route[method]();
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST', method);
  }
  assert.equal(writes.length, 0, 'a link scanner prefetching the endpoint records nothing');
});

test('an email answer is stored against the cancellation the token names, with a funnel row', async () => {
  reset();
  const res = await post({ t: issueFeedbackToken(EMAIL_SCOPE), reason: 'too_expensive' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const [row] = tables.cancellation_feedback;
  assert.equal(row.subscription_id, 'sub_Email1');
  assert.equal(row.stripe_customer_id, 'cus_Email1');
  assert.equal(row.period_end, new Date(EMAIL_SCOPE.periodEnd * 1000).toISOString());
  assert.equal(row.user_id, 'u-email');
  assert.equal(row.reason, 'too_expensive');
  assert.equal(row.detail, null);
  assert.equal(row.source, 'cancel_email');
  assert.equal(writes.find((w) => w.table === 'cancellation_feedback')?.onConflict, 'subscription_id,period_end');

  const [event] = tables.product_funnel_events;
  assert.equal(event.workspace_id, 'ws-email');
  assert.equal(event.stage, 'cancel_reason_submitted');
  assert.equal(event.outcome, 'success');
  assert.equal(event.category, 'too_expensive');
});

test('a resubmit replaces the answer instead of adding a row', async () => {
  reset();
  const t = issueFeedbackToken(EMAIL_SCOPE);
  assert.equal((await post({ t, reason: 'too_expensive' })).status, 200);
  assert.equal((await post({ t, reason: 'other', detail: '  needed IMAP IDLE  ' })).status, 200);
  assert.equal(tables.cancellation_feedback.length, 1);
  assert.equal(tables.cancellation_feedback[0].reason, 'other');
  assert.equal(tables.cancellation_feedback[0].detail, 'needed IMAP IDLE');
});

test('typed text is kept for Other only, and cut to 500 characters', async () => {
  reset();
  const t = issueFeedbackToken(EMAIL_SCOPE);
  await post({ t, reason: 'reliability', detail: 'stray text' });
  assert.equal(tables.cancellation_feedback[0].detail, null);
  await post({ t, reason: 'other', detail: 'x'.repeat(900) });
  assert.equal(String(tables.cancellation_feedback[0].detail).length, 500);
});

test('a bad, forged or expired token is a 401 and writes nothing', async () => {
  reset();
  const expired = issueFeedbackToken(EMAIL_SCOPE, Date.now() - 61 * 24 * 60 * 60 * 1000);
  const good = issueFeedbackToken(EMAIL_SCOPE);
  for (const t of ['', 'nonsense', expired, `${good}x`, 42]) {
    const res = await post({ t, reason: 'too_expensive' });
    assert.equal(res.status, 401, String(t));
    assert.equal((await res.json()).error, 'invalid_token');
  }
  assert.equal(writes.length, 0);
});

test('a reason outside the seven is a 400 and writes nothing', async () => {
  reset();
  const t = issueFeedbackToken(EMAIL_SCOPE);
  for (const reason of ['price', '', null, 'OTHER', ['other']]) {
    const res = await post({ t, reason });
    assert.equal(res.status, 400, String(reason));
    assert.equal((await res.json()).error, 'invalid_reason');
  }
  for (const body of ['not json', '[]', 'null']) {
    assert.equal((await post(body)).status, 400, body);
  }
  assert.equal((await post({ t, reason: 'other', detail: 'x'.repeat(9000) })).status, 400, 'oversized body');
  assert.equal(writes.length, 0);
});

test('rate limited callers get a 429 before anything is read or written', async () => {
  reset();
  rateLimited = true;
  const res = await post({ t: issueFeedbackToken(EMAIL_SCOPE), reason: 'too_expensive' });
  assert.equal(res.status, 429);
  assert.equal(writes.length, 0);
});

test('without a token, a signed-in caller answers for their own subscription (billing_card)', async () => {
  reset();
  sessionUser = 'u-card';
  const res = await post({ reason: 'temporary_need', subscriptionId: 'sub_Email1' });
  assert.equal(res.status, 200);
  const [row] = tables.cancellation_feedback;
  assert.equal(row.subscription_id, 'sub_Card1', 'read from user_billing, never from the body');
  assert.equal(row.stripe_customer_id, 'cus_Card1');
  assert.equal(row.period_end, '2026-12-01T12:00:00.000Z');
  assert.equal(row.user_id, 'u-card');
  assert.equal(row.source, 'billing_card');
  assert.equal(tables.product_funnel_events[0].workspace_id, 'ws-card');
});

test('without a token: signed out is a 401, no subscription is a 404', async () => {
  reset();
  assert.equal((await post({ reason: 'other' })).status, 401);
  sessionUser = 'u-free';
  const res = await post({ reason: 'other' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'no_subscription');
  assert.equal(writes.length, 0);
});

test('a failed write is a 500 and records no funnel row', async () => {
  reset();
  failUpsert = true;
  const res = await post({ t: issueFeedbackToken(EMAIL_SCOPE), reason: 'too_expensive' });
  assert.equal(res.status, 500);
  assert.equal(tables.product_funnel_events.length, 0);
});
