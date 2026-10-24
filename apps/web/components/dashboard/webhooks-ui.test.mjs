// ---------------------------------------------------------------------------
// The Webhooks panel on the API keys page: create (secret shown once), send a
// test, read the delivery log, re-enable a failing endpoint, delete, and what
// a member or a Free workspace is offered.
//
// Run with: npm run test:webhooks-ui
//
// Renders the REAL DashboardApp (real en messages) on the keys route. `fetch`
// is stubbed per URL and recorded.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
// The upgrade prompt renders a next/link. jsdom has no IntersectionObserver or
// `self`, which next/link needs to decide on prefetching (same shim as
// inbox-cap-offer-ui.test.mjs); an observer that never fires prefetches nothing.
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const W = en.webhooks;

const WS = 'ws-0001';
const SECRET = `whsec_${'ab'.repeat(32)}`;

function endpoint(id, extra = {}) {
  return {
    id, url: `https://hooks.example.com/${id}`, secretPrefix: 'whsec_abcdef', inboxIds: null, events: ['message.received'],
    payloadMode: 'ids', createdBy: 'u-me', createdAt: '2026-10-20T00:00:00.000Z', disabledAt: null, disabledReason: null,
    consecutiveFailures: 0, lastSuccessAt: null, ...extra,
  };
}

async function render(t, { list, userRole = 'owner', routes = {} }) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    requests.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${u}`];
    if (handler) {
      const [status, body] = handler(init);
      return { ok: status < 400, status, json: async () => body };
    }
    if (method === 'GET' && u === '/api/webhook-endpoints') return { ok: true, status: 200, json: async () => list };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'keys',
      user: { displayName: 'Me', email: 'me@acme.test', initials: 'M', id: 'u-me' },
      workspace: { id: WS, slug: 'acme', plan: list.plan ?? 'solo', compedScale: null, displayName: 'Acme', isOwner: userRole === 'owner' },
      workspaces: [],
      activeWorkspaceId: WS,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { inboxes: 10, members: 1 },
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
  await waitFor(() => view.container.querySelector('[data-testid="webhooks-panel"]') && requests.some((r) => r.url === '/api/webhook-endpoints'), { message: 'panel loaded' });
  await flush();
  return { ...view, requests };
}

const panel = (view) => view.container.querySelector('[data-testid="webhooks-panel"]');
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;
const buttonTexts = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const PRO = (endpoints = []) => ({ endpoints, webhooksEnabled: true, plan: 'solo', canManage: true, maxEndpoints: 10 });

test('an owner on Pro creates a webhook and sees the secret once', async (t) => {
  const view = await render(t, {
    list: PRO(),
    routes: { 'POST /api/webhook-endpoints': () => [201, { ...endpoint('ep-new'), secret: SECRET }] },
  });
  assert.ok(panel(view).textContent.includes(W.empty));
  await flush(async () => { button(panel(view), W.add).click(); });
  setInput(view.container.querySelector('#webhook-url'), 'https://hooks.example.com/ep-new');
  await flush();
  await flush(async () => { button(panel(view), W.create).click(); });
  await waitFor(() => view.container.querySelector('[data-testid="webhook-secret"]'), { message: 'secret dialog' });

  const post = view.requests.find((r) => r.method === 'POST' && r.url === '/api/webhook-endpoints');
  assert.deepEqual(post.body, { url: 'https://hooks.example.com/ep-new', payloadMode: 'ids', inboxIds: null });
  assert.equal(view.container.querySelector('[data-testid="webhook-secret"]').textContent, SECRET);
  assert.ok(view.container.querySelector('[data-testid="webhook-row-ep-new"]'), 'the new row is listed');

  await flush(async () => { button(view.container.querySelector('[data-testid="webhook-secret-dialog"]'), W.done).click(); });
  assert.equal(view.container.querySelectorAll('[data-testid="webhook-secret-dialog"]').length, 0);
  assert.equal(view.container.textContent.includes(SECRET), false, 'the secret is gone after Done');
});

test('a refused URL shows the reason in one line and creates nothing', async (t) => {
  const view = await render(t, {
    list: PRO(),
    routes: { 'POST /api/webhook-endpoints': () => [400, { error: 'x', error_code: 'host_not_allowed' }] },
  });
  await flush(async () => { button(panel(view), W.add).click(); });
  setInput(view.container.querySelector('#webhook-url'), 'https://10.0.0.1/x');
  await flush();
  await flush(async () => { button(panel(view), W.create).click(); });
  const error = await waitFor(() => view.container.querySelector('[data-testid="webhook-form-error"]'), { message: 'form error' });
  assert.equal(error.textContent, W.errors.host_not_allowed);
  assert.equal(view.container.querySelectorAll('[data-testid="webhook-secret-dialog"]').length, 0);
});

test('send test reports the receiver\'s answer; the delivery log opens', async (t) => {
  const view = await render(t, {
    list: PRO([endpoint('ep-1')]),
    routes: {
      'POST /api/webhook-endpoints/ep-1/test': () => [200, { ok: true, status: 204, errorCode: null }],
      'GET /api/webhook-endpoints/ep-1/deliveries': () => [200, {
        deliveries: [{ id: 'd1', eventId: 'evt_1', eventType: 'ping', status: 'delivered', responseCode: 204, attempt: 1, createdAt: '2026-10-24T10:00:00.000Z', lastAttemptAt: '2026-10-24T10:00:00.000Z' }],
      }],
    },
  });
  const row = view.container.querySelector('[data-testid="webhook-row-ep-1"]');
  await flush(async () => { button(row, W.test).click(); });
  const note = await waitFor(() => row.querySelector('[data-testid="webhook-note"]'), { message: 'test note' });
  assert.equal(note.textContent, W.testOk.replace('{status}', '204'));

  await flush(async () => { button(row, W.deliveries).click(); });
  const log = await waitFor(() => view.container.querySelector('[data-testid="webhook-log"]'), { message: 'log' });
  assert.ok(log.textContent.includes('ping'));
  assert.ok(log.textContent.includes(`${W.resultDelivered} (HTTP 204)`));
});

test('a failing endpoint can be turned back on', async (t) => {
  const view = await render(t, {
    list: PRO([endpoint('ep-f', { disabledAt: '2026-10-24T00:00:00.000Z', disabledReason: 'failing' })]),
    routes: { 'PATCH /api/webhook-endpoints/ep-f': () => [200, endpoint('ep-f')] },
  });
  const row = () => view.container.querySelector('[data-testid="webhook-row-ep-f"]');
  assert.ok(row().textContent.includes(W.statusFailing));
  await flush(async () => { button(row(), W.turnOn).click(); });
  await waitFor(() => row().textContent.includes(W.statusActive), { message: 'active again' });
  const patch = view.requests.find((r) => r.method === 'PATCH');
  assert.deepEqual(patch.body, { enabled: true });
});

test('delete asks once more, then removes the row', async (t) => {
  const view = await render(t, {
    list: PRO([endpoint('ep-d')]),
    routes: { 'DELETE /api/webhook-endpoints/ep-d': () => [200, { deleted: true }] },
  });
  const row = view.container.querySelector('[data-testid="webhook-row-ep-d"]');
  await flush(async () => { button(row, W.delete).click(); });
  assert.ok(row.querySelector('[data-testid="webhook-delete-confirm"]'));
  assert.equal(view.requests.some((r) => r.method === 'DELETE'), false, 'the first click only asks');
  await flush(async () => { button(row.querySelector('[data-testid="webhook-delete-confirm"]'), W.delete).click(); });
  await waitFor(() => view.container.querySelectorAll('[data-testid="webhook-row-ep-d"]').length === 0, { message: 'row removed' });
});

test('a member sees the list and the log, and no button that changes anything', async (t) => {
  const view = await render(t, { userRole: 'member', list: { ...PRO([endpoint('ep-1')]), canManage: false } });
  const texts = buttonTexts(panel(view));
  assert.ok(texts.includes(W.deliveries));
  for (const text of [W.add, W.test, W.delete, W.turnOff, W.turnOn]) assert.equal(texts.includes(text), false, text);
  assert.ok(panel(view).textContent.includes(W.readOnly));
});

test('a Free workspace gets the upgrade prompt with the display name, never the plan id', async (t) => {
  const view = await render(t, {
    list: { endpoints: [endpoint('ep-old')], webhooksEnabled: false, plan: 'free', canManage: true, maxEndpoints: 10 },
  });
  const prompt = view.container.querySelector('[data-testid="webhooks-upgrade"]');
  assert.ok(prompt);
  assert.ok(prompt.textContent.includes(W.upgradeBody.replace('{plan}', 'Free')));
  assert.ok(prompt.textContent.includes(W.pausedNote));
  const texts = buttonTexts(panel(view));
  assert.equal(texts.includes(W.add), false);
  assert.equal(texts.includes(W.test), false);
  assert.ok(texts.includes(W.delete), 'a paused endpoint can still be deleted');
  assert.ok(view.container.querySelector('[data-testid="webhook-row-ep-old"]').textContent.includes(W.statusPaused));
});

test('a Personal workspace prompt names the plan by its display name and never prints an internal id', async (t) => {
  const view = await render(t, { list: { endpoints: [], webhooksEnabled: false, plan: 'personal', canManage: true, maxEndpoints: 10 } });
  const prompt = view.container.querySelector('[data-testid="webhooks-upgrade"]');
  assert.ok(prompt.textContent.includes('Personal'));
  assert.equal(/\bsolo\b/.test(panel(view).textContent), false);
});
