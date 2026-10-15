// ---------------------------------------------------------------------------
// /connect/<provider>: where "Connect IONOS free" goes.
//
// Run with: npm run test:connect-cta
//
// The two signup buttons on a provider landing page used to be a bare
// `/signup`, so the visitor arrived at signup, and then at the dashboard, with
// nothing saying which provider they had come for. They now carry the slug
// (`/signup?provider=ionos`), which src/lib/connect/intent-carry.mjs takes the
// rest of the way.
//
// This renders the real `ConnectProviderView` with the real copy, for every
// released provider in every locale it is published in, and pins:
//
//   - both signup buttons carry that page's own slug, and nothing else;
//   - the href is the same on /nb, /es, /fr and /zh as on the English page.
//     /signup is not a localised route (it lives at app/signup, outside
//     [locale]), so a locale prefix on it is a 404, and next-intl's `locale`
//     prop would emit /en/... and 307. These are plain anchors on purpose.
//
// `next-intl/server` is replaced by a translator over the real message files,
// because there is no request to read a locale from under `node --test`. Nav
// and Footer are dropped from the tree before it is rendered: they are client
// components that need a router and an intl provider, they have their own
// suites, and they are not what this page's buttons are.
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
const { connectIntentSlugShape, CONNECT_INTENT_PARAM } = await import('../../src/lib/connect/intent-carry.mjs');
const { routing } = await import('../../src/i18n/routing.ts');

/** Every wave that has a date is open, so the set does not depend on today. */
const NOW = new Date('2026-12-01T00:00:00.000Z');
const LOCALES = routing.locales;

async function signupAnchors(locale, provider) {
  const content = await getProviderContent(locale, provider.slug);
  assert.ok(content, `no ${locale} copy for ${provider.slug}`);
  const page = await ConnectProviderView({ locale, provider, content });
  const all = Children.toArray(page.props.children);
  const kept = all.filter((c) => c?.type !== Nav && c?.type !== Footer);
  assert.equal(
    all.length - kept.length, 2,
    'expected Nav and Footer as direct children of the page',
  );
  const html = renderToStaticMarkup(cloneElement(page, {}, ...kept));
  const { document } = new JSDOM(html).window;
  return [...document.querySelectorAll('a')]
    .filter((a) => /(^|\/)signup(\?|$|\/)/.test(a.getAttribute('href') ?? ''))
    .map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent,
      intlLink: a.hasAttribute('data-intl-link'),
      className: a.className,
    }));
}

test('the locales under test are the ones the site routes', () => {
  assert.deepEqual([...LOCALES], ['en', 'nb', 'es', 'fr', 'zh']);
  assert.equal(routing.defaultLocale, 'en');
  assert.equal(routing.localePrefix, 'as-needed');
});

for (const locale of LOCALES) {
  test(`${locale}: /connect/ionos sends both signup buttons to /signup?provider=ionos`, async () => {
    const ionos = PROVIDERS.find((p) => p.slug === 'ionos');
    const anchors = await signupAnchors(locale, ionos);
    assert.equal(anchors.length, 2, 'the hero and the closing band each have one signup button');
    const label = messagesFor(locale).cta.primary.replace('{provider}', ionos.name);
    for (const a of anchors) {
      assert.equal(a.href, '/signup?provider=ionos');
      assert.equal(a.text, label);
      // A plain anchor: no locale prefix is ever added to it.
      assert.equal(a.intlLink, false);
      assert.equal(a.className, 'btn btn-primary btn-lg');
    }
  });
}

test('every released provider page carries its own slug, identically in every locale', async () => {
  const released = releasedProviders(NOW);
  assert.ok(released.length > 90, `expected the whole released set, got ${released.length}`);
  let pages = 0;
  for (const provider of released) {
    for (const locale of provider.locales) {
      const anchors = await signupAnchors(locale, provider);
      assert.equal(anchors.length, 2, `${locale}/${provider.slug}`);
      for (const a of anchors) {
        assert.equal(a.href, `/signup?${CONNECT_INTENT_PARAM}=${provider.slug}`, `${locale}/${provider.slug}`);
        assert.equal(a.intlLink, false, `${locale}/${provider.slug}`);
      }
      pages += 1;
    }
  }
  assert.equal(pages, released.reduce((n, p) => n + p.locales.length, 0));
});

test('the slug is the only thing the link carries, and it needs no escaping', () => {
  for (const p of PROVIDERS) {
    // The href is built by interpolation, which is only safe because a slug is
    // letters, digits and hyphens. A registry entry that broke that would have
    // to fail here, not in a URL.
    assert.equal(connectIntentSlugShape(p.slug), p.slug, p.slug);
    assert.equal(encodeURIComponent(p.slug), p.slug, p.slug);
    const url = new URL(`/signup?provider=${p.slug}`, 'https://mcpemails.com');
    assert.deepEqual([...url.searchParams.keys()], ['provider'], p.slug);
    assert.equal(url.pathname, '/signup', p.slug);
  }
});

test('no bare /signup is left on the page for the hint to be lost through', () => {
  const source = readFileSync(new URL('./ConnectProviderView.jsx', import.meta.url), 'utf8');
  assert.equal(source.match(/href="\/signup"/g), null);
  assert.equal(source.match(/href=\{`\/signup\?provider=\$\{provider\.slug\}`\}/g)?.length, 2);
});
