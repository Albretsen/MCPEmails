// The message namespaces each route hands to the browser are no wider than
// what its client code reads. The companion of analyze.test.mjs: that one
// proves nothing a route needs is missing, this one pins that the surplus
// stays gone. Run: npm run test:i18n-coverage

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = analyze(webRoot);
const isPage = (route) => /\/page\.(js|jsx|ts|tsx)$/.test(route.file);
const marketingPages = real.routes.filter((route) => route.file.startsWith('app/[locale]/') && isPage(route));

// Read on the client by the nav and footer every marketing page renders.
const SHARED = ['compare', 'home'];

test('the root layout sends no messages: a route outside app/[locale] gets only what AppLocaleProvider bundles', () => {
  const outside = real.routes.filter((route) => !route.file.startsWith('app/[locale]/') && route.file !== 'app/layout.js');
  assert.ok(outside.length > 20);
  for (const route of outside) {
    if (route.provider === 'AppLocaleProvider') assert.deepEqual(route.provided, real.appNamespaces, route.file);
    else assert.deepEqual(route.provided, [], `${route.file} (${route.provider})`);
  }
});

test('every marketing page is handed exactly the namespaces its client code reads, plus the two shared ones', () => {
  assert.ok(marketingPages.length >= 20);
  for (const route of marketingPages) {
    const expected = [...new Set([...SHARED, ...route.needs])].sort();
    assert.deepEqual(route.provided, expected, route.file);
  }
});

test('namespaces only Server Components read are sent to no route', () => {
  const sent = new Set(real.routes.flatMap((route) => route.provided));
  for (const namespace of ['privacy', 'terms', 'security', 'selfHosting', 'about', 'connect']) {
    assert.ok(real.requestNamespaces.includes(namespace), `${namespace} is no longer loaded at all`);
    assert.ok(!sent.has(namespace), `${namespace} is handed to the browser again`);
  }
});

// The docs catalogue (about 70 KB raw in English) goes to the two pages whose
// client code reads it, through app/[locale]/docs/(catalogue)/layout.js, and
// to no other docs page.
test('the heavy docs catalogue goes only to the docs index and the provider matrix', () => {
  const withDocs = real.routes.filter((route) => isPage(route) && route.provided.includes('docs')).map((route) => route.file);
  assert.deepEqual(withDocs.sort(), ['app/[locale]/docs/(catalogue)/page.js', 'app/[locale]/docs/(catalogue)/providers/page.js']);
  const otherDocs = marketingPages.filter((route) => route.file.startsWith('app/[locale]/docs/') && !route.file.includes('/(catalogue)/'));
  assert.ok(otherDocs.length >= 3, `only ${otherDocs.length} other docs pages found`);
  for (const route of otherDocs) assert.deepEqual(route.provided, SHARED, route.file);
});
