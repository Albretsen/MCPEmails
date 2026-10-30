// ---------------------------------------------------------------------------
// Sidebar: the "Help & support" item.
//
// Run with: npm run test:support-ui
//
// Help & support is internal-only. The dashboard page decides that once
// (`supportVisibleTo`, SUPPORT_RELEASE_GATE) and hands the Sidebar a boolean.
// This pins the Sidebar's half: the item exists iff `supportVisible` is true,
// and it is a dashboard section like the others: a real link to
// /dashboard/help (no locale prefix, the dashboard is not under [locale]) that
// a plain click turns into `setRoute('help')`, marked active on that route.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

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
const { DASHBOARD_SECTIONS, pathSegmentToSection, sectionToPath } = await import('./routes.js');
const en = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const nb = (await import('../../messages/nb/dashboardChrome.json', { with: { type: 'json' } })).default;

async function renderSidebar(t, { supportVisible, locale = 'en', messages = en, route = 'overview', setRoute = () => {} }) {
  const props = {
    route,
    setRoute,
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

test('supportVisible: one "Help & support" nav item to /dashboard/help', async (t) => {
  const view = await renderSidebar(t, { supportVisible: true });
  const links = helpLinks(view);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/dashboard/help');
  assert.equal(links[0].textContent.trim(), en.sidebar.navHelp);
  assert.equal(links[0].classList.contains('nav-item'), true);
  assert.equal(links[0].classList.contains('active'), false);
  assert.equal(view.container.querySelector('nav.nav').contains(links[0]), true, 'it is in the nav');
});

test('a plain click switches to the help section in place', async (t) => {
  const routes = [];
  const view = await renderSidebar(t, { supportVisible: true, setRoute: (r) => routes.push(r) });
  const link = helpLinks(view)[0];
  // Read on the document, after React's root listener has run.
  let prevented = null;
  const onClick = (e) => { prevented = e.defaultPrevented; };
  document.addEventListener('click', onClick);
  t.after(() => document.removeEventListener('click', onClick));
  await flush(() => link.click());
  assert.equal(routes.join(','), 'help');
  assert.equal(prevented, true, 'no full navigation');
});

test('on the help route the item is active and marked as the current page', async (t) => {
  const view = await renderSidebar(t, { supportVisible: true, route: 'help' });
  const link = helpLinks(view)[0];
  assert.equal(link.classList.contains('active'), true);
  assert.equal(link.getAttribute('aria-current'), 'page');
  assert.equal(view.container.querySelectorAll('.nav-item.active').length, 1);
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

test('Norwegian app locale: same dashboard path, Norwegian label', async (t) => {
  const view = await renderSidebar(t, { supportVisible: true, locale: 'nb', messages: nb });
  const links = helpLinks(view);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/dashboard/help');
  assert.equal(links[0].textContent.trim(), nb.sidebar.navHelp);
});

test('help is a dashboard section', () => {
  assert.equal(DASHBOARD_SECTIONS.includes('help'), true);
  assert.equal(pathSegmentToSection('help'), 'help');
  assert.equal(sectionToPath('help'), '/dashboard/help');
});

test('every locale has a non-empty navHelp label with no literal "<"', async () => {
  for (const l of ['en', 'nb', 'es', 'fr', 'zh', 'de']) {
    const m = (await import(`../../messages/${l}/dashboardChrome.json`, { with: { type: 'json' } })).default;
    for (const v of [m.sidebar.navHelp, m.connect.errorContactSupport, m.help.loading, m.help.loadError]) {
      assert.equal(typeof v === 'string' && v.trim().length > 0, true, `${l} label present`);
      assert.equal(v.includes('<'), false, `${l} label has no "<"`);
    }
  }
});
