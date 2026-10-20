import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizeHref, pathLocales } from './links.mjs';
import { getProvider } from '../connect/providers.mjs';
import { getClient } from '../clients/clients.mjs';
import { renderMarkdown } from './markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
const postsDir = join(here, 'posts');
const translationsDir = join(here, 'translations');
const localeAppDir = join(here, '../../../app/[locale]');

const slugs = readdirSync(postsDir).map((f) => f.replace(/\.js$/, ''));

/**
 * Locales a post is translated into, read from disk the way posts.js reads
 * them: a sidecar per locale, plus inline `{ en, es, ... }` field maps.
 * posts.js itself uses extensionless imports that plain node cannot load.
 */
function postLocales(slug) {
  if (!slugs.includes(slug)) return [];
  const locales = new Set(['en']);
  const dir = join(translationsDir, slug);
  if (existsSync(dir)) for (const f of readdirSync(dir)) locales.add(f.replace(/\.js$/, ''));
  const src = readFileSync(join(postsDir, `${slug}.js`), 'utf8');
  for (const m of src.matchAll(/^\s+(nb|es|fr|zh):\s/gm)) locales.add(m[1]);
  return [...locales];
}

const opts = { postLocales };

test('English pages keep every href as written', () => {
  assert.equal(localizeHref('/docs', 'en', opts), '/docs');
  assert.equal(localizeHref('/blog/claude-imap-connector', 'en', opts), '/blog/claude-imap-connector');
});

test('a page in every locale gets the prefix, keeping its hash and query', () => {
  assert.equal(localizeHref('/docs', 'es', opts), '/es/docs');
  assert.equal(localizeHref('/pricing#faq', 'fr', opts), '/fr/pricing#faq');
  assert.equal(localizeHref('/', 'nb', opts), '/nb');
  assert.equal(localizeHref('/#features', 'zh', opts), '/zh#features');
});

test('a post is prefixed only in the locales it is translated into', () => {
  assert.ok(postLocales('claude-imap-connector').includes('es'));
  assert.equal(localizeHref('/blog/claude-imap-connector', 'es', opts), '/es/blog/claude-imap-connector');
  // English only: /es/blog/approve-ai-agent-email-sends is a 308 to this URL.
  assert.deepEqual(postLocales('approve-ai-agent-email-sends'), ['en']);
  assert.equal(localizeHref('/blog/approve-ai-agent-email-sends', 'es', opts), '/blog/approve-ai-agent-email-sends');
});

test('English-only pages, app routes, external links and files are left alone', () => {
  assert.equal(localizeHref('/best-email-mcp-servers', 'es', opts), '/best-email-mcp-servers');
  assert.equal(localizeHref('/signup', 'es', opts), '/signup');
  assert.equal(localizeHref('/dashboard', 'es', opts), '/dashboard');
  assert.equal(localizeHref('/api/mcp', 'es', opts), '/api/mcp');
  assert.equal(localizeHref('/llms.txt', 'es', opts), '/llms.txt');
  assert.equal(localizeHref('https://example.com/docs', 'es', opts), 'https://example.com/docs');
  assert.equal(localizeHref('//cdn.example.com/x', 'es', opts), '//cdn.example.com/x');
  assert.equal(localizeHref('#setup', 'es', opts), '#setup');
  assert.equal(localizeHref('/es/docs', 'es', opts), '/es/docs');
});

test('provider and client pages follow their own locale lists', () => {
  const englishOnly = ['strato', 'migadu', 'namecheap', 'ionos'].find(
    (s) => getProvider(s) && !getProvider(s).locales.includes('zh'),
  );
  if (englishOnly) {
    assert.equal(localizeHref(`/connect/${englishOnly}`, 'zh', opts), `/connect/${englishOnly}`);
  }
  assert.equal(localizeHref('/connect/gmail', 'es', opts), '/es/connect/gmail');
  assert.equal(localizeHref('/docs/claude', 'fr', opts), '/fr/docs/claude');
  assert.equal(localizeHref('/docs/providers', 'fr', opts), '/fr/docs/providers');
});

test('renderMarkdown applies hrefFor to internal links only', () => {
  const md = 'See [docs](/docs) and [site](https://example.com).';
  const plain = renderMarkdown(md).html;
  assert.match(plain, /href="\/docs"/);
  const es = renderMarkdown(md, { hrefFor: (h) => localizeHref(h, 'es', opts) }).html;
  assert.match(es, /href="\/es\/docs"/);
  assert.match(es, /href="https:\/\/example\.com"/);
});

/** Static routes under app/[locale], as URL paths ("/docs/providers"). */
function staticRoutes(dir = localeAppDir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('[')) continue;
    const sub = join(dir, entry.name);
    const path = `${prefix}/${entry.name}`;
    if (readdirSync(sub).some((f) => /^page\.(js|jsx|tsx)$/.test(f))) out.push(path);
    out.push(...staticRoutes(sub, path));
  }
  return out;
}

/**
 * The guard: every internal link in every post and translation, rendered for
 * the locale it is shown in, lands on a page that exists in that locale. A
 * link that 404s or redirects fails here instead of in Search Console.
 */
test('every internal blog link resolves to a page that exists in its locale', () => {
  const routes = new Set(['/', ...staticRoutes()]);
  const exists = (path, locale) => {
    const locales = pathLocales(path, opts);
    if (locales === null) return true; // app route or file, not a localized page
    if (!locales.includes(locale)) return false;
    const blog = path.match(/^\/blog\/([^/]+)$/);
    if (blog) return slugs.includes(blog[1]);
    const provider = path.match(/^\/connect\/([^/]+)$/);
    if (provider) return Boolean(getProvider(provider[1]));
    if (routes.has(path)) return true;
    const client = path.match(/^\/docs\/([^/]+)$/);
    return Boolean(client && getClient(client[1]));
  };

  const sources = [];
  for (const slug of slugs) {
    sources.push({ file: `posts/${slug}.js`, locales: ['en'], src: readFileSync(join(postsDir, `${slug}.js`), 'utf8') });
    const dir = join(translationsDir, slug);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const locale = f.replace(/\.js$/, '');
      sources.push({ file: `translations/${slug}/${f}`, locales: [locale], src: readFileSync(join(dir, f), 'utf8') });
    }
  }

  const broken = [];
  for (const { file, locales, src } of sources) {
    for (const [, href] of src.matchAll(/\]\((\/[^)\s]*)\)/g)) {
      for (const locale of locales) {
        const out = localizeHref(href, locale, opts);
        const m = out.match(/^\/(nb|es|fr|zh)(\/[^?#]*)?/);
        const target = m ? m[2] || '/' : out.replace(/[?#].*$/, '');
        const targetLocale = m ? m[1] : 'en';
        if (!exists(target, targetLocale)) broken.push(`${file}: ${href} -> ${out}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
