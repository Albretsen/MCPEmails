// POST /api/internal/site-feed/dispatch: the secret gate, the job switch, the
// unset-key no-op, and a 405 for every other method. The jobs themselves are
// covered in src/lib/site-feed/run.test.ts; here they are stubbed so the route
// is tested on its own.
//
// Run: npm run test:site-feed-route
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.DISPATCH_SECRET = 'dispatch_unit_secret';

/** `mock.module` post-dates the pinned @types/node, same cast as checkout-core.test.ts. */
const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

const ran: string[] = [];

nodeMock.module('@/lib/site-feed/run', {
  namedExports: {
    runEventsJob: async (deps: { key: string }) => {
      ran.push(`events:${deps.key}`);
      return { job: 'events', candidates: 0, posted: 0 };
    },
    runMrrJob: async (deps: { key: string }) => {
      ran.push(`mrr:${deps.key}`);
      return { job: 'mrr', posted: true };
    },
  },
});
nodeMock.module('@/lib/supabase/service', { namedExports: { createServiceRoleClient: () => ({}) } });
nodeMock.module('@/lib/analytics/kiosk-revenue', { namedExports: { loadRecurringRevenue: async () => ({ mrrMinor: 1 }) } });

const route = await import('./route.ts');

function post(query: string, secret: string | null = 'dispatch_unit_secret') {
  const headers: Record<string, string> = {};
  if (secret !== null) headers['x-dispatch-secret'] = secret;
  return route.POST(new Request(`https://mcpemails.com/api/internal/site-feed/dispatch${query}`, { method: 'POST', headers }));
}

test('a missing or wrong secret is a 403 and runs nothing', async () => {
  process.env.ALBRETSEN_FEED_KEY = 'feed_key';
  ran.length = 0;
  for (const secret of [null, '', 'wrong', 'dispatch_unit_secretX']) {
    const res = await post('?job=events', secret);
    assert.equal(res.status, 403, String(secret));
  }
  assert.deepEqual(ran, []);
});

test('an unset DISPATCH_SECRET refuses everything', async () => {
  const saved = process.env.DISPATCH_SECRET;
  delete process.env.DISPATCH_SECRET;
  try {
    assert.equal((await post('?job=events', '')).status, 403);
  } finally {
    process.env.DISPATCH_SECRET = saved;
  }
});

test('an unknown or missing job is a 400', async () => {
  ran.length = 0;
  assert.equal((await post('')).status, 400);
  assert.equal((await post('?job=all')).status, 400);
  assert.deepEqual(ran, []);
});

test('without ALBRETSEN_FEED_KEY every job is a silent no-op', async () => {
  delete process.env.ALBRETSEN_FEED_KEY;
  ran.length = 0;
  for (const job of ['events', 'mrr']) {
    const res = await post(`?job=${job}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { job, skipped: 'not_configured' });
  }
  process.env.ALBRETSEN_FEED_KEY = '   ';
  assert.deepEqual(await (await post('?job=mrr')).json(), { job: 'mrr', skipped: 'not_configured' });
  assert.deepEqual(ran, []);
});

test('each job runs with the key, and the key is not in the response', async () => {
  process.env.ALBRETSEN_FEED_KEY = 'feed_key_secret_value';
  ran.length = 0;
  const events = await post('?job=events');
  assert.equal(events.status, 200);
  const mrr = await post('?job=mrr');
  assert.equal(mrr.status, 200);
  assert.deepEqual(ran, ['events:feed_key_secret_value', 'mrr:feed_key_secret_value']);
  const text = JSON.stringify([await events.json(), await mrr.json()]);
  assert.ok(!text.includes('feed_key_secret_value'));
});

for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
  test(`${method} is a 405 that allows only POST`, async () => {
    ran.length = 0;
    const handler = (route as unknown as Record<string, (req: Request) => Promise<Response>>)[method];
    assert.equal(typeof handler, 'function');
    const res = await handler(new Request('https://mcpemails.com/api/internal/site-feed/dispatch?job=events', {
      method,
      headers: { 'x-dispatch-secret': 'dispatch_unit_secret' },
    }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    assert.deepEqual(ran, []);
  });
}
