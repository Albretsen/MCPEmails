// ---------------------------------------------------------------------------
// POST /api/stripe/portal, end to end through the handler.
//
// The portal used to open a session for whatever `cus_...` id sat on a
// workspace the caller owned, and the owner could write that column through
// PostgREST. These tests pin the fix: user_billing (server-written) is trusted,
// a workspace-only id is used only after the Stripe customer itself names the
// caller, and an id that names someone else never reaches
// billingPortal.sessions.create or user_billing.
//
// Only I/O is stubbed: both Supabase clients (in-memory tables honouring the
// filters the route uses), the Stripe client, the billing-funnel recorder and
// `next/server`. The ownership rules run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/portal/route.test.ts src/lib/stripe/portal-customer.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Row = Record<string, unknown>;
type Customer = { id: string; deleted?: boolean; email?: string | null; metadata?: Record<string, string> };

const CALLER = 'user-caller';
const VICTIM = 'user-victim';

let caller: { id: string; email: string; email_confirmed_at: string | null } | null;
let tables: Record<string, Row[]>;
let customers: Record<string, Customer>;
let portalSessions: string[];
let customerLookups: string[];
let upserts: Row[];
let updates: Row[];
/** When set, customers.retrieve throws this instead of looking the id up. */
let stripeOutage: Error | null;

function reset() {
  caller = { id: CALLER, email: 'caller@example.test', email_confirmed_at: '2026-06-01T00:00:00Z' };
  tables = {
    user_billing: [],
    workspaces: [
      { id: 'ws-victim', owner_id: VICTIM, stripe_customer_id: 'cus_victim', deleted_at: null, created_at: '2026-05-01' },
    ],
  };
  customers = {
    cus_victim: { id: 'cus_victim', email: 'victim@example.test', metadata: { user_id: VICTIM } },
    cus_caller: { id: 'cus_caller', email: 'caller@example.test', metadata: { user_id: CALLER } },
  };
  portalSessions = [];
  customerLookups = [];
  upserts = [];
  updates = [];
  stripeOutage = null;
}
reset();

/** A chainable read builder over `tables[table]`, honouring eq / is / not-null. */
function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: caller }, error: caller ? null : { message: 'no session' } }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      let patch: Row | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return builder; };
      builder.is = (col: string, v: unknown) => { filters.push((r) => (r[col] ?? null) === v); return builder; };
      builder.not = (col: string, _op: string, v: unknown) => { filters.push((r) => (r[col] ?? null) !== v); return builder; };
      builder.in = (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return builder; };
      builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      builder.single = async () => ({ data: rows()[0] ?? null, error: null });
      builder.upsert = (values: Row) => { upserts.push({ table, ...values }); return builder; };
      builder.update = (values: Row) => { patch = values; return builder; };
      builder.then = (resolve: (v: unknown) => unknown) => {
        if (patch) {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          updates.push({ table, ...patch, ids: hit.map((r) => r.id) });
          return resolve({ data: null, error: null });
        }
        return resolve({ data: rows(), error: null });
      };
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeDb() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeDb() } });
nodeMock.module('@/lib/analytics/billing-funnel', {
  namedExports: {
    planCategory: () => 'free',
    primaryWorkspaceId: async () => null,
    recordPortalOpened: async () => undefined,
  },
});
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      customers: {
        retrieve: async (id: string) => {
          customerLookups.push(id);
          if (stripeOutage) throw stripeOutage;
          const found = customers[id];
          if (!found) throw Object.assign(new Error(`No such customer: '${id}'`), { code: 'resource_missing' });
          return found;
        },
      },
      billingPortal: {
        sessions: {
          create: async ({ customer }: { customer: string }) => {
            portalSessions.push(customer);
            return { url: `https://billing.stripe.test/session/${customer}` };
          },
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

const { POST } = await import('./route.ts');

async function openPortal() {
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await POST(new Request('https://mcpemails.test/api/stripe/portal', { method: 'POST' }) as never);
    return { status: res.status, body: (await res.json()) as { url?: string; error?: string } };
  } finally {
    console.error = originalError;
  }
}

function ownWorkspace(customerId: string | null, extra: Row = {}) {
  tables.workspaces.push({
    id: 'ws-caller', owner_id: CALLER, stripe_customer_id: customerId, deleted_at: null, created_at: '2026-05-02', ...extra,
  });
}

test('a user_billing customer opens the portal directly, without a Stripe lookup', async () => {
  reset();
  tables.user_billing.push({ user_id: CALLER, stripe_customer_id: 'cus_caller', plan: 'personal' });
  ownWorkspace('cus_victim'); // ignored: user_billing wins
  const { status, body } = await openPortal();
  assert.equal(status, 200);
  assert.equal(body.url, 'https://billing.stripe.test/session/cus_caller');
  assert.deepEqual(portalSessions, ['cus_caller']);
  assert.deepEqual(customerLookups, []);
});

test("a planted workspace customer id that names another user never opens that user's portal", async () => {
  reset();
  ownWorkspace('cus_victim');
  const { status, body } = await openPortal();
  assert.equal(status, 422);
  assert.match(body.error ?? '', /No billing account found/);
  assert.deepEqual(portalSessions, []);
  // ...and is never copied into user_billing, where it would be trusted next time.
  assert.deepEqual(upserts, []);
});

test("a planted id from the workspace-scoped era is refused unless its workspace is the caller's", async () => {
  reset();
  customers.cus_old_victim = { id: 'cus_old_victim', email: 'victim@example.test', metadata: { workspace_id: 'ws-victim' } };
  ownWorkspace('cus_old_victim');
  const { status } = await openPortal();
  assert.equal(status, 422);
  assert.deepEqual(portalSessions, []);
  assert.deepEqual(upserts, []);
});

test('a hand-made customer with no metadata and a different email is refused', async () => {
  reset();
  customers.cus_manual = { id: 'cus_manual', email: 'someone-else@example.test', metadata: {} };
  ownWorkspace('cus_manual');
  const { status } = await openPortal();
  assert.equal(status, 422);
  assert.deepEqual(portalSessions, []);
});

test('a legacy paying user whose id is only on their workspace still reaches the portal, and is backfilled', async () => {
  reset();
  ownWorkspace('cus_caller');
  const { status, body } = await openPortal();
  assert.equal(status, 200);
  assert.equal(body.url, 'https://billing.stripe.test/session/cus_caller');
  assert.deepEqual(portalSessions, ['cus_caller']);
  assert.deepEqual(upserts, [{ table: 'user_billing', user_id: CALLER, stripe_customer_id: 'cus_caller' }]);
});

test('a workspace-era customer tied to the caller\'s own workspace still works', async () => {
  reset();
  customers.cus_old_own = { id: 'cus_old_own', email: 'caller@example.test', metadata: { workspace_id: 'ws-caller' } };
  ownWorkspace('cus_old_own');
  const { status } = await openPortal();
  assert.equal(status, 200);
  assert.deepEqual(portalSessions, ['cus_old_own']);
});

test("a hand-made customer with the caller's confirmed email still works; an unconfirmed email does not", async () => {
  reset();
  customers.cus_manual = { id: 'cus_manual', email: 'Caller@Example.test', metadata: {} };
  ownWorkspace('cus_manual');
  assert.equal((await openPortal()).status, 200);
  assert.deepEqual(portalSessions, ['cus_manual']);

  reset();
  customers.cus_manual = { id: 'cus_manual', email: 'caller@example.test', metadata: {} };
  ownWorkspace('cus_manual');
  caller!.email_confirmed_at = null;
  assert.equal((await openPortal()).status, 422);
  assert.deepEqual(portalSessions, []);
});

test('a refused candidate does not hide a valid one on another owned workspace', async () => {
  reset();
  ownWorkspace('cus_victim');
  tables.workspaces.push({ id: 'ws-caller-2', owner_id: CALLER, stripe_customer_id: 'cus_caller', deleted_at: null, created_at: '2026-05-03' });
  const { status } = await openPortal();
  assert.equal(status, 200);
  assert.deepEqual(customerLookups, ['cus_victim', 'cus_caller']);
  assert.deepEqual(portalSessions, ['cus_caller']);
});

test('deleted workspaces and dead customer ids are not used as a fallback', async () => {
  reset();
  ownWorkspace('cus_caller', { deleted_at: '2026-07-01T00:00:00Z' });
  assert.equal((await openPortal()).status, 422);
  assert.deepEqual(customerLookups, []);

  reset();
  ownWorkspace('cus_gone');
  assert.equal((await openPortal()).status, 422);
  assert.deepEqual(customerLookups, ['cus_gone']);
  assert.deepEqual(portalSessions, []);

  reset();
  customers.cus_caller = { id: 'cus_caller', deleted: true };
  ownWorkspace('cus_caller');
  assert.equal((await openPortal()).status, 422);
  assert.deepEqual(portalSessions, []);
});

test('a free user with no customer anywhere gets the existing 422', async () => {
  reset();
  ownWorkspace(null);
  const { status, body } = await openPortal();
  assert.equal(status, 422);
  assert.equal(body.error, 'No billing account found. Upgrade to a paid plan to access the customer portal.');
  assert.deepEqual(customerLookups, []);
});

test('no session is still a 401', async () => {
  reset();
  caller = null;
  assert.equal((await openPortal()).status, 401);
});

// ── Self-heal of the workspace fallback ──────────────────────────────────────

const wsCustomer = (id: string) => tables.workspaces.find((w) => w.id === id)?.stripe_customer_id;

test('a workspace id Stripe no longer has is nulled, so the next click makes no Stripe call', async () => {
  reset();
  ownWorkspace('cus_gone');
  assert.equal((await openPortal()).status, 422);
  assert.equal(wsCustomer('ws-caller'), null);
  assert.deepEqual(updates, [{ table: 'workspaces', stripe_customer_id: null, ids: ['ws-caller'] }]);

  customerLookups = [];
  assert.equal((await openPortal()).status, 422);
  assert.deepEqual(customerLookups, []);
});

test('a deleted Stripe customer is nulled on the workspace', async () => {
  reset();
  customers.cus_caller = { id: 'cus_caller', deleted: true };
  ownWorkspace('cus_caller');
  assert.equal((await openPortal()).status, 422);
  assert.equal(wsCustomer('ws-caller'), null);
});

test("a planted id that belongs to another user (or another user's workspace) is nulled, and the victim's row is untouched", async () => {
  for (const planted of ['cus_victim', 'cus_old_victim']) {
    reset();
    customers.cus_old_victim = { id: 'cus_old_victim', metadata: { workspace_id: 'ws-victim' } };
    ownWorkspace(planted);
    assert.equal((await openPortal()).status, 422, planted);
    assert.equal(wsCustomer('ws-caller'), null, planted);
    assert.equal(wsCustomer('ws-victim'), 'cus_victim', planted);
    assert.deepEqual(portalSessions, [], planted);
  }
});

test('the heal touches only the caller\'s own live workspaces carrying that id', async () => {
  reset();
  ownWorkspace('cus_gone');
  tables.workspaces.push(
    { id: 'ws-caller-old', owner_id: CALLER, stripe_customer_id: 'cus_gone', deleted_at: '2026-07-01', created_at: '2026-04-01' },
    { id: 'ws-caller-2', owner_id: CALLER, stripe_customer_id: 'cus_gone', deleted_at: null, created_at: '2026-05-05' },
    { id: 'ws-stranger', owner_id: 'user-stranger', stripe_customer_id: 'cus_gone', deleted_at: null, created_at: '2026-05-06' },
  );
  await openPortal();
  assert.equal(wsCustomer('ws-caller'), null);
  assert.equal(wsCustomer('ws-caller-2'), null);
  assert.equal(wsCustomer('ws-caller-old'), 'cus_gone');
  assert.equal(wsCustomer('ws-stranger'), 'cus_gone');
  assert.equal(wsCustomer('ws-victim'), 'cus_victim');
});

test('a Stripe outage, an unproven hand-made customer, or a verified customer is never nulled', async () => {
  reset();
  ownWorkspace('cus_caller');
  stripeOutage = Object.assign(new Error('An error occurred with our connection to Stripe.'), { code: 'api_connection_error' });
  assert.equal((await openPortal()).status, 422);
  assert.equal(wsCustomer('ws-caller'), 'cus_caller');
  assert.deepEqual(updates, []);

  reset();
  customers.cus_manual = { id: 'cus_manual', email: 'someone-else@example.test', metadata: {} };
  ownWorkspace('cus_manual');
  assert.equal((await openPortal()).status, 422);
  assert.equal(wsCustomer('ws-caller'), 'cus_manual');
  assert.deepEqual(updates, []);

  reset();
  ownWorkspace('cus_caller');
  assert.equal((await openPortal()).status, 200);
  assert.equal(wsCustomer('ws-caller'), 'cus_caller');
  assert.deepEqual(updates, []);
});

test('a dead first candidate is healed and a valid second one still opens the portal', async () => {
  reset();
  ownWorkspace('cus_gone');
  tables.workspaces.push({ id: 'ws-caller-2', owner_id: CALLER, stripe_customer_id: 'cus_caller', deleted_at: null, created_at: '2026-05-03' });
  const { status } = await openPortal();
  assert.equal(status, 200);
  assert.deepEqual(portalSessions, ['cus_caller']);
  assert.equal(wsCustomer('ws-caller'), null);
  assert.equal(wsCustomer('ws-caller-2'), 'cus_caller');
});

// ── test(verify): independent checks of the self-heal delta ──────────────────
test('[verify] rate limits, Stripe 5xx, code-less socket errors and metadata-less customers never null a paying id', async () => {
  const transient: Error[] = [
    Object.assign(new Error('Too many requests'), { code: 'rate_limit', type: 'StripeRateLimitError', statusCode: 429 }),
    Object.assign(new Error('Something went wrong on our end'), { type: 'StripeAPIError', statusCode: 500 }),
    new Error('socket hang up'),
    Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }),
  ];
  for (const err of transient) {
    reset();
    ownWorkspace('cus_caller');
    stripeOutage = err;
    assert.equal((await openPortal()).status, 422, err.message);
    assert.equal(wsCustomer('ws-caller'), 'cus_caller', err.message);
    assert.deepEqual(updates, [], err.message);
  }
  // No metadata, email matches but is unconfirmed: unproven, kept.
  reset();
  caller!.email_confirmed_at = null;
  customers.cus_legacy = { id: 'cus_legacy', email: 'caller@example.test' };
  ownWorkspace('cus_legacy');
  assert.equal((await openPortal()).status, 422);
  assert.equal(wsCustomer('ws-caller'), 'cus_legacy');
  assert.deepEqual(updates, []);
});

test('[verify] a failing heal write never blocks the response', async () => {
  reset();
  ownWorkspace('cus_gone');
  tables.workspaces.push({ id: 'ws-caller-2', owner_id: CALLER, stripe_customer_id: 'cus_caller', deleted_at: null, created_at: '2026-05-03' });
  updates = { push() { throw new Error('db down'); } } as unknown as Row[];
  const { status } = await openPortal();
  assert.equal(status, 200);
  assert.deepEqual(portalSessions, ['cus_caller']);
});
