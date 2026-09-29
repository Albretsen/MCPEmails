// ---------------------------------------------------------------------------
// The Resend webhook end to end through POST: unsigned and badly signed
// requests are refused, ignored event types get a 2xx, a complaint writes the
// opt-out, and a replay of the same svix-id writes nothing new.
//
// Only the I/O is stubbed: the service-role Supabase client (an in-memory
// users table that honours `.is('unsubscribed_at', null)`) and `next/server`.
// The signature check, classification and suppression run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/webhooks/resend/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const KEY = Buffer.from('route-test-signing-key').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = `whsec_${KEY}`;

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type User = { id: string; email: string; unsubscribed_at: string | null };
const users: User[] = [];
let updates = 0;

/** Just enough of PostgREST for SupabaseSuppressionStore. */
function fakeServiceClient() {
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.update = (values: Record<string, unknown>) => {
        patch = values;
        return builder;
      };
      builder.in = (col: string, values: unknown[]) => {
        filters.push((r) => values.includes(r[col]));
        return builder;
      };
      builder.eq = (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      };
      builder.is = (col: string, value: unknown) => {
        filters.push((r) => r[col] === value);
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const rows = (table === 'users' ? users : []) as unknown as Array<Record<string, unknown>>;
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) {
          for (const r of hit) Object.assign(r, patch);
          updates += hit.length;
        }
        return resolve({ data: hit.map((r) => ({ id: r.id, user_id: r.user_id })), error: null });
      };
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/service', {
  namedExports: { createServiceRoleClient: fakeServiceClient },
});
nodeMock.module('next/server', {
  namedExports: {
    NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
  },
});

const { POST } = await import('./route.ts');
const { signSvix } = await import('@/lib/email/resend-webhook');

function deliver(event: unknown, opts: { id?: string; sign?: boolean; tamper?: boolean } = {}) {
  const body = JSON.stringify(event);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) {
    headers['svix-id'] = id;
    headers['svix-timestamp'] = ts;
    headers['svix-signature'] = `v1,${signSvix(process.env.RESEND_WEBHOOK_SECRET!, id, ts, body)}`;
  }
  return POST(
    new Request('https://mcpemails.test/api/webhooks/resend', {
      method: 'POST',
      headers,
      body: opts.tamper ? body.replace('owner@', 'other@') : body,
    }),
  );
}

const complaint = {
  type: 'email.complained',
  created_at: '2026-09-29T12:00:00.000Z',
  data: { email_id: 'em_1', to: ['owner@example.test'], subject: 'x' },
};

test.beforeEach(() => {
  users.length = 0;
  users.push({ id: 'u1', email: 'owner@example.test', unsubscribed_at: null });
  users.push({ id: 'u2', email: 'other@example.test', unsubscribed_at: null });
  updates = 0;
});

test('an unsigned request is rejected and writes nothing', async () => {
  const res = await deliver(complaint, { sign: false });
  assert.equal(res.status, 401);
  assert.equal(updates, 0);
});

test('a request whose body was changed after signing is rejected', async () => {
  const res = await deliver(complaint, { tamper: true });
  assert.equal(res.status, 401);
  assert.equal(users[1].unsubscribed_at, null);
});

test('an unset secret refuses everything', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const res = await POST(new Request('https://mcpemails.test/api/webhooks/resend', { method: 'POST', body: '{}' }));
    assert.equal(res.status, 500);
  } finally {
    process.env.RESEND_WEBHOOK_SECRET = saved;
  }
});

test('a complaint suppresses the recipient only; a replay of the same svix-id is a 2xx no-op', async () => {
  const res = await deliver(complaint, { id: 'msg_replay' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, reason: 'complaint', matchedUsers: 1, newlySuppressed: 1 });
  const stamped = users[0].unsubscribed_at;
  assert.ok(stamped);
  assert.equal(users[1].unsubscribed_at, null);

  const again = await deliver(complaint, { id: 'msg_replay' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).newlySuppressed, 0);
  assert.equal(users[0].unsubscribed_at, stamped);
  assert.equal(updates, 1);
});

test('a permanent bounce suppresses; a transient one is acknowledged and ignored', async () => {
  const transient = await deliver({
    type: 'email.bounced',
    data: { email_id: 'em_2', to: ['owner@example.test'], bounce: { type: 'Transient', subType: 'MailboxFull' } },
  });
  assert.equal(transient.status, 200);
  assert.equal(users[0].unsubscribed_at, null);

  const hard = await deliver({
    type: 'email.bounced',
    data: { email_id: 'em_3', to: ['owner@example.test'], bounce: { type: 'Permanent', subType: 'General' } },
  });
  assert.equal(hard.status, 200);
  assert.ok(users[0].unsubscribed_at);
});

test('other event types get a 2xx and write nothing', async () => {
  for (const type of ['email.delivered', 'email.opened', 'email.sent']) {
    const res = await deliver({ type, data: { to: ['owner@example.test'] } });
    assert.equal(res.status, 200);
  }
  assert.equal(updates, 0);
});
