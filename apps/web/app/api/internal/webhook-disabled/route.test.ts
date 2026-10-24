// ---------------------------------------------------------------------------
// POST /api/internal/webhook-disabled: the dispatch secret is required, only an
// endpoint really disabled for failing is mailed about, the owner is the
// recipient, the email names the host and not the path, and Resend gets an
// idempotency key per disable.
//
// Run: npm run test:webhooks
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown>; defaultExport?: unknown }) => void;
};

const EP = '2c000000-0000-4000-8000-000000000001';
const world = {
  endpoint: null as Record<string, unknown> | null,
  sends: [] as Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>,
};

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => {
        if (table === 'webhook_endpoints') return { data: world.endpoint, error: null };
        if (table === 'workspaces') return { data: { display_name: 'Acme', owner_id: 'u-owner' }, error: null };
        if (table === 'users') return { data: { email: 'owner@acme.test' }, error: null };
        return { data: null, error: null };
      };
      return b;
    },
  };
}

process.env.DISPATCH_SECRET = 'dispatch-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key';

nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => client() } });
nodeMock.module('next/server', {
  namedExports: { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
});
nodeMock.module('resend', {
  namedExports: {
    Resend: class {
      emails = {
        send: async (message: Record<string, unknown>, options: Record<string, unknown>) => {
          world.sends.push({ message, options });
          return { data: { id: 'r1' }, error: null };
        },
      };
    },
  },
});

const route = (await import('./route.ts')) as unknown as { POST: (r: Request) => Promise<Response> };

beforeEach(() => {
  world.sends = [];
  world.endpoint = {
    id: EP,
    workspace_id: 'ws',
    url: 'https://hooks.receiver.example/secret-token-in-path',
    disabled_at: '2026-10-24T10:00:00.000Z',
    disabled_reason: 'failing',
  };
});

const post = (body: unknown, secret = 'dispatch-secret-for-tests') =>
  route.POST(new Request('https://mcpemails.test/api/internal/webhook-disabled', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dispatch-secret': secret },
    body: JSON.stringify(body),
  }));

test('refuses a missing or wrong dispatch secret', async () => {
  assert.equal((await post({ endpoint_id: EP }, 'nope')).status, 401);
  assert.equal(world.sends.length, 0);
});

test('mails the owner once per disable, naming the host and not the path', async () => {
  const res = await post({ endpoint_id: EP });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, true);
  assert.equal(world.sends.length, 1);
  const { message, options } = world.sends[0];
  assert.equal(message.to, 'owner@acme.test');
  assert.ok(String(message.text).includes('hooks.receiver.example'));
  assert.ok(!String(message.text).includes('secret-token-in-path'));
  assert.ok(!String(message.html).includes('secret-token-in-path'));
  assert.ok(!/—/.test(String(message.text)), 'no em dash');
  assert.equal(options.idempotencyKey, `webhook-disabled-${EP}-2026-10-24T10:00:00.000Z`);
});

test('does nothing for an endpoint that is enabled, or was turned off by hand', async () => {
  world.endpoint = { ...world.endpoint!, disabled_at: null, disabled_reason: null };
  assert.equal((await (await post({ endpoint_id: EP })).json()).sent, false);
  world.endpoint = { ...world.endpoint!, disabled_at: '2026-10-24T10:00:00.000Z', disabled_reason: 'manual' };
  assert.equal((await (await post({ endpoint_id: EP })).json()).sent, false);
  assert.equal(world.sends.length, 0);
  assert.equal((await post({ endpoint_id: 'x' })).status, 400);
});
