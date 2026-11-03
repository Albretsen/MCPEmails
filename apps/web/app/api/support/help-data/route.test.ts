// ---------------------------------------------------------------------------
// GET /api/support/help-data, every method, signed in and signed out.
//
// Run with: npm run test:help-center
//
// The viewer and the context read are stubbed (no session, no database); the
// session arrives through the stubbed viewer exactly as it would from
// getSupportViewer(). Everything else is real: the copy, the articles, the
// search index and the form token.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'cd'.repeat(32);

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Viewer = { user: { id: string; email: string } | null };
let viewer: Viewer = { user: null };
const contextReads: string[] = [];
nodeMock.module('@/lib/support/viewer', { namedExports: { getSupportViewer: async () => viewer } });
nodeMock.module('@/lib/support/context', {
  namedExports: {
    getTicketContextPreview: async (userId: string) => {
      contextReads.push(userId);
      return { workspace_id: 'ws-1', plan: 'free', mailboxes: [] };
    },
  },
});

const route = (await import('./route.ts')) as unknown as Record<string, (r: Request) => Promise<Response>>;
const { checkSupportFormToken } = await import('@/lib/support/form-token');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const SIGNED_IN: Viewer = { user: { id: 'u1', email: 'staff@example.com' } };
const SIGNED_OUT: Viewer = { user: null };

const req = (method: string, query = '') =>
  new Request(`https://mcpemails.test/api/support/help-data${query}`, { method });

test('405 with Allow: GET on every other method', async () => {
  viewer = SIGNED_IN;
  for (const m of METHODS.filter((x) => x !== 'GET')) {
    const res = await route[m](req(m));
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('allow'), 'GET', m);
  }
});

test('signed-in GET: the whole payload, uncached', async () => {
  viewer = SIGNED_IN;
  contextReads.length = 0;
  const res = await route.GET(req('GET', '?locale=en'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.email, 'support@mcpemails.com');
  assert.equal(body.signedIn, true);
  assert.equal(body.signedInEmail, 'staff@example.com');
  assert.equal(contextReads.join(','), 'u1');
  assert.equal(body.context.workspace_id, 'ws-1');
  assert.equal(checkSupportFormToken(body.formToken, Date.now() + 5_000), 'ok');
  assert.equal(body.locale, 'en');
  assert.equal(body.categories[0].area, 'common-fixes');
  assert.equal(body.copy.articles, undefined, 'articles travel in categories, not twice');
  assert.equal(typeof body.copy.contact.openForm, 'string');
  assert.equal(body.ticketCategories.join(','), 'connect,client,billing,bug,feature,other');
  const articleEntries = body.index.filter((e: { kind: string }) => e.kind === 'article');
  const articleCount = body.categories.reduce((n: number, c: { articles: unknown[] }) => n + c.articles.length, 0);
  assert.equal(articleEntries.length, articleCount);
  assert.equal(articleEntries.every((e: { href: string }) => e.href.startsWith('#article-')), true, 'in-page anchors');
});

test('locale: a supported one is used, anything else is English', async () => {
  viewer = SIGNED_IN;
  const nb = await (await route.GET(req('GET', '?locale=nb'))).json();
  assert.equal(nb.locale, 'nb');
  assert.notEqual(nb.copy.hero.title, (await (await route.GET(req('GET', '?locale=en'))).json()).copy.hero.title);
  assert.equal((await (await route.GET(req('GET', '?locale=it'))).json()).locale, 'en');
  assert.equal((await (await route.GET(req('GET'))).json()).locale, 'en');
});

test('topic, provider and code seed the form and the context', async () => {
  viewer = SIGNED_IN;
  const body = await (await route.GET(req('GET', '?locale=en&topic=connect&provider=yahoo&code=auth_failed'))).json();
  assert.equal(body.form.initialCategory, 'connect');
  assert.equal(body.form.providerName, 'Yahoo Mail');
  assert.equal(body.form.initialSubject.includes('Yahoo Mail'), true);
  assert.equal(body.form.open, true);
  assert.equal(body.context.provider, 'yahoo');
  assert.equal(body.context.code, 'auth_failed');
  const junk = await (await route.GET(req('GET', '?topic=%3Cscript%3E&provider=a%20b'))).json();
  assert.equal(junk.form.initialCategory, 'connect');
  assert.equal(junk.form.providerName, null);
  assert.equal(junk.form.open, false);
});

test('signed out: no context read', async () => {
  viewer = SIGNED_OUT;
  contextReads.length = 0;
  const body = await (await route.GET(req('GET', '?locale=fr'))).json();
  assert.equal(body.signedIn, false);
  assert.equal(body.signedInEmail, null);
  assert.equal(body.context, null);
  assert.equal(contextReads.length, 0);
});
