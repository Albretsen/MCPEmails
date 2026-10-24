// ---------------------------------------------------------------------------
// GET /api/stripe/payment-fix, end to end through the handler.
//
// Pins: an open invoice sends the owner to its hosted page; with none, a
// billing portal session (our pinned configuration); signed out goes to
// /login and back; a customer that names someone else never reaches Stripe's
// invoice or portal APIs; and only GET is exported.
//
// Only I/O is stubbed (both Supabase clients, the Stripe client, next/server).
// The ownership rules in src/lib/stripe/portal-customer.ts run for real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/stripe/payment-fix/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

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
let openInvoices: Record<string, Array<{ id: string; customer: string; hosted_invoice_url: string | null }>>;
let invoiceLookups: string[];
let portalSessions: Array<{ customer: string; configuration?: string; return_url: string }>;

function reset() {
  caller = { id: CALLER, email: 'caller@example.test', email_confirmed_at: '2026-06-01T00:00:00Z' };
  tables = { user_billing: [], workspaces: [] };
  customers = {
    cus_caller: { id: 'cus_caller', email: 'caller@example.test', metadata: { user_id: CALLER } },
    cus_victim: { id: 'cus_victim', email: 'victim@example.test', metadata: { user_id: VICTIM } },
  };
  openInvoices = {};
  invoiceLookups = [];
  portalSessions = [];
}
reset();

function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: caller }, error: caller ? null : { message: 'no session' } }) },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return builder; };
      builder.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return builder;
    },
  };
}

nodeMock.module('@/lib/supabase/server', { namedExports: { createClient: async () => fakeDb() } });
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => fakeDb() } });
nodeMock.module('@/lib/stripe/client', {
  namedExports: {
    stripe: {
      customers: {
        retrieve: async (id: string) => {
          const found = customers[id];
          if (!found) throw Object.assign(new Error(`No such customer: '${id}'`), { code: 'resource_missing' });
          return found;
        },
      },
      invoices: {
        list: async ({ customer, status }: { customer: string; status: string }) => {
          invoiceLookups.push(customer);
          assert.equal(status, 'open');
          return { data: openInvoices[customer] ?? [] };
        },
      },
      billingPortal: {
        sessions: {
          create: async (params: { customer: string; configuration?: string; return_url: string }) => {
            portalSessions.push(params);
            return { url: `https://billing.stripe.test/session/${params.customer}` };
          },
        },
      },
    },
  },
});
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      redirect: (url: URL, status: number) => new Response(null, { status, headers: { location: String(url) } }),
    },
  },
});

process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_mcpemails';
process.env.NEXT_PUBLIC_APP_URL = 'https://mcpemails.test';

const route = (await import('./route.ts')) as Record<string, unknown>;
const GET = route.GET as (req: Request) => Promise<Response>;

async function click() {
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await GET(new Request('https://mcpemails.test/api/stripe/payment-fix'));
    return { status: res.status, location: res.headers.get('location') ?? '', cache: res.headers.get('cache-control') ?? '' };
  } finally {
    console.error = originalError;
  }
}

test('an open invoice redirects (302) to its hosted invoice page', async () => {
  reset();
  tables.user_billing.push({ user_id: CALLER, stripe_customer_id: 'cus_caller' });
  openInvoices.cus_caller = [
    { id: 'in_open', customer: 'cus_caller', hosted_invoice_url: 'https://invoice.stripe.test/i/in_open' },
  ];
  const res = await click();
  assert.equal(res.status, 302);
  assert.equal(res.location, 'https://invoice.stripe.test/i/in_open');
  assert.match(res.cache, /no-store/);
  assert.equal(portalSessions.length, 0);
});

test('no open invoice falls back to a pinned billing portal session', async () => {
  reset();
  tables.user_billing.push({ user_id: CALLER, stripe_customer_id: 'cus_caller' });
  const res = await click();
  assert.equal(res.status, 302);
  assert.equal(res.location, 'https://billing.stripe.test/session/cus_caller');
  assert.equal(portalSessions.length, 1);
  assert.equal(portalSessions[0].configuration, 'bpc_mcpemails');
  assert.equal(portalSessions[0].return_url, 'https://mcpemails.test/dashboard/settings');
});

test('signed out redirects to /login and back here', async () => {
  reset();
  caller = null;
  const res = await click();
  assert.equal(res.status, 303);
  const url = new URL(res.location);
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('redirect'), '/api/stripe/payment-fix');
  assert.equal(invoiceLookups.length, 0);
});

test("someone else's customer on a workspace row is refused", async () => {
  reset();
  tables.workspaces.push({ id: 'ws-caller', owner_id: CALLER, stripe_customer_id: 'cus_victim', deleted_at: null });
  openInvoices.cus_victim = [
    { id: 'in_victim', customer: 'cus_victim', hosted_invoice_url: 'https://invoice.stripe.test/i/in_victim' },
  ];
  const res = await click();
  assert.equal(res.status, 302);
  assert.equal(new URL(res.location).pathname, '/dashboard/settings');
  assert.equal(invoiceLookups.length, 0, 'no invoice lookup for a refused customer');
  assert.equal(portalSessions.length, 0, 'no portal session for a refused customer');
});

test("a user_billing id whose Stripe customer names someone else is refused too", async () => {
  reset();
  tables.user_billing.push({ user_id: CALLER, stripe_customer_id: 'cus_victim' });
  const res = await click();
  assert.equal(new URL(res.location).pathname, '/dashboard/settings');
  assert.equal(invoiceLookups.length, 0);
});

test('a workspace customer that proves it is the caller\'s is used', async () => {
  reset();
  tables.workspaces.push({ id: 'ws-caller', owner_id: CALLER, stripe_customer_id: 'cus_caller', deleted_at: null });
  openInvoices.cus_caller = [
    { id: 'in_open', customer: 'cus_caller', hosted_invoice_url: 'https://invoice.stripe.test/i/in_open' },
  ];
  const res = await click();
  assert.equal(res.location, 'https://invoice.stripe.test/i/in_open');
});

test('no customer at all goes to settings', async () => {
  reset();
  const res = await click();
  assert.equal(res.status, 302);
  assert.equal(new URL(res.location).pathname, '/dashboard/settings');
});

test('only GET is exported, so every other method is a 405', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(typeof route[method], 'undefined', method);
  }
  assert.equal(typeof route.GET, 'function');
});
