// ---------------------------------------------------------------------------
// /api/geo through the exported handler, every method.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        app/api/geo/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import * as route from './route.ts';

function req(country: string | null): Request {
  const headers = new Headers();
  if (country != null) headers.set('x-vercel-ip-country', country);
  return new Request('https://mcpemails.com/api/geo', { headers });
}

async function answer(country: string | null) {
  const res = await route.GET(req(country));
  return { res, body: (await res.json()) as { country: string | null; eur: boolean } };
}

test('switch off: EU visitors stay on USD', async () => {
  delete process.env.STRIPE_EUR_PRICES;
  const { res, body } = await answer('DE');
  assert.deepEqual(body, { country: 'DE', eur: false });
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.match(res.headers.get('cache-control') ?? '', /private/);
});

test('switch on: EU countries, including non-euro members, get EUR', async () => {
  process.env.STRIPE_EUR_PRICES = 'true';
  try {
    for (const cc of ['DE', 'FR', 'SE', 'PL', 'CZ', 'DK', 'HU', 'RO', 'GR']) {
      assert.equal((await answer(cc)).body.eur, true, cc);
    }
    for (const cc of ['US', 'NO', 'GB', 'CH', 'XX', 'EU']) {
      assert.equal((await answer(cc)).body.eur, false, cc);
    }
    assert.deepEqual((await answer(null)).body, { country: null, eur: false });
  } finally {
    delete process.env.STRIPE_EUR_PRICES;
  }
});

test('the switch is read per request', async () => {
  process.env.STRIPE_EUR_PRICES = 'off';
  assert.equal((await answer('DE')).body.eur, false);
  process.env.STRIPE_EUR_PRICES = 'YES';
  assert.equal((await answer('DE')).body.eur, true);
  delete process.env.STRIPE_EUR_PRICES;
});

test('STRIPE_FORCE_USD beats STRIPE_EUR_PRICES: checkout sells USD, so the page says USD', async () => {
  process.env.STRIPE_EUR_PRICES = 'true';
  process.env.STRIPE_FORCE_USD = 'true';
  try {
    assert.equal((await answer('DE')).body.eur, false);
    assert.equal((await answer('SE')).body.eur, false);
  } finally {
    delete process.env.STRIPE_EUR_PRICES;
    delete process.env.STRIPE_FORCE_USD;
  }
});

test('only GET is exported, so other methods get 405 from Next', () => {
  const methods = Object.keys(route).filter((k) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k));
  assert.deepEqual(methods, ['GET']);
});
