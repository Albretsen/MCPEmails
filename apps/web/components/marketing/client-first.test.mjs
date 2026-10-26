// ---------------------------------------------------------------------------
// Client-first website (owner feedback F5): a visitor from an AI assistant sees
// it first in the home page marquee, the hero diagram line and the guide links,
// and the signup links carry it to onboarding as ?client=.
//
// Run with: npm run test:client-first
//
// Renders the real sections with the real messages, with and without a
// preferred client, and checks that the page source for metadata and JSON-LD
// never reads it (the snippet CTR test and cloaking safety).
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { Trusted, WhatIs, HeroPipeDiagram, HeroTextBlock, agentSubLine, marqueeBrands } = await import('./Sections.jsx');
const { PreferredClientProvider } = await import('./PreferredClient.jsx');

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];
const homeFor = (locale) =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/home.json`, import.meta.url), 'utf8'));

function render(component, { locale = 'en', preferred = null } = {}) {
  const html = renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages: { home: homeFor(locale) }, timeZone: 'UTC' },
      createElement(PreferredClientProvider, { value: preferred }, createElement(component, {})),
    ),
  );
  return new JSDOM(html).window.document;
}

const firstMarqueeName = (doc) => doc.querySelector('.marquee-item')?.textContent ?? '';

test('marquee: ChatGPT first for a ChatGPT visitor, Claude first by default', () => {
  assert.equal(firstMarqueeName(render(Trusted)), 'Claude');
  assert.equal(firstMarqueeName(render(Trusted, { preferred: 'chatgpt' })), 'ChatGPT');
  assert.equal(firstMarqueeName(render(Trusted, { preferred: 'cursor' })), 'Cursor');
  assert.equal(firstMarqueeName(render(Trusted, { preferred: 'perplexity' })), 'Perplexity');
  assert.equal(firstMarqueeName(render(Trusted, { preferred: 'gemini' })), 'Gemini CLI');
});

test('marquee: the default order is the brand list unchanged', () => {
  const base = marqueeBrands(null).map((b) => b.name);
  const chat = marqueeBrands('chatgpt').map((b) => b.name);
  assert.deepEqual([...chat].sort(), [...base].sort());
  assert.deepEqual(chat.slice(1), base.filter((n) => n !== 'ChatGPT'));
});

for (const locale of LOCALES) {
  test(`${locale}: the hero line keeps its translated tail and is unchanged without a client`, () => {
    const message = homeFor(locale).hero.pipe.agentSub;
    assert.equal(agentSubLine(message, null), message);
    assert.equal(agentSubLine(message, 'claude'), message);
    const chat = agentSubLine(message, 'chatgpt');
    assert.ok(chat.startsWith('ChatGPT · Claude'), chat);
    assert.equal(chat.split(' · ').at(-1), message.split(' · ').at(-1));
    assert.ok(agentSubLine(message, 'perplexity').startsWith('Perplexity · Claude · '));
    const doc = render(HeroPipeDiagram, { locale, preferred: 'cursor' });
    assert.ok(doc.body.textContent.includes(agentSubLine(message, 'cursor')));
  });
}

test('guide links: ChatGPT guide first for a ChatGPT visitor', () => {
  const hrefs = (doc) => [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((h) => h.startsWith('/blog/'));
  assert.deepEqual(hrefs(render(WhatIs)), [
    '/blog/connect-claude-to-email', '/blog/connect-chatgpt-to-email', '/blog/claude-imap-connector',
  ]);
  assert.deepEqual(hrefs(render(WhatIs, { preferred: 'chatgpt' })), [
    '/blog/connect-chatgpt-to-email', '/blog/connect-claude-to-email', '/blog/claude-imap-connector',
  ]);
});

test('signup link carries ?client= only when the visitor came from an assistant', () => {
  const signup = (doc) => [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href')).find((h) => h.startsWith('/signup'));
  assert.equal(signup(render(HeroTextBlock)), '/signup');
  assert.equal(signup(render(HeroTextBlock, { preferred: 'chatgpt' })), '/signup?client=chatgpt');
  assert.equal(signup(render(HeroTextBlock, { locale: 'fr', preferred: 'cursor' })), '/signup?lang=fr&client=cursor');
  assert.equal(signup(render(HeroTextBlock, { preferred: 'perplexity' })), '/signup');
});

// ── Metadata and JSON-LD never read the preferred client ─────────────────────
//
// The byte-level check against a running build is
// scripts/built-output/client-first.check.mjs. This one runs in CI: no
// generateMetadata body, no JSON-LD builder and no seo helper may mention it.

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARKERS = /preferred|AI_CLIENT|x-ai-client|mx_ai_client/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** The text of `export async function generateMetadata` up to the next top-level declaration. */
function generateMetadataBody(source) {
  const start = source.search(/export (async )?function generateMetadata/);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(export |function |const |async function )/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('no generateMetadata under app/[locale] reads the preferred client', () => {
  const files = walk(path.join(webRoot, 'app/[locale]'));
  assert.ok(files.length > 20);
  for (const file of files) {
    const body = generateMetadataBody(readFileSync(file, 'utf8'));
    assert.equal(MARKERS.test(body), false, `${path.relative(webRoot, file)} generateMetadata mentions the preferred client`);
  }
});

test('JSON-LD on the pages that read the preferred client is built without it', () => {
  for (const rel of ['app/[locale]/docs/clients/page.js', 'app/[locale]/docs/[client]/page.js', 'app/[locale]/page.tsx']) {
    const source = readFileSync(path.join(webRoot, rel), 'utf8');
    const start = source.indexOf('const jsonLd');
    assert.notEqual(start, -1, `${rel} has no jsonLd`);
    const end = source.indexOf('\n  return', start);
    assert.equal(MARKERS.test(source.slice(start, end)), false, `${rel} jsonLd mentions the preferred client`);
  }
  for (const file of walk(path.join(webRoot, 'src/i18n'))) {
    assert.equal(MARKERS.test(readFileSync(file, 'utf8')), false, `${path.relative(webRoot, file)} mentions the preferred client`);
  }
});
