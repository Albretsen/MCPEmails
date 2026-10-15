// ---------------------------------------------------------------------------
// The dashboard, arriving from a provider landing page.
//
// Run with: npm run test:connect-preselect-ui
//
// A visitor presses "Connect IONOS free" on /connect/ionos, signs up or signs
// in, and lands on /dashboard carrying `?provider=ionos` and/or a record in
// browser storage (src/lib/connect/intent-carry.mjs). This renders the real
// DashboardApp and the real ConnectModal and pins what that hint does:
//
//   - the connect modal opens with that provider's card selected and, for a
//     provider on the generic form, the landing page's server settings in the
//     fields;
//   - the hint is spent the moment it is read: gone from the address bar, gone
//     from storage, and absent the next time the modal is opened;
//   - an unknown, unreleased or unsupported provider does nothing at all;
//   - a hint never opens the upgrade panel on a workspace at its inbox cap;
//   - with no hint the dashboard does not open a modal.
//
// The unit tests in src/lib/connect/intent.test.mjs cover the rules. These
// cover the wiring: an initial-state prop read one render too late, or a
// storage record cleared after the modal instead of before, is invisible to a
// test that imports the helpers directly.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The shared next/navigation stub reports empty search params, which is right
// for every other suite and wrong for this one: `firstrun` is read through
// `useSearchParams`, and the first-run path is half of what is under test. So
// here, and only here, it reports what the address bar actually holds when the
// dashboard mounts.
const navigationStub = new URL('../../scripts/test-stubs/next-navigation.mjs', import.meta.url).href;
const navigation = await import(navigationStub);
let searchAtMount = '';
mock.module(navigationStub, {
  namedExports: { ...navigation, useSearchParams: () => new URLSearchParams(searchAtMount) },
});

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const { CONNECT_INTENT_KEY, rememberConnectIntent } = await import('../../src/lib/connect/intent-carry.mjs');
const { MODAL_CARD_BY_SLUG, GENERIC_CARD } = await import('../../src/lib/connect/intent.mjs');
const { getProvider } = await import('../../src/lib/connect/providers.mjs');
const { IMAP_PRESETS } = await import('../../src/lib/email-providers/imap-presets.ts');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const WORKSPACE_ID = 'ws-0001';

function inbox(address, index) {
  return {
    id: `ib-${index}`,
    label: address.split('@')[0],
    address,
    provider: 'imap',
    service: 'imap',
    status: 'active',
    lastError: null,
    hasImap: true,
    calls: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
  };
}

/**
 * Mount the dashboard as it loads at `url`, with `stored` already remembered.
 * `maxInboxes: null` is an uncapped workspace.
 */
async function renderDashboard(t, { url = '/dashboard', stored = null, addresses = [], maxInboxes = null } = {}) {
  window.localStorage.clear();
  window.history.replaceState({}, '', url);
  searchAtMount = window.location.search;
  if (stored) rememberConnectIntent(window.localStorage, stored);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@gmail.com', initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID, slug: 'acme', plan: 'free', compedScale: null, displayName: 'Acme',
        isOwner: true, draftEditorEnabled: false, draftEditorHidden: false,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
      planLimits: { maxInboxes, historyDays: 30 },
      stripePrices: null,
      overviewStats: {},
      activityFeed: [],
      inboxes: addresses.map(inbox),
      apiKeys: [],
      usageData: {},
      auditLog: [],
      members: [],
      pendingInvites: [],
    })));

  // Several tests mount more than once and unmount as they go.
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await view.unmount(); } };
  t.after(async () => {
    await unmount();
    globalThis.fetch = previousFetch;
    window.localStorage.clear();
    window.history.replaceState({}, '', '/dashboard');
  });
  return { ...view, unmount };
}

const modalOf = (view) => view.container.querySelector('[role="dialog"]');
const checkedCard = (view) => modalOf(view)?.querySelector('.provider-chip[aria-checked="true"] .pn')?.textContent ?? null;
const field = (view, id) => modalOf(view)?.querySelector(`#${id}`)?.value ?? null;

async function click(node) {
  await flush(async () => { node.click(); });
}

/** Long enough for the on-demand registry import to have settled either way. */
async function settle() {
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
}

async function waitForModal(view) {
  return waitFor(() => modalOf(view), { message: 'the connect modal to open' });
}

async function continueToForm(view) {
  const button = [...modalOf(view).querySelectorAll('button')]
    .find((b) => b.textContent.includes(chrome.connect.enterCredentials));
  assert.ok(button, 'step 1 should have its primary button');
  await click(button);
}

async function closeModal(view) {
  const close = modalOf(view).querySelector(`button[aria-label="${chrome.connect.close}"]`);
  assert.ok(close, 'the modal should have a close button');
  await click(close);
  await waitFor(() => !modalOf(view), { message: 'the connect modal to close' });
}

async function openFromPage(view) {
  const button = [...view.container.querySelectorAll('button')]
    .find((b) => b.textContent.includes(dashboard.inboxes.connectInbox));
  assert.ok(button, 'the Inboxes page should have its connect button');
  await click(button);
  await waitForModal(view);
}

test('a hint in the link opens the modal on the generic form with the provider settings filled in', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard?firstrun=1&provider=ionos' });
  await waitForModal(view);

  assert.equal(checkedCard(view), 'IMAP / SMTP');
  await continueToForm(view);

  const ionos = getProvider('ionos');
  assert.equal(field(view, 'cm-imap-host'), ionos.imap.host);
  assert.equal(field(view, 'cm-smtp-host'), ionos.smtp.host);
  assert.equal(field(view, 'cm-imap-port'), String(ionos.imap.port));
  assert.equal(field(view, 'cm-smtp-port'), String(ionos.smtp.port));
  // The same note the modal shows when it recognises a typed address.
  assert.equal(
    modalOf(view).querySelector('#cm-email-detected')?.textContent,
    chrome.connect.hostPrefillNote.replace('{provider}', 'IONOS'),
  );
  // Prefilled, not locked: it is still the person's form.
  assert.equal(modalOf(view).querySelector('#cm-imap-host').readOnly, false);
  assert.equal(field(view, 'cm-email'), '');
});

test('the hint is spent on arrival: gone from the address bar and from storage', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard?firstrun=1&provider=ionos', stored: 'gmx' });
  // Before anything is shown, not when the modal closes.
  assert.equal(window.location.search, '?firstrun=1');
  assert.equal(window.localStorage.getItem(CONNECT_INTENT_KEY), null);
  await waitForModal(view);
  // The link won over the stored record.
  await continueToForm(view);
  assert.equal(field(view, 'cm-imap-host'), getProvider('ionos').imap.host);
});

test('a hint held only in storage does the same, with a clean address bar', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard', stored: 'yahoo' });
  await waitForModal(view);
  assert.equal(checkedCard(view), IMAP_PRESETS.yahoo.label);
  assert.equal(window.localStorage.getItem(CONNECT_INTENT_KEY), null);
  assert.equal(window.location.search, '');
});

test('after a dismissal the next opening of the modal is the ordinary one', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard?provider=yahoo' });
  await waitForModal(view);
  assert.equal(checkedCard(view), IMAP_PRESETS.yahoo.label);

  await closeModal(view);
  await openFromPage(view);
  assert.equal(checkedCard(view), 'IMAP / SMTP');
  await continueToForm(view);
  assert.equal(field(view, 'cm-imap-host'), '');
  assert.equal(modalOf(view).querySelector('#cm-email-detected'), null);
});

test('Gmail and Outlook open on their own cards', async (t) => {
  for (const [slug, label] of [['gmail', 'Gmail'], ['google-workspace', 'Gmail'], ['outlook', 'Outlook'], ['office365', 'Outlook']]) {
    const view = await renderDashboard(t, { url: `/dashboard?provider=${slug}` });
    await waitForModal(view);
    assert.equal(checkedCard(view), label, slug);
    await view.unmount();
  }
});

test('every card the registry can name is a card the modal has', async (t) => {
  // Read off the real modal rather than a list kept beside the map.
  const view = await renderDashboard(t, { url: '/dashboard?provider=imap' });
  await waitForModal(view);
  const labels = [...modalOf(view).querySelectorAll('.provider-chip .pn')].map((n) => n.textContent);
  const labelOf = (card) => {
    if (card === GENERIC_CARD) return 'IMAP / SMTP';
    if (card === 'fastmail') return 'Fastmail';
    if (card === 'outlook') return 'Outlook';
    return IMAP_PRESETS[card]?.label;
  };
  for (const [slug, card] of Object.entries(MODAL_CARD_BY_SLUG)) {
    const label = labelOf(card);
    assert.ok(label, `${slug} maps to "${card}", which is not a modal card`);
    assert.ok(labels.includes(label), `${slug} maps to "${card}" (${label}), which the modal does not render`);
  }
  // And the keys, against the modal's own source: `k` is what `preselect.card`
  // is compared with.
  const source = readFileSync(new URL('./ConnectModal.jsx', import.meta.url), 'utf8');
  for (const literal of [GENERIC_CARD, 'fastmail', 'outlook']) {
    assert.ok(source.includes(`{ k: '${literal}',`), `ConnectModal no longer has a '${literal}' card`);
  }
  assert.ok(source.includes('...Object.values(IMAP_PRESETS).map(p => ({\n    k: p.service,'));
});

test('an unknown, unreleased or unsupported provider changes nothing and is still spent', async (t) => {
  for (const slug of ['not-a-provider', 'startmail', 'hey', 'proton', 'tutanota']) {
    const view = await renderDashboard(t, { url: `/dashboard?provider=${slug}`, stored: slug });
    await settle();
    assert.equal(modalOf(view), null, `${slug} opened the modal`);
    assert.equal(window.location.search, '', slug);
    assert.equal(window.localStorage.getItem(CONNECT_INTENT_KEY), null, slug);
    await view.unmount();
  }
});

test('on a first run an unusable hint still gets the ordinary first-run modal', async (t) => {
  for (const slug of ['not-a-provider', 'proton', 'startmail']) {
    const view = await renderDashboard(t, { url: `/dashboard?firstrun=1&provider=${slug}` });
    await waitForModal(view);
    assert.equal(checkedCard(view), 'IMAP / SMTP', slug);
    await continueToForm(view);
    assert.equal(field(view, 'cm-imap-host'), '', slug);
    assert.equal(modalOf(view).querySelector('#cm-email-detected'), null, slug);
    assert.equal(window.location.search, '?firstrun=1', slug);
    await view.unmount();
  }
});

test('a first run with no hint is what it always was: the plain modal, after the welcome delay', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard?firstrun=1' });
  assert.equal(modalOf(view), null, 'the modal must not open before the welcome delay');
  await waitForModal(view);
  assert.equal(checkedCard(view), 'IMAP / SMTP');
  await continueToForm(view);
  assert.equal(field(view, 'cm-imap-host'), '');
  assert.equal(field(view, 'cm-smtp-host'), '');
  assert.equal(window.location.search, '?firstrun=1');
});

test('a hint never opens the upgrade panel on a workspace at its inbox cap', async (t) => {
  const view = await renderDashboard(t, {
    url: '/dashboard?provider=ionos',
    addresses: ['ada@gmail.com'],
    maxInboxes: 1,
  });
  await settle();
  assert.equal(modalOf(view), null);
  assert.equal(window.location.search, '');
});

test('with no hint the dashboard opens no modal and touches nothing', async (t) => {
  const view = await renderDashboard(t, { url: '/dashboard/inboxes?ref=nav' });
  await settle();
  assert.equal(modalOf(view), null);
  assert.equal(window.location.pathname + window.location.search, '/dashboard/inboxes?ref=nav');
});

test('a reconnect ignores a preselect entirely', () => {
  const source = readFileSync(new URL('./ConnectModal.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('const seed = !isReconnect && preselect && PROVIDERS.some(p => p.k === preselect.card)'));
  const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  assert.ok(app.includes('preselect={reconnectInbox == null ? connectPreselect : null}'));
});
