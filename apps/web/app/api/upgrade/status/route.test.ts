// ---------------------------------------------------------------------------
// GET /api/upgrade/status: the success page's poll. Public, so the one thing
// pinned here is that it answers `{ active: boolean }` and nothing else, for
// every state a session can be in, and is never cached.
//
// checkoutLinkStatus is stubbed; its own cases are in
// src/lib/stripe/checkout-link.test.ts.
//
// Run: npm run test:checkout-link
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let status = 'active';
let asked: unknown[] = [];

nodeMock.module('@/lib/stripe/checkout-link', {
  namedExports: {
    checkoutLinkStatus: async (sessionId: unknown) => {
      asked.push(sessionId);
      return status;
    },
  },
});

nodeMock.module('@/lib/email/abandoned-checkout', {
  namedExports: {
    checkoutSessionIdOrNull: (value: unknown) =>
      typeof value === 'string' && /^cs_(?:test|live)_[A-Za-z0-9]{8,240}$/.test(value) ? value : null,
  },
});

nodeMock.module('next/server', {
  namedExports: {
    NextRequest: Request,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    },
  },
});

const route = (await import('./route.ts')) as Record<string, unknown>;
const GET = route.GET as (req: unknown) => Promise<Response>;

async function poll(query: string) {
  const url = new URL(`https://mcpemails.test/api/upgrade/status${query}`);
  const res = await GET(Object.assign(new Request(url), { nextUrl: url }));
  assert.equal(res.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(res.headers.get('set-cookie'), null);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['active']);
  assert.equal(typeof body.active, 'boolean');
  return { res, body };
}

test('only an active purchase reads true; every other state is the same false', async () => {
  for (const [s, expected] of [['active', true], ['activating', false], ['unpaid', false], ['unknown', false]] as const) {
    status = s;
    const { res, body } = await poll('?session_id=cs_test_a1B2c3D4e5F6g7H8');
    assert.equal(res.status, 200, s);
    assert.equal(body.active, expected, s);
  }
});

test('a malformed or missing session id is refused before any lookup', async () => {
  asked = [];
  for (const q of ['', '?session_id=', '?session_id=pi_123', '?session_id=cs_test_%3Cx%3E']) {
    const { res, body } = await poll(q);
    assert.equal(res.status, 400, q);
    assert.equal(body.active, false);
  }
  assert.deepEqual(asked, []);
});

test('the route exports GET only', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  assert.deepEqual(methods.filter((m) => typeof route[m] === 'function'), ['GET']);
});
