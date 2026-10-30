// ---------------------------------------------------------------------------
// /help search: the index the server ships, and the filter the browser runs.
//
// Run with: npm run test:support-help
//
// The index is serialised into the page (and, in the dashboard, into the
// help-data response), so it has byte budgets, checked per part:
//  - everything but the articles: 40 KB. Measured at 24 KB on 2026-10-15 (100
//    released providers, 13 clients, 10 docs entries, 13 FAQ items); room for
//    the held provider wave, and it trips long before anyone ships provider
//    guide copy in it by accident, which would add hundreds of KB.
//  - articles: 400 bytes per entry on average. Measured at about 320 with 59
//    articles (help center v2). Hints are clipped to 80 characters and terms to
//    260 (most keyword lists are far shorter), so only an article set that
//    keeps growing moves this total.
//  - the whole index: 64 KB. Measured at 43 KB for English with 59 articles;
//    this is the number that matters to a reader on a slow connection, and it
//    leaves room for roughly 50 more articles before anyone has to look again.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import { getSearchIndex, HINT_MAX, TERMS_MAX, clip, clipTerms } from './search-index.mjs';
import { prepareIndex, searchIndex, normalize, oneEdit, MAX_RESULTS } from './search-filter.mjs';
import { getHelpContent, HELP_LOCALES } from './help-content.mjs';
import { getHelpArticles, flattenArticles } from './articles.mjs';
import { releasedProviders } from '../connect/release.mjs';
import { CLIENTS } from '../clients/clients.mjs';

const BUDGET_BYTES = 64 * 1024;
const NON_ARTICLE_BUDGET_BYTES = 40 * 1024;
const ARTICLE_AVG_BYTES = 400;

async function articlesFor(locale, help) {
  return flattenArticles((await getHelpArticles(locale, { help })).categories);
}

const indexFor = async (locale, { inApp = false } = {}) => {
  const help = await getHelpContent(locale);
  return getSearchIndex(locale, help, { articles: await articlesFor(locale, help), inApp });
};
const countKind = (index, kind) => index.filter((e) => e.kind === kind).length;
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));

test('every locale stays under each byte budget', async () => {
  for (const locale of HELP_LOCALES) {
    const index = await indexFor(locale);
    const articles = index.filter((e) => e.kind === 'article');
    const rest = index.filter((e) => e.kind !== 'article');
    assert.equal(bytes(index) < BUDGET_BYTES, true, `${locale} index is ${bytes(index)} bytes`);
    assert.equal(bytes(rest) < NON_ARTICLE_BUDGET_BYTES, true, `${locale} non-article part is ${bytes(rest)} bytes`);
    const avg = bytes(articles) / Math.max(1, articles.length);
    assert.equal(avg <= ARTICLE_AVG_BYTES, true, `${locale} articles average ${Math.round(avg)} bytes`);
  }
});

test('it holds every released provider, every public client, every article, docs and FAQ', async () => {
  const help = await getHelpContent('en');
  const index = await indexFor('en');
  assert.equal(countKind(index, 'provider'), releasedProviders().length);
  assert.equal(countKind(index, 'client'), CLIENTS.length);
  assert.equal(CLIENTS.length, 21);
  const articles = await articlesFor('en', help);
  assert.equal(articles.length >= 7, true);
  assert.equal(countKind(index, 'article'), articles.length);
  assert.equal(countKind(index, 'docs'), 10);
  assert.equal(countKind(index, 'faq') > 0, true);
});

test('without an article list it falls back to the troubleshooting set', async () => {
  const help = await getHelpContent('en');
  const index = await getSearchIndex('en', help);
  assert.equal(countKind(index, 'article'), help.articles.length);
});

test('in the app, articles link to the in-page anchor; elsewhere to /help', async () => {
  const page = await indexFor('nb');
  const app = await indexFor('nb', { inApp: true });
  const pick = (ix) => ix.find((e) => e.id === 'article:yandex-imap-disabled').href;
  assert.equal(pick(page), '/nb/help#article-yandex-imap-disabled');
  assert.equal(pick(app), '#article-yandex-imap-disabled');
  assert.equal(app.find((e) => e.id === 'provider:yahoo').href, '/nb/connect/yahoo', 'other kinds unchanged');
});

test('clipTerms cuts on a word boundary with no ellipsis', () => {
  const long = 'alpha '.repeat(60);
  const out = clipTerms(long);
  assert.equal(out.length <= TERMS_MAX, true);
  assert.equal(out.endsWith('alpha'), true);
  assert.equal(clipTerms('short terms'), 'short terms');
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
    assert.equal(e.terms.length <= TERMS_MAX || e.kind !== 'article', true, e.id);
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

test('one or two words must all match', () => {
  assert.equal(ids('yahoo password'), 'b');
  assert.equal(ids('yahoo nothingmatches'), '');
});

test('a typo, a plural and filler words still find the entry', () => {
  assert.equal(ids('pasword'), 'b');
  assert.equal(ids('passwords'), 'b');
  assert.equal(ids('how do i get my app password'), 'b');
});

test('keyword hits outrank title and hint hits', () => {
  const p = prepareIndex([
    { id: 'hint', kind: 'docs', title: 'Something', hint: 'refund policy', terms: '' },
    { id: 'title', kind: 'docs', title: 'Refund window', hint: '', terms: '' },
    { id: 'kw', kind: 'article', title: 'Change your plan', hint: '', terms: 'refund cancel' },
  ]);
  assert.deepEqual(searchIndex(p, 'refund').map((e) => e.id), ['kw', 'title', 'hint']);
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

test('the real index answers questions typed as sentences', async () => {
  const p = prepareIndex(await indexFor('en'));
  const top = (q, n = 3) => searchIndex(p, q).slice(0, n).map((e) => e.id);
  assert.ok(top('claude cant see my emails').includes('article:assistant-sees-nothing'), top('claude cant see my emails').join());
  assert.ok(top('how do i cancel my subscription').some((id) => id.includes('cancel')), top('how do i cancel my subscription').join());
  assert.ok(top('my password is not working').includes('article:imap-password-rejected'), top('my password is not working').join());
});

test('oneEdit counts a swap of neighbours as one edit, not two', () => {
  assert.equal(oneEdit('gmial', 'gmail'), true);
  assert.equal(oneEdit('fastmial', 'fastmail'), true);
  assert.equal(oneEdit('gmal', 'gmail'), true);
  assert.equal(oneEdit('gmial', 'gmali'), false, 'two swaps');
  assert.equal(oneEdit('abcd', 'badc'), false);
});

test('a 4-letter typo needs its first letter; a short word never swallows a long one', () => {
  const p = prepareIndex([
    { id: 'gmail', kind: 'provider', title: 'Gmail', hint: '', terms: '' },
    { id: 'mail', kind: 'provider', title: 'Yahoo Mail', hint: '', terms: '' },
    { id: 'lend', kind: 'docs', title: 'Lend', hint: '', terms: '' },
  ]);
  assert.deepEqual(searchIndex(p, 'gmal').map((e) => e.id), ['gmail']);
  assert.deepEqual(searchIndex(p, 'gmail').map((e) => e.id), ['gmail']);
  assert.deepEqual(searchIndex(p, 'send').map((e) => e.id), []);
});

test('a query of filler words alone finds nothing, unless it is a keyword phrase', () => {
  const p = prepareIndex([
    { id: 'kw', kind: 'article', title: 'Something broke', hint: 'the help page', terms: 'connector not working' },
    { id: 'other', kind: 'article', title: 'The other one', hint: 'help', terms: 'help the issue' },
  ]);
  assert.deepEqual(searchIndex(p, 'help').map((e) => e.id), []);
  assert.deepEqual(searchIndex(p, 'the').map((e) => e.id), []);
  assert.deepEqual(searchIndex(p, 'not working').map((e) => e.id), ['kw']);
  assert.deepEqual(searchIndex(p, 'it is not').map((e) => e.id), []);
});

test('a query word in the title breaks a tie between equal keyword hits', () => {
  const p = prepareIndex([
    { id: 'client', kind: 'client', title: 'Cline', hint: '', terms: 'cline api key' },
    { id: 'article', kind: 'article', title: 'Create an API key', hint: '', terms: 'api key token' },
  ]);
  assert.deepEqual(searchIndex(p, 'api key').map((e) => e.id), ['article', 'client']);
});

test('the real English index puts the right entry first', async () => {
  const p = prepareIndex(await indexFor('en'));
  const first = (q) => searchIndex(p, q)[0]?.id ?? 'none';
  const CASES = {
    'gmail app password': 'article:app-password-required',
    'outlook wont connect': 'article:connect-outlook-microsoft-365',
    'delete account': 'article:disconnect-or-delete',
    chatgpt: 'client:chatgpt',
    imap: 'provider:imap',
    'draft not showing': 'article:draft-editor-card',
    icloud: 'provider:icloud',
    cancel: 'article:change-or-cancel-plan',
    fastmail: 'provider:fastmail',
    gmial: 'provider:gmail',
    fastmial: 'provider:fastmail',
    gmal: 'provider:gmail',
    passwords: 'article:imap-password-rejected',
    help: 'none',
    the: 'none',
    'not working': 'article:assistant-sees-nothing',
    'cant send email': 'article:send-new-email',
    "can't send email": 'article:send-new-email',
    invoice: 'article:change-or-cancel-plan',
    'change plan': 'article:change-or-cancel-plan',
    yahoo: 'provider:yahoo',
    'claude connector': 'article:connect-claude',
    'rate limit': 'docs:rate-limits',
    'two factor': 'article:app-password-required',
    '2fa': 'article:app-password-required',
    mfa: 'article:app-password-required',
    'smtp error': 'article:imap-password-rejected',
    error: 'docs:errors',
    'where is my sent email': 'article:search-misses-messages',
    'api key': 'article:api-keys-and-revoking',
    token: 'article:api-keys-and-revoking',
    send: 'article:send-new-email',
    spam: 'article:search-misses-messages',
  };
  const wrong = Object.entries(CASES)
    .filter(([q, id]) => first(q) !== id)
    .map(([q, id]) => `${q}: got ${first(q)}, want ${id}`);
  assert.deepEqual(wrong, []);
  assert.equal(['faq:', 'article:change-or-cancel-plan'].some((x) => first('refund').startsWith(x)), true, first('refund'));
});

test('the real nb, fr, es and zh indexes find the same answers in their own words', async () => {
  const CASES = {
    nb: { 'slette konto': 'article:disconnect-or-delete', refusjon: 'article:change-or-cancel-plan', 'app-passord': 'article:app-password-required', tofaktor: 'article:app-password-required' },
    fr: { 'supprimer compte': 'article:disconnect-or-delete', 'double authentification': 'article:app-password-required', 'clé api': 'article:api-keys-and-revoking' },
    es: { 'eliminar cuenta': 'article:disconnect-or-delete', 'doble factor': 'article:app-password-required', 'clave api': 'article:api-keys-and-revoking' },
    zh: { 双重验证: 'article:app-password-required', 删除账户: 'article:disconnect-or-delete' },
  };
  const wrong = [];
  for (const [locale, cases] of Object.entries(CASES)) {
    const p = prepareIndex(await indexFor(locale));
    for (const [q, id] of Object.entries(cases)) {
      const got = searchIndex(p, q)[0]?.id ?? 'none';
      if (got !== id) wrong.push(`${locale} ${q}: got ${got}, want ${id}`);
    }
  }
  assert.deepEqual(wrong, []);
  const fr = prepareIndex(await indexFor('fr'));
  assert.equal(searchIndex(fr, 'remboursement').some((e) => e.id === 'article:change-or-cancel-plan'), true);
});

test('clip strips rich-text tags and never leaves an angle bracket', () => {
  assert.equal(clip('Use <b>app</b> passwords'), 'Use app passwords');
  assert.equal(clip('a <scr<b>ipt>alert(1)</script> b').includes('<'), false);
  assert.equal(clip('x > y < z').includes('>'), false);
});
