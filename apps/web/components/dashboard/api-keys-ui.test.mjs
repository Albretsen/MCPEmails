// ---------------------------------------------------------------------------
// Keys page: Edit and Revoke are offered only where the server will allow them.
//
// Run with: npm run test:api-keys-ui
//
// PATCH /api/api-keys/[id] and /revoke now refuse a member or viewer acting on
// somebody else's key, and cap a viewer's key to read-only scopes whoever edits
// it. A dashboard that still showed those buttons would answer a click with a
// 403 toast. This renders the REAL DashboardApp (real en messages) on the keys
// route and checks what each role is offered. `fetch` is stubbed and recorded.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const WS = 'ws-0001';
const ME = 'u-me';
const OTHER = 'u-other';
const VIEWER_ID = 'u-viewer';

function apiKey(id, createdBy, scopes = ['read:email']) {
  return {
    id, name: `Key ${id}`, keyPrefix: 'abcd1234', scopes, inboxIds: null, createdBy,
    createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null, expiresAt: null,
  };
}

const MEMBERS = [
  { userId: ME, role: 'member', email: 'me@acme.test', displayName: 'Me' },
  { userId: OTHER, role: 'member', email: 'other@acme.test', displayName: 'Other' },
  { userId: VIEWER_ID, role: 'viewer', email: 'viewer@acme.test', displayName: 'Viewer' },
];

async function renderKeys(t, { userRole, userId = ME, keys }) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'keys',
      user: { displayName: 'Me', email: 'me@acme.test', initials: 'M', id: userId },
      workspace: { id: WS, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: userRole === 'owner' },
      workspaces: [],
      activeWorkspaceId: WS,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { inboxes: 10, members: 5 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: [],
      apiKeys: keys,
      usageData: {},
      auditLog: [],
      members: MEMBERS,
      pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  return { ...view, requests };
}

/** The table row for a key, found by its name cell. */
function row(view, id) {
  return [...view.container.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(`Key ${id}`));
}
const buttons = (tr) => [...tr.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean);

test('a member sees Edit and Revoke on their own key, and a note instead on someone else\'s', async (t) => {
  const view = await renderKeys(t, { userRole: 'member', keys: [apiKey('mine', ME), apiKey('theirs', OTHER)] });
  const mine = row(view, 'mine');
  const theirs = row(view, 'theirs');
  assert.deepEqual(buttons(mine).filter(b => b !== ''), [en.apiKeys.editAccess, en.apiKeys.revoke]);
  assert.deepEqual(buttons(theirs), [], 'no Edit/Revoke offered on another member\'s key');
  assert.ok(theirs.querySelector('[data-testid="key-not-yours"]'));
  assert.ok(theirs.textContent.includes(en.apiKeys.notYours));
});

test('a viewer may still revoke their own key but not the owner\'s', async (t) => {
  const view = await renderKeys(t, { userRole: 'viewer', userId: VIEWER_ID, keys: [apiKey('v', VIEWER_ID), apiKey('o', OTHER)] });
  assert.ok(buttons(row(view, 'v')).includes(en.apiKeys.revoke));
  assert.deepEqual(buttons(row(view, 'o')), []);
});

test('an admin sees Edit and Revoke on every key, including a legacy key with no creator', async (t) => {
  const view = await renderKeys(t, { userRole: 'admin', keys: [apiKey('a', OTHER), apiKey('b', null)] });
  for (const id of ['a', 'b']) {
    assert.ok(buttons(row(view, id)).includes(en.apiKeys.editAccess), id);
    assert.ok(buttons(row(view, id)).includes(en.apiKeys.revoke), id);
  }
  assert.equal(view.container.querySelector('[data-testid="key-not-yours"]'), null);
});

test('editing a viewer\'s key as an admin: write scopes are locked and the reason is stated', async (t) => {
  const view = await renderKeys(t, { userRole: 'admin', keys: [apiKey('vk', VIEWER_ID, ['read:email'])] });
  const edit = [...row(view, 'vk').querySelectorAll('button')].find(b => b.textContent.includes(en.apiKeys.editAccess));
  await flush(async () => { edit.click(); });

  const dialog = view.container.querySelector('[role="dialog"]');
  assert.ok(dialog, 'the edit modal opened');
  assert.ok(dialog.textContent.includes(en.apiKeys.editModal.viewerCapNote));
  const box = (scope) => [...dialog.querySelectorAll('label')].find(l => l.textContent.includes(scope)).querySelector('input');
  assert.equal(box('send:email').disabled, true);
  assert.equal(box('delete:email').disabled, true);
  assert.equal(box('search:email').disabled, false, 'read-only scopes stay selectable');
  assert.equal(box('read:email').disabled, false);
});

test('editing a member\'s key as an admin: nothing is locked and no note is shown', async (t) => {
  const view = await renderKeys(t, { userRole: 'admin', keys: [apiKey('mk', OTHER, ['read:email'])] });
  const edit = [...row(view, 'mk').querySelectorAll('button')].find(b => b.textContent.includes(en.apiKeys.editAccess));
  await flush(async () => { edit.click(); });
  const dialog = view.container.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('[data-testid="scope-cap-note"]'), null);
  assert.equal([...dialog.querySelectorAll('input[type="checkbox"]')].some(i => i.disabled), false);
});

test('a key whose creator has left may keep its write scope but not gain another', async (t) => {
  const view = await renderKeys(t, { userRole: 'owner', keys: [apiKey('gone', 'u-gone', ['read:email', 'send:email'])] });
  const edit = [...row(view, 'gone').querySelectorAll('button')].find(b => b.textContent.includes(en.apiKeys.editAccess));
  await flush(async () => { edit.click(); });
  const dialog = view.container.querySelector('[role="dialog"]');
  assert.ok(dialog.textContent.includes(en.apiKeys.editModal.noWidenNote));
  const box = (scope) => [...dialog.querySelectorAll('label')].find(l => l.textContent.includes(scope)).querySelector('input');
  assert.equal(box('send:email').disabled, false, 'a held scope can still be unticked');
  assert.equal(box('delete:email').disabled, true);
});
