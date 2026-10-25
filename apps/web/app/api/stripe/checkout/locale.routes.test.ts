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
let passCalls: Array<Record<string, unknown>> = [];
let nextOutcome: Outcome = { kind: 'checkout', url: SESSION_URL };

beforeEach(() => {
  calls = [];
  passCalls = [];
  nextOutcome = { kind: 'checkout', url: SESSION_URL };
});

nodeMock.module('@/lib/stripe/checkout-core', {
  namedExports: {
    runCheckout: async (input: Record<string, unknown>) => {
      calls.push(input);
      return nextOutcome;
    },
    runPassCheckout: async (input: Record<string, unknown>) => {
      passCalls.push(input);
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

test('GET hands the reminder link\'s recovered_from to the core, and keeps it through /login', async () => {
  await GET(getRequest('?plan=solo&interval=year&lang=fr&recovered_from=cs_live_a1B2c3D4e5F6g7H8'));
  assert.deepEqual(calls, [
    { planId: 'solo', interval: 'year', locale: 'fr', recoveredFrom: 'cs_live_a1B2c3D4e5F6g7H8' },
  ]);
  nextOutcome = { kind: 'error', reason: 'unauthenticated', status: 401, message: 'Unauthorized' };
  const res = await GET(getRequest('?plan=solo&interval=year&recovered_from=cs_live_a1B2c3D4e5F6g7H8'));
  const login = new URL(res.headers.get('location') ?? '');
  assert.match(login.searchParams.get('redirect') ?? '', /recovered_from=cs_live_a1B2c3D4e5F6g7H8/);
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

// ── The 3-month Personal pass ───────────────────────────────────────────────

test('GET product=personal_pass_3m runs the pass checkout, with the language, arm and surface', async () => {
  const response = await GET(getRequest('?product=personal_pass_3m&lang=de&arm=treatment&from=cap_banner&plan=solo'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), SESSION_URL);
  assert.equal(calls.length, 0, 'never the subscription checkout');
  assert.deepEqual(passCalls, [{ locale: 'de', experimentArm: 'treatment', surface: 'cap_banner' }]);
});

test('GET a refused pass lands on the billing screen with its reason', async () => {
  nextOutcome = { kind: 'error', reason: 'pass_unavailable', status: 404, message: 'x' };
  const response = await GET(getRequest('?product=personal_pass_3m'));
  assert.equal(response.status, 303);
  const location = new URL(String(response.headers.get('location')));
  assert.equal(location.pathname, '/dashboard/settings');
  assert.equal(location.searchParams.get('checkout_error'), 'pass_unavailable');
});

test('GET without a product is the subscription checkout, exactly as before', async () => {
  await GET(getRequest('?plan=personal&interval=month'));
  assert.equal(passCalls.length, 0);
  assert.equal(calls.length, 1);
});

test('POST product=personal_pass_3m runs the pass checkout and answers the URL', async () => {
  const response = await POST(postRequest({ product: 'personal_pass_3m', locale: 'de', arm: 'holdout', surface: 'checkout_return', confirm: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: SESSION_URL });
  assert.equal(calls.length, 0);
  assert.deepEqual(passCalls, [{ locale: 'de', experimentArm: 'holdout', surface: 'checkout_return' }]);
});

test('POST an unknown product is a 400 and runs nothing', async () => {
  const response = await POST(postRequest({ product: 'personal_pass_12m', planId: 'personal', interval: 'month' }));
  assert.equal(response.status, 400);
  assert.equal(calls.length + passCalls.length, 0);
});

test('POST a refused pass answers its status and message', async () => {
  nextOutcome = { kind: 'error', reason: 'already_subscribed', status: 409, message: 'You already have a subscription.' };
  const response = await POST(postRequest({ product: 'personal_pass_3m' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'You already have a subscription.' });
});
