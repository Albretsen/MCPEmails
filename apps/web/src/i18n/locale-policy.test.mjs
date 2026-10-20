// The locale policy (locale-policy.mjs) and the language switcher links that
// follow from it (language-switcher.mjs). Run: npm run test:locale-policy

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FULL_LOCALES, FROZEN_LOCALES, SCOPED_LOCALES, isScopedLocale, FALLBACK_LOCALE, deepMergeMessages, withEnglishFallback,
  isFullLocale, isFrozenLocale,
} from './locale-policy.mjs';
import { languageSwitcherLinks, localizedHref } from './language-switcher.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALL = ['en', 'nb', 'es', 'fr', 'zh'];

function leafPaths(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.push(prefix);
  return out;
}

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

test('the policy covers every routed locale exactly once, and English is full', async () => {
  const source = readFileSync(path.join(webRoot, 'src/i18n/routing.ts'), 'utf8');
  const routed = JSON.parse(/locales:\s*(\[[^\]]*\])/.exec(source)[1].replace(/'/g, '"'));
  assert.deepEqual([...FULL_LOCALES, ...SCOPED_LOCALES, ...FROZEN_LOCALES].sort(), [...routed].sort());
  assert.equal(new Set([...FULL_LOCALES, ...SCOPED_LOCALES, ...FROZEN_LOCALES]).size, routed.length);
  assert.ok(isFullLocale(FALLBACK_LOCALE));
  assert.ok(isFrozenLocale('zh') && !isFullLocale('zh'));
  assert.ok(isFullLocale('nb') && !isFrozenLocale('nb'));
  assert.ok(isScopedLocale('de') && !isFullLocale('de') && !isFrozenLocale('de'));
});

// ---------------------------------------------------------------------------
// Message fallback
// ---------------------------------------------------------------------------

test('deepMergeMessages: the override wins, missing keys come from the base, nothing is mutated', () => {
  const en = { a: 'A', nested: { x: 'X', y: 'Y', deep: { z: 'Z' } }, list: ['1', '2'] };
  const zh = { a: 'a-zh', nested: { x: 'x-zh', deep: {} }, list: ['one'] };
  const enCopy = structuredClone(en);
  const zhCopy = structuredClone(zh);
  assert.deepEqual(deepMergeMessages(en, zh), {
    a: 'a-zh',
    nested: { x: 'x-zh', y: 'Y', deep: { z: 'Z' } },
    // Arrays are leaves: replaced whole, never merged by index.
    list: ['one'],
  });
  assert.deepEqual(en, enCopy);
  assert.deepEqual(zh, zhCopy);
});

test('withEnglishFallback: a frozen locale gets English for missing keys, a full one is untouched', () => {
  const en = { hero: { title: 'Hi', sub: 'New line' } };
  const partial = { hero: { title: 'Ni hao' } };
  assert.deepEqual(withEnglishFallback('zh', partial, en), { hero: { title: 'Ni hao', sub: 'New line' } });
  // A full locale is returned as is: CI guarantees it is complete, and merging
  // there would hide a real gap rather than fall back.
  assert.equal(withEnglishFallback('nb', partial, en), partial);
  // A frozen locale with no file at all for a namespace renders it in English.
  assert.deepEqual(withEnglishFallback('zh', undefined, en), en);
});

test('every frozen locale catalog, merged over English, defines every English key', () => {
  const dir = path.join(webRoot, 'messages');
  for (const locale of FROZEN_LOCALES) {
    for (const file of readdirSync(path.join(dir, 'en')).filter((f) => f.endsWith('.json'))) {
      const en = JSON.parse(readFileSync(path.join(dir, 'en', file), 'utf8'));
      let own;
      try {
        own = JSON.parse(readFileSync(path.join(dir, locale, file), 'utf8'));
      } catch {
        own = undefined;
      }
      const merged = withEnglishFallback(locale, own, en);
      const have = new Set(leafPaths(merged));
      const missing = leafPaths(en).filter((p) => !have.has(p));
      assert.deepEqual(missing, [], `${locale}/${file}`);
    }
  }
});

test('the server and app providers both apply the fallback', () => {
  // Both places a catalog reaches next-intl. A provider that skipped the merge
  // would show raw key paths in zh the first time a key lands without one.
  const request = readFileSync(path.join(webRoot, 'src/i18n/request.ts'), 'utf8');
  assert.match(request, /withEnglishFallback\(/);
  // AppLocaleProvider and AuthLocaleProvider both render through LocaleCore,
  // which merges every catalog it loads before handing it on.
  const app = readFileSync(path.join(webRoot, 'components/i18n/LocaleCore.jsx'), 'utf8');
  assert.match(app, /const effective = withEnglishFallback\(locale, raw, english\);/);
  assert.match(app, /<NextIntlClientProvider locale=\{shownLocale\} messages=\{messages\}>/);
});

// ---------------------------------------------------------------------------
// Language switcher
// ---------------------------------------------------------------------------

test('localizedHref: English has no prefix, every other locale does, and home has no trailing slash', () => {
  assert.equal(localizedHref('en', '/pricing'), '/pricing');
  assert.equal(localizedHref('es', '/pricing'), '/es/pricing');
  assert.equal(localizedHref('en', '/'), '/');
  assert.equal(localizedHref('zh', '/'), '/zh');
  assert.equal(localizedHref('fr', ''), '/fr');
});

test('switcher: a page in all five locales links the same page in each', () => {
  assert.deepEqual(
    languageSwitcherLinks('/pricing', ALL, ALL).map((l) => l.href),
    ['/pricing', '/nb/pricing', '/es/pricing', '/fr/pricing', '/zh/pricing'],
  );
});

test('switcher: an English-only page sends the other options to their home pages', () => {
  const links = languageSwitcherLinks('/best-email-mcp-servers', ['en'], ALL);
  assert.deepEqual(links.map((l) => l.href), ['/best-email-mcp-servers', '/nb', '/es', '/fr', '/zh']);
  assert.deepEqual(links.map((l) => l.samePage), [true, false, false, false, false]);
});

test('switcher: a provider page without zh links zh home, never /zh/connect/<slug>', () => {
  const links = languageSwitcherLinks('/connect/example', ['en', 'nb', 'es', 'fr'], ALL);
  assert.deepEqual(links.map((l) => l.href), ['/connect/example', '/nb/connect/example', '/es/connect/example', '/fr/connect/example', '/zh']);
});

test('switcher: a blog post translated into some locales never links an English fallback URL', () => {
  const links = languageSwitcherLinks('/blog/a-post', ['en', 'es'], ALL);
  assert.deepEqual(links.map((l) => l.href), ['/blog/a-post', '/nb', '/es/blog/a-post', '/fr', '/zh']);
  // The options keep the site's order and are all present.
  assert.deepEqual(links.map((l) => l.code), ALL);
});

test('switcher: the Footer passes the page locales through, and restricted pages pass them', () => {
  // A switcher that ignores its list, or a page that forgets to pass one, is the
  // bug this exists to stop: /nb/best-email-mcp-servers and friends were 404s
  // linked from every footer.
  const read = (f) => readFileSync(path.join(webRoot, f), 'utf8');
  const sections = read('components/marketing/Sections.jsx');
  assert.match(sections, /export function Footer\(\{ locales \} = \{\}\)/);
  assert.match(sections, /<LanguageSwitcher locales=\{locales\} \/>/);
  assert.match(sections, /languageSwitcherLinks\(pathname, locales, routing\.locales\)/);
  assert.match(read('components/marketing/ConnectProviderView.jsx'), /<Footer locales=\{provider\.locales\} \/>/);
  assert.match(read('components/marketing/ClientSetupView.jsx'), /<Footer locales=\{client\.locales\} \/>/);
  assert.match(read('components/marketing/EmailMcpServersView.jsx'), /<Footer locales=\{locales\} \/>/);
  assert.match(read('app/[locale]/best-email-mcp-servers/page.js'), /<EmailMcpServersView locales=\{LOCALES\} \/>/);
  assert.match(read('components/marketing/BlogPostClient.jsx'), /<Footer locales=\{post\.locales\} \/>/);
  assert.match(read('app/[locale]/blog/[slug]/page.js'), /locales: post\.locales/);
});
