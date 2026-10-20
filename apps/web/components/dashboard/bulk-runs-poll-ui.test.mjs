// ---------------------------------------------------------------------------
// Workflows page, large-work runs: how often the panel asks the server.
//
// Run with: npm run test:bulk-runs-ui
//
// The panel used to GET /api/workflows/runs every 5 s forever, hidden tab or
// not, run or no run. Now: 5 s while a run is running or cancelling, 60 s
// while idle, nothing while the tab is hidden, and one GET the moment it is
// shown again. Fake timers drive the real DashboardApp; `fetch` is the stub.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');

const WORKSPACE_ID = 'ws-0001';
const run = (status) => ({
  id: 'run-0001', operation: 'move_messages', status, total: 200, processed: 40, succeeded: 40, failed: 0,
  cancelRequestedAt: null, createdAt: '2026-10-16T08:00:00.000Z', completedAt: null, errorCode: null, inbox: 'work@acme.com',
});

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
function setVisibility(state) {
  visibility = state;
  document.dispatchEvent(new window.Event('visibilitychange'));
}

// setImmediate is not faked; a few turns drain fetch -> json -> setState.
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await flush(() => new Promise((resolve) => setImmediate(resolve)));
  }
}

async function advance(t, ms) {
  await flush(() => { t.mock.timers.tick(ms); });
  await settle();
}

async function renderPanel(t, statuses) {
  visibility = 'visible';
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let gets = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/workflows/runs') && (init.method ?? 'GET') === 'GET') {
      const status = statuses[Math.min(gets, statuses.length - 1)];
      gets += 1;
      return { ok: true, status: 200, json: async () => ({ runs: status ? [run(status)] : [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'workflows',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', displayName: 'Acme', isOwner: true },
      workspaces: [], activeWorkspaceId: WORKSPACE_ID, mcpUrl: 'https://mcpemails.com/api/mcp', userRole: 'owner',
      planLimits: { inboxes: 10, members: 5 }, stripePrices: {}, overviewStats: {}, activityFeed: [], inboxes: [],
      apiKeys: [], usageData: {}, auditLog: [], members: [], pendingInvites: [],
    })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    visibility = 'visible';
  });
  await settle();
  return { view, gets: () => gets };
}

test('idle: one GET on mount, then every 60 s, not every 5 s', async (t) => {
  const { view, gets } = await renderPanel(t, [null]);
  assert.equal(gets(), 1);
  assert.match(view.container.textContent, /No large-work runs yet/);
  await advance(t, 5_000);
  assert.equal(gets(), 1, 'an idle panel must not poll at 5 s');
  await advance(t, 54_999);
  assert.equal(gets(), 1);
  await advance(t, 1);
  assert.equal(gets(), 2);
});

test('a finished run counts as idle', async (t) => {
  const { gets } = await renderPanel(t, ['completed']);
  await advance(t, 5_000);
  assert.equal(gets(), 1);
});

for (const status of ['running', 'cancelling']) {
  test(`${status}: polls every 5 s`, async (t) => {
    const { gets } = await renderPanel(t, [status]);
    assert.equal(gets(), 1);
    await advance(t, 5_000);
    assert.equal(gets(), 2);
    await advance(t, 5_000);
    assert.equal(gets(), 3);
  });
}

test('a run that finishes drops the panel back to the idle cadence', async (t) => {
  const { view, gets } = await renderPanel(t, ['running', 'completed']);
  await advance(t, 5_000);
  assert.equal(gets(), 2);
  assert.match(view.container.textContent, /completed/);
  await advance(t, 5_000);
  assert.equal(gets(), 2, 'no fast poll after the run completed');
  await advance(t, 55_000);
  assert.equal(gets(), 3);
});

test('hidden: no GETs at all; shown again: one GET at once, then the cadence', async (t) => {
  const { gets } = await renderPanel(t, ['running']);
  await flush(() => setVisibility('hidden'));
  await advance(t, 10 * 60_000);
  assert.equal(gets(), 1, 'a hidden tab must not poll');
  await flush(() => setVisibility('visible'));
  await settle();
  assert.equal(gets(), 2, 'becoming visible refetches immediately');
  await advance(t, 5_000);
  assert.equal(gets(), 3);
});
