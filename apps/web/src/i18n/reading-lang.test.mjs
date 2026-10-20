// ---------------------------------------------------------------------------
// The reading language carried from a localized marketing page into /signup
// and /login: which links get `?lang=`, what they keep, and which values the
// signup and login pages accept.
//
// Run with: npm run test:reading-lang
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_LOCALES, LANG_PARAM, readingLangFromParam, withReadingLang, withReadingLangEscaped } from './reading-lang.mjs';
import { renderMarkdown } from '../lib/blog/markdown.js';

test('the locale list matches routing.locales', () => {
  const routing = readFileSync(new URL('./routing.ts', import.meta.url), 'utf8');
  const match = routing.match(/locales:\s*\[([^\]]*)\]/);
  assert.ok(match, 'routing.ts declares its locales');
  const declared = match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(declared, APP_LOCALES);
  assert.equal(LANG_PARAM, 'lang');
});

/* ------------------------------------------------- reading the param */

test('every supported language is accepted', () => {
  for (const locale of APP_LOCALES) assert.equal(readingLangFromParam(locale), locale);
});

test('anything else is ignored', () => {
  for (const value of [undefined, null, '', 'de', 'FR', 'fr-CA', 'fr ', 'no', 'nn', 'zh-Hans', ['fr'], ['fr', 'es'], 1, {}]) {
    assert.equal(readingLangFromParam(value), null, JSON.stringify(value));
  }
});

/* -------------------------------------------------- building the link */

test('a translated page adds its language to /signup and /login', () => {
  assert.equal(withReadingLang('/signup', 'fr'), '/signup?lang=fr');
  assert.equal(withReadingLang('/signup', 'es'), '/signup?lang=es');
  assert.equal(withReadingLang('/signup', 'nb'), '/signup?lang=nb');
  assert.equal(withReadingLang('/signup', 'zh'), '/signup?lang=zh');
  assert.equal(withReadingLang('/login', 'fr'), '/login?lang=fr');
});

test('an English page adds nothing', () => {
  assert.equal(withReadingLang('/signup', 'en'), '/signup');
  assert.equal(withReadingLang('/signup?provider=gmx', 'en'), '/signup?provider=gmx');
});

test('an unknown or missing locale adds nothing', () => {
  for (const locale of [undefined, null, '', 'de', 'FR']) {
    assert.equal(withReadingLang('/signup', locale), '/signup', String(locale));
  }
});

test('existing query parameters and the fragment are kept exactly', () => {
  assert.equal(withReadingLang('/signup?provider=gmx', 'fr'), '/signup?provider=gmx&lang=fr');
  const paid = `/signup?redirect=${encodeURIComponent('/api/stripe/checkout/start?plan=solo&interval=month')}`;
  assert.equal(withReadingLang(paid, 'es'), `${paid}&lang=es`);
  assert.equal(withReadingLang('/signup?plan=pro#top', 'zh'), '/signup?plan=pro&lang=zh#top');
  assert.equal(withReadingLang('/signup#form', 'nb'), '/signup?lang=nb#form');
});

test('a link that already names a language is left alone', () => {
  assert.equal(withReadingLang('/signup?lang=es', 'fr'), '/signup?lang=es');
});

test('other destinations are never touched', () => {
  for (const href of ['/dashboard', '/api/stripe/checkout/start?plan=solo', '/signup-guide', '/fr/signup', '/docs', 'https://example.com/signup', '#signup']) {
    assert.equal(withReadingLang(href, 'fr'), href);
  }
  assert.equal(withReadingLang(undefined, 'fr'), undefined);
});

/* --------------------------------------------------- blog prose links */

test('a signup link in a translated blog post keeps the reader language', () => {
  const md = 'Start [here](/signup) or [with GMX](/signup?provider=gmx), read [the docs](/docs), or [elsewhere](https://example.com/signup).';
  const { html } = renderMarkdown(md, { hrefFor: (h) => withReadingLangEscaped(h, 'fr') });
  assert.match(html, /<a href="\/signup\?lang=fr">here<\/a>/);
  assert.match(html, /<a href="\/signup\?provider=gmx&amp;lang=fr">with GMX<\/a>/);
  assert.match(html, /<a href="\/docs">the docs<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/signup" target="_blank"/);
});

test('an English post, or no locale at all, renders links exactly as written', () => {
  const md = '[Sign up](/signup?provider=gmx&plan=solo)';
  const en = renderMarkdown(md, { hrefFor: (h) => withReadingLangEscaped(h, 'en') }).html;
  const none = renderMarkdown(md).html;
  assert.equal(en, none);
  assert.match(none, /<a href="\/signup\?provider=gmx&amp;plan=solo">Sign up<\/a>/);
});

/* ------------------------------------- every marketing CTA carries it */

// Each file that renders a signup or login button on a localized page. A bare
// href="/signup" there would send a French reader to an English form again.
const CTA_FILES = [
  '../../components/marketing/Sections.jsx',
  '../../components/marketing/FoundersClient.jsx',
  '../../components/marketing/ProvidersClient.jsx',
  '../../components/marketing/CompareClient.jsx',
  '../../components/marketing/BusinessView.jsx',
  '../../components/marketing/DocsClient.jsx',
  '../../components/marketing/ClientSetupView.jsx',
  '../../components/marketing/PricingClient.jsx',
  '../../components/marketing/ConnectProviderView.jsx',
  '../../components/marketing/BlogPostClient.jsx',
  '../../app/[locale]/self-hosting/page.js',
  '../../app/[locale]/docs/read-only-access/page.js',
];

test('no localized marketing CTA links to a bare /signup or /login', () => {
  for (const file of CTA_FILES) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /href="\/(signup|login)[?"]/, file);
    assert.doesNotMatch(src, /href=\{`\/signup/, file);
    assert.match(src, /withReadingLang\(/, file);
  }
});

test('the signup and login layouts, and only they, read lang', () => {
  for (const file of ['../../app/signup/layout.js', '../../app/(auth)/login/layout.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /<AppLocaleProvider readLangParam>/, file);
  }
  // Anywhere else, a stray lang must not override a choice made in Settings.
  for (const file of ['../../app/(auth)/layout.js', '../../app/dashboard/layout.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /readLangParam/, file);
  }
});
