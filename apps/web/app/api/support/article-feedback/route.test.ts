// ---------------------------------------------------------------------------
// POST /api/support/article-feedback, every method, signed in and signed out.
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

type Viewer = { user: { id: string; email: string } | null };
let viewer: Viewer = { user: null };
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
const SIGNED_IN: Viewer = { user: { id: '11111111-1111-4111-8111-111111111111', email: 'staff@example.com' } };
const SIGNED_OUT: Viewer = { user: null };

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://mcpemails.test/api/support/article-feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('anything but POST is 405', async () => {
  viewer = SIGNED_IN;
  for (const m of METHODS.filter((x) => x !== 'POST')) {
    const res = await route[m](new Request('https://mcpemails.test/api/support/article-feedback', { method: m }));
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.get('Allow'), 'POST');
  }
});

test('a signed-in vote is stored once per user and article', async () => {
  viewer = SIGNED_IN;
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
      voter_key: `u:${SIGNED_IN.user!.id}`,
      user_id: SIGNED_IN.user!.id,
      updated_at: 'string',
    },
  );
  assert.deepEqual(opts, { onConflict: 'article_id,voter_key' });
});

test('a signed-out vote is keyed by a hash of the IP, never the address', async () => {
  viewer = SIGNED_OUT;
  upserts.length = 0;
  await route.POST(post({ articleId: 'imap-password-rejected', locale: 'en', helpful: true }, { 'x-forwarded-for': '203.0.113.9' }));
  assert.equal(upserts.length, 1);
  const key = String(upserts[0].row.voter_key);
  assert.match(key, /^ip:[A-Za-z0-9_-]+$/);
  assert.equal(key.includes('203.0.113.9'), false);
  assert.equal(upserts[0].row.user_id, null);
});

test('a malformed body is 400 and never written', async () => {
  viewer = SIGNED_IN;
  upserts.length = 0;
  const cases: [unknown, string][] = [
    ['not json', 'invalid_body'],
    ['[1,2]', 'invalid_body'],
    ['null', 'invalid_body'],
    [{ locale: 'en', helpful: true }, 'invalid_article_id'],
    [{ articleId: '', locale: 'en', helpful: true }, 'invalid_article_id'],
    [{ articleId: 'a'.repeat(121), locale: 'en', helpful: true }, 'invalid_article_id'],
    [{ articleId: 'imap-password-rejected', locale: 'en', helpful: 'yes' }, 'invalid_helpful'],
    [{ articleId: 'imap-password-rejected', locale: 'en' }, 'invalid_helpful'],
    [{ articleId: 'imap-password-rejected', locale: 'xx', helpful: true }, 'invalid_locale'],
    [{ articleId: 'imap-password-rejected', locale: 7, helpful: true }, 'invalid_locale'],
    [{ articleId: 'imap-password-rejected', helpful: true, padding: 'x'.repeat(2000) }, 'body_too_large'],
    [{ articleId: 'x'.repeat(100 * 1024), helpful: true }, 'body_too_large'],
    // 400 characters, 1200 bytes: the cap is in bytes.
    [{ articleId: 'imap-password-rejected', helpful: true, padding: '字'.repeat(400) }, 'body_too_large'],
  ];
  for (const [body, error] of cases) {
    const res = await route.POST(post(body));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await res.json(), { error });
  }
  assert.equal(upserts.length, 0);
});

test('a well-formed vote for an unknown article is 204 with no write', async () => {
  viewer = SIGNED_IN;
  upserts.length = 0;
  const res = await route.POST(post({ articleId: 'no-such-article', locale: 'en', helpful: true }));
  assert.equal(res.status, 204);
  assert.equal(upserts.length, 0);
});

test('a vote without a locale is stored as English', async () => {
  viewer = SIGNED_IN;
  upserts.length = 0;
  const res = await route.POST(post({ articleId: 'imap-password-rejected', helpful: true }));
  assert.equal(res.status, 204);
  assert.equal(upserts[0].row.locale, 'en');
});
