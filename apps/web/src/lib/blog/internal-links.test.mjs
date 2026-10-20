// ---------------------------------------------------------------------------
// Links inside blog post bodies.
//
// Run with: npm run test:blog-links
//
// Renders posts the way app/[locale]/blog/[slug]/page.js does (hrefFor =
// localizeHref from links.mjs) and pins:
//
//   - the guide posts link the provider pages that own the provider queries,
//     in every locale, with the locale prefix;
//   - the posts that earn search clicks are linked from the rest of the blog
//     (2026-10-19: two incoming links for the best-converting post, none from
//     other posts for the IMAP connector guide).
//
// That every link resolves in its locale is links.test.mjs's job.
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
const { localizeHref } = await import('./links.mjs');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];
const postLocales = (slug) => {
  const p = getPost(slug);
  return p ? getPostLocales(p) : [];
};

/** Internal hrefs (path only, no hash/query) of one post rendered in one locale. */
function internalHrefs(slug, locale) {
  const post = getLocalizedPost(slug, locale);
  const { html } = renderMarkdown(post.content, {
    hrefFor: (href) => localizeHref(href, locale, { postLocales }),
  });
  return [...html.matchAll(/<a href="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((h) => h.startsWith('/'))
    .map((h) => h.replace(/[?#].*$/, '').replace(/\/$/, '') || '/');
}

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
