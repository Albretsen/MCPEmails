// ---------------------------------------------------------------------------
// Home page: the row of setup-guide links under "What is an email MCP server".
//
// Run with: npm run test:home-guides
//
// Until 2026-10-20 the home page linked no blog post at all, while the three
// setup guides below take 58% of blog search clicks. This renders the real
// WhatIs section with the real messages in every locale and pins the three
// links, their locale-aware Link, and their anchor text.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { JSDOM } from 'jsdom';

mock.module(new URL('../../src/i18n/navigation.ts', import.meta.url).href, {
  namedExports: {
    Link: ({ href, children, ...rest }) => createElement('a', { ...rest, href, 'data-intl-link': '' }, children),
    usePathname: () => '/',
    useRouter: () => ({}),
    redirect: () => {},
    getPathname: () => '/',
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mcpemails.com/' });
globalThis.window ??= dom.window;
globalThis.document ??= dom.window.document;
globalThis.self ??= globalThis;

const { NextIntlClientProvider } = await import('next-intl');
const { renderToStaticMarkup } = await import('react-dom/server');
const { WhatIs } = await import('./Sections.jsx');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];
const GUIDES = [
  ['/blog/connect-claude-to-email', 'guideClaude'],
  ['/blog/connect-chatgpt-to-email', 'guideChatgpt'],
  ['/blog/claude-imap-connector', 'guideImap'],
];
const homeFor = (locale) =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/home.json`, import.meta.url), 'utf8'));

for (const locale of LOCALES) {
  test(`${locale}: the home page links the three setup guides`, () => {
    const home = homeFor(locale);
    const html = renderToStaticMarkup(
      createElement(NextIntlClientProvider, { locale, messages: { home }, timeZone: 'UTC' }, createElement(WhatIs)),
    );
    const anchors = [...new JSDOM(html).window.document.querySelectorAll('a')];
    for (const [href, key] of GUIDES) {
      const a = anchors.find((el) => el.getAttribute('href') === href);
      assert.ok(a, `no link to ${href}`);
      assert.ok(home.whatIs[key]?.trim(), `no whatIs.${key}`);
      assert.equal(a.textContent, home.whatIs[key]);
      assert.equal(a.hasAttribute('data-intl-link'), true, `${href} is not a locale Link`);
    }
  });
}
