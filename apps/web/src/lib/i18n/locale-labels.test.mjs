/**
 * The copy that lives in modules next to the pages rather than in messages/
 * (per apps/web/CLAUDE.md) is outside scripts/i18n-coverage, so a locale can
 * silently drop back to English there. This pins the three tables the
 * 2026-11-10 locale sweep added: the /connect hub headings, the generic IMAP
 * provider name, and the blog tag labels and author bylines. Every locale CI
 * keeps complete (FULL + SCOPED) must have every entry; zh may lag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { FULL_LOCALES, SCOPED_LOCALES } from '../../i18n/locale-policy.mjs';
import { PROVIDER_CATEGORIES, PROVIDERS } from '../connect/providers.mjs';
import { categoryLabelsFor, categoryLabel } from '../../../app/[locale]/connect/category-labels.mjs';
import { GENERIC_NAME_LOCALES, providerDisplayName, localizeProvider } from '../connect/display-name.mjs';
import { tagLabel, tagLabelMap, hasTagLabel, TAG_LABEL_LOCALES, UNTRANSLATED_TAGS } from '../blog/tag-labels.mjs';

// posts.js imports its post modules without a file extension (Next resolves
// those; bare node does not), same workaround as src/lib/blog/anchors.test.mjs.
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

const { AUTHORS, getAuthor, getAllPosts } = await import('../blog/posts.js');

const REQUIRED = [...FULL_LOCALES, ...SCOPED_LOCALES];
const NON_ENGLISH = REQUIRED.filter((l) => l !== 'en');
const noEmDash = (s, where) => assert.ok(!s.includes('—'), `${where} contains an em dash: ${s}`);
const noAngle = (s, where) => assert.ok(!s.includes('<'), `${where} contains an angle bracket: ${s}`);

for (const locale of REQUIRED) {
  test(`connect hub: every category heading exists in ${locale}`, () => {
    const table = categoryLabelsFor(locale);
    for (const c of PROVIDER_CATEGORIES) {
      const label = table[c.id];
      assert.equal(typeof label, 'string', `${locale} lacks a heading for ${c.id}`);
      assert.ok(label.trim().length > 0);
      noEmDash(label, `${locale}/${c.id}`);
      noAngle(label, `${locale}/${c.id}`);
      assert.equal(categoryLabel(c.id, locale), label);
    }
  });
}

test('connect hub: a non-English heading is not the English one', () => {
  const en = categoryLabelsFor('en');
  for (const locale of NON_ENGLISH) {
    const table = categoryLabelsFor(locale);
    const same = PROVIDER_CATEGORIES.filter((c) => table[c.id] === en[c.id]).map((c) => c.id);
    assert.deepEqual(same, [], `${locale} still shows English for ${same.join(', ')}`);
  }
});

test('connect hub: an unknown locale falls back to English, an unknown id to itself', () => {
  assert.equal(categoryLabel('consumer', 'xx'), categoryLabelsFor('en').consumer);
  assert.equal(categoryLabel('nope', 'de'), 'nope');
});

test('generic IMAP: a name in every required locale, brands untouched', () => {
  for (const locale of REQUIRED) assert.ok(GENERIC_NAME_LOCALES.includes(locale), `no generic name for ${locale}`);
  const imap = PROVIDERS.find((p) => p.slug === 'imap');
  const gmail = PROVIDERS.find((p) => p.slug === 'gmail');
  assert.equal(providerDisplayName(imap, 'en'), 'Generic IMAP');
  for (const locale of NON_ENGLISH) {
    assert.notEqual(providerDisplayName(imap, locale), 'Generic IMAP', `${locale} still says Generic IMAP`);
    assert.equal(providerDisplayName(gmail, locale), gmail.name);
    assert.equal(localizeProvider(gmail, locale), gmail, 'a brand is returned as the same object');
    assert.equal(localizeProvider(imap, locale).name, providerDisplayName(imap, locale));
    assert.equal(localizeProvider(imap, locale).slug, 'imap');
  }
  assert.equal(providerDisplayName(imap, 'xx'), 'Generic IMAP');
});

test('blog tags: every tag a post uses has a label in every required locale, or is a name', () => {
  const used = new Set(getAllPosts().flatMap((p) => p.tags));
  for (const locale of NON_ENGLISH) {
    assert.ok(TAG_LABEL_LOCALES.includes(locale), `no tag table for ${locale}`);
    const missing = [...used].filter((tag) => !hasTagLabel(tag, locale) && !UNTRANSLATED_TAGS.includes(tag));
    assert.deepEqual(missing, [], `${locale} shows English for tags: ${missing.join(', ')}`);
    for (const tag of used) {
      noEmDash(tagLabel(tag, locale), `${locale}/${tag}`);
      noAngle(tagLabel(tag, locale), `${locale}/${tag}`);
    }
  }
});

test('blog tags: the map keeps English keys and translates the values', () => {
  const map = tagLabelMap(['Tutorial', 'MCP', 'Tutorial'], 'de');
  assert.deepEqual(map, { Tutorial: 'Anleitung', MCP: 'MCP' });
  assert.equal(tagLabel('Tutorial', 'xx'), 'Tutorial');
});

test('blog authors: role and bio exist in every required locale, without em dashes', () => {
  for (const author of Object.values(AUTHORS)) {
    for (const locale of REQUIRED) {
      const resolved = getAuthor({ authorId: author.id }, locale);
      assert.equal(typeof resolved.role, 'string', `${author.id} has no ${locale} role`);
      assert.equal(typeof resolved.bio, 'string', `${author.id} has no ${locale} bio`);
      assert.ok(author.role[locale], `${author.id} role falls back to English in ${locale}`);
      assert.ok(author.bio[locale], `${author.id} bio falls back to English in ${locale}`);
      noEmDash(resolved.bio, `${author.id}/${locale} bio`);
      noEmDash(resolved.role, `${author.id}/${locale} role`);
      assert.ok(resolved.bio.includes('MCPEmails'), 'the bio names the product, one word');
      assert.ok(!resolved.bio.includes('MCP Emails'));
    }
  }
  // Callers that pass no locale keep getting English strings, not maps.
  const en = getAuthor({ authorId: 'asgeir' });
  assert.equal(typeof en.bio, 'string');
  assert.equal(en.role, AUTHORS.asgeir.role.en);
});
