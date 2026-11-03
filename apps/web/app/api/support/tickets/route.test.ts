// ---------------------------------------------------------------------------
// /api/support/tickets end to end through the exported handlers, every method,
// signed in and signed out.
//
// Stubbed: the viewer (who is asking), the service-role Supabase client (an
// in-memory support_tickets plus the context tables), next/headers, and the
// Resend SDK. Validation, form token, rate limits, context building, email
// composition and the row-first-then-send flow run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/support/tickets/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'ab'.repeat(32);
process.env.RESEND_API_KEY = 're_test_dummy';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Viewer = { user: { id: string; email: string } | null };
let viewer: Viewer = { user: null };

type Ticket = Record<string, unknown> & { id: string; ref: string; created_at: string };
const tickets: Ticket[] = [];
let failInsert = false;
let failSend = false;
const sends: Array<{ payload: Record<string, unknown>; opts: Record<string, unknown> }> = [];

const contextTables: Record<string, Array<Record<string, unknown>>> = {
  workspace_members: [{ user_id: 'u-internal', workspace_id: 'w1', joined_at: '2026-01-01' }],
  workspaces: [{ id: 'w1', plan: 'solo', deleted_at: null }],
  inboxes: [
    { workspace_id: 'w1', email_address: 'staff-box@example.com', provider: 'imap', service: 'yahoo', imap_host: 'imap.mail.yahoo.com', status: 'error', last_error: 'AUTHENTICATIONFAILED', deleted_at: null, imap_password: 'SECRETPW' },
  ],
};

function fakeServiceClient() {
  return {
    from(table: string) {
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
      b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
      b.gte = (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b);
      b.order = () => b;
      b.limit = () => b;
      const rows = () =>
        ((table === 'support_tickets' ? tickets : contextTables[table]) ?? []).filter((r) => filters.every((f) => f(r)));
      b.single = async () => {
        if (op === 'insert') {
          if (failInsert) return { data: null, error: { code: '23514' } };
          const row = {
            id: `t${tickets.length + 1}`,
            ref: `MCPE-${1001 + tickets.length}`,
            created_at: new Date().toISOString(),
            notified_at: null,
            confirmation_sent_at: null,
            ...payload,
          } as Ticket;
          tickets.push(row);
          return { data: { id: row.id, ref: row.ref }, error: null };
        }
        return { data: rows()[0] ?? null, error: null };
      };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
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
      return failSend ? { data: null, error: { message: 'resend down' } } : { data: { id: 'em' }, error: null };
    },
  };
}

nodeMock.module('@/lib/support/viewer', { namedExports: { getSupportViewer: async () => viewer } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: fakeServiceClient } });
nodeMock.module('next/headers', { namedExports: { cookies: async () => ({ get: () => undefined }) } });
nodeMock.module('resend', { namedExports: { Resend: FakeResend } });

const route = await import('./route.ts');
const { issueSupportFormToken } = await import('@/lib/support/form-token');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const URL_ = 'https://mcpemails.test/api/support/tickets';

function call(method: (typeof METHODS)[number], body?: unknown, headers: Record<string, string> = {}) {
  const handler = (route as unknown as Record<string, (r: Request) => Promise<Response>>)[method];
  assert.equal(typeof handler, 'function', `${method} is exported`);
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return handler(new Request(URL_, init));
}

const SIGNED_IN = { user: { id: 'u-internal', email: 'staff@mcpemails.com' } };
const SIGNED_OUT = { user: null };

function ticketBody(over: Record<string, unknown> = {}) {
  return {
    category: 'connect',
    subject: 'Yahoo will not connect',
    message: 'MSGMARK-route says password rejected',
    website: '',
    formToken: issueSupportFormToken(Date.now() - 10_000),
    from: 'connect-modal',
    provider: 'yahoo',
    code: 'auth_failed',
    ...over,
  };
}

test.beforeEach(() => {
  viewer = SIGNED_OUT;
  tickets.length = 0;
  sends.length = 0;
  failInsert = false;
  failSend = false;
});

test('every method but POST is 405 with Allow: POST', async () => {
  viewer = SIGNED_IN;
  for (const method of METHODS.filter((m) => m !== 'POST')) {
    const res = await call(method);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST');
  }
});

test('signed in: 201 with ref, row stored with context, both emails sent and recorded', async () => {
  viewer = SIGNED_IN;
  const res = await call('POST', ticketBody({ email: 'ignored@example.com' }), { 'x-forwarded-for': '203.0.113.9' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, ref: 'MCPE-1001' });

  assert.equal(tickets.length, 1);
  const row = tickets[0];
  assert.equal(row.email, 'staff@mcpemails.com');
  assert.equal(row.user_id, 'u-internal');
  assert.equal(row.workspace_id, 'w1');
  assert.equal(row.source, 'form_signed_in');
  assert.equal(typeof row.ip_hash, 'string');
  assert.equal(String(row.ip_hash).includes('203.0.113'), false);
  assert.equal(JSON.stringify(row.context).includes('SECRETPW'), false);
  assert.deepEqual(row.context, {
    workspace_id: 'w1',
    plan: 'solo',
    mailboxes: [{
      email: 'staff-box@example.com',
      provider: 'imap',
      service: 'yahoo',
      service_name: 'Yahoo Mail',
      host: 'imap.mail.yahoo.com',
      status: 'error',
      health: 'reconnect_required',
      last_error_code: 'AUTHENTICATIONFAILED',
      last_error_text: 'AUTHENTICATIONFAILED',
    }],
    from: 'connect-modal',
    provider: 'yahoo',
    code: 'auth_failed',
  });
  assert.equal(typeof row.notified_at, 'string');
  assert.equal(typeof row.confirmation_sent_at, 'string');

  assert.equal(sends.length, 2);
  const toSupport = sends.find((s) => s.payload.to === 'support@mcpemails.com')!;
  const toCustomer = sends.find((s) => s.payload.to === 'staff@mcpemails.com')!;
  assert.equal(toSupport.payload.replyTo, 'staff@mcpemails.com');
  assert.equal(toSupport.payload.subject, '[MCPE-1001] Connecting a mailbox: Yahoo will not connect');
  assert.equal(toCustomer.payload.replyTo, 'support@mcpemails.com');
  assert.equal(JSON.stringify(toCustomer.payload).includes('MSGMARK-route'), false);
  assert.equal(toSupport.opts.idempotencyKey, 'support-production-ticket-MCPE-1001');
});

test('signed out: email from the body, no context, no user', async () => {
  viewer = SIGNED_OUT;
  const missing = await call('POST', ticketBody());
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { ok: false, error: 'invalid_email' });

  const res = await call('POST', ticketBody({ email: 'Visitor@Example.com' }));
  assert.equal(res.status, 201);
  const row = tickets[0];
  assert.equal(row.email, 'visitor@example.com');
  assert.equal(row.user_id, null);
  assert.equal(row.workspace_id, null);
  assert.equal(row.source, 'form_signed_out');
  assert.equal((row.context as { mailboxes: unknown[] }).mailboxes.length, 0);
});

test('400s: bad JSON, bad category, missing form token', async () => {
  viewer = SIGNED_IN;
  const cases: Array<[unknown, string]> = [
    ['{not json', 'invalid_json'],
    [ticketBody({ category: 'sales' }), 'invalid_category'],
    [ticketBody({ formToken: undefined }), 'invalid_form_token'],
    [ticketBody({ subject: 's'.repeat(151) }), 'subject_too_long'],
  ];
  for (const [body, error] of cases) {
    const res = await call('POST', body);
    assert.equal(res.status, 400, error);
    assert.deepEqual(await res.json(), { ok: false, error });
  }
  assert.equal(tickets.length, 0);
});

test('honeypot or too fast: 200 with a null ref, nothing stored, nothing sent', async () => {
  viewer = SIGNED_IN;
  for (const body of [ticketBody({ website: 'https://spam.example' }), ticketBody({ formToken: issueSupportFormToken(Date.now()) })]) {
    const res = await call('POST', body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, ref: null });
  }
  assert.equal(tickets.length, 0);
  assert.equal(sends.length, 0);
});

test('429 once the per-email hourly limit is reached', async () => {
  viewer = SIGNED_IN;
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', ticketBody())).status, 201);
  const res = await call('POST', ticketBody());
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, error: 'rate_limited' });
  assert.equal(tickets.length, 3);
});

test('send fails but the row is kept: still 201, sent-at columns stay NULL', async () => {
  viewer = SIGNED_IN;
  failSend = true;
  const res = await call('POST', ticketBody());
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, ref: 'MCPE-1001' });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].notified_at, null);
  assert.equal(tickets[0].confirmation_sent_at, null);
});

test('insert fails: 500 server_error and nothing is sent', async () => {
  viewer = SIGNED_IN;
  failInsert = true;
  const res = await call('POST', ticketBody());
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'server_error' });
  assert.equal(sends.length, 0);
});
