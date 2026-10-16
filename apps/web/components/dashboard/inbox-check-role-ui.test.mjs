// ---------------------------------------------------------------------------
// Check connection, Reconnect and Disconnect for a workspace viewer.
//
// Run with: npm run test:inbox-check-role-ui
//
// POST /api/inboxes/[id]/check now answers 403 insufficient_role for a viewer
// (it decrypts the stored credentials and rewrites the inbox status for the
// whole workspace, an operator action; see lib/workspace/roles.ts). The
// dashboard must say so up front rather than offer a button that fails on
// click. This renders the REAL dashboard and asserts, through the DOM and the
// requests it makes, that:
//   - a viewer sees every Check connection control disabled with the reason,
//     and clicking one sends nothing;
//   - the same holds for Reconnect and Disconnect (DELETE /api/inboxes/[id]
//     and the connect routes / OAuth callbacks refuse a viewer too): disabled,
//     the reason as title and as a visible note, and no dialog opens;
//   - an owner/admin/member still gets working buttons: the check POSTs,
//     Disconnect opens its confirmation, Reconnect opens the connect form.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const CHECK = en.inboxes.checkConnection;
const VIEWER_NOTE = en.inboxes.viewerActionsNote;
const RECONNECT = en.inboxes.reconnect;
const DISCONNECT_LABELS = [en.inboxes.disconnectInbox, en.inboxes.detail.disconnect];
const DISCONNECT_TITLE = en.inboxes.disconnectDialog.title;
const WORKSPACE_ID = 'ws-0001';
const INBOX_ID = 'ib-0001';

function inbox(status = 'active') {
  return {
    id: INBOX_ID,
    label: 'work',
    address: 'work@acme.com',
    provider: 'imap',
    service: 'imap',
    status,
    lastError: status === 'error' ? 'The app password was rejected.' : null,
    hasImap: true,
    calls: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
  };
}

async function renderInboxes(t, userRole, status = 'active') {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'active', lastError: null, message: 'Connection is healthy.' }),
    };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: userRole === 'owner', draftEditorEnabled: true, draftEditorHidden: false },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { inboxes: 10, members: 5 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: [inbox(status)],
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
  return {
    ...view,
    requests,
    checks: () => requests.filter(r => r.method === 'POST' && r.url.endsWith('/check')),
  };
}

/** Every control that runs the connection check: table icon, mobile card, detail modal. */
function checkButtons(view) {
  return [...view.container.querySelectorAll('button')].filter(
    b => b.getAttribute('aria-label') === CHECK || b.textContent.trim() === CHECK,
  );
}

/** Reconnect controls: table row and mobile card (status 'error'), detail modal (always). */
function reconnectButtons(view) {
  return [...view.container.querySelectorAll('button')].filter(b => b.textContent.trim() === RECONNECT);
}

/** Disconnect controls: table icon, mobile card, detail modal. */
function disconnectButtons(view) {
  return [...view.container.querySelectorAll('button')].filter(
    b => DISCONNECT_LABELS.includes(b.getAttribute('aria-label')) || DISCONNECT_LABELS.includes(b.textContent.trim()),
  );
}

const dialogCount = view => view.container.ownerDocument.querySelectorAll('[role="dialog"]').length;

async function openDetail(view) {
  const row = view.container.querySelector('tr[role="button"]');
  assert.ok(row, 'the inboxes table has a clickable row');
  await flush(async () => { row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

test('the viewer note exists in every locale', async () => {
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    assert.equal(typeof messages.inboxes.viewerActionsNote, 'string', `${locale} has the note`);
    assert.ok(messages.inboxes.viewerActionsNote.length > 0);
  }
});

test('viewer: every Check connection control is disabled, explains why, and sends nothing', async (t) => {
  const view = await renderInboxes(t, 'viewer');
  await openDetail(view);

  const buttons = checkButtons(view);
  assert.ok(buttons.length >= 2, `expected the row and detail controls, found ${buttons.length}`);
  for (const b of buttons) {
    assert.equal(b.disabled, true, 'a viewer cannot start a check');
    b.click();
  }
  await flush(async () => {});
  assert.equal(view.checks().length, 0, 'no POST /check was sent');

  assert.ok(view.container.textContent.includes(VIEWER_NOTE), 'the reason is shown in the detail modal');
  const titled = buttons.filter(b => b.getAttribute('title') === VIEWER_NOTE);
  assert.ok(titled.length >= 1, 'the disabled buttons carry the reason as their title');
});

for (const role of ['owner', 'admin', 'member']) {
  test(`${role}: Check connection still works and POSTs the check`, async (t) => {
    const view = await renderInboxes(t, role);
    await openDetail(view);

    const buttons = checkButtons(view);
    assert.ok(buttons.length >= 2);
    for (const b of buttons) assert.equal(b.disabled, false, `${role} can start a check`);
    assert.ok(!view.container.textContent.includes(VIEWER_NOTE), 'no viewer note for an operator');

    await flush(async () => { buttons[0].click(); });
    await flush(async () => {});
    const checks = view.checks();
    assert.equal(checks.length, 1, 'one POST /check');
    assert.ok(checks[0].url.endsWith(`/api/inboxes/${INBOX_ID}/check`));
  });
}

test('viewer: Reconnect and Disconnect are disabled everywhere, explain why, and open nothing', async (t) => {
  // status 'error' so the row and mobile card show Reconnect instead of Check.
  const view = await renderInboxes(t, 'viewer', 'error');
  await openDetail(view);

  const reconnect = reconnectButtons(view);
  const disconnect = disconnectButtons(view);
  assert.ok(reconnect.length >= 3, `row, mobile card and detail Reconnect, found ${reconnect.length}`);
  assert.ok(disconnect.length >= 3, `row, mobile card and detail Disconnect, found ${disconnect.length}`);

  const dialogsBefore = dialogCount(view);
  for (const b of [...reconnect, ...disconnect]) {
    assert.equal(b.disabled, true, `a viewer cannot use "${b.textContent.trim() || b.getAttribute('aria-label')}"`);
    assert.equal(b.getAttribute('title'), VIEWER_NOTE, 'the disabled button carries the reason');
    await flush(async () => { b.click(); });
  }
  assert.equal(dialogCount(view), dialogsBefore, 'no confirmation or connect dialog opened');
  assert.ok(!view.container.textContent.includes(DISCONNECT_TITLE), 'the disconnect confirmation never opened');
  assert.equal(view.requests.filter(r => r.method !== 'GET').length, 0, 'nothing was sent');
  assert.ok(view.container.textContent.includes(VIEWER_NOTE), 'the reason is visible in the detail modal');
});

for (const role of ['owner', 'admin', 'member']) {
  test(`${role}: Reconnect and Disconnect still work`, async (t) => {
    const view = await renderInboxes(t, role, 'error');
    await openDetail(view);

    const reconnect = reconnectButtons(view);
    const disconnect = disconnectButtons(view);
    assert.ok(reconnect.length >= 3 && disconnect.length >= 3);
    for (const b of [...reconnect, ...disconnect]) {
      assert.equal(b.disabled, false, `${role} can use "${b.textContent.trim() || b.getAttribute('aria-label')}"`);
      assert.notEqual(b.getAttribute('title'), VIEWER_NOTE);
    }
    assert.ok(!view.container.textContent.includes(VIEWER_NOTE), 'no viewer note for an operator');

    // The table row's Disconnect opens the confirmation dialog.
    const rowDisconnect = disconnect.find(b => b.getAttribute('aria-label') === en.inboxes.disconnectInbox && b.closest('tr'));
    assert.ok(rowDisconnect, 'the table row has a Disconnect icon');
    await flush(async () => { rowDisconnect.click(); });
    assert.ok(view.container.textContent.includes(DISCONNECT_TITLE), 'Disconnect opens its confirmation');
  });

  test(`${role}: Reconnect opens the connect form`, async (t) => {
    const view = await renderInboxes(t, role, 'error');
    const before = dialogCount(view);
    const rowReconnect = reconnectButtons(view).find(b => b.closest('tr'));
    assert.ok(rowReconnect, 'the table row has Reconnect');
    await flush(async () => { rowReconnect.click(); });
    assert.ok(dialogCount(view) > before, 'Reconnect opened the connect form');
  });
}
