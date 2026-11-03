// ---------------------------------------------------------------------------
// Help center articles: the loader and the shipped files.
//
// Run with: npm run test:help-center
//
// The loader half uses an injected `load`, so it pins the merge rules (fixed
// area order, English fallback per area, Common fixes first, ids unique,
// malformed articles dropped) without depending on what the area files hold
// today. The shipped half holds the real files to the format the UI renders:
// nothing the loader would drop, no `<`, internal links only.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  getHelpArticles,
  flattenArticles,
  loadAreaFile,
  normalizeArticle,
  HELP_AREAS,
  COMMON_FIXES,
} from './articles.mjs';
import { getHelpContent, HELP_LOCALES } from './help-content.mjs';
import { releasedProviders } from '../connect/release.mjs';
import { CLIENTS } from '../clients/clients.mjs';
import { DASHBOARD_SECTIONS } from '../../../components/dashboard/routes.js';

const art = (id, extra = {}) => ({ id, title: `Title ${id}`, summary: `Summary ${id}`, steps: ['Do it.'], ...extra });
const HELP = {
  articlesHeading: 'Common fixes',
  articlesLead: 'Lead',
  articles: [art('fix-one'), art('fix-two')],
};

/** A loader over an in-memory table: { 'en/getting-started': file, ... }. */
const loaderOf = (table) => async (locale, area) => table[`${locale}/${area}`] ?? null;

const areaIds = (cats) => cats.map((c) => c.area).join(',');
const ids = (cats) => flattenArticles(cats).map((a) => a.id).join(',');

test('no area files: only Common fixes, from help-content', async () => {
  const { categories } = await getHelpArticles('en', { help: HELP, load: loaderOf({}) });
  assert.equal(areaIds(categories), COMMON_FIXES);
  assert.equal(categories[0].title, 'Common fixes');
  assert.equal(categories[0].lead, 'Lead');
  assert.equal(ids(categories), 'fix-one,fix-two');
});

test('areas render in the fixed order, whatever order they load in', async () => {
  const table = {
    'en/account-team': { title: 'Account', articles: [art('d1')] },
    'en/getting-started': { title: 'Start', articles: [art('a1')] },
    'en/safety-automation': { title: 'Safety', articles: [art('c1')] },
  };
  const { categories } = await getHelpArticles('en', { help: HELP, load: loaderOf(table) });
  assert.equal(areaIds(categories), 'common-fixes,getting-started,safety-automation,account-team');
  assert.equal(categories[1].title, 'Start');
});

test('another locale falls back to English per area, not as a whole', async () => {
  const table = {
    'en/getting-started': { title: 'Start', articles: [art('a1')] },
    'en/using-email': { title: 'Email', articles: [art('b1')] },
    'nb/getting-started': { title: 'Kom i gang', articles: [art('a1', { title: 'Norsk' })] },
  };
  const { categories } = await getHelpArticles('nb', { help: HELP, load: loaderOf(table) });
  assert.equal(categories[1].title, 'Kom i gang');
  assert.equal(categories[1].articles[0].title, 'Norsk');
  assert.equal(categories[2].title, 'Email', 'using-email came from English');
});

test('a malformed locale file falls back to English for that area', async () => {
  const table = {
    'en/getting-started': { title: 'Start', articles: [art('a1')] },
    'fr/getting-started': { title: 'Broken', articles: 'not a list' },
  };
  const { categories } = await getHelpArticles('fr', { help: HELP, load: loaderOf(table) });
  assert.equal(categories[1].title, 'Start');
});

test('an unknown locale reads English', async () => {
  const seen = [];
  const load = async (locale, area) => { seen.push(`${locale}/${area}`); return null; };
  await getHelpArticles('it', { help: HELP, load });
  assert.equal(seen.every((k) => k.startsWith('en/')), true, seen.join(' '));
});

test('ids are unique across all categories: a later duplicate is dropped', async () => {
  const table = {
    'en/getting-started': { title: 'Start', articles: [art('a1'), art('fix-one')] },
    'en/using-email': { title: 'Email', articles: [art('a1'), art('b1')] },
  };
  const { categories } = await getHelpArticles('en', { help: HELP, load: loaderOf(table) });
  assert.equal(ids(categories), 'fix-one,fix-two,a1,b1');
});

test('an area whose articles are all invalid is left out', async () => {
  const table = { 'en/using-email': { title: 'Email', articles: [{ id: 'Bad Id', title: 'x', summary: 'y', steps: ['z'] }] } };
  const { categories } = await getHelpArticles('en', { help: HELP, load: loaderOf(table) });
  assert.equal(areaIds(categories), COMMON_FIXES);
});

test('normalizeArticle: the shape the UI renders, or null', () => {
  const ok = normalizeArticle({ ...art('ok'), body: ['Para.'], links: [{ label: 'Docs', href: '/docs' }], extra: 1 });
  assert.equal(JSON.stringify(Object.keys(ok)), JSON.stringify(['id', 'title', 'summary', 'keywords', 'body', 'steps', 'links']));
  assert.equal(normalizeArticle({ ...art('b'), steps: undefined, body: ['Only a body.'] }).steps.length, 0);
  assert.equal(normalizeArticle({ ...art('c'), steps: [], body: [] }), null, 'needs body or steps');
  assert.equal(normalizeArticle({ ...art('d'), title: 'Has <b>' }), null, 'no angle bracket');
  assert.equal(normalizeArticle({ ...art('e'), links: [{ label: 'Out', href: 'https://example.com' }] }), null, 'internal links only');
  assert.equal(normalizeArticle({ ...art('f'), links: [{ label: 'Proto', href: '//evil.example' }] }), null, 'no protocol-relative link');
  assert.equal(normalizeArticle({ ...art('g'), summary: '' }), null);
  assert.equal(normalizeArticle({ ...art('UPPER') }), null, 'kebab-case id');
});

test('loadAreaFile refuses names outside the allow-lists', async () => {
  assert.equal(await loadAreaFile('en', 'getting-started.sources'), null);
  assert.equal(await loadAreaFile('en', '../help-content/en'), null);
  assert.equal(await loadAreaFile('../..', 'getting-started'), null);
});

// --- the shipped files ------------------------------------------------------

const realEn = await getHelpArticles('en', { help: await getHelpContent('en') });

test('shipped: Common fixes first, then whichever areas exist, in order', () => {
  const areas = realEn.categories.map((c) => c.area);
  assert.equal(areas[0], COMMON_FIXES);
  const rest = areas.slice(1);
  assert.deepEqual(rest, HELP_AREAS.filter((a) => rest.includes(a)));
});

test('shipped: no article in any English area file is dropped by the loader', async () => {
  for (const area of HELP_AREAS) {
    const file = await loadAreaFile('en', area);
    if (!file) continue;
    assert.equal(file.area, area, `${area}.json says area "${file.area}"`);
    const kept = realEn.categories.find((c) => c.area === area)?.articles.length ?? 0;
    const bad = file.articles.filter((a) => normalizeArticle(a) === null).map((a) => a?.id);
    assert.deepEqual(bad, [], `${area}: articles that do not fit the format`);
    assert.equal(kept, file.articles.length, `${area}: ${file.articles.length - kept} article(s) dropped (duplicate id?)`);
  }
});

test('shipped: ids are unique across every locale and category', async () => {
  for (const locale of HELP_LOCALES) {
    const { categories } = await getHelpArticles(locale, { help: await getHelpContent(locale) });
    const all = flattenArticles(categories).map((a) => a.id);
    assert.equal(new Set(all).size, all.length, locale);
  }
});

test('shipped: article links point at paths that exist', () => {
  const providers = new Set(releasedProviders().map((p) => p.slug));
  const docs = new Set([...CLIENTS.map((c) => c.slug), 'providers', 'clients']);
  const ids = new Set(flattenArticles(realEn.categories).map((a) => a.id));
  const exists = (href) => {
    const [path, anchor = ''] = href.split('#');
    let m;
    if ((m = /^\/connect\/([a-z0-9-]+)$/.exec(path))) return providers.has(m[1]);
    if ((m = /^\/docs(?:\/([a-z0-9-]+))?$/.exec(path))) return !m[1] || docs.has(m[1]);
    if ((m = /^\/dashboard(?:\/([a-z-]+))?$/.exec(path))) return !m[1] || DASHBOARD_SECTIONS.includes(m[1]);
    if (path === '/help') return anchor === 'contact' || (anchor.startsWith('article-') && ids.has(anchor.slice(8)));
    // Any other marketing page: a page file under app/[locale].
    if (!/^\/[a-z0-9-]+$/.test(path)) return false;
    const dir = new URL(`../../../app/[locale]${path}/`, import.meta.url);
    return ['page.js', 'page.tsx', 'page.jsx', 'page.ts'].some((f) => existsSync(new URL(f, dir)));
  };
  for (const a of flattenArticles(realEn.categories)) {
    for (const l of a.links) assert.equal(exists(l.href), true, `${a.id}: ${l.href}`);
  }
});
