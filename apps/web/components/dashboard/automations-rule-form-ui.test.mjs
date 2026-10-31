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
import { readFileSync } from 'node:fs';
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

async function render(t, { rules = [aiRule()], keys = [SENDING_KEY, READ_KEY], respond, approvals = [] } = {}) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === '/api/approvals') {
      return { ok: true, status: 200, json: async () => ({ approvals, decided: [] }) };
    }
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

async function openDelete(t, approvals) {
  const { view, calls } = await render(t, { approvals });
  await click(buttonNamed(view.container, copy.rowDelete));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return { view, calls, dialog: dialogOf(view) };
}

const waitingRows = [{ id: 'a1', rule_id: 'rule-0001' }, { id: 'a2', rule_id: 'rule-0001' }, { id: 'a3', rule_id: 'someone-else' }, { id: 'a4', rule_id: null }];

test('row 22: the delete dialog counts this rule\'s forwards and cancels them by default', async (t) => {
  const { dialog, calls } = await openDelete(t, waitingRows);
  assert.ok(dialog.textContent.includes('2 forwards from this automation are waiting for approval.'), dialog.textContent);
  await click(buttonNamed(dialog, copy.delete.confirm));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(calls[0].body, { cancel_waiting: true });
});

test('row 22: unticking keeps them, and says where they stay', async (t) => {
  const { dialog, calls } = await openDelete(t, waitingRows);
  await click(dialog.querySelector('input[type="checkbox"]'));
  assert.ok(dialog.textContent.includes('They stay under Approvals'), dialog.textContent);
  await click(buttonNamed(dialog, copy.delete.confirm));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.deepEqual(calls[0].body, { cancel_waiting: false });
});

test('row 22: nothing waiting, nothing to ask', async (t) => {
  const { dialog, calls } = await openDelete(t, [{ id: 'a3', rule_id: 'someone-else' }]);
  assert.equal(dialog.querySelector('input[type="checkbox"]'), null);
  await click(buttonNamed(dialog, copy.delete.confirm));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.deepEqual(calls[0].body, { cancel_waiting: false });
});

test('row 22: the toast reports what the server really cancelled', async (t) => {
  // More than the queue's first page could count.
  const { view } = await render(t, {
    approvals: waitingRows,
    respond: () => ({ ok: true, status: 200, json: async () => ({ success: true, cancelled: 120 }) }),
  });
  await click(buttonNamed(view.container, copy.rowDelete));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  await click(buttonNamed(dialogOf(view), copy.delete.confirm));
  await flush(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.ok(document.body.textContent.includes('Automation deleted and 120 waiting forwards cancelled.'), document.body.textContent);
});

// The rule sentence says mail already in the mailbox counts, which is what the
// engine does today. Whoever adds "Include past mail" makes that false for some
// rules, so this fails until RuleSentence reads the new value: pick between
// automations.sentence.pastIncluded and pastExcluded, both already translated.
test('row 19: the past-mail line follows the engine', () => {
  const root = new URL('../../../../supabase/functions/mcp-server/triage-engine.ts', import.meta.url);
  const engine = readFileSync(root, 'utf8');
  const panel = readFileSync(new URL('./AutomationsPanel.jsx', import.meta.url), 'utf8');
  const hasOption = /include_?past|past_?mail|start_?from|starts_?from/i.test(engine);
  assert.equal(
    hasOption && !panel.includes('sentence.pastExcluded'),
    false,
    'The engine has a past-mail option. Make RuleSentence say sentence.pastExcluded when past mail is left out.',
  );
});

test('row 17: the page does not say nobody is watching', () => {
  assert.equal(/nobody watching|unattended/i.test(JSON.stringify({ s: copy.subtitle, f: copy.modal.filterUnsupported })), false);
});

test('row 2: Include past mail is off for a new rule, sent when ticked, and Preview marks past mail', async (t) => {
  const { view, calls } = await render(t, {
    rules: [aiRule({ include_past_mail: false })],
    respond: (target) => (target.endsWith('/preview')
      ? {
        ok: true,
        status: 200,
        json: async () => ({
          matched: 2,
          truncated: false,
          limit: 25,
          notes: [],
          messages: [
            { id: 'a', subject: 'New invoice', from: 'x@example.com', date: null, unread: true, past_mail: false },
            { id: 'b', subject: 'Old invoice', from: 'x@example.com', date: null, unread: false, past_mail: true },
          ],
        }),
      }
      : { ok: true, status: 200, json: async () => ({ automation: {} }) }),
  });
  await click(buttonNamed(view.container, copy.rowEdit));
  const dialog = dialogOf(view);
  const label = [...dialog.querySelectorAll('label')].find((l) => l.textContent.includes(copy.modal.includePastMail));
  const box = label.querySelector('input');
  assert.equal(box.checked, false);

  await click(buttonNamed(dialog, copy.modal.preview));
  await flush();
  assert.equal(calls[0].body.include_past_mail, false);
  assert.equal(calls[0].body.automation_id, 'rule-0001');
  const note = dialog.querySelector('[data-testid="automation-preview-past"]');
  assert.ok(note.textContent.includes('1 of these arrived before this rule starts'));
  assert.ok(dialog.textContent.includes(copy.modal.previewPastBadge));

  await click(box);
  await submit(dialog);
  const save = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(save.body, { include_past_mail: true });
});

test('row 24 and 16: a run with nothing new says so, and one that only queued forwards says it is waiting', async (t) => {
  const { view } = await render(t, {
    rules: [
      aiRule({ id: 'rule-a', name: 'Quiet', last_run: { status: 'skipped', started_at: '2026-10-31T10:00:00Z', matched: 4, succeeded: 0, queued: 0, failed: 0, skipped: 4 } }),
      aiRule({ id: 'rule-b', name: 'Busy', last_run: { status: 'completed', started_at: '2026-10-31T10:00:00Z', matched: 3, succeeded: 0, queued: 3, failed: 0, skipped: 0, forwards: { waiting: 1, sending: 0, sent: 2, failed: 0, rejected: 0, expired: 0 } } }),
      aiRule({ id: 'rule-c', name: 'Decided', last_run: { status: 'completed', started_at: '2026-10-31T10:00:00Z', matched: 1, succeeded: 0, queued: 1, failed: 0, skipped: 0, forwards: { waiting: 0, sending: 0, sent: 1, failed: 0, rejected: 0, expired: 0 } } }),
    ],
  });
  await flush();
  const rowText = (name) => [...view.container.querySelectorAll('tbody tr')].find((row) => row.textContent.includes(name)).textContent;
  assert.equal(copy.status.skipped, 'Nothing new');
  assert.ok(rowText('Quiet').includes(copy.status.skipped));
  assert.ok(rowText('Busy').includes(copy.status.queued));
  assert.ok(rowText('Decided').includes(copy.status.completed));
  assert.ok(!rowText('Decided').includes(copy.status.queued));
});
