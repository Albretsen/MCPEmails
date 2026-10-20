// ---------------------------------------------------------------------------
// Send As addresses in the inbox detail modal.
//
// Run with: npm run test:send-as-ui
//
// Renders the REAL dashboard and the real SendAsEditor against a stubbed
// /api/inboxes/[id]/send-as, and asserts through the DOM and the requests:
//   - an IMAP inbox that can send shows the section; Gmail and a receive-only
//     IMAP inbox do not;
//   - adding an address POSTs action 'add', then shows it waiting for a code;
//   - entering the code POSTs action 'verify' and the row turns Verified;
//   - a refusal shows its own one-line message;
//   - a viewer sees the list with every control disabled and sends nothing;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { useTranslations } from 'next-intl';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const { SendAsEditor } = await import('./Pages.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const S = en.inboxes.detail.sendAs;

const WORKSPACE_ID = 'ws-0001';
const INBOX = {
  id: 'ib-0001',
  label: 'home',
  address: 'primary@icloud.example',
  provider: 'icloud',
  service: 'icloud',
  status: 'active',
  lastError: null,
  hasImap: true,
  connectionMode: 'both',
  calls: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastCallAt: null,
  draftEditorHidden: false,
  sendReviewMode: 'off',
  sendApprovalRequired: false,
};

/** A stub for the send-as route that answers from `state` and records calls. */
function stubFetch(t, state) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (!String(url).includes('/send-as')) return json(200, {});
    if (method === 'GET') return json(200, { aliases: state.aliases });
    if (body?.action === 'add') {
      if (state.refuse) return json(400, { error: state.refuse });
      const alias = { id: 'al-1', email_address: body.email_address, display_name: null, verified: false, code_pending: true };
      state.aliases = [...state.aliases, alias];
      return json(200, { alias });
    }
    if (body?.action === 'verify') {
      if (body.code !== '123456') return json(400, { error: 'wrong_code' });
      const alias = { ...state.aliases.find(a => a.id === body.alias_id), verified: true, code_pending: false };
      return json(200, { alias });
    }
    return json(200, { success: true });
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

function Editor({ inbox, readOnly }) {
  const t = useTranslations('dashboard');
  return createElement(SendAsEditor, { inbox, t, readOnly });
}

async function renderEditor(t, { readOnly = false } = {}) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Editor, { inbox: INBOX, readOnly })));
  t.after(() => view.unmount());
  await waitFor(() => !view.container.textContent.includes(S.loading), { message: 'aliases loaded' });
  return view;
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

const button = (view, text) => [...view.container.querySelectorAll('button')].find(b => b.textContent.trim() === text);

test('every locale has every Send As key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(S).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh', 'de']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const copy = messages.inboxes.detail.sendAs;
    assert.deepEqual(keys(copy).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(copy);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
  }
});

test('add, then verify with the emailed code', async (t) => {
  const state = { aliases: [] };
  const requests = stubFetch(t, state);
  const view = await renderEditor(t);

  await type(view.container.querySelector('input[type="email"]'), 'crackerjack@icloud.example');
  await flush(async () => { button(view, S.add).click(); });
  const row = await waitFor(() => view.container.querySelector('[data-alias="crackerjack@icloud.example"]'), { message: 'pending row' });
  assert.equal(row.textContent.includes(S.pending), true, 'waiting for its code');
  const add = requests.find(r => r.body?.action === 'add');
  assert.equal(add.method, 'POST');
  assert.equal(add.body.email_address, 'crackerjack@icloud.example');

  await type(row.querySelector('input[autocomplete="one-time-code"]'), '123456');
  await flush(async () => { button(view, S.verify).click(); });
  await waitFor(() => view.container.querySelector('[data-alias="crackerjack@icloud.example"]').textContent.includes(S.verified), { message: 'verified badge' });
  const verify = requests.find(r => r.body?.action === 'verify');
  assert.deepEqual(verify.body, { action: 'verify', alias_id: 'al-1', code: '123456' });
  assert.equal(view.container.querySelectorAll('input[autocomplete="one-time-code"]').length, 0, 'no code box once verified');
});

test('a refusal shows its own message on one line', async (t) => {
  stubFetch(t, { aliases: [], refuse: 'own_address' });
  const view = await renderEditor(t);
  await type(view.container.querySelector('input[type="email"]'), 'primary@icloud.example');
  await flush(async () => { button(view, S.add).click(); });
  const alert = await waitFor(() => view.container.querySelector('[role="alert"]'), { message: 'error line' });
  assert.equal(alert.textContent, S.errors.own_address);
});

test('a wrong code says so and the row stays unverified', async (t) => {
  stubFetch(t, { aliases: [{ id: 'al-1', email_address: 'a@icloud.example', display_name: null, verified: false, code_pending: true }] });
  const view = await renderEditor(t);
  await type(view.container.querySelector('input[autocomplete="one-time-code"]'), '000000');
  await flush(async () => { button(view, S.verify).click(); });
  const alert = await waitFor(() => view.container.querySelector('[role="alert"]'), { message: 'error line' });
  assert.equal(alert.textContent, S.errors.wrong_code);
  assert.equal(view.container.querySelector('[data-alias="a@icloud.example"]').textContent.includes(S.verified), false);
});

test('viewer: the list shows, every control is disabled, and nothing is sent', async (t) => {
  const requests = stubFetch(t, { aliases: [{ id: 'al-1', email_address: 'a@icloud.example', display_name: null, verified: true, code_pending: false }] });
  const view = await renderEditor(t, { readOnly: true });
  assert.equal(view.container.querySelectorAll('[data-alias]').length, 1);
  const controls = [...view.container.querySelectorAll('button, input')];
  assert.ok(controls.length >= 3);
  assert.equal(controls.every(c => c.disabled), true, 'all disabled');
  for (const b of view.container.querySelectorAll('button')) await flush(async () => { b.click(); });
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0);
});

async function openDetail(t, inbox) {
  stubFetch(t, { aliases: [] });
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true, draftEditorEnabled: true, draftEditorHidden: false },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
      planLimits: { inboxes: 10, members: 5 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: [inbox],
      apiKeys: [],
      usageData: {},
      auditLog: [],
      members: [],
      pendingInvites: [],
    })));
  t.after(() => view.unmount());
  const row = view.container.querySelector('tr[role="button"]');
  assert.ok(row, 'the inboxes table has a clickable row');
  await flush(async () => { row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  return view;
}

const hasSection = view => view.container.ownerDocument.querySelectorAll('[data-send-as]').length;

test('the detail modal shows Send As for an IMAP inbox that sends, and only then', async (t) => {
  assert.equal(hasSection(await openDetail(t, INBOX)), 1, 'iCloud (IMAP + SMTP)');
});

test('no Send As section for Gmail', async (t) => {
  assert.equal(hasSection(await openDetail(t, { ...INBOX, provider: 'gmail', service: null, hasImap: false, connectionMode: null })), 0);
});

test('no Send As section for a receive-only IMAP inbox', async (t) => {
  assert.equal(hasSection(await openDetail(t, { ...INBOX, connectionMode: 'imap' })), 0);
});
