// ---------------------------------------------------------------------------
// /connect/<provider>/<client>: the per-assistant guide pages.
//
// Run with: npm run test:connect-client-guides
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLIENT_GUIDE_PROVIDERS,
  CLIENT_GUIDE_CLIENTS,
  CLIENT_GUIDE_LOCALES,
  clientGuideParams,
  clientGuideLinksFor,
  getClientGuide,
  hasClientGuide,
} from './client-guides.mjs';

const leaves = (value, path = '', out = []) => {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  } else out.push([path, value]);
  return out;
};
const copy = (locale) =>
  JSON.parse(readFileSync(new URL(`./client-guides/${locale}.json`, import.meta.url), 'utf8'));

test('six pages in English and German', () => {
  const params = clientGuideParams(new Date('2026-12-01T00:00:00Z'));
  assert.equal(params.length, CLIENT_GUIDE_PROVIDERS.length * CLIENT_GUIDE_CLIENTS.length * CLIENT_GUIDE_LOCALES.length);
  assert.ok(params.some((p) => p.locale === 'de' && p.provider === 'yahoo' && p.client === 'chatgpt'));
});

test('no page for other providers, clients or locales', () => {
  assert.equal(hasClientGuide('gmail', 'claude', 'en'), false);
  assert.equal(hasClientGuide('yahoo', 'cursor', 'en'), false);
  assert.equal(hasClientGuide('yahoo', 'claude', 'nb'), false);
});

test('German mirrors the English key structure', () => {
  const en = leaves(copy('en')).map(([p]) => p).sort();
  const de = leaves(copy('de')).map(([p]) => p).sort();
  assert.deepEqual(de, en);
});

test('copy rules: no em dashes, only b and code tags, no Claude directory claim', () => {
  for (const locale of CLIENT_GUIDE_LOCALES) {
    for (const [path, value] of leaves(copy(locale))) {
      if (typeof value !== 'string') continue;
      const where = `${locale} ${path}`;
      assert.ok(!value.includes('—'), `${where} has an em dash`);
      for (const tag of value.match(/<[^>]*>/g) ?? []) assert.match(tag, /^<\/?(b|code)>$/, where);
      assert.ok(!/Claude('s)? (connector |plugin )?directory/i.test(value), `${where} claims a Claude directory listing`);
      assert.ok(!/30 days|30 Tage/i.test(value), where);
    }
  }
});

test('every page: H1 matches the title, steps, an FAQ, links to parent and sibling', async () => {
  for (const { locale, provider, client } of clientGuideParams()) {
    const g = await getClientGuide(locale, provider, client);
    const where = `${locale} ${provider}/${client}`;
    assert.ok(g, where);
    assert.equal(g.h1.toLowerCase(), g.meta.title.toLowerCase(), where);
    assert.ok(g.meta.description.length <= 170, `${where} description is ${g.meta.description.length} chars`);
    assert.equal(g.steps.length, 5, where);
    assert.ok(g.faq.length >= 3, where);
    assert.ok(g.steps.every((s) => !s.h.includes('{') && !s.p.includes('{')), `${where} has an unfilled token`);
    assert.equal(g.parent.href, `/connect/${provider}`);
    assert.equal(g.sibling.href, `/connect/${provider}/${client === 'claude' ? 'chatgpt' : 'claude'}`);
    assert.match(g.answer, client === 'claude' ? /custom connector|Custom Connector/ : /Any Mailbox/, where);
  }
});

test('the provider page links both guides where they exist, nothing elsewhere', async () => {
  const links = await clientGuideLinksFor('icloud', 'de');
  assert.deepEqual(links.links.map((l) => l.href), ['/connect/icloud/claude', '/connect/icloud/chatgpt']);
  assert.equal(await clientGuideLinksFor('icloud', 'fr'), null);
  assert.equal(await clientGuideLinksFor('gmail', 'en'), null);
});
