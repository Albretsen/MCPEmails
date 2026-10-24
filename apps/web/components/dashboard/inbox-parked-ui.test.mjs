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
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

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

async function renderInboxes(t, { active = [], parked = [], maxInboxes = 1, userRole = 'owner', fetchImpl = null }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) }));
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
      userRole,
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

// ── "Make active": the one swap a day ────────────────────────────────────────

const makeActiveButtons = view =>
  [...view.container.querySelectorAll('button')].filter(b => b.textContent.trim() === dashboard.inboxes.makeActive);

test('owners see Make active on parked rows only; members and viewers do not', async (t) => {
  const owner = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'] });
  assert.equal(makeActiveButtons(owner).length, 2, 'desktop row and mobile card');
  await owner.unmount();
  for (const userRole of ['member', 'viewer']) {
    const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'], userRole });
    assert.equal(makeActiveButtons(view).length, 0, userRole);
    await view.unmount();
  }
});

test('at the cap the dialog asks which inbox to park, posts the pair, and the rows swap', async (t) => {
  const calls = [];
  let activeId = null;
  let parkedId = null;
  const fetchImpl = async (url, init) => {
    if (url === '/api/inboxes/swap-parked') {
      const body = JSON.parse(init.body);
      calls.push(body);
      return { ok: true, status: 200, json: async () => ({ active: [body.parkedInboxId], parked: [body.activeInboxId], next_swap_at: '2026-10-25T10:00:00.000Z' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'], fetchImpl });
  await flush(() => makeActiveButtons(view)[0].click());
  const select = view.container.querySelector('[data-testid="swap-pick"]');
  assert.ok(select, 'the pick is shown at the cap');
  activeId = select.value;
  const confirm = [...view.container.querySelectorAll('.modal button')].find(b => b.textContent.trim() === dashboard.inboxes.swapDialog.confirm);
  await flush(() => confirm.click());
  await waitFor(() => calls.length === 1, { message: 'the swap request' });
  parkedId = calls[0].parkedInboxId;
  assert.equal(calls[0].activeInboxId, activeId);
  assert.notEqual(parkedId, activeId);
  await waitFor(() => !view.container.querySelector('.modal'), { message: 'the dialog to close' });
  const parkedRows = [...view.container.querySelectorAll('.inbox-row-parked')].map(row => row.textContent);
  assert.ok(parkedRows.every(row => row.includes('one@example.com')), 'one@ is parked now');
  assert.ok(parkedRows.length > 0);
});

test('a second swap the same day shows one line and keeps the dialog open', async (t) => {
  const fetchImpl = async (url) => (url === '/api/inboxes/swap-parked'
    ? { ok: false, status: 429, json: async () => ({ error: 'swap_limit', next_swap_at: '2026-10-25T10:00:00.000Z' }) }
    : { ok: true, status: 200, json: async () => ({}) });
  const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'], fetchImpl });
  await flush(() => makeActiveButtons(view)[0].click());
  const confirm = [...view.container.querySelectorAll('.modal button')].find(b => b.textContent.trim() === dashboard.inboxes.swapDialog.confirm);
  await flush(() => confirm.click());
  const error = await waitFor(() => view.container.querySelector('[data-testid="swap-error"]'), { message: 'the error line' });
  assert.ok(error.textContent.startsWith(dashboard.inboxes.swapDialog.errorLimit.split('{time}')[0]));
  assert.ok(view.container.querySelector('.modal'), 'still open');
});

test('with a free slot there is nothing to pick', async (t) => {
  const view = await renderInboxes(t, { active: ['one@example.com'], parked: ['two@example.com'], maxInboxes: 3 });
  await flush(() => makeActiveButtons(view)[0].click());
  assert.ok(view.container.querySelector('.modal'));
  assert.equal(view.container.querySelectorAll('[data-testid="swap-pick"]').length, 0);
});
