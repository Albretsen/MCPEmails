// ---------------------------------------------------------------------------
// An inbox whose password the mail server refused, on the dashboard.
//
// Run with: npm run test:inbox-health-ui
//
// Such a row stays `status = 'active'` with the login-refused marker in
// `last_error` (supabase/functions/mcp-server/inbox-health.ts). The mcp-server
// tells AI clients it needs reconnecting; the Inboxes page used to show a
// green "Connected" and no banner (production, 2026-10-30). Renders the REAL
// dashboard with the real English messages; `fetch` is the only thing replaced.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
// See inbox-cap-offer-ui.test.mjs: next/link needs these two globals in jsdom.
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const WORKSPACE_ID = 'ws-0001';
const MARKER = "The mail server refused this mailbox's password. Reconnect this inbox to restore access. (Checked 2026-10-04T20:04:04.730Z)";

let nextInboxId = 1;
function inbox(address, lastError = null, status = 'active') {
  const id = `ib-${String(nextInboxId++).padStart(4, '0')}`;
  return {
    id,
    label: address.split('@')[0],
    address,
    provider: 'imap',
    service: 'generic',
    status,
    parked: false,
    lastError,
    hasImap: true,
    calls: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
  };
}

async function render(t, inboxes, initialRoute = 'inboxes') {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute,
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID,
        slug: 'acme',
        plan: 'pro',
        compedScale: null,
        displayName: 'Acme',
        isOwner: true,
        draftEditorEnabled: false,
        draftEditorHidden: false,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
      planLimits: { maxInboxes: 10, historyDays: 30 },
      stripePrices: null,
      overviewStats: {},
      activityFeed: [],
      inboxes,
      apiKeys: [],
      usageData: {},
      auditLog: [],
      members: [],
      pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  return view;
}

const text = view => view.container.textContent;
const count = (haystack, needle) => haystack.split(needle).length - 1;
const reconnectButtons = view =>
  [...view.container.querySelectorAll('button')].filter(b => b.textContent.trim() === dashboard.inboxes.reconnect);

test('a refused password reads "Needs reconnect", with the banner and Reconnect', async (t) => {
  const view = await render(t, [inbox('ok@example.com'), inbox('refused@example.com', MARKER)]);
  // Desktop table and mobile card both render each inbox.
  assert.equal(count(text(view), dashboard.inboxes.statusNeedsReconnect), 2);
  assert.equal(count(text(view), dashboard.inboxes.statusConnected), 2, 'only the healthy inbox is Connected');
  assert.equal(count(text(view), dashboard.inboxes.errorBannerOne), 1);
  assert.equal(count(text(view), dashboard.inboxes.errorBannerSupport), 1);
  assert.equal(reconnectButtons(view).length, 2);
  assert.equal(count(text(view), "The mail server refused this mailbox's password."), 2);
  assert.equal(text(view).includes('(Checked'), false, 'no raw timestamp suffix');
});

test('the banner counts refused passwords and error rows together', async (t) => {
  const view = await render(t, [inbox('refused@example.com', MARKER), inbox('broken@example.com', 'invalid_grant', 'error')]);
  const many = dashboard.inboxes.errorBannerMany.replace('{count}', '2');
  assert.equal(count(text(view), many), 1);
  assert.equal(reconnectButtons(view).length, 4);
});

test('healthy inboxes: Connected, no banner, no Reconnect (the checks above can fail)', async (t) => {
  const view = await render(t, [inbox('ok@example.com'), inbox('other@example.com', 'Sent copy failed')]);
  assert.equal(count(text(view), dashboard.inboxes.statusNeedsReconnect), 0);
  assert.equal(count(text(view), dashboard.inboxes.statusConnected), 4);
  assert.equal(count(text(view), dashboard.inboxes.errorBannerSupport), 0);
  assert.equal(reconnectButtons(view).length, 0);
});

test('the detail modal agrees with the row', async (t) => {
  const view = await render(t, [inbox('refused@example.com', MARKER)]);
  const row = view.container.querySelector('tr[role="button"]');
  await flush(() => row.click());
  const modal = view.container.querySelector('.modal');
  assert.equal(Boolean(modal), true);
  const badges = label => [...modal.querySelectorAll('span')].filter(el => el.textContent.trim() === label).length;
  assert.equal(badges(dashboard.inboxes.statusNeedsReconnect) > 0, true);
  assert.equal(badges(dashboard.inboxes.statusConnected), 0);
});

test('Overview does not count a refused password as active', async (t) => {
  const view = await render(t, [inbox('ok@example.com'), inbox('refused@example.com', MARKER)], 'overview');
  const expected = dashboard.overview.activeOfConnected.replace('{active}', '1').replace('{count}', '2');
  assert.equal(count(text(view), expected), 1);
});
