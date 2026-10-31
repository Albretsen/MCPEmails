// ---------------------------------------------------------------------------
// The automation list and form against a rule made by an AI assistant.
//
// Run with: npm run test:automations-ui
//
// Renders the real dashboard with fetch replaced and reads what a person sees.
// rule-form.test.ts proves the helpers; this proves the panel actually uses them.
//
// Only reserved example domains appear below.
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

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const copy = dashboard.automations;
const WORKSPACE_ID = 'ws-0001';

function inbox(id, address) {
  return {
    id, label: address.split('@')[0], displayName: null, address, provider: 'imap', status: 'active', lastError: null,
    hasImap: true, service: 'generic', calls: 0, createdAt: '2026-09-01T00:00:00.000Z', lastCallAt: null,
    draftEditorHidden: false, sendReviewMode: 'off', sendApprovalRequired: false,
  };
}

const INBOXES = [inbox('ib-0001', 'ops@acme.example'), inbox('ib-0002', 'billing@acme.example')];
const SENDING_KEY = { id: 'ak-send', name: 'Sender', scopes: ['read:email', 'send:email'], inboxIds: null };
const READ_KEY = { id: 'ak-read', name: 'Reader', scopes: ['read:email'], inboxIds: null };

const aiRule = (overrides = {}) => ({
  id: 'rule-0001',
  workspace_id: WORKSPACE_ID,
  inbox_id: 'ib-0001',
  api_key_id: 'ak-send',
  name: 'Invoices',
  enabled: true,
  filter: { from: 'billing@vendor.example', cc: 'accounts@acme.example', since: '2026-09-01' },
  action: { type: 'forward', to: ['bookkeeper@acme.example'] },
  interval_minutes: 60,
  max_messages_per_run: 25,
  inboxes: { email_address: 'ops@acme.example', display_name: null },
  last_run: null,
  ...overrides,
});

async function render(t, { rules = [aiRule()], keys = [SENDING_KEY, READ_KEY], respond } = {}) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === '/api/automations' && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ role: 'owner', automations: rules }) };
    }
    if (target.startsWith('/api/automations')) {
      calls.push({ url: target, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      if (respond) return respond(target);
      return { ok: true, status: 200, json: async () => ({ automation: {} }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'automations',
      user: { displayName: 'Ada', email: 'ada@example.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true, draftEditorEnabled: false, draftEditorHidden: false },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
      planLimits: { maxInboxes: 10, historyDays: 90 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: INBOXES,
      apiKeys: keys,
      usageData: {},
      auditLog: [],
      members: [],
      pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return { view, calls };
}

const buttons = (root) => [...root.querySelectorAll('button')];
const buttonNamed = (root, text) => buttons(root).find((b) => b.textContent.trim() === text);
const dialogOf = (view) => view.container.querySelector('[role="dialog"]');
const click = (node) => flush(async () => { node.click(); });

async function setValue(node, value, proto, event) {
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  await flush(async () => {
    setter.call(node, value);
    node.dispatchEvent(new window.Event(event, { bubbles: true }));
  });
}
const typeInto = (input, value) => setValue(input, value, window.HTMLInputElement.prototype, 'input');
const choose = (select, value) => setValue(select, value, window.HTMLSelectElement.prototype, 'change');

async function submit(dialog) {
  await flush(async () => {
    dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

test('row 18: the rule row names the real address, and Needs approval explains itself', async (t) => {
  const { view } = await render(t);
  assert.ok(view.container.textContent.includes('Forward to bookkeeper@acme.example'));
  assert.equal(view.container.textContent.includes('1 recipient'), false);

  await click(buttonNamed(view.container, copy.approvalBadge));
  const dialog = dialogOf(view);
  assert.ok(dialog.textContent.includes(copy.approvalHelp.title));
  assert.ok(dialog.textContent.includes(copy.approvalHelp.step2));
  assert.equal(dialog.querySelector('a').getAttribute('href'), '/dashboard/approvals');
});

test('row 4: renaming an AI-made rule sends only the name, so since and cc survive', async (t) => {
  const { view, calls } = await render(t);
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  // What the form cannot edit, it still shows.
  assert.ok(dialog.textContent.includes('accounts@acme.example'));
  assert.ok(dialog.textContent.includes('2026-09-01'));

  await typeInto(dialog.querySelector('#automation-name'), 'Vendor invoices');
  await submit(dialog);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { name: 'Vendor invoices' });
});

test('row 4: changing the filter keeps the fields the form does not show', async (t) => {
  const { view, calls } = await render(t);
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  await typeInto(dialog.querySelector('#automation-filter-subject'), 'invoice');
  await submit(dialog);
  assert.deepEqual(calls[0].body, {
    filter: { from: 'billing@vendor.example', cc: 'accounts@acme.example', since: '2026-09-01', subject: 'invoice' },
  });
});

test('row 4: a condition can be removed on purpose', async (t) => {
  const { view, calls } = await render(t);
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  const remove = buttons(dialog).find((b) => b.getAttribute('aria-label') === copy.modal.hiddenFilterRemoveLabel.replace('{label}', copy.modal.filterCc));
  await click(remove);
  await submit(dialog);
  assert.deepEqual(calls[0].body, { filter: { from: 'billing@vendor.example', since: '2026-09-01' } });
});

test('row 4: a rule on a key the list does not offer can still be renamed', async (t) => {
  const { view, calls } = await render(t, { rules: [aiRule({ api_key_id: 'ak-connection' })] });
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  assert.equal(dialog.querySelector('#automation-key').value, 'ak-connection');
  await typeInto(dialog.querySelector('#automation-name'), 'Renamed');
  await submit(dialog);
  assert.deepEqual(calls[0].body, { name: 'Renamed' });
});

test('row 19: the sentence states the real values before saving', async (t) => {
  const { view } = await render(t);
  await click(buttonNamed(view.container, copy.rowEdit));
  const sentence = dialogOf(view).querySelector('[data-testid="automation-rule-sentence"]').textContent;
  assert.ok(sentence.includes('Every hour, MCPEmails checks ops@acme.example'), sentence);
  assert.ok(sentence.includes('from billing@vendor.example'), sentence);
  assert.ok(sentence.includes('copied to accounts@acme.example'), sentence);
  assert.ok(sentence.includes('received on or after 2026-09-01'), sentence);
  assert.ok(sentence.includes('approve it, and only then goes to bookkeeper@acme.example'), sentence);
});

test('row 19: no sentence while the form cannot say anything true', async (t) => {
  const { view } = await render(t, { rules: [] });
  await click(buttonNamed(view.container, copy.newButton));
  assert.equal(dialogOf(view).querySelector('[data-testid="automation-rule-sentence"]'), null);
});

test('row 20: a forward on a key that cannot send is refused before saving', async (t) => {
  const { view, calls } = await render(t);
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  await choose(dialog.querySelector('#automation-key'), 'ak-read');
  assert.ok(dialog.textContent.includes(copy.modal.keyCannotSend));
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
  await submit(dialog);
  assert.equal(calls.length, 0);

  await choose(dialog.querySelector('#automation-key'), 'ak-send');
  assert.equal(dialog.textContent.includes(copy.modal.keyCannotSend), false);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, false);
});

test('row 20: the cause never claims the key once had a permission', () => {
  assert.equal(copy.health.causeScopeDenied.includes('no longer'), false);
});

test('row 5: a refused preview shows a sentence, never the raw code', async (t) => {
  const { view } = await render(t, {
    respond: () => ({ ok: false, status: 503, json: async () => ({ error: 'unauthorized', code: 'preview_unavailable' }) }),
  });
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  await click(buttonNamed(dialog, copy.modal.preview));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.ok(dialog.textContent.includes(copy.modal.previewUnavailable));
  assert.equal(dialog.textContent.includes('unauthorized'), false);
});

test('row 5: an unknown failure falls back rather than printing what the server said', async (t) => {
  const { view } = await render(t, {
    respond: () => ({ ok: false, status: 400, json: async () => ({ error: 'scope_denied' }) }),
  });
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  await click(buttonNamed(dialog, copy.modal.preview));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.ok(dialog.textContent.includes(copy.modal.previewFailed));
  assert.equal(dialog.textContent.includes('scope_denied'), false);
});

test('row 23: a duplicate asks for the inbox, keeps hidden conditions, and posts no state', async (t) => {
  const { view, calls } = await render(t);
  await click(buttonNamed(view.container, copy.rowDuplicate));
  const dialog = dialogOf(view);
  assert.ok(dialog.textContent.includes(copy.modal.duplicateTitle));
  assert.equal(dialog.querySelector('#automation-name').value, 'Copy of Invoices');
  assert.equal(dialog.querySelector('#automation-inbox').value, '');

  await choose(dialog.querySelector('#automation-inbox'), 'ib-0002');
  await submit(dialog);

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/automations');
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'action', 'api_key_id', 'filter', 'inbox_id', 'interval_minutes', 'max_messages_per_run', 'name',
  ]);
  assert.equal(calls[0].body.inbox_id, 'ib-0002');
  assert.deepEqual(calls[0].body.filter, aiRule().filter);
});

test('row 17: the page does not say nobody is watching', () => {
  assert.equal(/nobody watching|unattended/i.test(JSON.stringify({ s: copy.subtitle, f: copy.modal.filterUnsupported })), false);
});
