// Client-first website (owner feedback F5) against a production build.
//
// A visitor from an AI assistant (utm_source, Referer or the mx_ai_client
// cookie) sees it first in the client lists, and the <title>, meta description
// and every JSON-LD block are byte-identical to what everyone else (and every
// crawler) gets. Unit-level checks run in CI: components/marketing/client-first.test.mjs.
//
// Needs a production build made with the CI placeholder env (see
// visible-text.check.mjs), then: npm run check:built-output

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequired, buildUnavailableReason, startServer, decodeEntities } from './harness.mjs';

const unavailable = buildUnavailableReason();
const skip = unavailable && !buildRequired ? unavailable : false;

let server;

before(async () => {
  if (skip) return;
  if (unavailable) throw new Error(unavailable);
  server = await startServer();
});

after(async () => {
  if (server) await server.stop();
});

async function get(route, headers = {}) {
  const response = await fetch(server.origin + route, {
    redirect: 'manual',
    headers: { accept: 'text/html', ...headers },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, headers: response.headers, html: await response.text() };
}

/** Everything a crawler or snippet reads from the head, plus the JSON-LD. */
function seoSurface(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? null;
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? null;
  const jsonLd = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return { title, description, jsonLd };
}

const marqueeNames = (html) =>
  [...html.matchAll(/<span class="marquee-item">[\s\S]*?<\/svg><\/span>([^<]+)<\/span>/g)].map((m) => decodeEntities(m[1]));

const ROUTES = ['/', '/fr', '/docs', '/docs/clients', '/docs/claude', '/docs/cursor'];
const VARIANTS = [
  ['utm_source=chatgpt.com', { query: 'utm_source=chatgpt.com' }],
  ['Referer claude.ai', { headers: { referer: 'https://claude.ai/' } }],
  ['cookie cursor', { headers: { cookie: 'mx_ai_client=cursor' } }],
];

for (const route of ROUTES) {
  test(`${route}: title, description and JSON-LD identical with and without an AI client`, { skip }, async () => {
    const base = await get(route);
    assert.equal(base.status, 200);
    const expected = seoSurface(base.html);
    assert.ok(expected.title, 'no <title>');
    for (const [label, v] of VARIANTS) {
      const sep = route.includes('?') ? '&' : '?';
      const got = await get(v.query ? `${route}${sep}${v.query}` : route, v.headers);
      assert.equal(got.status, 200, label);
      assert.deepEqual(seoSurface(got.html), expected, `${route} with ${label}`);
    }
  });
}

test('/: the marquee leads with ChatGPT for utm_source=chatgpt.com, Claude without', { skip }, async () => {
  const base = await get('/');
  const chat = await get('/?utm_source=chatgpt.com');
  assert.equal(marqueeNames(base.html)[0], 'Claude');
  assert.equal(marqueeNames(chat.html)[0], 'ChatGPT');
  assert.equal(base.headers.get('set-cookie')?.includes('mx_ai_client') ?? false, false);
  assert.match(chat.headers.get('set-cookie') ?? '', /mx_ai_client=chatgpt; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
  // The cookie alone reorders the next page view, and sets nothing new.
  const again = await get('/', { cookie: 'mx_ai_client=chatgpt' });
  assert.equal(marqueeNames(again.html)[0], 'ChatGPT');
  assert.equal(again.headers.get('set-cookie')?.includes('mx_ai_client') ?? false, false);
  // A direct visit never clears it; a newer AI signal replaces it.
  const google = await get('/', { cookie: 'mx_ai_client=chatgpt', referer: 'https://www.google.com/' });
  assert.equal(marqueeNames(google.html)[0], 'ChatGPT');
  const cursor = await get('/?utm_source=cursor', { cookie: 'mx_ai_client=chatgpt' });
  assert.equal(marqueeNames(cursor.html)[0], 'Cursor');
  assert.match(cursor.headers.get('set-cookie') ?? '', /mx_ai_client=cursor/);
});
