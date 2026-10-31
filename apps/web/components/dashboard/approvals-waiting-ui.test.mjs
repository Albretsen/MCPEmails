// ---------------------------------------------------------------------------
// The waiting counts: the sidebar, the automation row, the filtered queue.
//
// Run with: npm run test:approvals-waiting-ui
//
// Renders the real dashboard with fetch replaced. Only reserved example domains
// appear below.
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
const panel = dashboard.approvals.panel;
const copy = dashboard.automations;

const WORKSPACE_ID = 'ws-0001';
const RULE = 'rule-0001';
const OTHER_RULE = 'rule-0002';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

const approval = (id, over = {}) => ({
  id,
  inbox_id: 'ib-0001',
  operation: 'email_forward',
  summary: { to: ['books@example.test'], subject: `Mail ${id}` },
  status: 'pending',
  created_at: '2026-10-31T10:00:00.000Z',
  expires_at: FUTURE,
  revision: 1,
  kind: 'rule_forward',
  rule_id: RULE,
  rule_name: 'Invoices',
  inboxes: { email_address: 'ops@example.test', display_name: null },
  ...over,
});

const rule = (id, name) => ({
  id,
  workspace_id: WORKSPACE_ID,
  inbox_id: 'ib-0001',
  api_key_id: 'ak-send',
  name,
  enabled: true,
  filter: { subject: 'invoice' },
  action: { type: 'forward', to: ['books@example.test'] },
  interval_minutes: 60,
  max_messages_per_run: 25,
  inboxes: { email_address: 'ops@example.test', display_name: null },
  last_run: null,
});

async function render(t, { approvals, role = 'owner' }) {
  const state = { approvals: [...approvals] };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === '/api/approvals' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body);
      state.approvals = state.approvals.filter((item) => item.id !== body.id);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (target === '/api/approvals') {
      return { ok: true, status: 200, json: async () => ({ approvals: state.approvals, decided: [] }) };
    }
    if (target.startsWith('/api/approvals/')) {
      return { ok: true, status: 200, json: async () => ({ to: ['books@example.test'], subject: 'Mail', revision: 1, approvable: true, bcc: [] }) };
    }
    if (target === '/api/automations') {
      return { ok: true, status: 200, json: async () => ({ role, automations: [rule(RULE, 'Invoices'), rule(OTHER_RULE, 'Receipts')] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'automations',
      user: { displayName: 'Ada', email: 'ada@example.test', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: role === 'owner', draftEditorEnabled: false, draftEditorHidden: false },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://example.test/api/mcp',
      userRole: role,
      planLimits: { maxInboxes: 10, historyDays: 90 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes: [],
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
  await settle();
  return { view, state };
}

const settle = () => flush(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const navItem = (root, label) => [...root.querySelectorAll('.nav-item')].find((a) => a.textContent.includes(label));
const sidebarCount = (root) => navItem(root, 'Approvals')?.querySelector('.count')?.textContent ?? null;
const ruleLinks = (root) => [...root.querySelectorAll('a[href*="approvals?rule="]')];
const buttonNamed = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const click = async (node) => { await flush(async () => { node.click(); }); await settle(); };

test('the sidebar counts what waits and hides at zero', async (t) => {
  const { view } = await render(t, { approvals: [approval('a1'), approval('a2'), approval('ai1', { kind: 'ai_send', rule_id: null, rule_name: null })] });
  assert.equal(sidebarCount(view.container), '3');
  await view.unmount();
  const empty = await render(t, { approvals: [] });
  assert.equal(sidebarCount(empty.view.container), null);
});

test('expired rows count nowhere', async (t) => {
  const { view } = await render(t, { approvals: [approval('a1'), approval('gone', { expires_at: PAST })] });
  assert.equal(sidebarCount(view.container), '1');
  assert.equal(ruleLinks(view.container)[0].textContent.trim(), '1 waiting');
});

test('each rule row links to its own waiting forwards, and only when it has some', async (t) => {
  const { view } = await render(t, { approvals: [approval('a1'), approval('a2')] });
  const links = ruleLinks(view.container);
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent.trim(), copy.waitingLink.replace('{count}', '2'));
  assert.equal(links[0].getAttribute('href'), `/dashboard/approvals?rule=${RULE}`);
});

test('the link opens the queue filtered to the rule, with a way back to all', async (t) => {
  const { view } = await render(t, {
    approvals: [approval('a1'), approval('b1', { rule_id: OTHER_RULE, rule_name: 'Receipts' })],
  });
  await click(ruleLinks(view.container)[0]);
  const text = view.container.textContent;
  assert.ok(text.includes(panel.filterShowing.replace('{rule}', 'Invoices')));
  assert.ok(text.includes('Mail a1'));
  assert.equal(text.includes('Mail b1'), false);
  assert.equal(sidebarCount(view.container), '2', 'the sidebar still counts the whole workspace');

  await click(buttonNamed(view.container, panel.filterClear));
  assert.ok(view.container.textContent.includes('Mail b1'));
  assert.equal(view.container.textContent.includes(panel.filterClear), false);
});

test('a decision moves the counts without a reload, down to hidden', async (t) => {
  const { view } = await render(t, { approvals: [approval('a1')] });
  await click(ruleLinks(view.container)[0]);
  await click(buttonNamed(view.container, 'Reject'));
  await click(buttonNamed(view.container, 'Reject request'));
  assert.equal(sidebarCount(view.container), null);
  assert.ok(view.container.textContent.includes(panel.filterEmpty));
  await click(navItem(view.container, dashboard.automations.title ?? 'Automations'));
  assert.equal(ruleLinks(view.container).length, 0);
});

test('a member sees the same count and rows, with no way to decide', async (t) => {
  const { view } = await render(t, { approvals: [approval('a1')], role: 'member' });
  assert.equal(sidebarCount(view.container), '1');
  await click(ruleLinks(view.container)[0]);
  assert.ok(view.container.textContent.includes('Mail a1'));
  assert.equal(buttonNamed(view.container, 'Reject'), undefined);
});

// ---------------------------------------------------------------------------
// Sender warnings at the moment of decision, and Escape.
// ---------------------------------------------------------------------------
const pressEscape = async () => {
  await flush(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
  await settle();
};
const openApprovals = async (t, approvals) => {
  const rendered = await render(t, { approvals });
  await click(navItem(rendered.view.container, 'Approvals'));
  return rendered;
};
const warned = (id, reason = 'sender_failed') => approval(id, { no_approval_wait_reason: reason });

test('the review dialog shows a sender warning prominently, and Escape closes it', async (t) => {
  const { view } = await openApprovals(t, [warned('a1')]);
  await click(buttonNamed(view.container, panel.reviewApprove));
  const dialog = view.container.querySelector('[aria-labelledby="approval-decision-title"]');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('.alert-error')?.textContent, dashboard.approvals.senderWarning.sender_failed);
  await pressEscape();
  assert.equal(view.container.querySelectorAll('[aria-labelledby="approval-decision-title"]').length, 0);
});

test('Approve all leaves warned forwards out, and says how many and why', async (t) => {
  const { view } = await openApprovals(t, [approval('a1'), approval('a2'), warned('a3')]);
  await click(buttonNamed(view.container, panel.approveAll));
  const dialog = view.container.querySelector('[aria-labelledby="approve-all-title"]');
  assert.ok(dialog.textContent.includes('Approve 2 forwards?'));
  assert.ok(dialog.textContent.includes('1 needs review one by one'));
  assert.ok(buttonNamed(dialog, 'Approve 2'));
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/approvals/approve-rule') {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ outcomes: [] }) };
    }
    return previous(url, init);
  };
  t.after(() => { globalThis.fetch = previous; });
  await click(buttonNamed(dialog, 'Approve 2'));
  assert.deepEqual(sent[0].items.map((item) => item.id), ['a1', 'a2']);
});

test('Approve all stays off when every waiting forward has a warning', async (t) => {
  const { view } = await openApprovals(t, [warned('a1'), warned('a2', 'sender_unverified')]);
  assert.equal(buttonNamed(view.container, panel.approveAll), undefined);
  assert.ok(view.container.textContent.includes('2 forwards need review one by one'));
});

test('Escape closes the Approve all dialog', async (t) => {
  const { view } = await openApprovals(t, [approval('a1'), approval('a2')]);
  await click(buttonNamed(view.container, panel.approveAll));
  assert.ok(view.container.querySelector('[aria-labelledby="approve-all-title"]'));
  await pressEscape();
  assert.equal(view.container.querySelectorAll('[aria-labelledby="approve-all-title"]').length, 0);
});
