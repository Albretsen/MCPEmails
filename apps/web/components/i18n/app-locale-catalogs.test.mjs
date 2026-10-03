// ---------------------------------------------------------------------------
// app-locale-catalogs.mjs: the real loaders, against the files on disk.
//
// Run with: npm run test:app-locale
//
// app-locale-lazy.test.mjs replaces this module to control timing, so it says
// nothing about whether the real one loads the right files. This does: every
// language's loader must return exactly that language's four namespaces, and
// only English may be available without a load. It also reads the two source
// files, because the thing this split exists for is invisible to a render:
// a single static import of another language's JSON puts it back in the
// bundle every visitor downloads.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { peekAppCatalog, loadAppCatalog } = await import('./app-locale-catalogs.mjs');
const { routing } = await import('../../src/i18n/routing.ts');

const NAMESPACES = ['dashboard', 'dashboardChrome', 'auth', 'common'];
const onDisk = (locale) => Object.fromEntries(NAMESPACES.map((ns) => [
  ns,
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/${ns}.json`, import.meta.url), 'utf8')),
]));

test('English is available synchronously and is the catalog on disk', () => {
  assert.deepEqual(peekAppCatalog('en'), onDisk('en'));
});

test('no other language is available before it is loaded', () => {
  for (const locale of routing.locales.filter((l) => l !== 'en')) {
    assert.equal(peekAppCatalog(locale), null, `${locale} must not be bundled with English`);
  }
});

test('every supported language has a loader that returns exactly its own four namespaces', async () => {
  assert.deepEqual([...routing.locales].sort(), ['en', 'es', 'fr', 'nb', 'zh'], 'a new locale needs a loader and a row here');
  for (const locale of routing.locales) {
    const catalog = await loadAppCatalog(locale);
    assert.deepEqual(Object.keys(catalog), NAMESPACES, `${locale}: the four namespaces, in order`);
    assert.deepEqual(catalog, onDisk(locale), `${locale}: loaded catalog equals the files`);
    assert.equal(peekAppCatalog(locale), catalog, `${locale}: once loaded it is available synchronously`);
  }
});

test('a loaded catalog is one stable object, however often it is asked for', async () => {
  const [a, b] = await Promise.all([loadAppCatalog('fr'), loadAppCatalog('fr')]);
  assert.equal(a, b);
  assert.equal(await loadAppCatalog('fr'), a);
  assert.equal(peekAppCatalog('fr'), a);
});

test('a language with no catalog rejects, and does not become available', async () => {
  for (const bad of ['de', '', 'constructor', '__proto__', undefined]) {
    await assert.rejects(() => loadAppCatalog(bad), /No message catalog/);
    assert.equal(peekAppCatalog(bad), null);
  }
});

test('only English is imported statically; every other language is behind import()', () => {
  const catalogs = readFileSync(new URL('./app-locale-catalogs.mjs', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('./AppLocaleProvider.jsx', import.meta.url), 'utf8');
  const staticJson = (source) => source.split('\n')
    .filter((line) => /^\s*import\b.*\bfrom\b.*messages\//.test(line))
    .map((line) => line.match(/messages\/([a-z]+)\//)[1]);

  assert.deepEqual([...new Set(staticJson(catalogs))], ['en']);
  assert.equal(staticJson(catalogs).length, 4, 'English: four namespaces, statically');
  assert.deepEqual(staticJson(provider), [], 'the provider imports no catalog itself');

  for (const locale of ['nb', 'es', 'fr', 'zh']) {
    for (const ns of NAMESPACES) {
      assert.ok(catalogs.includes(`import('../../messages/${locale}/${ns}.json')`), `${locale}/${ns} is loaded with a literal import()`);
    }
  }
});
