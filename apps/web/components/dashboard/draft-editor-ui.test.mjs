// ---------------------------------------------------------------------------
// Draft editor card toggle: the WIRING, at both grains.
//
// Run with: npm run test:draft-editor
//
// WHY THIS EXISTS, SEPARATELY FROM editor-preference.test.ts. That suite covers
// the arithmetic: given a rollout flag and two `*_hidden` columns, what should
// the control show. It is thorough, and it cannot fail for any of the bugs that
// would actually reach a customer, because none of them are in that module.
// Planting sixteen deliberate defects in `Pages.jsx` and `App.jsx` -- an
// inverted `checked`, a `!` on the way into `hiddenFromShown`, the raw
// `nextShown` handed to `onSave`, a camelCase body at the snake_case inbox
// route, a rollback that restores the value that just failed, no rollback at
// all, a dropped `disabled`, a viewer treated as a manager, the workspace
// override ignored -- left the whole suite green. Every one of those ships a
// silently wrong preference.
//
// So this file renders the REAL components: `DashboardApp` inside the real
// `AppLocaleProvider`, with the real `messages/en/dashboard.json`, and drives
// them through the DOM the way a person would. `fetch` is the only thing
// replaced, because a test must not PATCH anything, and it is also the
// assertion surface: what the dashboard would have sent is what matters.
//
// TWO ROUTES, TWO BODY SHAPES, ON PURPOSE. PATCH /api/workspaces/[id] reads
// camelCase `draftEditorHidden`; PATCH /api/inboxes/[id] reads snake_case
// `draft_editor_hidden`. Sending either shape to the other route is a silent
// no-op with a 200, so both are pinned here by name.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const COPY = en.settings.draftEditor;
const INBOX_COPY = en.inboxes.detail.draftEditor;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-0001';
const INBOX_ID = 'ib-0001';

function workspace(overrides = {}) {
  return {
    id: WORKSPACE_ID,
    slug: 'acme',
    plan: 'pro',
    compedScale: null,
    displayName: 'Acme',
    isOwner: true,
    draftEditorEnabled: true,
    draftEditorHidden: false,
    ...overrides,
  };
}

function inbox(overrides = {}) {
  return {
    id: INBOX_ID,
    label: 'work',
    address: 'work@acme.com',
    provider: 'imap',
    service: 'imap',
    status: 'active',
    lastError: null,
    hasImap: true,
    calls: 3,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null,
    draftEditorHidden: false,
    sendReviewMode: 'off',
    sendApprovalRequired: false,
    ...overrides,
  };
}

/**
 * Renders the real dashboard and records every request it makes.
 *
 * `respond` receives (url, init) and returns the Response-ish object the
 * component should see, or throws to stand in for a dropped connection. The
 * default answers 200 with an empty body, which is what a successful PATCH
 * looks like to these two call sites.
 *
 * The first argument is the test's own context, and unmounting is registered on
 * it rather than left to a `done()` at the end of the test body. A failing
 * assertion returns through neither, and a dashboard left mounted with its
 * `fetch` still replaced does not just leak: it keeps answering timers into the
 * next test. That turns one honest red into a hang, which is the worst way for
 * a suite to tell you something is broken.
 */
async function renderDashboard(t, {
  route = 'settings',
  ws = workspace(),
  inboxes = [inbox()],
  userRole = 'owner',
  respond = async () => ({ ok: true, status: 200, json: async () => ({}) }),
} = {}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    return respond(String(url), init);
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: route,
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: ws,
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole,
      planLimits: { inboxes: 10, members: 5 },
      stripePrices: {},
      overviewStats: {},
      activityFeed: [],
      inboxes,
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
    /** Only the PATCHes the draft editor controls make. */
    patches() {
      return requests.filter(r => r.method === 'PATCH');
    },
  };
}

/** Opens the inbox detail modal by clicking the row, as a person does. */
async function openInboxModal(view) {
  const row = view.container.querySelector('tr[role="button"]');
  assert.ok(row, 'the inboxes table should have a clickable row');
  await flush(async () => {
    row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

/**
 * Clicks a checkbox the way a person does.
 *
 * `input.click()` and not a hand-assembled event: jsdom flips `checked` and
 * dispatches the click itself, which is what React's change simulation listens
 * for. Assigning `input.checked` first would instead update React's own value
 * tracker, and the onChange handler would never run -- a test that silently
 * exercises nothing. It also honours `disabled`, which is the point of every
 * "sends nothing" assertion below.
 */
async function click(input) {
  await flush(async () => { input.click(); });
}

const workspaceBox = view => view.container.querySelector('#settings-draft-editor');
const inboxBox = view => view.container.querySelector(`#draft-editor-${INBOX_ID}`);
const text = view => view.container.textContent;

// ===========================================================================
// The workspace grain: Settings -> Draft editor card
// ===========================================================================

test('workspace: the checkbox reads the stored value POSITIVELY', async (t) => {
  const shown = await renderDashboard(t, { ws: workspace({ draftEditorHidden: false }) });
  assert.equal(workspaceBox(shown).checked, true, 'hidden=false must render as ticked');

  const hidden = await renderDashboard(t, { ws: workspace({ draftEditorHidden: true }) });
  assert.equal(workspaceBox(hidden).checked, false, 'hidden=true must render as unticked');
});

test('workspace: unticking PATCHes draftEditorHidden TRUE, camelCase, to the workspace route', async (t) => {
  const view = await renderDashboard(t);
  await click(workspaceBox(view));

  assert.equal(view.patches().length, 1);
  const [patch] = view.patches();
  assert.equal(patch.url, `/api/workspaces/${WORKSPACE_ID}`);
  assert.deepEqual(patch.body, { draftEditorHidden: true },
    'the workspace route reads camelCase; a snake_case body is a silent no-op');
});

test('workspace: ticking a hidden workspace PATCHes draftEditorHidden FALSE', async (t) => {
  const view = await renderDashboard(t, { ws: workspace({ draftEditorHidden: true }) });
  assert.equal(workspaceBox(view).checked, false);
  await click(workspaceBox(view));

  assert.deepEqual(view.patches()[0].body, { draftEditorHidden: false });
});

test('workspace: a 403 rolls the checkbox BACK and shows the server message', async (t) => {
  const view = await renderDashboard(t, {
    respond: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Only owners and admins can change this.' }),
    }),
  });
  assert.equal(workspaceBox(view).checked, true);

  await click(workspaceBox(view));

  assert.equal(workspaceBox(view).checked, true,
    'a refused save must restore the PREVIOUS value, not keep the one that failed');
  assert.ok(text(view).includes('Only owners and admins can change this.'),
    "the server's own reason must reach the screen");
});

test('workspace: a dropped connection rolls back and says so', async (t) => {
  const view = await renderDashboard(t, {
    respond: async () => { throw new TypeError('Failed to fetch'); },
  });
  await click(workspaceBox(view));

  assert.equal(workspaceBox(view).checked, true);
  assert.ok(text(view).includes(COPY.networkError));
});

test('workspace: a member sees a disabled control, the role note, and sends nothing', async (t) => {
  const view = await renderDashboard(t, {
    userRole: 'member',
    ws: workspace({ isOwner: false }),
  });
  const box = workspaceBox(view);
  assert.ok(box, 'the preference is a fact about the workspace, so it is still shown');
  assert.equal(box.disabled, true, 'PATCH /api/workspaces/[id] refuses a member, so prevent the 403');
  assert.ok(text(view).includes(COPY.roleNote));

  await click(box);
  assert.equal(view.patches().length, 0, 'a disabled control must fire no request');
});

test('workspace: a VIEWER is not pointed at the Inboxes page, where they are also refused', async (t) => {
  const view = await renderDashboard(t, {
    userRole: 'viewer',
    ws: workspace({ isOwner: false }),
  });
  assert.equal(workspaceBox(view).disabled, true);
  assert.ok(text(view).includes(COPY.viewerNote),
    'a viewer cannot manage an inbox either; the member pointer would be a false instruction');
  assert.ok(!text(view).includes(COPY.roleNote));
});

test('workspace: a member still gets the per-inbox pointer, which is true for them', async (t) => {
  const view = await renderDashboard(t, {
    userRole: 'member',
    ws: workspace({ isOwner: false }),
  });
  assert.ok(text(view).includes(COPY.roleNote));
  assert.ok(!text(view).includes(COPY.viewerNote));
});

test('workspace: a workspace outside the rollout gets no control at all', async (t) => {
  const view = await renderDashboard(t, { ws: workspace({ draftEditorEnabled: false }) });
  // `=== null` and not `assert.equal(node, null)`: on failure the assertion
  // would deep-inspect a jsdom element to build its diff, and an element's
  // ownerDocument reaches the whole window. That turns a one-line red into an
  // out-of-memory kill, which tells you nothing.
  assert.equal(workspaceBox(view) === null, true, 'no control at all for a workspace outside the rollout');
  assert.ok(!text(view).includes(COPY.title),
    'not an inert toggle, and not a title with nothing behind it');
});

// ===========================================================================
// The inbox grain: Inboxes -> a mailbox -> Draft editor card
// ===========================================================================

test('inbox: the checkbox reads the stored value POSITIVELY', async (t) => {
  const shown = await renderDashboard(t, { route: 'inboxes', inboxes: [inbox({ draftEditorHidden: false })] });
  await openInboxModal(shown);
  assert.equal(inboxBox(shown).checked, true);

  const hidden = await renderDashboard(t, { route: 'inboxes', inboxes: [inbox({ draftEditorHidden: true })] });
  await openInboxModal(hidden);
  assert.equal(inboxBox(hidden).checked, false);
});

test('inbox: unticking PATCHes draft_editor_hidden TRUE, snake_case, to the inbox route', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes' });
  await openInboxModal(view);
  await click(inboxBox(view));

  assert.equal(view.patches().length, 1);
  const [patch] = view.patches();
  assert.equal(patch.url, `/api/inboxes/${INBOX_ID}`);
  assert.deepEqual(patch.body, { draft_editor_hidden: true },
    'the inbox route reads snake_case; camelCase would 200 without storing anything');
  assert.ok(!('draftEditorHidden' in patch.body),
    'the camelCase key must not appear at this route under any spelling');
});

test('inbox: ticking a hidden mailbox PATCHes draft_editor_hidden FALSE', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes', inboxes: [inbox({ draftEditorHidden: true })] });
  await openInboxModal(view);
  assert.equal(inboxBox(view).checked, false);
  await click(inboxBox(view));

  assert.deepEqual(view.patches()[0].body, { draft_editor_hidden: false });
});

test('inbox: a 403 rolls the checkbox BACK and shows the server message', async (t) => {
  const view = await renderDashboard(t, {
    route: 'inboxes',
    respond: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Viewers cannot change inbox settings.' }),
    }),
  });
  await openInboxModal(view);
  assert.equal(inboxBox(view).checked, true);

  await click(inboxBox(view));

  assert.equal(inboxBox(view).checked, true,
    'the optimistic tick must go back, or the screen claims a preference the database does not hold');
  assert.ok(text(view).includes('Viewers cannot change inbox settings.'));
});

test('inbox: a dropped connection rolls back too', async (t) => {
  const view = await renderDashboard(t, {
    route: 'inboxes',
    respond: async () => { throw new TypeError('Failed to fetch'); },
  });
  await openInboxModal(view);
  await click(inboxBox(view));

  assert.equal(inboxBox(view).checked, true);
});

test('inbox: the workspace switch WINS, and says so', async (t) => {
  const view = await renderDashboard(t, {
    route: 'inboxes',
    ws: workspace({ draftEditorHidden: true }),
    inboxes: [inbox({ draftEditorHidden: false })],
  });
  await openInboxModal(view);
  const box = inboxBox(view);

  assert.equal(box.checked, true, "the mailbox's own stored value is still surfaced");
  assert.equal(box.disabled, true, 'a workspace "off" beats an inbox "on"');
  assert.ok(text(view).includes(INBOX_COPY.workspaceOff),
    'the override has to be stated, or the dead toggle is unexplainable');

  await click(box);
  assert.equal(view.patches().length, 0);
});

test('inbox: a viewer sees a disabled control, the viewer note, and sends nothing', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes', userRole: 'viewer' });
  await openInboxModal(view);
  const box = inboxBox(view);

  assert.equal(box.disabled, true, 'PATCH /api/inboxes/[id] refuses a viewer outright');
  assert.ok(text(view).includes(INBOX_COPY.viewerNote));

  await click(box);
  assert.equal(view.patches().length, 0);
});

test('inbox: a member may hide one mailbox even though the workspace switch is not theirs', async (t) => {
  const view = await renderDashboard(t, {
    route: 'inboxes',
    userRole: 'member',
    ws: workspace({ isOwner: false }),
  });
  await openInboxModal(view);
  const box = inboxBox(view);

  assert.equal(box.disabled, false, 'hiding one mailbox affects only that mailbox');
  await click(box);
  assert.deepEqual(view.patches()[0].body, { draft_editor_hidden: true });
});

test('inbox: a mailbox outside the rollout gets no control at all', async (t) => {
  const view = await renderDashboard(t, {
    route: 'inboxes',
    ws: workspace({ draftEditorEnabled: false }),
  });
  await openInboxModal(view);

  assert.equal(inboxBox(view) === null, true, 'no control at all for a mailbox outside the rollout');
  assert.ok(!text(view).includes(INBOX_COPY.title));
});

test('inbox: a row that predates the column renders as SHOWN, never as hidden', async (t) => {
  const row = inbox();
  delete row.draftEditorHidden;
  const view = await renderDashboard(t, { route: 'inboxes', inboxes: [row] });
  await openInboxModal(view);

  assert.equal(inboxBox(view).checked, true,
    'undefined is the pre-feature default and the column\'s own DEFAULT false');
});
