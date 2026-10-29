// ---------------------------------------------------------------------------
// /connect/<provider>: the "More guides" line (moreGuideLinksFor).
//
// Run with: npm run test:connect-more-guides
//
// Pins that every connectable released provider page links two of the four
// rotating buyer posts, that all four are reached across the pages, that the
// Outlook page leads with the personal-account walkthrough, and that an
// untranslated post is flagged so the page links its English URL.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moreGuideLinksFor, MORE_GUIDE_POSTS } from './guides.mjs';
import { releasedProviders } from './release.mjs';
import { getProviderContent } from './content.mjs';

const NOW = new Date('2026-12-01T00:00:00.000Z');
const allLocales = () => ['en', 'nb', 'es', 'fr', 'zh', 'de'];

test('every connectable page links two rotating posts, and all four are reached', async () => {
  const counts = new Map();
  let pages = 0;
  for (const provider of releasedProviders(NOW)) {
    const content = await getProviderContent('en', provider.slug);
    const links = moreGuideLinksFor({ providerSlug: provider.slug, content, locale: 'en', postLocales: allLocales });
    if (content?.auth?.method === 'none') {
      assert.equal(links.length, 0, provider.slug);
      continue;
    }
    pages++;
    const rotating = links.filter((l) => l.key !== 'personal');
    assert.equal(rotating.length, 2, provider.slug);
    for (const l of rotating) counts.set(l.key, (counts.get(l.key) ?? 0) + 1);
  }
  assert.ok(pages > 50, `checked ${pages} pages`);
  assert.deepEqual([...counts.keys()].sort(), ['agentInbox', 'connectors', 'inboxZero', 'schedule']);
});

test('the Outlook page leads with the personal-account walkthrough', async () => {
  const content = await getProviderContent('en', 'outlook');
  const links = moreGuideLinksFor({ providerSlug: 'outlook', content, locale: 'en', postLocales: allLocales });
  assert.equal(links[0].href, MORE_GUIDE_POSTS.personal);
});

test('an untranslated post is not localized', () => {
  const content = { auth: { method: 'app-password' } };
  const links = moreGuideLinksFor({ providerSlug: 'gmail', content, locale: 'zh', postLocales: () => ['en'] });
  assert.ok(links.length > 0);
  for (const l of links) assert.equal(l.localized, false);
  const en = moreGuideLinksFor({ providerSlug: 'gmail', content, locale: 'en', postLocales: () => ['en'] });
  for (const l of en) assert.equal(l.localized, true);
});
