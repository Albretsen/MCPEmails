// ---------------------------------------------------------------------------
// Sidebar: the "Help & support" item.
//
// Run with: npm run test:support-entry-points
//
// v1 of /help is internal-only. The dashboard page decides that once
// (`supportVisibleTo`, SUPPORT_RELEASE_GATE) and hands the Sidebar a boolean.
// This pins the Sidebar's half: the item exists iff `supportVisible` is true,
// it links to the marketing /help route (not a dashboard section), and the
// link follows the app's own locale, which lives in the client provider rather
// than in the URL, so a Norwegian user lands on /nb/help.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();
// A next/link (under next-intl's Link) prefetches on idle and on intersection;
// jsdom has neither `self` nor IntersectionObserver.
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { NextIntlClientProvider } = await import('next-intl');
const { Sidebar } = await import('./Sidebar.jsx');
const en = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const nb = (await import('../../messages/nb/dashboardChrome.json', { with: { type: 'json' } })).default;

async function renderSidebar(t, { supportVisible, locale = 'en', messages = en }) {
  const props = {
    route: 'overview',
    setRoute: () => {},
    counts: { inboxes: 1, keys: 1, members: 1 },
    user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A' },
    workspace: { id: 'ws-0001', slug: 'acme', plan: 'pro', displayName: 'Acme' },
    workspaces: [],
    activeWorkspaceId: 'ws-0001',
    isOpen: false,
    onClose: () => {},
  };
  if (supportVisible !== undefined) props.supportVisible = supportVisible;
  const view = await mount(
    createElement(NextIntlClientProvider, { locale, messages: { dashboardChrome: messages } },
      createElement(Sidebar, props)),
  );
  t.after(() => view.unmount());
  return view;
}

const helpLinks = (view) =>
  [...view.container.querySelectorAll('a')].filter((a) => /\/help$/.test(a.getAttribute('href') ?? ''));

test('supportVisible: one "Help & support" nav link to /help', async (t) => {
  const view = await renderSidebar(t, { supportVisible: true });
  const links = helpLinks(view);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/help');
  assert.equal(links[0].textContent.trim(), en.sidebar.navHelp);
  assert.equal(view.container.querySelector('nav.nav').contains(links[0]), true, 'it is in the nav');
});

test('not visible: no help link at all', async (t) => {
  const view = await renderSidebar(t, { supportVisible: false });
  assert.equal(helpLinks(view).length, 0);
  assert.equal(view.container.textContent.includes(en.sidebar.navHelp), false);
});

test('prop omitted: hidden by default', async (t) => {
  const view = await renderSidebar(t, {});
  assert.equal(helpLinks(view).length, 0);
});

test('Norwegian app locale: the link goes to /nb/help with the Norwegian label', async (t) => {
  const view = await renderSidebar(t, { supportVisible: true, locale: 'nb', messages: nb });
  const links = helpLinks(view);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/nb/help');
  assert.equal(links[0].textContent.trim(), nb.sidebar.navHelp);
});

test('every locale has a non-empty navHelp label with no literal "<"', async () => {
  for (const l of ['en', 'nb', 'es', 'fr', 'zh']) {
    const m = (await import(`../../messages/${l}/dashboardChrome.json`, { with: { type: 'json' } })).default;
    for (const v of [m.sidebar.navHelp, m.connect.errorContactSupport]) {
      assert.equal(typeof v === 'string' && v.trim().length > 0, true, `${l} label present`);
      assert.equal(v.includes('<'), false, `${l} label has no "<"`);
    }
  }
});
