// ---------------------------------------------------------------------------
// /connect/<provider>: the "Step-by-step guides" line under the setup steps.
//
// Run with: npm run test:connect-guides
//
// Renders the real ConnectProviderView with the real copy for every released
// provider in every locale it is published in, the way page.js calls it, and
// pins that the guide links src/lib/connect/guides.mjs chooses are on the page,
// as locale-aware Links (so /fr/connect/x links /fr/blog/y), with the
// locale's own anchor text. The harness is the one connect-provider-cta.test.mjs
// uses; see that file for why next-intl and Link are mocked.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { JSDOM } from 'jsdom';

const messagesFor = (locale) =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/connect.json`, import.meta.url), 'utf8'));

const { createTranslator } = await import('next-intl');

mock.module('next-intl/server', {
  namedExports: {
    getTranslations: async ({ locale, namespace }) =>
      createTranslator({ locale, namespace, messages: { [namespace]: messagesFor(locale) } }),
  },
});
// The locale-aware Link needs Next's router context. Its output is marked so
// the assertions below can tell it apart from the plain anchors under test.
mock.module(new URL('../../src/i18n/navigation.ts', import.meta.url).href, {
  namedExports: {
    Link: ({ href, children, ...rest }) => createElement('a', { ...rest, href, 'data-intl-link': '' }, children),
    // Named so that Sections.jsx links; never called, Nav is not rendered.
    usePathname: () => '/',
    useRouter: () => ({}),
    redirect: () => {},
    getPathname: () => '/',
  },
});

// Installed before React loads: Sections.jsx is imported below (for the
// identity of Nav and Footer) and its tree expects a document to exist.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mcpemails.com/' });
globalThis.window ??= dom.window;
globalThis.document ??= dom.window.document;
globalThis.self ??= globalThis;

const { default: ConnectProviderView } = await import('./ConnectProviderView.jsx');
const { Nav, Footer } = await import('./Sections.jsx');
const { cloneElement, Children } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { PROVIDERS } = await import('../../src/lib/connect/providers.mjs');
const { releasedProviders } = await import('../../src/lib/connect/release.mjs');
const { getProviderContent } = await import('../../src/lib/connect/content.mjs');

const { guideLinksFor, getGuideCopy } = await import('../../src/lib/connect/guides.mjs');

const NOW = new Date('2026-12-01T00:00:00.000Z');

async function renderPage(locale, provider, guides) {
  const content = await getProviderContent(locale, provider.slug);
  const page = await ConnectProviderView({ locale, provider, content, guides });
  const kept = Children.toArray(page.props.children).filter((c) => c?.type !== Nav && c?.type !== Footer);
  const html = renderToStaticMarkup(cloneElement(page, {}, ...kept));
  return { content, document: new JSDOM(html).window.document };
}

test('every released provider page renders its guide links as locale Links', async () => {
  let checked = 0;
  for (const provider of releasedProviders(NOW)) {
    for (const locale of provider.locales) {
      const guides = await getGuideCopy(locale);
      const { content, document } = await renderPage(locale, provider, guides);
      const expected = guideLinksFor(content);
      for (const { key, href } of expected) {
        const a = [...document.querySelectorAll('a')].find((el) => el.getAttribute('href') === href);
        assert.ok(a, `${locale}/${provider.slug}: no link to ${href}`);
        assert.equal(a.textContent, guides[key], `${locale}/${provider.slug}: anchor for ${href}`);
        assert.equal(a.hasAttribute('data-intl-link'), true, `${locale}/${provider.slug}: ${href} is not a locale Link`);
      }
      if (expected.length) {
        assert.ok(document.body.textContent.includes(guides.intro), `${locale}/${provider.slug}: no intro`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 400, `expected the whole set, got ${checked}`);
});

test('without guide copy the page renders no guides line (other callers stay unchanged)', async () => {
  const yahoo = PROVIDERS.find((p) => p.slug === 'yahoo');
  const { document } = await renderPage('en', yahoo, null);
  const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.equal(hrefs.includes('/blog/connect-claude-to-email'), false);
});

test('connectable pages link the client setup pages and, outside zh, the settings lookup', async () => {
  const { clientsForLocale } = await import('../../src/lib/clients/clients.mjs');
  const gmail = PROVIDERS.find((p) => p.slug === 'gmail');
  for (const locale of gmail.locales) {
    const guides = await getGuideCopy(locale);
    const { document } = await renderPage(locale, gmail, guides);
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    const available = new Set(clientsForLocale(locale).map((c) => c.slug));
    for (const slug of ['claude', 'chatgpt', 'cursor', 'vscode']) {
      if (available.has(slug)) assert.ok(hrefs.includes(`/docs/${slug}`), `${locale}: no /docs/${slug}`);
    }
    assert.ok(hrefs.includes('/docs/clients'), `${locale}: no client hub link`);
    assert.equal(hrefs.includes('/tools/email-settings-lookup'), locale !== 'zh', `${locale}: lookup link`);
  }
});
