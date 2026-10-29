// ---------------------------------------------------------------------------
// POST /api/internal/referrals/dispatch: the secret, and the wiring from the
// route to the dispatcher (the dispatcher's behaviour is
// src/lib/referrals/dispatch.test.ts).
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { FakeSupabase } from '@/lib/billing/fake-supabase';
import { FakeStripe } from '@/lib/referrals/fake-stripe';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

let db = new FakeSupabase();
const fake = new FakeStripe();
const sent: unknown[] = [];

nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => db } });
nodeMock.module('@/lib/stripe/client', { namedExports: { stripe: fake.api() } });
nodeMock.module('@/lib/billing/deleted-account', { namedExports: { accountState: async () => 'live' } });
nodeMock.module('@/lib/email/referral-emails', {
  namedExports: {
    sendReferralEmail: async (input: unknown) => {
      sent.push(input);
      return { ok: true };
    },
  },
});

process.env.DISPATCH_SECRET = 'dispatch-unit-secret';
const { POST } = await import('./route.ts');

const call = (secret?: string) =>
  POST(new Request('https://mcpemails.test/api/internal/referrals/dispatch', {
    method: 'POST',
    headers: secret === undefined ? {} : { 'x-dispatch-secret': secret },
    body: '{}',
  }));

test('no secret, a wrong secret or a wrong-length secret is 403 and touches nothing', async () => {
  db = new FakeSupabase();
  for (const secret of [undefined, 'dispatch-unit-secreT', 'short']) {
    const res = await call(secret);
    assert.equal(res.status, 403);
  }
  assert.equal(fake.calls.length, 0);
});

test('with the secret it runs and answers with the summary', async () => {
  db = new FakeSupabase();
  const res = await call('dispatch-unit-secret');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { due: 0, qualified: 0, capped: 0, voided: 0, held: 0, waiting: 0, skipped: 0, failed: 0 });
});

test('a failed selection is a 500, not a silent success', async () => {
  db = new FakeSupabase();
  db.failOnce('referrals', { message: 'down' });
  assert.equal((await call('dispatch-unit-secret')).status, 500);
});

test('an unset DISPATCH_SECRET refuses everything', async () => {
  const saved = process.env.DISPATCH_SECRET;
  delete process.env.DISPATCH_SECRET;
  try {
    assert.equal((await call('')).status, 403);
  } finally {
    process.env.DISPATCH_SECRET = saved;
  }
});
