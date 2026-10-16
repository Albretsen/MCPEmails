// ---------------------------------------------------------------------------
// Workflows page, large-work runs: who sees a working Stop button.
//
// Run with: npm run test:bulk-runs-ui
//
// PATCH /api/workflows/runs refuses viewers with a 403 (they are read-only, see
// lib/workspace/roles.ts). The panel must say so up front instead of offering a
// button that fails on click: for a viewer Stop is rendered disabled with the
// reason in a notice and a tooltip, and clicking it sends nothing. For
// owner/admin/member it still PATCHes the run, unchanged.
//
// Renders the REAL DashboardApp at the workflows route inside the real
// AppLocaleProvider with the real English messages, so the App -> WorkflowsPage
// -> BulkRunsPanel userRole wiring is covered too. `fetch` is the only stub.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const COPY = en.workflows.bulkRuns;
const WORKSPACE_ID = 'ws-0001';

const RUNNING = {
  id: 'run-0001',
  operation: 'move_messages',
  status: 'running',
  total: 200,
  processed: 40,
  succeeded: 40,
  failed: 0,
  cancelRequestedAt: null,
  createdAt: '2026-10-16T08:00:00.000Z',
  completedAt: null,
  errorCode: null,
  inbox: 'work@acme.com',
};

async function renderWorkflows(t, { userRole, runs = [RUNNING] }) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).startsWith('/api/workflows/runs')) {
      if (method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ run: { id: RUNNING.id, status: 'cancelling' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ runs }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'workflows',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', displayName: 'Acme', isOwner: userRole === 'owner' },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { inboxes: 10, members: 5 },
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

  return { ...view, requests, patches: () => requests.filter((r) => r.url.startsWith('/api/workflows/runs') && r.method === 'PATCH') };
}

function stopButton(view) {
  return [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop') ?? null;
}

const notice = (view) => view.container.querySelector('[data-testid="bulk-runs-viewer-notice"]');

test('the copy exists in English', () => {
  assert.equal(typeof COPY.viewerNotice, 'string');
  assert.equal(typeof COPY.stopViewerTitle, 'string');
});

test('viewer: Stop is disabled with the reason, and clicking it sends nothing', async (t) => {
  const view = await renderWorkflows(t, { userRole: 'viewer' });
  const button = await waitFor(() => stopButton(view), { message: 'the Stop button for a running run' });

  assert.equal(button.disabled, true, 'a viewer must not get a live Stop button');
  assert.equal(button.getAttribute('title'), COPY.stopViewerTitle);
  assert.ok(notice(view), 'the viewer notice is shown');
  assert.equal(notice(view).textContent, COPY.viewerNotice);

  await flush(async () => { button.click(); });
  assert.deepEqual(view.patches(), [], 'no PATCH may be sent for a viewer');
  // The run itself is still visible: viewers keep read access.
  assert.match(view.container.textContent, /40 \/ 200 processed/);
});

for (const userRole of ['owner', 'admin', 'member']) {
  test(`${userRole}: Stop is enabled, has no viewer notice, and PATCHes the run`, async (t) => {
    const view = await renderWorkflows(t, { userRole });
    const button = await waitFor(() => stopButton(view), { message: 'the Stop button for a running run' });

    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), null);
    assert.equal(notice(view), null, 'operators see no viewer notice');

    await flush(async () => { button.click(); });
    await waitFor(() => view.patches().length === 1, { message: 'the cancel PATCH' });
    assert.deepEqual(view.patches()[0].body, { id: RUNNING.id });
  });
}

test('viewer with no runs: the notice still explains, and no Stop button exists', async (t) => {
  const view = await renderWorkflows(t, { userRole: 'viewer', runs: [] });
  await waitFor(() => /No large-work runs yet/.test(view.container.textContent), { message: 'empty state' });
  assert.ok(notice(view));
  assert.equal(stopButton(view), null);
});
