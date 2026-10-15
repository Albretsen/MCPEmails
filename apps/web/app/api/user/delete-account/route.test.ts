// ---------------------------------------------------------------------------
// DELETE /api/user/delete-account and the Stripe subscription.
//
// Deleting an account soft-deletes every workspace and bans the auth user, but
// the subscription lives in Stripe and nothing used to cancel it, so a paying
// customer who deleted their account kept being charged. The route now cancels
// every live subscription first, and if Stripe fails it stops before tearing
// anything down. These tests pin both halves, and the ordering between them.
//
// Only the I/O is stubbed (Supabase, Stripe, next/server). Every Supabase call
// is written to one ordered log alongside the Stripe calls, so "Stripe was
// called before the first write" is a fact about the log, not about mocks.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/user/delete-account/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const USER = { id: '00000000-0000-4000-8000-00000000d31e', email: 'owner@example.test' };

type Sub = { id: string; status: string; customer: string };

interface World {
  authed: boolean;
  workspaces: Array<{ id: string; stripe_customer_id: string | null }>;
  billing: { stripe_customer_id: string | null } | null;
  billingError: { message: string } | null;
  subs: Sub[];
  stripeFails: boolean;
  /** Every Supabase and Stripe call, in order. */
  log: string[];
  cancelParams: Array<{ id: string; params: Record<string, unknown> }>;
}

let world: World;

function reset(overrides: Partial<World> = {}): void {
  world = {
    authed: true,
    workspaces: [{ id: 'ws-1', stripe_customer_id: null }],
    billing: { stripe_customer_id: 'cus_owner' },
    billingError: null,
    subs: [
      { id: 'sub_live', status: 'active', customer: 'cus_owner' },
      { id: 'sub_old', status: 'canceled', customer: 'cus_owner' },
    ],
    stripeFails: false,
    log: [],
    cancelParams: [],
    ...overrides,
  };
}

/** A chainable PostgREST stand-in that logs `table.op` when the query runs. */
function query(table: string, op: string) {
  const result = () => {
    world.log.push(`db:${table}.${op}`);
    if (table === 'workspaces' && op === 'select') return { data: world.workspaces, error: null };
    if (table === 'user_billing' && op === 'select') {
      return { data: world.billing, error: world.billingError };
    }
    return { data: null, error: null };
  };
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'range']) {
    builder[name] = () => builder;
  }
  builder.maybeSingle = async () => result();
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve().then(result).then(resolve, reject);
  return builder;
}

nodeMock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: world.authed ? USER : null },
          error: null,
        }),
        signOut: async () => {
          world.log.push('auth:signOut');
          return { error: null };
        },
      },
    }),
  },
});

nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => ({
        select: () => query(table, 'select'),
        update: () => query(table, 'update'),
        delete: () => query(table, 'delete'),
      }),
      auth: {
        admin: {
          updateUserById: async () => {
            world.log.push('auth:ban');
            return { error: null };
          },
        },
      },
    }),
  },
});

nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      subscriptions: {
        list: async (params: { customer: string }) => {
          world.log.push(`stripe:list:${params.customer}`);
          if (world.stripeFails) throw new Error('Stripe is down');
          return {
            data: world.subs.filter((s) => s.customer === params.customer),
            has_more: false,
          };
        },
        cancel: async (id: string, params: Record<string, unknown>) => {
          world.log.push(`stripe:cancel:${id}`);
          world.cancelParams.push({ id, params });
          return { id, status: 'canceled' };
        },
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
  },
});

const route = (await import('./route.ts')) as Record<string, unknown>;
const DELETE = route.DELETE as (req: Request) => Promise<Response>;

function request(body: unknown = { confirmEmail: USER.email }): Request {
  return new Request('https://mcpemails.test/api/user/delete-account', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A Supabase call that changes something, as opposed to a read. */
const isWrite = (entry: string) =>
  /^db:.*\.(update|delete)$/.test(entry) || entry === 'auth:ban' || entry === 'auth:signOut';

beforeEach(() => reset());

// ── Every HTTP method ──────────────────────────────────────────────────────
// Only DELETE is exported, so Next answers every other method with 405 before
// any of this code runs. A GET or POST handler added here later would be a
// second, unreviewed way into account deletion.
for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS']) {
  test(`${method} is not handled (Next answers 405)`, () => {
    assert.equal(route[method], undefined, `${method} must not be exported`);
  });
}

test('DELETE is the only handler', () => {
  assert.equal(typeof DELETE, 'function');
});

// ── DELETE ─────────────────────────────────────────────────────────────────

test('DELETE cancels the live subscription immediately, before anything is torn down', async () => {
  const res = await DELETE(request());
  assert.equal(res.status, 200);

  assert.deepEqual(
    world.cancelParams.map((c) => c.id),
    ['sub_live'],
    'the live subscription is cancelled; the already-cancelled one is left alone',
  );
  assert.deepEqual(world.cancelParams[0].params, {
    invoice_now: false,
    prorate: false,
    cancellation_details: { comment: 'account_deleted' },
  });

  const cancelAt = world.log.indexOf('stripe:cancel:sub_live');
  const firstWrite = world.log.findIndex(isWrite);
  assert.ok(firstWrite > cancelAt, `cancel must precede every write: ${world.log.join(', ')}`);
  assert.ok(world.log.includes('auth:ban'), 'the account is still banned');
});

test('DELETE also cancels on a customer id found only on a legacy workspace row', async () => {
  reset({
    billing: null,
    workspaces: [{ id: 'ws-1', stripe_customer_id: 'cus_legacy' }],
    subs: [{ id: 'sub_legacy', status: 'past_due', customer: 'cus_legacy' }],
  });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.deepEqual(world.cancelParams.map((c) => c.id), ['sub_legacy']);
});

test('DELETE asks Stripe once per customer when both rows name the same one', async () => {
  reset({ workspaces: [{ id: 'ws-1', stripe_customer_id: 'cus_owner' }] });
  await DELETE(request());
  assert.equal(world.log.filter((e) => e === 'stripe:list:cus_owner').length, 1);
});

test('DELETE stops with a one-line error and touches nothing when Stripe fails', async () => {
  reset({ stripeFails: true });
  const res = await DELETE(request());
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /subscription/i);
  assert.doesNotMatch(body.error, /\n/);
  assert.deepEqual(world.log.filter(isWrite), [], `no write may happen: ${world.log.join(', ')}`);
});

test('DELETE stops and touches nothing when the billing row cannot be read', async () => {
  reset({ billingError: { message: 'connection reset' } });
  const res = await DELETE(request());
  assert.equal(res.status, 500);
  assert.deepEqual(world.log.filter((e) => e.startsWith('stripe:')), []);
  assert.deepEqual(world.log.filter(isWrite), []);
});

test('DELETE for a free user with no Stripe customer never calls Stripe', async () => {
  reset({ billing: null, subs: [] });
  const res = await DELETE(request());
  assert.equal(res.status, 200);
  assert.deepEqual(world.log.filter((e) => e.startsWith('stripe:')), []);
});

test('DELETE without a session is 401 and never calls Stripe', async () => {
  reset({ authed: false });
  const res = await DELETE(request());
  assert.equal(res.status, 401);
  assert.deepEqual(world.log, []);
});

test('DELETE with the wrong confirmation email is 400 and never calls Stripe', async () => {
  const res = await DELETE(request({ confirmEmail: 'someone@else.test' }));
  assert.equal(res.status, 400);
  assert.deepEqual(world.log, []);
});
