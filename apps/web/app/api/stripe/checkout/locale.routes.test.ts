// ---------------------------------------------------------------------------
// The buyer's language, from each checkout entry point into runCheckout.
//
// GET /api/stripe/checkout/start reads it from `?lang=` (the marketing CTAs and
// the dashboard's buy links), POST /api/stripe/checkout from the JSON body's
// `locale` (the dashboard's billing cards). Both hand the raw value to the
// core, which allow-lists it (checkoutLocale in checkout-core.ts, tested in
// checkout-core.test.ts). These tests pin the plumbing: that the value
// arrives, that a missing one stays missing, and that it survives the /login
// bounce a signed-out buyer takes.
//
// Only runCheckout and next/server are stubbed.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs \
//        app/api/stripe/checkout/locale.routes.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const SESSION_URL = 'https://checkout.stripe.com/c/pay/test_session';

type Outcome =
  | { kind: 'checkout'; url: string }
  | { kind: 'error'; reason: string; status: number; message: string };

let calls: Array<Record<string, unknown>> = [];
let nextOutcome: Outcome = { kind: 'checkout', url: SESSION_URL };

beforeEach(() => {
  calls = [];
  nextOutcome = { kind: 'checkout', url: SESSION_URL };
});

nodeMock.module('@/lib/stripe/checkout-core', {
  namedExports: {
    runCheckout: async (input: Record<string, unknown>) => {
      calls.push(input);
      return nextOutcome;
    },
  },
});

// Plain Node cannot resolve `next/server` outside the Next toolchain.
nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
      redirect: (url: string | URL, status: number) =>
        new Response(null, { status, headers: { location: String(url) } }),
    },
  },
});

const startRoute = (await import('./start/route.ts')) as Record<string, unknown>;
const postRoute = (await import('./route.ts')) as Record<string, unknown>;
const GET = startRoute.GET as (req: unknown) => Promise<Response>;
const POST = postRoute.POST as (req: unknown) => Promise<Response>;

/** A NextRequest as far as the start route reads one: `nextUrl`. */
function getRequest(query: string) {
  const url = new URL(`https://mcpemails.test/api/stripe/checkout/start${query}`);
  return Object.assign(new Request(url), { nextUrl: url });
}

function postRequest(body: unknown) {
  return new Request('https://mcpemails.test/api/stripe/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── GET /api/stripe/checkout/start ──────────────────────────────────────────

test('GET hands ?lang=de to the core and redirects to Stripe', async () => {
  const res = await GET(getRequest('?plan=personal&interval=year&lang=de'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), SESSION_URL);
  assert.deepEqual(calls, [{ planId: 'personal', interval: 'year', locale: 'de' }]);
});

test('GET without ?lang= hands the core no language, so it stays English', async () => {
  await GET(getRequest('?plan=solo&interval=month'));
  assert.deepEqual(calls, [{ planId: 'solo', interval: 'month', locale: null }]);
});

test('GET passes another language through as given: the core decides, not the route', async () => {
  await GET(getRequest('?plan=solo&interval=month&lang=nb'));
  assert.equal(calls[0].locale, 'nb');
});

test('GET keeps ?lang=de through the /login bounce, so the German page follows sign-in', async () => {
  nextOutcome = { kind: 'error', reason: 'unauthenticated', status: 401, message: 'Unauthorized' };
  const res = await GET(getRequest('?plan=pro&interval=month&lang=de'));
  assert.equal(res.status, 303);
  const login = new URL(res.headers.get('location') ?? '');
  assert.equal(login.pathname, '/login');
  const back = new URL(login.searchParams.get('redirect') ?? '', 'https://mcpemails.test');
  assert.equal(back.pathname, '/api/stripe/checkout/start');
  assert.equal(back.searchParams.get('lang'), 'de');
  assert.equal(back.searchParams.get('plan'), 'pro');
});

// ── POST /api/stripe/checkout ───────────────────────────────────────────────

test('POST hands the body locale to the core and answers the session URL', async () => {
  const res = await POST(postRequest({ planId: 'personal', interval: 'month', locale: 'de' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: SESSION_URL });
  assert.deepEqual(calls, [
    { planId: 'personal', interval: 'month', confirmChange: undefined, locale: 'de' },
  ]);
});

test('POST without a locale hands the core none, so it stays English', async () => {
  await POST(postRequest({ planId: 'solo', interval: 'year' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].locale, undefined);
});

test('POST still refuses a body that is not a JSON object before reaching the core', async () => {
  const res = await POST(postRequest('de'));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// ── Methods ────────────────────────────────────────────────────────────────

test('each route exports only the method it serves; Next answers 405 to the rest', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  assert.deepEqual(methods.filter((m) => typeof startRoute[m] === 'function'), ['GET']);
  assert.deepEqual(methods.filter((m) => typeof postRoute[m] === 'function'), ['POST']);
});
