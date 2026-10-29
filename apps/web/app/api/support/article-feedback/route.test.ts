// ---------------------------------------------------------------------------
// POST /api/support/article-feedback, every method, for hidden and visible
// callers.
//
// Run with: npm run test:help-center
//
// The viewer and the service client are stubbed; the article list is real, so
// a vote is accepted only for an article that ships.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

process.env.CSRF_SECRET = 'cd'.repeat(32);

const nodeMock = mock as unknown as {
  module: (specifier: string, options: { namedExports?: Record<string, unknown> }) => void;
};

type Viewer = { visible: boolean; user: { id: string; email: string } | null };
let viewer: Viewer = { visible: false, user: null };
const upserts: { row: Record<string, unknown>; opts: unknown }[] = [];
nodeMock.module('@/lib/support/viewer', { namedExports: { getSupportViewer: async () => viewer } });
nodeMock.module('@/lib/supabase/service', {
  namedExports: {
    createServiceRoleClient: () => ({
      from: (table: string) => {
        assert.equal(table, 'help_article_feedback');
        return {
          upsert: async (row: Record<string, unknown>, opts: unknown) => {
            upserts.push({ row, opts });
            return { error: null };
          },
        };
      },
    }),
  },
});

const route = (await import('./route.ts')) as unknown as Record<string, (r: Request) => Promise<Response>>;

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const INTERNAL: Viewer = { visible: true, user: { id: '11111111-1111-4111-8111-111111111111', email: 'staff@example.com' } };
const PREVIEW_ONLY: Viewer = { visible: true, user: null };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://mcpemails.test/api/support/article-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('hidden caller: the unmatched 404 on every method, nothing written', async () => {
  viewer = { visible: false, user: { id: 'u2', email: 'customer@example.net' } };
  upserts.length = 0;
  for (const m of METHODS) {
    const req = m === 'POST'
      ? post({ articleId: 'imap-password-rejected', locale: 'en', helpful: true })
      : new Request('https://mcpemails.test/api/support/article-feedback', { method: m });
    const res = await route[m](req);
    assert.equal(res.status, 404, m);
  }
  assert.equal(upserts.length, 0);
});

test('visible caller: anything but POST is 405', async () => {
  viewer = INTERNAL;
  for (const m of METHODS.filter((x) => x !== 'POST')) {
    const res = await route[m](new Request('https://mcpemails.test/api/support/article-feedback', { method: m }));
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('Allow'), 'POST');
  }
});

test('a signed-in vote is stored once per user and article', async () => {
  viewer = INTERNAL;
  upserts.length = 0;
  const res = await route.POST(post({ articleId: 'imap-password-rejected', locale: 'nb', helpful: false }));
  assert.equal(res.status, 204);
  assert.equal(upserts.length, 1);
  const { row, opts } = upserts[0];
  assert.deepEqual(
    { ...row, updated_at: typeof row.updated_at },
    {
      article_id: 'imap-password-rejected',
      locale: 'nb',
      helpful: false,
      voter_key: `u:${INTERNAL.user!.id}`,
      user_id: INTERNAL.user!.id,
      updated_at: 'string',
    },
  );
  assert.deepEqual(opts, { onConflict: 'article_id,voter_key' });
});

test('a signed-out vote is keyed by a hash of the IP, never the address', async () => {
  viewer = PREVIEW_ONLY;
  upserts.length = 0;
  await route.POST(post({ articleId: 'imap-password-rejected', locale: 'en', helpful: true }, { 'x-forwarded-for': '203.0.113.9' }));
  assert.equal(upserts.length, 1);
  const key = String(upserts[0].row.voter_key);
  assert.match(key, /^ip:[A-Za-z0-9_-]+$/);
  assert.equal(key.includes('203.0.113.9'), false);
  assert.equal(upserts[0].row.user_id, null);
});

test('junk is answered 204 and never written', async () => {
  viewer = INTERNAL;
  upserts.length = 0;
  for (const body of [
    'not json',
    { articleId: 'no-such-article', locale: 'en', helpful: true },
    { articleId: 'imap-password-rejected', locale: 'en', helpful: 'yes' },
    { articleId: 'imap-password-rejected', helpful: true, padding: 'x'.repeat(2000) },
  ]) {
    const res = await route.POST(post(body));
    assert.equal(res.status, 204);
  }
  assert.equal(upserts.length, 0);
});

test('an unknown locale is stored as English', async () => {
  viewer = INTERNAL;
  upserts.length = 0;
  await route.POST(post({ articleId: 'imap-password-rejected', locale: 'xx', helpful: true }));
  assert.equal(upserts[0].row.locale, 'en');
});
