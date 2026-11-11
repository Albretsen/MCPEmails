// ---------------------------------------------------------------------------
// The Business privacy model on the Inboxes page (migration 20261111120000).
//
// Run with: npm run test:inbox-visibility-ui
//
//   - An owner/admin sees other people's private inboxes as metadata rows
//     (address, owner, "Private") whose only action is Disconnect.
//   - The Private / Company-wide control appears in the inbox detail only for
//     an inbox the viewer connected, on Business, and only when the seat
//     switch is on or the workspace has more than one member.
//
// Renders the REAL dashboard with the real English messages; `fetch` is the
// only thing replaced. Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const V = dashboard.inboxes.visibility;

const WORKSPACE_ID = 'ws-0001';
const ME = 'u-0001';

function inbox(id, address, ownerUserId, visibility) {
  return {
    id,
    label: address.split('@')[0],
    address,
    provider: 'imap',
    service: 'imap',
    status: 'active',
    parked: false,
    lastError: null,
    hasImap: true,
    calls: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
    ownerUserId,
    visibility,
  };
}

const MEMBERS = [
  { userId: ME, role: 'owner', email: 'ada@example.com' },
  { userId: 'u-0002', role: 'member', email: 'bob@example.com' },
];

async function render(t, { plan = 'pro', userRole = 'owner', members = MEMBERS, seatSwitch = false, hiddenInboxes = [], inboxes = [], fetchImpl = null }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: ME },
      workspace: {
        id: WORKSPACE_ID,
        slug: 'acme',
        plan,
        compedScale: null,
        displayName: 'Acme',
        isOwner: true,
        draftEditorEnabled: false,
        draftEditorHidden: false,
        hiddenInboxes,
        businessSeatPricing: seatSwitch,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { maxInboxes: null, historyDays: 30 },
      stripePrices: null,
      overviewStats: {},
      activityFeed: [],
      inboxes,
      apiKeys: [],
      usageData: {},
      auditLog: [],
      members,
      pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  return view;
}

const text = view => view.container.textContent;
const HIDDEN = [{ id: 'ib-hidden', address: 'bob@example.com', label: 'bob', provider: 'imap', status: 'active', parked: false, ownerName: 'Bob' }];

test("owner/admin: someone else's private inbox is a metadata row with only Disconnect", async (t) => {
  const view = await render(t, { hiddenInboxes: HIDDEN, inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  assert.ok(text(view).includes(V.othersTitle));
  assert.ok(text(view).includes('bob@example.com'));
  assert.ok(text(view).includes(V.ownedBy.replace('{name}', 'Bob')));
  const section = [...view.container.querySelectorAll('.approvals-decided')].find(n => n.textContent.includes(V.othersTitle));
  const buttons = [...section.querySelectorAll('button')];
  assert.equal(buttons.length, 1, 'Disconnect is the only action');
  assert.equal(buttons[0].getAttribute('aria-label'), dashboard.inboxes.disconnectInbox);
});

test('disconnecting a hidden inbox calls DELETE and drops the row', async (t) => {
  const calls = [];
  const view = await render(t, {
    hiddenInboxes: HIDDEN,
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
  });
  const section = [...view.container.querySelectorAll('.approvals-decided')].find(n => n.textContent.includes(V.othersTitle));
  section.querySelector('button').click();
  await flush();
  const confirm = [...view.container.querySelectorAll('.modal button')].find(b => /disconnect/i.test(b.textContent));
  confirm.click();
  await waitFor(() => calls.includes('DELETE /api/inboxes/ib-hidden'));
  await waitFor(() => !text(view).includes(V.othersTitle));
});

test('no hidden inboxes, no section', async (t) => {
  const view = await render(t, { inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  assert.equal(text(view).includes(V.othersTitle), false);
});

async function openDetail(view, label) {
  const row = [...view.container.querySelectorAll('tr[role="button"]')].find(r => r.textContent.includes(label));
  row.click();
  await flush();
}
const visibilitySelect = view => view.container.querySelector(`select[aria-label="${V.label}"]`);

test('the Private / Company-wide control shows for my own inbox on Business with more than one member', async (t) => {
  const view = await render(t, { inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  await openDetail(view, 'ada');
  const select = visibilitySelect(view);
  assert.ok(select, 'control shown');
  assert.equal(select.value, 'private');
  assert.ok(text(view).includes(V.privateHint));
});

test('the control is hidden for an inbox someone else owns, off Business, and on a one-member Business without the switch', async (t) => {
  const others = await render(t, { inboxes: [inbox('ib-1', 'bob@example.com', 'u-0002', 'company')] });
  await openDetail(others, 'bob');
  assert.equal(visibilitySelect(others), null, 'not the owner');
  await others.unmount();

  const solo = await render(t, { plan: 'solo', inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  await openDetail(solo, 'ada');
  assert.equal(visibilitySelect(solo), null, 'not Business');
  await solo.unmount();

  const single = await render(t, { members: [MEMBERS[0]], inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  await openDetail(single, 'ada');
  assert.equal(visibilitySelect(single), null, 'one member, switch off');
  await single.unmount();

  const switched = await render(t, { members: [MEMBERS[0]], seatSwitch: true, inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')] });
  await openDetail(switched, 'ada');
  assert.ok(visibilitySelect(switched), 'one member, switch on');
});

test('changing it PATCHes the visibility route; a refusal is one line and the value reverts', async (t) => {
  const calls = [];
  let answer = { ok: true, status: 200, json: async () => ({ visibility: 'company' }) };
  const view = await render(t, {
    inboxes: [inbox('ib-1', 'ada@example.com', ME, 'private')],
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return answer;
    },
  });
  await openDetail(view, 'ada');
  const select = visibilitySelect(view);
  select.value = 'company';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => text(view).includes(V.companyHint));
  const patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.url, '/api/inboxes/ib-1/visibility');
  assert.deepEqual(JSON.parse(patch.body), { visibility: 'company' });

  answer = { ok: false, status: 403, json: async () => ({ error: 'no' }) };
  const again = visibilitySelect(view);
  again.value = 'private';
  again.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => text(view).includes(V.saveError));
  assert.equal(visibilitySelect(view).value, 'company');
});
