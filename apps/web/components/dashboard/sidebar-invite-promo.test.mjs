// ---------------------------------------------------------------------------
// Sidebar: the referral entry ("Invite a friend / Give a month, get a month").
//
// Run with: npm run test:sidebar-invite
//
// While the program is on for the workspace (`referralVisible`) there is
// exactly one Invite entry, pinned above the account footer rather than in
// the workspace list. A plain click switches to the Invite page in place, and
// it is active there. Off, there is none.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { NextIntlClientProvider } = await import('next-intl');
const { Sidebar } = await import('./Sidebar.jsx');
const en = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

async function renderSidebar(t, { route = 'overview', setRoute = () => {}, referralVisible = true } = {}) {
  const view = await mount(
    createElement(NextIntlClientProvider, { locale: 'en', messages: { dashboardChrome: en } },
      createElement(Sidebar, {
        route,
        setRoute,
        counts: { inboxes: 1, keys: 1, members: 1 },
        user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A' },
        workspace: { id: 'ws-0001', slug: 'acme', plan: 'solo', displayName: 'Acme' },
        workspaces: [],
        activeWorkspaceId: 'ws-0001',
        referralVisible,
        isOpen: false,
        onClose: () => {},
      })),
  );
  t.after(() => view.unmount());
  return view;
}

const inviteLinks = (view) =>
  [...view.container.querySelectorAll('a')].filter((a) => /\/invite$/.test(a.getAttribute('href') ?? ''));

test('program on: one Invite entry, above the account footer, with the promo line', async (t) => {
  const view = await renderSidebar(t);
  const links = inviteLinks(view);
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '/dashboard/invite');
  assert.equal(links[0].textContent.includes(en.sidebar.navInvite), true);
  assert.equal(links[0].textContent.includes(en.sidebar.invitePromo), true);
  assert.equal(view.container.querySelector('nav.nav').contains(links[0]), false, 'not buried in the nav list');
  assert.equal(links[0].nextElementSibling?.classList.contains('footer-user'), true, 'right above the account footer');
});

test('a plain click opens the Invite page in place, where it is active', async (t) => {
  const routes = [];
  const view = await renderSidebar(t, { setRoute: (r) => routes.push(r) });
  await flush(() => inviteLinks(view)[0].click());
  assert.equal(routes.join(','), 'invite');

  const onInvite = await renderSidebar(t, { route: 'invite' });
  const link = inviteLinks(onInvite)[0];
  assert.equal(link.classList.contains('active'), true);
  assert.equal(link.getAttribute('aria-current'), 'page');
});

test('program off: no Invite entry', async (t) => {
  const view = await renderSidebar(t, { referralVisible: false });
  assert.equal(inviteLinks(view).length, 0);
});

test('every locale has the promo line, without < or an em dash', async () => {
  for (const l of ['en', 'nb', 'es', 'fr', 'de', 'pt', 'ja', 'zh']) {
    const m = (await import(`../../messages/${l}/dashboardChrome.json`, { with: { type: 'json' } })).default;
    const v = m.sidebar.invitePromo;
    assert.equal(typeof v === 'string' && v.trim().length > 0, true, `${l} present`);
    assert.equal(v.includes('<'), false, `${l} no <`);
    assert.equal(v.includes('—'), false, `${l} no em dash`);
  }
});
