// ---------------------------------------------------------------------------
// /api/support/preview and /api/support/visibility, every method, for hidden
// and visible callers. Only the viewer is stubbed; the gate and token are real.
//
// Run: node --test --experimental-strip-types --experimental-test-module-mocks \
//        --import ./scripts/register-ts-alias.mjs app/api/support/preview/route.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'ab'.repeat(32);
process.env.GROWTH_INTERNAL_EMAILS = 'staff@example.com';

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Viewer = { visible: boolean; user: { id: string; email: string } | null };
let viewer: Viewer = { visible: false, user: null };
nodeMock.module('@/lib/support/viewer', { namedExports: { getSupportViewer: async () => viewer } });

const preview = (await import('./route.ts')) as unknown as Record<string, (r: Request) => Promise<Response>>;
const visibility = (await import('../visibility/route.ts')) as unknown as Record<string, () => Promise<Response>>;
const { readPreviewToken, SUPPORT_PREVIEW_COOKIE, supportVisibleTo } = await import('@/lib/support/release-gate');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const HIDDEN = { visible: false, user: { id: 'u2', email: 'customer@example.net' } };
const INTERNAL = { visible: true, user: { id: 'u1', email: 'staff@example.com' } };
const PREVIEW_ONLY = { visible: true, user: null };

const req = (method: string, query = '') => new Request(`https://mcpemails.test/api/support/preview${query}`, { method });

test('preview: hidden caller gets the unmatched 404 on every method', async () => {
  viewer = HIDDEN;
  for (const m of METHODS) {
    const res = await preview[m](req(m));
    assert.equal(res.status, 404, m);
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('preview: visible caller gets 405 on everything but GET', async () => {
  viewer = INTERNAL;
  for (const m of METHODS.filter((x) => x !== 'GET')) {
    const res = await preview[m](req(m));
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('allow'), 'GET');
  }
});

test('preview: signed-in internal gets a working signed cookie and a 303 to /help', async () => {
  viewer = INTERNAL;
  const res = await preview.GET(req('GET'));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://mcpemails.test/help');
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.equal(cookie.startsWith(`${SUPPORT_PREVIEW_COOKIE}=`), true);
  for (const attr of ['Path=/', 'Max-Age=2592000', 'Secure', 'SameSite=Lax']) assert.equal(cookie.includes(attr), true, attr);
  assert.equal(/httponly/i.test(cookie), false);
  const token = cookie.split(';')[0].split('=').slice(1).join('=');
  assert.equal(readPreviewToken(token, Date.now()), 'staff@example.com');
  assert.equal(supportVisibleTo(null, token), true);
});

test('preview: a preview-cookie-only visitor cannot mint a new token, but can clear', async () => {
  viewer = PREVIEW_ONLY;
  assert.equal((await preview.GET(req('GET'))).status, 404);
  const res = await preview.GET(req('GET', '?clear=1'));
  assert.equal(res.status, 303);
  assert.equal((res.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true);
});

test('preview: an external account that is visible only through a preview cookie cannot mint', async () => {
  viewer = { visible: true, user: { id: 'u3', email: 'customer@example.net' } };
  const res = await preview.GET(req('GET'));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('preview: ?clear=1 from a hidden caller is still a 404', async () => {
  viewer = HIDDEN;
  assert.equal((await preview.GET(req('GET', '?clear=1'))).status, 404);
});

test('visibility: 204 when visible, 404 when hidden; 405 on other methods only when visible', async () => {
  viewer = INTERNAL;
  assert.equal((await visibility.GET()).status, 204);
  assert.equal((await visibility.HEAD()).status, 204);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await visibility[m]();
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
  viewer = HIDDEN;
  for (const m of METHODS) {
    const res = await visibility[m]();
    assert.equal(res.status, 404, m);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});
