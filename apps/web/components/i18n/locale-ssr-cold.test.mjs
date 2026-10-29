// ---------------------------------------------------------------------------
// The server render of a reading language (`/signup?lang=nb`) with no catalog
// but English in memory yet: what a fresh server instance does on its first
// such request. Only English is bundled into AppLocaleProvider and
// AuthLocaleProvider (LocaleCore.jsx), so the render has to wait for the
// language's catalog rather than send English or key paths.
//
// Run with: npm run test:app-locale (its own file, so its own cold process).
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom } from '../../scripts/test-dom.mjs';

installDom();

const { renderToReadableStream } = await import('react-dom/server');
const { useMessages, useTranslations } = await import('next-intl');
const { default: AppLocaleProvider } = await import('./AppLocaleProvider.jsx');
const { default: AuthLocaleProvider } = await import('./AuthLocaleProvider.jsx');

const catalog = (locale, ns) =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/${ns}.json`, import.meta.url), 'utf8'));

async function serverHtml(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

for (const [Provider, name, ns, key] of [
  [AuthLocaleProvider, 'AuthLocaleProvider', ['auth', 'common'], ['auth', 'login', 'title']],
  [AppLocaleProvider, 'AppLocaleProvider', ['dashboard', 'dashboardChrome', 'auth', 'common', 'convert'], ['dashboard', 'settings', 'languageHeading']],
]) {
  for (const locale of ['nb', 'fr']) {
    test(`${name}: a cold server render in ${locale} waits for the ${locale} catalog`, async () => {
      const rendered = [];
      let messages = null;
      function Probe() {
        messages = useMessages();
        const text = useTranslations(key[0])(key.slice(1).join('.'));
        rendered.push(text);
        return createElement('h1', null, text);
      }
      const expected = catalog(locale, key[0])[key[1]][key[2]];
      const html = await serverHtml(createElement(Provider, { initialLocale: locale }, createElement(Probe)));
      assert.equal(html, `<h1>${expected}</h1>`);
      assert.deepEqual([...new Set(rendered)], [expected], 'no render showed English or a key path');
      assert.deepEqual(Object.keys(messages), ns);
      for (const n of ns) assert.deepEqual(messages[n], catalog(locale, n), `${n} is the ${locale} file`);
    });
  }
}
