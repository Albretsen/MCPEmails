import assert from 'node:assert/strict';
import test from 'node:test';

import * as route from './route.ts';
import { noticeSendAllowed } from '../../../../../src/lib/email/pro-price-notice.ts';

const URL_ = 'https://mcpemails.com/api/internal/pro-price-notice/dispatch';

test('only POST is exported; every other method falls to Next.js 405', () => {
  assert.equal(typeof route.POST, 'function');
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
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

// Skipped on the announcement day itself, when a sending call is supposed to read.
test('a sending call outside the announcement day sends nothing and reads nothing', { skip: noticeSendAllowed() }, async () => {
  process.env.DISPATCH_SECRET = 'right-secret';
  // Placeholder credentials: a read would fail loudly, so a 200 proves none happened.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const res = await route.POST(new Request(URL_, { method: 'POST', headers: { 'x-dispatch-secret': 'right-secret' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'outside_window');
  assert.equal(body.sent, 0);
  assert.equal(body.read, 0);
});
