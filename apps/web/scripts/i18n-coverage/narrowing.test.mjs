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

// Pages that are handed a namespace they do not read, and why. Both sit under
// app/[locale]/docs/layout.js, which has to cover the docs index; a narrower
// layout nested under it would not stop that layout's messages being sent.
const KNOWN_SURPLUS = {
  'app/[locale]/docs/[client]/page.js': ['docs'],
  'app/[locale]/docs/clients/page.js': ['docs'],
};

test('every marketing page is handed exactly the namespaces its client code reads, plus the two shared ones', () => {
  assert.ok(marketingPages.length >= 20);
  for (const route of marketingPages) {
    const expected = [...new Set([...SHARED, ...route.needs, ...(KNOWN_SURPLUS[route.file] ?? [])])].sort();
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

test('the heavy docs catalogue goes only to the docs section', () => {
  const withDocs = real.routes.filter((route) => isPage(route) && route.provided.includes('docs')).map((route) => route.file);
  assert.ok(withDocs.length > 0);
  for (const file of withDocs) assert.ok(file.startsWith('app/[locale]/docs/'), file);
});
