// ---------------------------------------------------------------------------
// POST /api/internal/eur-launch/dispatch through the exported handler: every
// method, the secret, and that a call before the launch date touches nothing.
// The run itself is tested in src/lib/stripe/eur-launch-run.test.ts.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        app/api/internal/eur-launch/dispatch/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import * as route from './route.ts';
import { eurLaunchDatePassed } from '../../../../../src/lib/stripe/eur-launch-date.ts';

const URL_ = 'https://mcpemails.com/api/internal/eur-launch/dispatch';

test('only POST is exported; every other method falls to Next.js 405', () => {
  assert.equal(typeof route.POST, 'function');
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((route as Record<string, unknown>)[m], undefined, m);
  }
});

test('no secret configured, or a wrong one, is refused before any read', async () => {
  delete process.env.DISPATCH_SECRET;
  let res = await route.POST(new Request(URL_, { method: 'POST', headers: { 'x-dispatch-secret': 'x' } }));
  assert.equal(res.status, 403);

  process.env.DISPATCH_SECRET = 'right-secret';
  res = await route.POST(new Request(URL_, { method: 'POST', headers: { 'x-dispatch-secret': 'wrong-secret' } }));
  assert.equal(res.status, 403);
  res = await route.POST(new Request(URL_, { method: 'POST' }));
  assert.equal(res.status, 403);
});

// Skipped from the launch date on, when a call is supposed to read.
test('a call before the launch date reads nothing and returns outside_window', { skip: eurLaunchDatePassed() }, async () => {
  process.env.DISPATCH_SECRET = 'right-secret';
  // Placeholder credentials: a database read or a Stripe call would fail
  // loudly, so a 200 with outside_window proves neither happened.
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error('no network in this test');
  }) as typeof fetch;
  try {
    const res = await route.POST(new Request(URL_, { method: 'POST', headers: { 'x-dispatch-secret': 'right-secret' } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'outside_window');
    assert.equal(body.launchAt, '2026-12-06T23:00:00.000Z');
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no Stripe key: a clear 500, not a crash', async () => {
  process.env.DISPATCH_SECRET = 'right-secret';
  delete process.env.STRIPE_SECRET_KEY;
  const res = await route.POST(new Request(URL_, { method: 'POST', headers: { 'x-dispatch-secret': 'right-secret' } }));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'stripe_not_configured');
});
