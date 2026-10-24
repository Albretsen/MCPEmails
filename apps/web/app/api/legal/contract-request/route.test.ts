// ---------------------------------------------------------------------------
// /api/legal/contract-request end to end through the exported handlers, every
// method.
//
// Stubbed: the service-role Supabase client (an in-memory support_tickets)
// and the Resend SDK. Validation, the form token, rate limits, email
// composition and the row-first-then-send flow run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/legal/contract-request/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'cd'.repeat(32);
process.env.RESEND_API_KEY = 're_test_dummy';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.com';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Ticket = Record<string, unknown> & { id: string; ref: string; created_at: string };
const tickets: Ticket[] = [];
let failInsert = false;
const sends: Array<{ payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];

function fakeServiceClient() {
  return {
    from(_table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let op: 'select' | 'count' | 'insert' | 'update' = 'select';
      let payload: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) op = 'count';
        return b;
      };
      b.insert = (row: Record<string, unknown>) => ((op = 'insert'), (payload = row), b);
      b.update = (row: Record<string, unknown>) => ((op = 'update'), (payload = row), b);
      b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
      b.gte = (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b);
      const rows = () => tickets.filter((r) => filters.every((f) => f(r)));
      b.single = async () => {
        if (failInsert) return { data: null, error: { code: '23514' } };
        const row = {
          id: `t${tickets.length + 1}`,
          ref: `MCPE-${1001 + tickets.length}`,
          created_at: new Date().toISOString(),
          ...payload,
        } as Ticket;
        tickets.push(row);
        return { data: { id: row.id, ref: row.ref }, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (op === 'count') return resolve({ count: rows().length, error: null });
        if (op === 'update') {
          for (const r of rows()) Object.assign(r, payload);
          return resolve({ data: null, error: null });
        }
        return resolve({ data: rows(), error: null });
      };
      return b;
    },
  };
}

class FakeResend {
  emails = {
    send: async (payload: Record<string, unknown>, opts: Record<string, unknown>) => {
      sends.push({ payload, opts });
      return { data: { id: 'em' }, error: null };
    },
  };
}

nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: fakeServiceClient } });
nodeMock.module('resend', { namedExports: { Resend: FakeResend } });

const route = await import('./route.ts');
const { issueSupportFormToken } = await import('@/lib/support/form-token');

const URL = 'https://mcpemails.com/api/legal/contract-request';
let ip = 1;

function post(body: Record<string, unknown>, fromIp = `203.0.113.${ip++}`) {
  return route.POST(
    new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': fromIp },
      body: JSON.stringify(body),
    }),
  );
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'cancel',
    cancelType: 'ordinary',
    name: 'Kari Nordmann',
    email: 'Kari@Example.com',
    contract: 'Pro, invoice 1234',
    locale: 'nb',
    website: '',
    formToken: issueSupportFormToken(Date.now() - 10_000),
    ...overrides,
  };
}

function reset() {
  tickets.length = 0;
  sends.length = 0;
  failInsert = false;
}

test('every method other than POST is a 405 naming POST, without a session', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const res = await route[method]();
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST', method);
  }
});

test('an ordinary cancellation is stored as a billing ticket and mails support and the customer', async () => {
  reset();
  const res = await post(body());
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.ref, 'MCPE-1001');
  assert.match(json.receivedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(tickets.length, 1);
  const row = tickets[0];
  assert.equal(row.category, 'billing');
  assert.equal(row.source, 'form_signed_out');
  assert.equal(row.email, 'kari@example.com');
  assert.equal(row.subject, 'Cancellation (ordinary)');
  const ctx = row.context as Record<string, Record<string, unknown>>;
  assert.equal(ctx.contract_request.kind, 'cancel');
  assert.equal(ctx.contract_request.locale, 'nb');
  assert.deepEqual(ctx.mailboxes, []);
  assert.ok(row.notified_at && row.confirmation_sent_at, 'both sends recorded on the row');

  assert.equal(sends.length, 2);
  const notice = sends.find((s) => s.payload.to === 'support@mcpemails.com');
  const receipt = sends.find((s) => s.payload.to === 'kari@example.com');
  assert.ok(notice && receipt);
  assert.equal(notice.payload.replyTo, 'kari@example.com');
  assert.match(String(notice.payload.subject), /^\[MCPE-1001\] CANCEL: Kari Nordmann/);
  assert.match(String(receipt.payload.subject), /cancellation is received \(MCPE-1001\)/);
  assert.match(String(receipt.payload.text), /At the earliest possible date/);
  assert.match(String(receipt.payload.text), /Received: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.equal(receipt.opts.idempotencyKey, 'contract-receipt-MCPE-1001');
});

function isoDay(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test('an ordinary cancellation without a date stores a null effective date', async () => {
  reset();
  assert.equal((await post(body())).status, 201);
  const ctx = tickets[0].context as Record<string, Record<string, unknown>>;
  assert.equal(ctx.contract_request.effective_date, null);
});

test('an ordinary cancellation on a later date carries the date to the record and both emails', async () => {
  reset();
  const date = isoDay(40);
  const res = await post(body({ effectiveDate: date }));
  assert.equal(res.status, 201);
  const ctx = tickets[0].context as Record<string, Record<string, unknown>>;
  assert.equal(ctx.contract_request.effective_date, date);
  assert.ok(String(tickets[0].message).includes(date), 'the stored record names the date');
  const receipt = sends.find((s) => s.payload.to === 'kari@example.com');
  const notice = sends.find((s) => s.payload.to === 'support@mcpemails.com');
  assert.ok(
    String(receipt?.payload.text).includes(
      `Takes effect: ${date}, or the end of the period you have already paid for if that is later`,
    ),
  );
  assert.ok(String(receipt?.payload.html).includes(date));
  assert.match(String(notice?.payload.text), new RegExp(`set cancel_at in Stripe to ${date} or the end of the paid period, whichever is later`));
});

test('today is a valid effective date', async () => {
  reset();
  assert.equal((await post(body({ effectiveDate: isoDay(0) }))).status, 201);
});

test('an effective date in the past, too far out or malformed is refused', async () => {
  reset();
  for (const effectiveDate of [isoDay(-3), isoDay(5 * 366 + 2), '2026-02-30', '24.10.2026', '2026-1-5', 20261024]) {
    const res = await post(body({ effectiveDate }));
    assert.equal(res.status, 400, String(effectiveDate));
    assert.equal((await res.json()).error, 'invalid_effective_date', String(effectiveDate));
  }
  assert.equal(tickets.length, 0);
});

test('a date sent with a withdrawal or an extraordinary cancellation is ignored', async () => {
  reset();
  const date = isoDay(40);
  assert.equal((await post(body({ kind: 'withdraw', cancelType: undefined, effectiveDate: date }))).status, 201);
  assert.equal((await post(body({ cancelType: 'extraordinary', reason: 'Service down', effectiveDate: 'nonsense' }))).status, 201);
  for (const t of tickets) {
    assert.equal((t.context as Record<string, Record<string, unknown>>).contract_request.effective_date, null);
  }
  const receipts = sends.filter((s) => s.payload.to === 'kari@example.com');
  for (const r of receipts) assert.match(String(r.payload.text), /Takes effect: Immediately/);
});

test('a withdrawal says it refunds the first charge and takes effect immediately', async () => {
  reset();
  const res = await post(body({ kind: 'withdraw', cancelType: undefined }));
  assert.equal(res.status, 201);
  assert.equal(tickets[0].subject, 'Withdrawal from contract');
  const receipt = sends.find((s) => s.payload.to === 'kari@example.com');
  assert.match(String(receipt?.payload.text), /Takes effect: Immediately/);
  assert.match(String(receipt?.payload.text), /refund the first charge in full/);
});

test('a 3-month pass withdrawal needs no subscription and is told apart from a subscription withdrawal', async () => {
  reset();
  // The handler never looks up the account, so a pass buyer with no
  // subscription goes through. A stray cancelType or reason is ignored.
  const res = await post(body({ kind: 'withdraw_pass', cancelType: 'extraordinary', reason: '', contract: '' }));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.ok, true);

  assert.equal(tickets.length, 1);
  const row = tickets[0];
  assert.equal(row.subject, 'Withdrawal from 3-month pass');
  assert.equal(row.category, 'billing');
  const ctx = row.context as Record<string, Record<string, unknown>>;
  assert.equal(ctx.contract_request.kind, 'withdraw_pass');
  assert.equal(ctx.contract_request.cancel_type, null);
  assert.equal(ctx.contract_request.contract, null);
  assert.match(String(row.message), /refund the 3-month pass payment in full/);
  assert.match(String(row.message), /no subscription to cancel/);

  assert.equal(sends.length, 2);
  const notice = sends.find((s) => s.payload.to === 'support@mcpemails.com');
  const receipt = sends.find((s) => s.payload.to === 'kari@example.com');
  assert.match(String(notice?.payload.subject), /^\[MCPE-1001\] WITHDRAWAL \(3-month pass\): Kari Nordmann/);
  assert.match(String(receipt?.payload.subject), /withdrawal is received \(MCPE-1001\)/);
  const text = String(receipt?.payload.text);
  assert.match(text, /Request: Withdrawal from your MCPEmails 3-month Personal pass/);
  assert.match(text, /Takes effect: Immediately/);
  assert.match(text, /refund the payment for your pass in full within 14 days/);
  assert.ok(!/first charge/.test(text), 'a pass has no first charge');
  assert.ok(!/30 days/.test(text));
});

test('a subscription withdrawal stays labelled as a subscription, not a pass', async () => {
  reset();
  const res = await post(body({ kind: 'withdraw', cancelType: undefined }));
  assert.equal(res.status, 201);
  const notice = sends.find((s) => s.payload.to === 'support@mcpemails.com');
  assert.match(String(notice?.payload.subject), /^\[MCPE-1001\] WITHDRAWAL: /);
  assert.ok(!/pass/i.test(String(notice?.payload.text)));
  assert.equal((tickets[0].context as Record<string, Record<string, unknown>>).contract_request.kind, 'withdraw');
});

test('the receipt never echoes the free-text reason; the notice to support does', async () => {
  reset();
  const reason = 'Visit http://spam.example for cheap watches';
  const res = await post(body({ cancelType: 'extraordinary', reason }));
  assert.equal(res.status, 201);
  const receipt = sends.find((s) => s.payload.to === 'kari@example.com');
  const notice = sends.find((s) => s.payload.to === 'support@mcpemails.com');
  assert.ok(!String(receipt?.payload.text).includes('spam.example'));
  assert.ok(!String(receipt?.payload.html).includes('spam.example'));
  assert.ok(String(notice?.payload.text).includes(reason));
  assert.ok(String(tickets[0].message).includes(reason), 'the stored record keeps the reason');
});

test('validation errors are 400 with a code and store nothing', async () => {
  reset();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: '   ' }, 'name_required'],
    [{ name: 'x'.repeat(101) }, 'name_too_long'],
    [{ email: 'not-an-address' }, 'invalid_email'],
    [{ kind: 'delete' }, 'invalid_kind'],
    [{ cancelType: 'whenever' }, 'invalid_cancel_type'],
    [{ cancelType: 'extraordinary', reason: '' }, 'reason_required'],
    [{ contract: 'x'.repeat(101) }, 'contract_too_long'],
    [{ formToken: 'forged.token' }, 'invalid_form_token'],
  ];
  for (const [overrides, code] of cases) {
    const res = await post(body(overrides));
    assert.equal(res.status, 400, code);
    assert.equal((await res.json()).error, code);
  }
  assert.equal(tickets.length, 0);
  assert.equal(sends.length, 0);
});

test('a filled honeypot or an instant submit gets a silent 200 and sends nothing', async () => {
  reset();
  for (const overrides of [{ website: 'https://spam.example' }, { formToken: issueSupportFormToken(Date.now()) }]) {
    const res = await post(body(overrides));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ref: null, receivedAt: null });
  }
  assert.equal(tickets.length, 0);
  assert.equal(sends.length, 0);
});

test('the per-address limit caps what one recipient can be sent', async () => {
  reset();
  for (let i = 0; i < 3; i++) assert.equal((await post(body())).status, 201);
  const res = await post(body());
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
  assert.equal(tickets.length, 3);
});

test('a failed insert is a 500 and sends nothing', async () => {
  reset();
  failInsert = true;
  const res = await post(body());
  assert.equal(res.status, 500);
  assert.equal(sends.length, 0);
});
