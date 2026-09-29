import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { renderMarkdown, slugify } from './markdown.js';

// posts.js and translations/index.js import their modules without a file
// extension (Next's bundler resolves those; bare node does not). Retry any
// unresolved relative specifier with ".js" (or "/index.js" for a directory) so
// this test can load the real registry, the same one the blog page renders from.
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

const { getAllPosts, getLocalizedPost } = await import('./posts.js');

// Mirrors routing.locales in src/i18n/routing.ts. Untranslated locales fall
// back to English content, so every post renders in every locale.
const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

test('slugify keeps CJK and accented letters', () => {
  assert.equal(slugify('为什么一个智能体胜过在邮件客户端之间切换'), '为什么一个智能体胜过在邮件客户端之间切换');
  assert.equal(slugify('用 Claude 管理邮箱：第 2 步'), '用-claude-管理邮箱第-2-步');
  assert.equal(slugify('Étape 2 : ajouter le connecteur'), 'étape-2-ajouter-le-connecteur');
  assert.equal(slugify('Feilsøking'), 'feilsøking');
  assert.equal(slugify('¿Dónde caen los límites?'), 'dónde-caen-los-límites');
  // A decomposed "é" (e + U+0301) slugs the same as the precomposed one.
  assert.equal(slugify('Café'), slugify('Café'));
});

test('renderMarkdown gives repeated and symbol-only headings unique, non-empty ids', () => {
  const { html, headings } = renderMarkdown('## Setup\n\n## Setup\n\n### Setup\n\n## ???\n\n## ???\n\n## Setup-2');
  assert.deepEqual(
    headings.map((h) => h.id),
    ['setup', 'setup-2', 'setup-3', 'section', 'section-2', 'setup-2-2'],
  );
  assert.deepEqual(attrs(html, 'id'), headings.map((h) => h.id));
});

for (const { slug } of getAllPosts()) {
  for (const locale of LOCALES) {
    test(`${locale}/blog/${slug}: every id is non-empty and unique, every #anchor resolves`, () => {
      const post = getLocalizedPost(slug, locale);
      const { html, headings } = renderMarkdown(post.content);
      const ids = attrs(html, 'id');

      assert.deepEqual(ids.filter((id) => id === ''), [], 'an element has an empty id');
      assert.deepEqual(
        ids.filter((id, i) => ids.indexOf(id) !== i),
        [],
        'duplicate ids in one document',
      );

      // The TOC (BlogPostClient) links to `#${h.id}` for each of these.
      for (const h of headings) {
        assert.ok(h.id, `TOC heading "${h.text}" has an empty id`);
        assert.ok(ids.includes(h.id), `TOC heading "${h.text}" -> #${h.id} has no element`);
      }

      // In-content links such as the "Jump to" line.
      const idSet = new Set(ids);
      const broken = attrs(html, 'href')
        .filter((href) => href.startsWith('#'))
        .map((href) => decodeURIComponent(href.slice(1)))
        .filter((anchor) => !idSet.has(anchor));
      assert.deepEqual(broken, [], `in-page anchors with no matching id; ids are: ${ids.join(', ')}`);
    });
  }
}
