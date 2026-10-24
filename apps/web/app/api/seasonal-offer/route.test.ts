// GET /api/seasonal-offer, outside the window: no Stripe call, an empty answer
// the edge may cache for a minute, and no handler for any other method (Next
// answers those 405).
// Run with: npm run test:seasonal-switch
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SEASONAL_OFFER_PREVIEW_NOW;
const route = await import('./route.ts');

test('only GET is handled, and the route is never prerendered', () => {
  assert.equal(route.dynamic, 'force-dynamic');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((route as Record<string, unknown>)[method], undefined, method);
  }
});

test('outside the window it answers no offers, cacheable for a minute', async () => {
  // The suite runs before 27 Nov 2026 or after 1 Dec 2026; either way the
  // window is closed and no Stripe key is needed.
  const now = Date.now();
  if (now >= Date.parse('2026-11-26T23:00:00Z') && now <= Date.parse('2026-12-01T22:59:59Z')) return;
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { offers: {} });
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/);
});
