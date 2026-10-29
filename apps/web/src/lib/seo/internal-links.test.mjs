// ---------------------------------------------------------------------------
// Internal links between /connect, /blog and /docs.
//
// Run with: npm run test:internal-links
//
// On 2026-10-19, 95 of 100 provider pages linked to no blog post, 27 of 31
// posts linked to no provider page, and the post that converts best had two
// incoming links. This pins the links that fixed that, so a later edit cannot
// drop them quietly:
//
//   - every provider page that can connect links the Claude guide, and
//     password-login pages also link the IMAP connector guide (the ChatGPT
//     guide is linked by the page's ChatGPT section instead);
//   - every link target is a real post, translated into every locale the
//     linking page is published in (a locale Link to an untranslated post
//     lands on an English fallback);
//   - the guide copy has the same keys in every locale;
//   - the blog index leads with the three posts search sends people to;
//   - the client setup pages link their walkthrough post.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';

// posts.js imports its modules without a file extension (Next's bundler
// resolves those; bare node does not). Same hook as blog/anchors.test.mjs.
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

const { getAllPosts, getPost, getPostLocales } = await import('../blog/posts.js');
const { GUIDE_POSTS, guideLinksFor } = await import('../connect/guides.mjs');
const { PROVIDERS } = await import('../connect/providers.mjs');
const { CLIENTS } = await import('../clients/clients.mjs');
const { clientUi } = await import('../clients/ui.mjs');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];
const contentFor = (locale, slug) =>
  JSON.parse(readFileSync(new URL(`../connect/content/${locale}/${slug}.json`, import.meta.url), 'utf8'));
const guideCopy = (locale) =>
  JSON.parse(readFileSync(new URL(`../connect/guides/${locale}.json`, import.meta.url), 'utf8'));

/** The post a `/blog/<slug>` href names, or undefined. */
const postAt = (href) => getPost(href.replace(/^\/blog\//, ''));

test('every guide post exists and is translated into every locale', () => {
  for (const href of Object.values(GUIDE_POSTS)) {
    const post = postAt(href);
    assert.ok(post, `${href} is not a post`);
    assert.deepEqual([...getPostLocales(post)].sort(), [...LOCALES].sort(), href);
  }
});

test('guide copy has the same keys in every locale, all non-empty, no angle brackets', () => {
  const en = Object.keys(guideCopy('en')).sort();
  assert.deepEqual(en, [
    'agentInbox', 'claude', 'clientsAll', 'clientsIntro', 'connectors', 'imap', 'inboxZero',
    'intro', 'lookupIntro', 'lookupLabel', 'moreIntro', 'personal', 'schedule',
  ]);
  for (const locale of LOCALES) {
    const copy = guideCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), en, locale);
    for (const [k, v] of Object.entries(copy)) {
      assert.ok(v.trim(), `${locale}.${k} is empty`);
      assert.doesNotMatch(v, /[<>—]/, `${locale}.${k}`);
    }
  }
});

test('guideLinksFor: which pages get which guides', () => {
  const slugs = (c) => guideLinksFor(c).map((g) => g.key);
  assert.deepEqual(slugs({ auth: { method: 'app-password' } }), ['claude', 'imap']);
  assert.deepEqual(slugs({ auth: { method: 'mail-password' } }), ['claude', 'imap']);
  assert.deepEqual(slugs({ auth: { method: 'account-password' } }), ['claude', 'imap']);
  assert.deepEqual(slugs({ auth: { method: 'oauth' } }), ['claude']);
  assert.deepEqual(slugs({ auth: { method: 'none' } }), []);
  // A page whose own `guide` is already the IMAP post does not link it twice.
  assert.deepEqual(
    slugs({ auth: { method: 'mail-password' }, guide: { href: GUIDE_POSTS.imap } }),
    ['claude'],
  );
});

test('the real provider pages: Claude guide on every page that can connect', () => {
  let linked = 0;
  for (const provider of PROVIDERS) {
    for (const locale of provider.locales) {
      const content = contentFor(locale, provider.slug);
      const links = guideLinksFor(content);
      const hrefs = links.map((l) => l.href);
      assert.equal(new Set(hrefs).size, hrefs.length, `${locale}/${provider.slug}: duplicate guide`);
      assert.ok(!hrefs.includes(content.guide?.href), `${locale}/${provider.slug}: repeats its own guide`);
      if (content.auth.method === 'none') continue;
      assert.ok(hrefs.includes(GUIDE_POSTS.claude), `${locale}/${provider.slug}`);
      linked += 1;
    }
  }
  // 100 English provider pages existed on 2026-10-19; nearly all can connect.
  assert.ok(linked > 400, `expected the whole set across locales, got ${linked}`);
});

test('the blog index leads with the posts search sends people to', () => {
  const order = getAllPosts().map((p) => p.slug);
  assert.deepEqual(order.slice(0, 3), [
    'connect-claude-to-email',
    'claude-imap-connector',
    'connect-chatgpt-to-email',
  ]);
  assert.equal(new Set(order).size, order.length, 'a post is listed twice');
});

test('client setup pages link a real, fully translated walkthrough', () => {
  const withPost = CLIENTS.filter((c) => c.post);
  assert.deepEqual(
    withPost.map((c) => c.slug).sort(),
    ['chatgpt', 'claude', 'cline', 'cursor', 'vscode', 'windsurf'],
  );
  for (const client of withPost) {
    const post = postAt(client.post.href);
    assert.ok(post, `${client.slug}: ${client.post.href} is not a post`);
    for (const locale of client.locales) {
      assert.ok(getPostLocales(post).includes(locale), `${locale}/docs/${client.slug}: post not translated`);
      const label = clientUi(locale).page.postLink[client.post.key];
      assert.ok(label?.trim(), `${locale}: no postLink.${client.post.key}`);
      assert.ok(clientUi(locale).page.postLink.intro?.trim(), `${locale}: no postLink.intro`);
    }
  }
});

test('the guide copy files are exactly the five locales', () => {
  const files = readdirSync(new URL('../connect/guides/', import.meta.url)).sort();
  assert.deepEqual(files, LOCALES.map((l) => `${l}.json`).sort());
});
