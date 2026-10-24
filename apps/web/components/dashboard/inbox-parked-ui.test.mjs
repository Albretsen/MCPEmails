// ---------------------------------------------------------------------------
// Parked inboxes on the Inboxes page (src/lib/billing/parking.ts).
//
// Run with: npm run test:inbox-parked-ui
//
// A parked inbox is listed, greyed, with a "Parked" badge and one line, and it
// does not hold a slot under the plan's inbox cap: the page counts only active
// inboxes, as the server's checkInboxLimit does. Renders the REAL dashboard
// with the real English messages; `fetch` is the only thing replaced.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

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

let nextInboxId = 1;
function inbox(address, parked) {
  const id = `ib-${String(nextInboxId++).padStart(4, '0')}`;
  return {
    id,
    label: address.split('@')[0],
    address,
    provider: 'imap',
    service: 'imap',
    status: 'active',
    parked,
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

async function renderInboxes(t, { active = [], parked = [], maxInboxes = 1 }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID,
        slug: 'acme',
        plan: 'free',
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
      planLimits: { maxInboxes, historyDays: 30 },
      stripePrices: null,
      overviewStats: {},
      activityFeed: [],
      inboxes: [...active.map(a => inbox(a, false)), ...parked.map(a => inbox(a, true))],
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
const capNoticeShown = view => view.container.querySelectorAll('a[data-cap-offer-plan]').length > 0;

test('a parked inbox is listed greyed, with the Parked badge and the one line', async (t) => {
  const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com', 'three@example.com'] });
  // Desktop table and mobile card both render; two parked inboxes, twice each.
  assert.equal(view.container.querySelectorAll('.inbox-row-parked').length, 4);
  assert.equal(count(text(view), dashboard.inboxes.parkedNote), 4);
  assert.ok(text(view).includes('two@example.com'), 'the parked inbox is still listed');
});

test('the header counts only active inboxes', async (t) => {
  const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com', 'three@example.com'] });
  const expected = dashboard.inboxes.subWithCountSingular.replace('{count}', '1').replace('{max}', '1');
  assert.ok(text(view).includes(expected.split(' · ')[0]), 'reads 1 of 1, not 3 of 1');
});

test('parked inboxes do not hold the slot: no cap notice when only parked ones remain', async (t) => {
  const onlyParked = await renderInboxes(t, { parked: ['two@example.com', 'three@example.com'] });
  assert.equal(capNoticeShown(onlyParked), false);
});

test('an active inbox at the cap still shows the cap notice (the check above can fail)', async (t) => {
  const atCap = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'] });
  assert.equal(capNoticeShown(atCap), true);
});

test('no parked inbox, no parked line', async (t) => {
  const view = await renderInboxes(t, { active: ['one@example.com'] });
  assert.equal(view.container.querySelectorAll('.inbox-row-parked').length, 0);
  assert.equal(count(text(view), dashboard.inboxes.parkedNote), 0);
});
