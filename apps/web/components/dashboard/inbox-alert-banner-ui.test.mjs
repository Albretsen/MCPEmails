// ---------------------------------------------------------------------------
// The broken-inbox alert banner (BrokenInboxBanner.jsx) on the real dashboard.
//
// Run with: npm run test:inbox-alert-ui
//
// Shown only when the server says the workspace is in the `alert` arm
// (workspace.inboxAlertBanner), on every page but Inboxes, while an inbox needs
// reconnecting. Renders the REAL dashboard with the real English messages;
// `fetch` is the only thing replaced. Only reserved example domains below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const { brokenInboxBannerState } = await import('./BrokenInboxBanner.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

const WORKSPACE_ID = 'ws-0001';
const MARKER = "The mail server refused this mailbox's password. Reconnect this inbox to restore access. (Checked 2026-11-04T20:04:04.730Z)";

let nextInboxId = 1;
function inbox(address, lastError = null, status = 'active', parked = false) {
  const id = `ib-${String(nextInboxId++).padStart(4, '0')}`;
  return {
    id, label: address.split('@')[0], address, provider: 'imap', service: 'generic', status, parked, lastError,
    hasImap: true, calls: 3, createdAt: '2026-09-01T00:00:00.000Z', lastCallAt: null, draftEditorHidden: false,
    sendReviewMode: 'off', sendApprovalRequired: false,
  };
}

async function render(t, { inboxes, banner, route = 'overview', role = 'owner' }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: route,
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID, slug: 'acme', plan: 'personal', compedScale: null, displayName: 'Acme', isOwner: true,
        draftEditorEnabled: false, draftEditorHidden: false, inboxAlertBanner: banner,
      },
      workspaces: [], activeWorkspaceId: WORKSPACE_ID, mcpUrl: 'https://mcpemails.com/api/mcp', userRole: role,
      planLimits: { maxInboxes: 3, historyDays: 90 }, stripePrices: null, overviewStats: {}, activityFeed: [],
      inboxes, apiKeys: [], usageData: {}, auditLog: [], members: [], pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  return view;
}

const banner = (view) => view.container.querySelector('[data-inbox-alert]');
const one = (address) => chrome.app.inboxAlertOne.replace('{address}', address);

test('alert arm: one broken inbox is named on the overview, with Reconnect', async (t) => {
  const view = await render(t, { inboxes: [inbox('ok@example.com'), inbox('refused@example.com', MARKER)], banner: true });
  assert.equal(banner(view)?.getAttribute('data-inbox-alert'), 'one');
  assert.equal(banner(view).textContent.includes(one('refused@example.com')), true);
  assert.equal(banner(view).textContent.includes(chrome.app.inboxAlertReconnect), true);
});

test('alert arm: several broken inboxes are counted', async (t) => {
  const view = await render(t, { inboxes: [inbox('a@example.com', MARKER), inbox('b@example.com', 'invalid_grant', 'error')], banner: true });
  assert.equal(banner(view)?.getAttribute('data-inbox-alert'), 'many');
  assert.equal(banner(view).textContent.includes(chrome.app.inboxAlertMany.replace('{count}', '2')), true);
});

test('holdout or flag off: no banner (the check above can fail)', async (t) => {
  const view = await render(t, { inboxes: [inbox('refused@example.com', MARKER)], banner: false });
  assert.equal(banner(view) === null, true);
});

test('no banner on the Inboxes page, which has its own', async (t) => {
  const view = await render(t, { inboxes: [inbox('refused@example.com', MARKER)], banner: true, route: 'inboxes' });
  assert.equal(banner(view) === null, true);
});

test('decision: healthy, parked and viewer cases', () => {
  const healthy = [inbox('ok@example.com')];
  assert.equal(brokenInboxBannerState({ enabled: true, route: 'overview', userRole: 'owner', inboxes: healthy }), null);
  const parked = [inbox('p@example.com', MARKER, 'active', true)];
  assert.equal(brokenInboxBannerState({ enabled: true, route: 'overview', userRole: 'owner', inboxes: parked }), null);
  const broken = [inbox('r@example.com', MARKER)];
  assert.equal(brokenInboxBannerState({ enabled: true, route: 'overview', userRole: 'viewer', inboxes: broken }), null);
  assert.equal(brokenInboxBannerState({ enabled: true, route: 'keys', userRole: 'admin', inboxes: broken })?.kind, 'one');
});
