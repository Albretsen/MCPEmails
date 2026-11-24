import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { FOOTER_PROVIDERS, FOOTER_GUIDES, footerProviders, footerGuides } from './footer-providers.mjs';
import { providerLocales } from './providers.mjs';
import { releasedProviders } from './release.mjs';

test('every footer provider lists exactly the locales its page exists in', () => {
  for (const p of FOOTER_PROVIDERS) {
    assert.deepEqual([...p.locales].sort(), [...providerLocales(p.slug)].sort(), p.slug);
  }
});

test('every footer provider is released', () => {
  const released = new Set(releasedProviders().map((p) => p.slug));
  for (const p of FOOTER_PROVIDERS) assert.ok(released.has(p.slug), p.slug);
});

test('pt and ja footers leave out Yandex, which has no page there', () => {
  assert.ok(!footerProviders('pt').some((p) => p.slug === 'yandex'));
  assert.ok(!footerProviders('ja').some((p) => p.slug === 'yandex'));
  assert.ok(footerProviders('de').some((p) => p.slug === 'yandex'));
});

test('every footer guide lists exactly the locales it is translated into', () => {
  for (const g of FOOTER_GUIDES) {
    const dir = new URL(`../blog/translations/${g.slug}/`, import.meta.url);
    const translated = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
    assert.deepEqual([...g.locales].sort(), ['en', ...translated].sort(), g.slug);
  }
});

test('an untranslated footer guide is not marked localized', () => {
  const pt = footerGuides('pt');
  assert.ok(pt.every((g) => g.localized === false));
  assert.ok(footerGuides('en').every((g) => g.localized));
});

test('help links keep a provider page missing in the locale on its English URL', async () => {
  const { helpHref } = await import('../support/help-links.mjs');
  assert.equal(helpHref('pt', '/connect/yandex'), '/connect/yandex');
  assert.equal(helpHref('de', '/connect/yandex'), '/de/connect/yandex');
  assert.equal(helpHref('pt', '/connect/gmail'), '/pt/connect/gmail');
});
