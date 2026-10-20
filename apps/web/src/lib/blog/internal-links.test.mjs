// ---------------------------------------------------------------------------
// Links inside blog post bodies.
//
// Run with: npm run test:blog-links
//
// Renders every post in every locale the way app/[locale]/blog/[slug]/page.js
// does, and pins:
//
//   - every site-internal link lands on a page that exists (a post, a released
//     provider page in that locale, a client setup page, or a known route);
//   - on /nb, /es, /fr and /zh a link carries the locale prefix only when the
//     target exists in that locale (lib/blog/localize-href.mjs), and the
//     guide posts' provider links carry it;
//   - the guide posts link the provider pages that own the provider queries,
//     and the posts that earn search clicks are linked from the rest of the
//     blog (2026-10-19: two incoming links for the best-converting post, none
//     from other posts for the IMAP connector guide).
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try {
        return await next(specifier, context);
      } catch (err) {
        if (!/^\\.\\.?\\//.test(specifier)) throw err;
        if (err?.code === 'ERR_MODULE_NOT_FOUND') return next(specifier + '.js', context);
        if (err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return next(specifier + '/index.js', context);
        throw err;
      }
    }
  `)}`,
);

const { getAllPosts, getLocalizedPost, getPost, getPostLocales } = await import('./posts.js');
const { renderMarkdown } = await import('./markdown.js');
const { localizeHrefFor } = await import('./localize-href.mjs');
const { getProvider } = await import('../connect/providers.mjs');
const { CLIENTS } = await import('../clients/clients.mjs');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];
const lookups = {
  postLocales: (slug) => {
    const p = getPost(slug);
    return p ? getPostLocales(p) : null;
  },
  providerLocales: (slug) => getProvider(slug)?.locales ?? null,
};

/** Internal hrefs (path only, no hash/query) of one post rendered in one locale. */
function internalHrefs(slug, locale) {
  const post = getLocalizedPost(slug, locale);
  const { html } = renderMarkdown(post.content, { mapHref: localizeHrefFor(locale, lookups) });
  return [...html.matchAll(/<a href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => h.startsWith('/'))
    .map((h) => h.replace(/[?#].*$/, '').replace(/\/$/, '') || '/');
}

const DOCS_PAGES = new Set(['providers', 'read-only-access', 'clients', ...CLIENTS.map((c) => c.slug)]);
const PLAIN_ROUTES = new Set([
  '', 'pricing', 'security', 'about', 'self-hosting', 'native-connectors-vs-mcp', 'changelog',
  'status', 'privacy', 'terms', 'docs', 'blog', 'connect', 'for/business', 'for/founders',
]);
const OUTSIDE_LOCALE = new Set(['signup', 'login', 'dashboard', 'best-email-mcp-servers']);

/** Why `href`, seen on a page in `locale`, is broken; null when it is fine. */
function problem(href, locale) {
  const prefixed = href.match(/^\/(nb|es|fr|zh)(\/.*)?$/);
  const hrefLocale = prefixed ? prefixed[1] : 'en';
  if (prefixed && hrefLocale !== locale) return `links another locale (${hrefLocale})`;
  const path = (prefixed ? prefixed[2] ?? '' : href).replace(/^\//, '');
  if (OUTSIDE_LOCALE.has(path)) return prefixed ? 'prefix on a route outside [locale]' : null;
  if (PLAIN_ROUTES.has(path)) return null;
  const [root, slug, more] = path.split('/');
  if (more !== undefined) return 'unknown nested route';
  if (root === 'blog') {
    const post = getPost(slug);
    if (!post) return 'no such post';
    if (prefixed && !getPostLocales(post).includes(hrefLocale)) return 'post not translated';
    return null;
  }
  if (root === 'connect') {
    const p = getProvider(slug);
    if (!p) return 'no such provider';
    if (!p.locales.includes(hrefLocale)) return 'provider page not in this locale';
    return null;
  }
  if (root === 'docs') return DOCS_PAGES.has(slug) ? null : 'no such docs page';
  return 'unknown route';
}

test('localizeHrefFor: prefixes only pages that exist in the locale', () => {
  const fr = localizeHrefFor('fr', {
    postLocales: (s) => ({ translated: ['en', 'fr'], englishOnly: ['en'] })[s] ?? null,
    providerLocales: (s) => ({ yahoo: ['en', 'fr'], tiny: ['en'] })[s] ?? null,
  });
  assert.equal(fr('/blog/translated'), '/fr/blog/translated');
  assert.equal(fr('/blog/englishOnly'), '/blog/englishOnly');
  assert.equal(fr('/blog/missing'), '/blog/missing');
  assert.equal(fr('/connect/yahoo'), '/fr/connect/yahoo');
  assert.equal(fr('/connect/tiny'), '/connect/tiny');
  assert.equal(fr('/docs#quickstart'), '/fr/docs#quickstart');
  assert.equal(fr('/docs/claude'), '/fr/docs/claude');
  assert.equal(fr('/pricing'), '/fr/pricing');
  assert.equal(fr('/'), '/fr');
  assert.equal(fr('/signup'), '/signup');
  assert.equal(fr('/best-email-mcp-servers'), '/best-email-mcp-servers');
  assert.equal(localizeHrefFor('en', {})('/blog/x'), '/blog/x');
});

test('every internal link in every post, in every locale, lands on a real page', () => {
  const broken = [];
  let links = 0;
  for (const { slug } of getAllPosts()) {
    for (const locale of LOCALES) {
      for (const href of internalHrefs(slug, locale)) {
        links += 1;
        const why = problem(href, locale);
        if (why) broken.push(`${locale}/blog/${slug} -> ${href}: ${why}`);
      }
    }
  }
  assert.ok(links > 1000, `expected the whole blog, saw ${links} links`);
  assert.deepEqual(broken, []);
});

const GUIDE_LINKS = {
  'connect-claude-to-email': [
    '/connect/gmail', '/connect/google-workspace', '/connect/icloud', '/connect/fastmail',
    '/connect/outlook', '/connect/office365', '/connect/yahoo', '/connect/zoho',
    '/connect/yandex', '/connect/imap', '/connect', '/docs/claude',
  ],
  'claude-imap-connector': [
    '/connect', '/connect/icloud', '/connect/yahoo', '/connect/zoho', '/connect/yandex',
    '/connect/fastmail', '/connect/imap',
  ],
};

for (const [slug, targets] of Object.entries(GUIDE_LINKS)) {
  for (const locale of LOCALES) {
    test(`${locale}/blog/${slug} links the provider pages that own the provider queries`, () => {
      const prefix = locale === 'en' ? '' : `/${locale}`;
      const hrefs = new Set(internalHrefs(slug, locale));
      for (const t of targets) assert.ok(hrefs.has(`${prefix}${t}`), `missing ${prefix}${t}`);
    });
  }
}

test('the posts that earn search clicks are linked from the rest of the blog', () => {
  const incoming = (target) =>
    getAllPosts().filter((p) => p.slug !== target && internalHrefs(p.slug, 'en').includes(`/blog/${target}`)).length;
  assert.ok(incoming('connect-claude-to-email') >= 8, `connect-claude-to-email: ${incoming('connect-claude-to-email')}`);
  assert.ok(incoming('connect-chatgpt-to-email') >= 4, `connect-chatgpt-to-email: ${incoming('connect-chatgpt-to-email')}`);
  assert.ok(incoming('claude-imap-connector') >= 2, `claude-imap-connector: ${incoming('claude-imap-connector')}`);
});
