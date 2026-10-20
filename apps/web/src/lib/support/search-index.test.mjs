// ---------------------------------------------------------------------------
// /help search: the index the server ships, and the filter the browser runs.
//
// Run with: npm run test:support-help
//
// The index is serialised into the page, so it has a byte budget: 40 KB for
// English. Measured at 26 KB on 2026-10-15 (100 released providers, 13
// clients, 10 docs entries, 13 FAQ items, 7 articles); the other locales run
// 1-2 KB heavier. The budget leaves room for the held provider wave and a few
// dozen more entries, and trips long before anyone ships provider guide copy
// in it by accident, which would add hundreds of KB.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import { getSearchIndex, HINT_MAX, clip } from './search-index.mjs';
import { prepareIndex, searchIndex, normalize, MAX_RESULTS } from './search-filter.mjs';
import { getHelpContent, HELP_LOCALES } from './help-content.mjs';
import { releasedProviders } from '../connect/release.mjs';
import { CLIENTS } from '../clients/clients.mjs';

const BUDGET_BYTES = 40 * 1024;

const indexFor = async (locale) => getSearchIndex(locale, await getHelpContent(locale));
const countKind = (index, kind) => index.filter((e) => e.kind === kind).length;

test('the English index stays under its byte budget', async () => {
  const bytes = Buffer.byteLength(JSON.stringify(await indexFor('en')));
  assert.equal(bytes < BUDGET_BYTES, true, `index is ${bytes} bytes`);
});

test('every locale stays under the same budget', async () => {
  for (const locale of HELP_LOCALES) {
    const bytes = Buffer.byteLength(JSON.stringify(await indexFor(locale)));
    assert.equal(bytes < BUDGET_BYTES, true, `${locale} index is ${bytes} bytes`);
  }
});

test('it holds every released provider, 13 clients, the 7 articles, docs and FAQ', async () => {
  const index = await indexFor('en');
  assert.equal(countKind(index, 'provider'), releasedProviders().length);
  assert.equal(countKind(index, 'client'), 13);
  assert.equal(CLIENTS.length, 13);
  assert.equal(countKind(index, 'article'), 7);
  assert.equal(countKind(index, 'docs'), 10);
  assert.equal(countKind(index, 'faq') > 0, true);
});

test('no unreleased provider is linked', async () => {
  const released = new Set(releasedProviders().map((p) => p.slug));
  const index = await indexFor('en');
  for (const e of index.filter((x) => x.kind === 'provider')) {
    assert.equal(released.has(e.id.slice('provider:'.length)), true, e.id);
  }
});

test('entries are compact: short hints, unique ids, the full shape', async () => {
  const index = await indexFor('en');
  const ids = new Set();
  for (const e of index) {
    assert.equal(typeof e.title, 'string');
    assert.equal(e.title.length > 0, true, e.id);
    assert.equal(e.hint.length <= HINT_MAX, true, `${e.id} hint is ${e.hint.length} chars`);
    assert.equal(typeof e.terms, 'string');
    assert.equal(e.href.startsWith('/'), true, e.id);
    assert.equal(e.hint.includes('<'), false, e.id);
    assert.equal(ids.has(e.id), false, `duplicate ${e.id}`);
    ids.add(e.id);
  }
});

test('localized: titles come from the locale and hrefs carry its prefix', async () => {
  const en = await indexFor('en');
  const nb = await indexFor('nb');
  const enDocs = en.find((e) => e.id === 'docs:quickstart');
  const nbDocs = nb.find((e) => e.id === 'docs:quickstart');
  assert.equal(enDocs.href, '/docs#quickstart');
  assert.equal(nbDocs.href, '/nb/docs#quickstart');
  assert.notEqual(nbDocs.title, enDocs.title);
  const nbArticle = nb.find((e) => e.id === 'article:yandex-imap-disabled');
  assert.equal(nbArticle.href, '/nb/help#article-yandex-imap-disabled');
  assert.equal(nb.find((e) => e.id === 'provider:yahoo').href, '/nb/connect/yahoo');
});

test('clip cuts on a word boundary and strips markup', () => {
  assert.equal(clip('<b>Short</b> text'), 'Short text');
  const long = 'word '.repeat(40);
  const out = clip(long, 30);
  assert.equal(out.length <= 30, true);
  assert.equal(out.endsWith('…'), true);
});

// --- the filter ------------------------------------------------------------

const FIXTURE = [
  { id: 'a', kind: 'provider', title: 'Yahoo Mail', hint: 'Webmail · yahoo.com', href: '/connect/yahoo', terms: 'ymail rocketmail' },
  { id: 'b', kind: 'article', title: 'App password required (Yahoo, iCloud)', hint: 'Create one', href: '/help#x', terms: 'app password' },
  { id: 'c', kind: 'provider', title: 'Zürich Mail', hint: 'Regional', href: '/z', terms: '' },
  { id: 'd', kind: 'docs', title: 'Rate limits', hint: 'Mentions yahoo in the hint', href: '/docs', terms: '' },
  { id: 'e', kind: 'faq', title: '我可以更改或取消套餐吗？', hint: '', href: '/pricing#faq', terms: '' },
];
const prepared = prepareIndex(FIXTURE);
const ids = (q) => searchIndex(prepared, q).map((e) => e.id).join(',');

test('normalize folds case and diacritics', () => {
  assert.equal(normalize('  ZÜRICH  Café '), 'zurich cafe');
});

test('an empty query returns nothing', () => {
  assert.equal(searchIndex(prepared, '   ').length, 0);
});

test('diacritics and case do not matter', () => {
  assert.equal(ids('zurich'), 'c');
  assert.equal(ids('ZÜRICH'), 'c');
});

test('every word must match (AND)', () => {
  assert.equal(ids('yahoo password'), 'b');
  assert.equal(ids('yahoo nothingmatches'), '');
});

test('title hits rank above hint and term hits, title starts first', () => {
  // a: title starts with "yahoo"; b: title contains it; d: only the hint does.
  assert.equal(ids('yahoo'), 'a,b,d');
  assert.equal(ids('rocketmail'), 'a');
});

test('a CJK phrase matches as a substring', () => {
  assert.equal(ids('取消套餐'), 'e');
});

test('results are capped', async () => {
  const index = await indexFor('en');
  const all = searchIndex(prepareIndex(index), 'mail');
  assert.equal(all.length, MAX_RESULTS);
});

test('the real index finds the obvious things', async () => {
  const p = prepareIndex(await indexFor('en'));
  assert.equal(searchIndex(p, 'hotmail')[0].id, 'provider:outlook');
  assert.equal(searchIndex(p, 'yandex imap').some((e) => e.id === 'article:yandex-imap-disabled'), true);
  assert.equal(searchIndex(p, 'cursor')[0].id, 'client:cursor');
});

test('clip strips rich-text tags and never leaves an angle bracket', () => {
  assert.equal(clip('Use <b>app</b> passwords'), 'Use app passwords');
  assert.equal(clip('a <scr<b>ipt>alert(1)</script> b').includes('<'), false);
  assert.equal(clip('x > y < z').includes('>'), false);
});
