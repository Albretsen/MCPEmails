// Every page under app/[locale] calls requireLocale() in generateMetadata and
// in the page itself, so /xyz/pricing 404s without the pricing meta copy.
// See src/i18n/require-locale.ts for why the layout's own check is not enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localeDir = path.join(webRoot, 'app/[locale]');

const pages = readdirSync(localeDir, { recursive: true })
  .filter((f) => /(^|\/)page\.(js|jsx|ts|tsx)$/.test(f))
  .sort();

/** Each exported function's source, from its `export` to the next one. */
function exportedFunctions(src) {
  const starts = [...src.matchAll(/^export (?:default )?(?:async )?function (\w+)/gm)];
  return starts.map((m, i) => ({ name: m[1], body: src.slice(m.index, starts[i + 1]?.index ?? src.length) }));
}

test('finds the pages', () => {
  assert.ok(pages.length >= 20, `only ${pages.length} pages under app/[locale]`);
});

for (const page of pages) {
  test(`app/[locale]/${page}: checks the locale wherever it reads params`, () => {
    const src = readFileSync(path.join(localeDir, page), 'utf8');
    const readers = exportedFunctions(src).filter((f) => f.name !== 'generateStaticParams' && /await params/.test(f.body));
    assert.ok(readers.length > 0, 'no exported function reads params');
    for (const { name, body } of readers) {
      assert.match(body, /requireLocale\(locale\)/, `${name} reads params without requireLocale(locale)`);
    }
  });
}
