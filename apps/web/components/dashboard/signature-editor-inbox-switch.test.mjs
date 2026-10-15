// ---------------------------------------------------------------------------
// The signature form when the inbox under it changes, the modal closes, or the
// page goes away, while the editor's code is still on its way.
//
// Run with: npm run test:signature-editor-ui
//
// THE BUG THIS FILE WAS WRITTEN FOR. Once the editor loads on demand, a Save
// clicked before it has arrived has to wait for it. The first version of that
// wait resumed with whatever editor was on screen when the wait ended, and
// sent it to the inbox the click was made for. The inbox detail modal has no
// focus trap and the inbox rows behind it stay keyboard-reachable, so:
//
//   open inbox A (editor not loaded yet)  ->  click Save  ->  Tab to row B,
//   Enter  ->  the editor's code arrives
//
// PATCHed /api/inboxes/A with B's signature and A's stale toggles: one
// mailbox's signature written over another's, on every mail A sends. When the
// editor was bundled the read was synchronous and this could not happen.
//
// THE RULE PINNED HERE. A save only ever sends the content of the inbox it
// was started for. A save that is waiting is CANCELLED, sending nothing, when
// the inbox changes, the modal closes or the form unmounts; it is not
// re-pointed at whatever is on screen later. Every test below asserts on the
// complete list of PATCHes, so "the wrong one was sent too" cannot hide behind
// "the right one was sent".
//
// The loader is replaced by one whose loads this file settles by hand, so the
// editor's code can be made to arrive at each point in those sequences. The
// dashboard, the modal, the editor and the sanitiser are real.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

// Idle preloading is driven by hand here (see `idle()`), never by a timer.
let idleCallbacks = [];
window.requestIdleCallback = (cb) => { idleCallbacks.push(cb); return idleCallbacks.length; };
window.cancelIdleCallback = (id) => { idleCallbacks[id - 1] = null; };

const { default: RealEditor } = await import('./SignatureRichEditor.jsx');
const { sanitizeSignatureHtml } = await import('../../src/lib/sanitizeSignatureHtml.js');
const REAL = { SignatureRichEditor: RealEditor, sanitizeSignatureHtml };

let arrived = null;
let gates = [];
let warmCalls = 0;

mock.module(new URL('./signature-editor-loader.mjs', import.meta.url).href, {
  namedExports: {
    peekSignatureEditor: () => arrived,
    loadSignatureEditor: () => {
      if (arrived) return Promise.resolve(arrived);
      return new Promise((resolve, reject) => { gates.push({ resolve, reject }); });
    },
    warmSignatureEditor: () => { warmCalls += 1; },
  },
});

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const COPY = en.inboxes.detail.signature;

// ---------------------------------------------------------------------------
// Two inboxes that differ in every field a save sends
// ---------------------------------------------------------------------------

const A = {
  id: 'ib-A', label: 'alpha', address: 'alpha@acme.com',
  signatureHtml: '<p>Alpha</p>', signatureText: 'Alpha',
  signatureEnabled: true, signatureReplyMode: 'always',
  sendReviewMode: 'off', sendApprovalRequired: false,
};
const B = {
  id: 'ib-B', label: 'bravo', address: 'bravo@acme.com',
  signatureHtml: '<p>Bravo</p>', signatureText: 'Bravo',
  signatureEnabled: false, signatureReplyMode: 'never',
  sendReviewMode: 'dashboard', sendApprovalRequired: true,
};
const SAVE_OF_A = {
  signature_html: '<p>Alpha</p>', signature_text: 'Alpha',
  signature_enabled: true, signature_reply_mode: 'always',
  send_review_mode: 'off', send_approval_required: false,
};
const SAVE_OF_B = {
  signature_html: '<p>Bravo</p>', signature_text: 'Bravo',
  signature_enabled: false, signature_reply_mode: 'never',
  send_review_mode: 'dashboard', send_approval_required: true,
};

function inbox(fields) {
  return {
    provider: 'imap', service: 'imap', status: 'active', lastError: null, hasImap: true,
    calls: 3, createdAt: '2026-09-01T00:00:00.000Z', lastCallAt: null, draftEditorHidden: false,
    ...fields,
  };
}

async function renderInboxes(t, { preloaded = false, inboxes = [inbox(A), inbox(B)] } = {}) {
  arrived = preloaded ? REAL : null;
  gates = [];
  warmCalls = 0;
  idleCallbacks = [];
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    return { ok: true, status: 200, json: async () => ({ signature: { ...body, signature_source: 'manual' }, sendReviewMode: body?.send_review_mode, sendApprovalRequired: body?.send_approval_required }) };
  };

  // Anything React or the form complains about is a failure of the test.
  const problems = [];
  const onUnhandled = (reason) => problems.push(`unhandled rejection: ${reason}`);
  process.on('unhandledRejection', onUnhandled);
  const previousError = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    // Node prints its own process warnings (module mocking is experimental,
    // a typeless package.json) through console.error. They are not the form's.
    if (/^\(node:\d+\) /.test(text)) return;
    problems.push(`console.error: ${text.slice(0, 300)}`);
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: 'ws-0001', slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true },
      workspaces: [],
      activeWorkspaceId: 'ws-0001',
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: 'owner',
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
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await view.unmount(); } };
  t.after(async () => {
    await unmount();
    globalThis.fetch = previousFetch;
    console.error = previousError;
    process.off('unhandledRejection', onUnhandled);
  });

  const c = view.container;
  const rows = () => [...c.querySelectorAll('tr[role="button"]')];
  const api = {
    ...view,
    unmount,
    problems,
    /** Every signature PATCH so far, as [url, body]. */
    patches: () => requests.filter((r) => r.method === 'PATCH').map((r) => [r.url, r.body]),
    title: () => c.querySelector('#inbox-detail-title')?.textContent ?? null,
    pm: () => c.querySelector('.sig-content .ProseMirror'),
    placeholder: () => c.querySelector('.sig-editor.sig-editor--loading'),
    button: (label) => [...c.querySelectorAll('button')].find((b) => b.textContent === label),
    select: () => c.querySelector('details.inbox-sending-details select.input'),
    enabledBox: () => c.querySelector('details.inbox-sending-details h3 + label input[type="checkbox"]'),
    radio: (mode) => c.querySelector(`input[name="send-review-mode"][value="${mode}"]`),
    /** Opens an inbox by clicking its row. */
    open: (i) => flush(() => { rows()[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    /**
     * Moves the open modal to another inbox the way the keyboard does: the
     * rows behind the modal are still focusable, and Enter on one opens it.
     */
    enterOnRow: (i) => flush(() => {
      rows()[i].focus();
      rows()[i].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }),
    close: () => flush(() => c.querySelector(`button[aria-label="${en.inboxes.detail.close}"]`).click()),
    clickSave: () => flush(() => { (api.button(COPY.save) ?? api.button(COPY.saving)).click(); }),
    arrive: () => flush(() => {
      arrived = REAL;
      for (const gate of gates.splice(0)) gate.resolve(REAL);
    }),
    fail: () => flush(() => {
      for (const gate of gates.splice(0)) gate.reject(new Error('ChunkLoadError'));
    }),
    pendingLoads: () => gates.length,
    /** Lets everything that was started finish: timers, promises, effects. */
    settle: () => flush(() => new Promise((resolve) => setTimeout(resolve, 40))),
  };
  return api;
}

/** The form shows inbox `which`'s own controls and, if loaded, its signature. */
function assertFormShows(view, which) {
  assert.equal(view.title(), which.label);
  assert.equal(view.select().value, which.signatureReplyMode);
  assert.equal(view.enabledBox().checked, which.signatureEnabled);
  assert.equal(view.radio(which.sendReviewMode).checked, true);
  if (view.pm()) assert.equal(view.pm().innerHTML, which.signatureHtml);
}

// ===========================================================================
// The reported sequence, with the editor's code arriving at each point
// ===========================================================================

test('code arrives AFTER the switch: Save on A, Enter on row B, then arrival sends NOTHING', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  assert.equal(view.title(), 'alpha');
  await view.clickSave(); // Waiting for the editor.
  assert.ok(view.button(COPY.saving), 'the save is waiting');

  await view.enterOnRow(1); // The modal is now on inbox B.
  assert.equal(view.title(), 'bravo');

  await view.arrive();
  await waitFor(() => view.pm(), { message: "B's editor" });
  await view.settle();

  assert.deepEqual(view.patches(), [],
    "A's save must not be sent with B's signature; it is cancelled when the inbox changes");
  assertFormShows(view, B);
  assert.ok(view.button(COPY.save), 'B is not left showing Saving… for a save nobody asked of it');
  assert.equal(view.button(COPY.save).disabled, false);
  assert.equal(view.select().disabled, false);
  assert.deepEqual(view.problems, []);
});

test('after that cancelled save, saving B sends B to B and nothing else', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.enterOnRow(1);
  await view.arrive();
  await waitFor(() => view.pm(), { message: "B's editor" });

  await view.clickSave();
  await waitFor(() => view.patches().length > 0, { message: "B's save" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-B', SAVE_OF_B]]);
  assert.deepEqual(view.problems, []);
});

test('code arrives BEFORE the save: A is saved as A, and switching afterwards sends nothing more', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.arrive();
  await waitFor(() => view.pm(), { message: "A's editor" });
  await view.clickSave();
  await waitFor(() => view.patches().length > 0, { message: "A's save" });

  await view.enterOnRow(1);
  await waitFor(() => view.pm()?.innerHTML === B.signatureHtml, { message: "B's editor" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assertFormShows(view, B);
  assert.deepEqual(view.problems, []);
});

test('code arrives BETWEEN the save click and the switch: A is saved as A, exactly once', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave(); // Waiting.
  await view.arrive(); // The wait ends while A is still the inbox on screen.
  await waitFor(() => view.patches().length > 0, { message: "A's deferred save" });

  await view.enterOnRow(1);
  await waitFor(() => view.pm()?.innerHTML === B.signatureHtml, { message: "B's editor" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assertFormShows(view, B);
  assert.deepEqual(view.problems, []);
});

test('code arrives AFTER THE MODAL IS CLOSED: a waiting save is dropped, nothing is sent, nothing complains', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.close();
  assert.equal(view.title(), null, 'the modal is closed');

  await view.arrive();
  await view.settle();
  assert.deepEqual(view.patches(), [], 'closing is not saving');
  assert.deepEqual(view.problems, [], 'no update on an unmounted form, no unhandled rejection');
});

test('rapid A -> B -> A while loading: the first save is cancelled for good, and a new Save on A sends A', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave(); // For A, waiting.
  await view.enterOnRow(1);
  await view.enterOnRow(0); // Back on A before the code arrives.
  assert.equal(view.title(), 'alpha');

  await view.arrive();
  await waitFor(() => view.pm(), { message: "A's editor" });
  await view.settle();
  assert.deepEqual(view.patches(), [], 'coming back to A does not resurrect the save that leaving it cancelled');
  assertFormShows(view, A);
  assert.ok(view.button(COPY.save));

  await view.clickSave();
  await waitFor(() => view.patches().length > 0, { message: "A's save" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.deepEqual(view.problems, []);
});

test('rapid A -> B -> A with a save started on B in between: nothing crosses over', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave(); // For A.
  await view.enterOnRow(1);
  await view.clickSave(); // For B.
  await view.enterOnRow(0);
  await view.arrive();
  await waitFor(() => view.pm(), { message: "A's editor" });
  await view.settle();
  assert.deepEqual(view.patches(), [], 'both waiting saves were left behind by a switch');
  assertFormShows(view, A);
  assert.deepEqual(view.problems, []);
});

test('toggles changed on A while loading do not follow the modal to B', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await flush(() => view.radio('inline').click());
  await flush(() => {
    view.select().value = 'first_only';
    view.select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await view.enterOnRow(1);
  assertFormShows(view, B);

  await view.arrive();
  await waitFor(() => view.pm(), { message: "B's editor" });
  await view.settle();
  assertFormShows(view, B);
  await view.clickSave();
  await waitFor(() => view.patches().length > 0, { message: "B's save" });
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-B', SAVE_OF_B]]);
});

// ===========================================================================
// Save immediately after open, close before load, unmount during load
// ===========================================================================

test('save immediately after open, code already loaded: sent at once, as when the editor was bundled', async (t) => {
  const view = await renderInboxes(t, { preloaded: true });
  await view.open(0);
  await view.clickSave();
  // No waiting state exists on this path at all.
  await waitFor(() => view.patches().length > 0, { message: "A's save" });
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.equal(view.pendingLoads(), 0);
  assert.deepEqual(view.problems, []);
});

test('save immediately after open, code still loading: waits, then sends A to A once', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.settle();
  assert.deepEqual(view.patches(), []);
  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: "A's deferred save" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.deepEqual(view.problems, []);
});

test('close before the code loads, then it arrives: nothing happens; reopening has the editor at once', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.close();
  await view.arrive();
  await view.settle();
  assert.deepEqual(view.patches(), []);
  assert.deepEqual(view.problems, []);

  await view.open(1);
  assert.ok(view.pm(), 'the editor is there on the first render of the reopened modal');
  assertFormShows(view, B);
});

test('close before the code loads, then the load FAILS: nothing happens, nothing complains', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.close();
  await view.fail();
  await view.settle();
  assert.deepEqual(view.patches(), []);
  assert.deepEqual(view.problems, []);
});

for (const outcome of ['arrive', 'fail']) {
  test(`unmount during load (${outcome}): no state update on an unmounted component, no unhandled rejection`, async (t) => {
    const view = await renderInboxes(t);
    await view.open(0);
    await view.clickSave(); // A save is waiting when the whole dashboard goes away.
    await view.unmount();
    await view[outcome]();
    await view.settle();
    assert.deepEqual(view.patches(), []);
    assert.deepEqual(view.problems, []);
  });
}

// ===========================================================================
// Load failure: never silent
// ===========================================================================

test('failure with a save waiting: the form says the signature was NOT saved', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.fail();
  await view.settle();

  assert.deepEqual(view.patches(), []);
  const alerts = [...view.container.querySelectorAll('details.inbox-sending-details [role="alert"]')].map((a) => a.textContent);
  assert.deepEqual(alerts, [
    'The signature editor could not be loaded. Check your connection and try again.',
    'Not saved. The signature editor could not be loaded, so nothing was sent. Check your connection and save again.',
  ], 'one alert where the editor should be, one by the Save button saying nothing was saved');
  assert.ok(view.button(COPY.save), 'the button is back');
  assert.equal(view.button(COPY.save).disabled, false);
  assert.deepEqual(view.problems, []);
});

test('failure, then Save: it retries the load, says it is working, and saves when the editor arrives', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.fail();
  await view.settle();
  assert.equal(view.pendingLoads(), 0);

  await view.clickSave();
  assert.equal(view.pendingLoads(), 1, 'Save does not silently do nothing: it starts the load again');
  assert.ok(view.button(COPY.saving), 'and shows it is working');
  assert.ok(view.placeholder(), 'the editor area is back to loading');

  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: 'the save after retry' });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.equal(view.container.querySelector('details.inbox-sending-details [role="alert"]'), null, 'the errors are cleared');
  assert.deepEqual(view.problems, []);
});

test('failure, Save, failure again: still nothing sent, and it says so again', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.fail();
  await view.clickSave();
  await view.fail();
  await view.settle();
  assert.deepEqual(view.patches(), []);
  const alerts = [...view.container.querySelectorAll('details.inbox-sending-details [role="alert"]')].map((a) => a.textContent);
  assert.equal(alerts.length, 2);
  assert.match(alerts[1], /^Not saved\./);
  assert.ok(view.button(COPY.save));
  assert.deepEqual(view.problems, []);
});

test('failure, "try again", then Save: the editor loads and the save is the stored signature', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.fail();
  await view.settle();
  const retry = view.container.querySelector('.sig-editor [role="alert"] button');
  await flush(() => retry.click());
  assert.equal(view.pendingLoads(), 1);
  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor after retry' });
  await view.settle();
  assert.deepEqual(view.patches(), [], 'retrying the load does not replay the save that failed');
  assert.equal(view.container.querySelector('details.inbox-sending-details [role="alert"]'), null);

  await view.clickSave();
  await waitFor(() => view.patches().length > 0, { message: 'the save' });
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.deepEqual(view.problems, []);
});

test('failure with a save waiting on A, then a switch to B: B shows no "not saved" message of A\'s', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.enterOnRow(1);
  await view.fail();
  await view.settle();
  assert.deepEqual(view.patches(), []);
  const alerts = [...view.container.querySelectorAll('details.inbox-sending-details [role="alert"]')].map((a) => a.textContent);
  assert.deepEqual(alerts, ['The signature editor could not be loaded. Check your connection and try again.'],
    'only the editor area reports the failed load; nothing claims a save of B failed');
  assert.ok(view.button(COPY.save));
  assert.deepEqual(view.problems, []);
});

// ===========================================================================
// A cancelled save is not a silent one
// ===========================================================================
//
// When the editor was bundled, Save sent at the click. Now a save clicked
// while the editor loads can be cancelled by an inbox switch or by closing the
// modal, and the person would otherwise never learn that the thing they
// clicked did not happen. It is NOT resurrected (see the top of this file);
// it is reported, with the same toast the dashboard already shows when a
// signature save fails on the network, which stays until dismissed and is
// outside the modal, so it survives the switch or the close that caused it.

const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const SAVE_FAILED = chrome.app.signatureSaveFailed;
const SAVED = chrome.app.signatureSaved;

/** Every toast on screen, oldest first: [variant class, role, message]. */
function toasts(view) {
  return [...view.container.querySelectorAll('.toast')].map((el) => [
    el.className, el.getAttribute('role'), el.querySelector('.toast-msg').textContent,
  ]);
}
const FAILED_TOAST = ['toast toast-error', 'alert', SAVE_FAILED];

test('cancelled by an inbox switch: the "Failed to save signature." toast appears at once, and stays', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  assert.deepEqual(toasts(view), [], 'nothing to report while the save is still waiting');

  await view.enterOnRow(1);
  assert.deepEqual(toasts(view), [FAILED_TOAST], 'the person is told the moment the save is dropped');
  assert.equal(view.title(), 'bravo');
  assert.ok(view.container.querySelector('.toast').closest('.modal') === null, 'it is not inside the modal that moved on');

  await view.arrive();
  await waitFor(() => view.pm(), { message: "B's editor" });
  await view.settle();
  assert.deepEqual(toasts(view), [FAILED_TOAST], 'exactly one notice for one dropped save, still there');
  assert.deepEqual(view.patches(), [], 'and it was not sent after all');
  assert.equal(view.container.querySelector('details.inbox-sending-details [role="alert"]'), null,
    "B's own form claims nothing: the notice is about a save B never had");
  assert.deepEqual(view.problems, []);
});

test('cancelled by closing the modal: the toast is there after the modal is gone', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.close();
  assert.equal(view.title(), null);
  assert.deepEqual(toasts(view), [FAILED_TOAST]);

  await view.arrive();
  await view.settle();
  assert.deepEqual(toasts(view), [FAILED_TOAST], 'error toasts wait to be dismissed');
  assert.deepEqual(view.patches(), []);
  assert.deepEqual(view.problems, []);
});

test('cancelled by clicking the scrim: same notice', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await flush(() => { view.container.querySelector('.scrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.deepEqual(toasts(view), [FAILED_TOAST]);
});

test('two saves dropped by A -> B -> A: two notices, one per save', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.enterOnRow(1);
  await view.clickSave();
  await view.enterOnRow(0);
  assert.deepEqual(toasts(view), [FAILED_TOAST, FAILED_TOAST]);
  await view.arrive();
  await view.settle();
  assert.deepEqual(view.patches(), []);
});

test('no notice when nothing was dropped: switching or closing without a waiting save is silent', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.enterOnRow(1);
  await view.enterOnRow(0);
  await view.close();
  await view.arrive();
  await view.settle();
  assert.deepEqual(toasts(view), []);
});

test('no "failed" notice when the waiting save goes through: only "Signature saved."', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: "A's deferred save" });
  await waitFor(() => toasts(view).length > 0, { message: 'the saved toast' });
  await view.enterOnRow(1); // Switching after it was sent drops nothing.
  await view.close();
  await view.settle();
  assert.deepEqual(toasts(view).map((x) => x[2]), [SAVED]);
});

test('no toast when the editor was already loaded: that save is sent at the click, as on main', async (t) => {
  const view = await renderInboxes(t, { preloaded: true });
  await view.open(0);
  await view.clickSave();
  await view.enterOnRow(1);
  await view.close();
  await waitFor(() => view.patches().length > 0, { message: "A's save" });
  await view.settle();
  assert.deepEqual(view.patches(), [['/api/inboxes/ib-A', SAVE_OF_A]]);
  assert.deepEqual(toasts(view).filter((x) => x[2] === SAVE_FAILED), []);
});

test('a save released by a FAILED load is reported in the form, not by a toast, and a later switch adds nothing', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.clickSave();
  await view.fail();
  await view.settle();
  assert.ok(view.container.textContent.includes('Not saved.'));
  assert.deepEqual(toasts(view), [], 'one report per event: the form already says it');
  await view.enterOnRow(1);
  await view.settle();
  assert.deepEqual(toasts(view), [], 'that save is no longer waiting, so the switch drops nothing');
});

/**
 * Whether a mouse can reach `el`. `pointer-events` is inherited, and jsdom's
 * click() ignores it, so this reads the nearest inline value up the tree: the
 * only place this form sets it is inline, on the wrapper that dims a disabled
 * signature.
 */
function pointerEvents(el) {
  for (let node = el; node; node = node.parentElement) {
    const value = node.style?.pointerEvents;
    if (value) return value;
  }
  return 'auto';
}

test('failure on a DISABLED signature: "try again" can be clicked with a mouse; the editor area stays inert', async (t) => {
  const view = await renderInboxes(t);
  await view.open(1); // Inbox B: signatureEnabled is false.
  assert.equal(view.enabledBox().checked, false);
  const wrapper = view.placeholder().parentElement;
  assert.equal(wrapper.style.pointerEvents, 'none', 'a disabled signature\'s editor area ignores the mouse');
  assert.equal(wrapper.style.opacity, '0.6');
  assert.equal(pointerEvents(view.placeholder()), 'none', 'the loading placeholder is inert too');

  await view.fail();
  await view.settle();
  const retry = view.container.querySelector('.sig-editor [role="alert"] button');
  assert.ok(retry);
  assert.equal(pointerEvents(retry), 'auto',
    'the retry control must be reachable: with the signature disabled it is the only way to get the editor back');
  // Nothing else about the disabled wrapper has changed.
  assert.equal(wrapper.style.pointerEvents, 'none');
  assert.equal(wrapper.style.opacity, '0.6');
  assert.equal(pointerEvents(view.container.querySelector('.sig-preview')), 'none');

  await flush(() => retry.click());
  assert.equal(view.pendingLoads(), 1);
  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor after retry' });
  // The editor itself is as inert as it is on main for a disabled signature.
  assert.equal(pointerEvents(view.pm()), 'none');
  assert.equal(pointerEvents(view.container.querySelector('.sig-toolbar button[title="Bold"]')), 'none');
  assert.equal(view.container.querySelector('.sig-toolbar button[title="Bold"]').disabled, true);
  assert.equal(view.pm().parentElement.parentElement.parentElement, wrapper, 'same wrapper, still dimmed');
  assert.equal(wrapper.style.pointerEvents, 'none');
});

test('failure on an ENABLED signature: "try again" is clickable there as well, and the wrapper is untouched', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.fail();
  await view.settle();
  const retry = view.container.querySelector('.sig-editor [role="alert"] button');
  assert.equal(pointerEvents(retry), 'auto');
  assert.equal(retry.closest('.sig-editor').parentElement.style.pointerEvents, 'auto');
  assert.equal(retry.closest('.sig-editor').parentElement.style.opacity, '1');
});

// ===========================================================================
// The preview while the editor is on its way
// ===========================================================================

test('preview while loading: a loading placeholder, never an empty preview that reads as "no signature"', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  const preview = view.container.querySelector('.sig-preview');
  assert.ok(preview, 'the preview block is in place, so nothing below it moves');
  assert.equal(preview.querySelector('.sig-preview-body'), null, 'no empty signature body is shown');
  assert.equal(preview.querySelector('.sig-preview-quote'), null, 'and no reply quote under a signature that is not there');
  const busy = preview.querySelector('[aria-busy="true"]');
  assert.ok(busy, 'a loading placeholder stands in for it');
  assert.ok(busy.querySelector('.sk'), 'using the dashboard\'s shimmer block');
  assert.ok(preview.querySelector('.sig-preview-label'), 'the label is there');
  assert.ok(preview.querySelector('.sig-preview-note'), 'and the note under it');

  await view.arrive();
  await waitFor(() => preview.querySelector('.sig-preview-body')?.innerHTML === A.signatureHtml, { message: 'the real preview' });
  assert.equal(preview.querySelector('[aria-busy="true"]'), null);
  assert.ok(preview.querySelector('.sig-preview-quote'));
});

test('preview after a failed load: says it is unavailable, does not show an empty signature', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  await view.fail();
  await view.settle();
  const preview = view.container.querySelector('.sig-preview');
  assert.equal(preview.querySelector('.sig-preview-body'), null);
  assert.equal(preview.querySelector('[aria-busy="true"]'), null, 'it is not loading any more');
  assert.equal(preview.querySelector('.sig-preview-empty').textContent, 'Preview unavailable until the editor has loaded.');
});

test('preview when the code is already loaded: the real body on the first render, no placeholder at any point', async (t) => {
  const view = await renderInboxes(t, { preloaded: true });
  await view.open(0);
  const preview = view.container.querySelector('.sig-preview');
  assert.ok(preview.querySelector('.sig-preview-body'));
  assert.equal(preview.querySelector('[aria-busy="true"]'), null);
});

// ===========================================================================
// The editor placeholder is the editor's own frame
// ===========================================================================

/** The parts of an editor box that decide how much room it takes. */
function frame(box) {
  return {
    tabs: [...box.querySelectorAll('.sig-mode-tabs > *')].map((el) => [el.tagName, el.className, el.textContent]),
    toolbar: [...box.querySelectorAll('.sig-toolbar > *')]
      .filter((el) => !(el.tagName === 'INPUT' && el.type === 'file')) // display:none in the real one
      // Labels, titles and the inert attributes do not take up room.
      .map((el) => [el.tagName, el.className.replace(' is-active', ''), el.innerHTML.replace(/ (aria-label|title|disabled|readonly|tabindex)="[^"]*"/g, '')]),
    areas: [...box.children].map((el) => el.className),
  };
}

test('placeholder (rich): the same tabs, the same toolbar and the same areas as the editor that replaces it', async (t) => {
  const view = await renderInboxes(t);
  await view.open(0);
  const placeholder = view.placeholder();
  assert.ok(placeholder);
  assert.equal(placeholder.getAttribute('aria-hidden'), 'true');
  const ghost = frame(placeholder);
  assert.equal(ghost.toolbar.length, 16, 'twelve controls and four separators');
  assert.ok([...placeholder.querySelectorAll('button, input, textarea')].every((el) => el.disabled),
    'nothing in the placeholder can be clicked or focused');
  // The writing area reserves the real one's minimum height.
  assert.equal(placeholder.querySelector('.sig-content > div').style.minHeight, '120px');
  const css = readFileSync(new URL('../../styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.sig-content \.ProseMirror \{\s*min-height: 120px;/);

  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor' });
  const real = frame(view.container.querySelector('.sig-editor'));
  assert.deepEqual(ghost.tabs, real.tabs, 'the mode tabs match, label for label');
  assert.deepEqual(ghost.toolbar, real.toolbar, 'the toolbar matches, control for control, so it wraps the same way');
  assert.deepEqual(ghost.areas, real.areas, 'tabs, toolbar, writing area: the same three blocks');
});

test('placeholder (table signature): the HTML source frame, because that is the mode the editor will open in', async (t) => {
  const table = '<table><tbody><tr><td>Ada</td></tr></tbody></table>';
  const second = await renderInboxes(t, { inboxes: [inbox({ ...A, signatureHtml: table })] });
  await second.open(0);
  const placeholder = second.placeholder();
  assert.equal(placeholder.querySelector('.sig-toolbar'), null, 'no rich toolbar');
  assert.equal(second.container.querySelector('textarea.sig-html-textarea'), null,
    'and nothing that could be taken for the real source textarea');
  const ghostBox = placeholder.querySelector('.sig-html-source textarea');
  assert.equal(ghostBox.style.minHeight, '160px');
  assert.equal(ghostBox.disabled, true);
  assert.equal(placeholder.querySelector('.sig-editor-hint').textContent, COPY.htmlSourceTableHint);
  assert.equal(second.container.querySelector('details.inbox-sending-details table'), null,
    'the stored HTML itself is not rendered while unsanitised');

  await second.arrive();
  await waitFor(() => second.container.querySelector('textarea.sig-html-textarea'), { message: 'source mode' });
  const real = second.container.querySelector('.sig-editor');
  assert.deepEqual(frame(real).tabs.map((x) => x[2]), [COPY.modeRich, COPY.modeHtml]);
  assert.deepEqual(frame(placeholder).tabs, frame(real).tabs, 'HTML source is the selected tab in both');
  assert.deepEqual([...real.children].map((el) => el.className), ['sig-mode-tabs', 'sig-html-source']);
  assert.ok(real.querySelector('.sig-editor-hint'));
});

// ===========================================================================
// Idle preloading
// ===========================================================================

test('idle preload: the dashboard asks for the editor once it is idle, not during mount', async (t) => {
  const view = await renderInboxes(t);
  assert.equal(warmCalls, 0, 'nothing is fetched while the dashboard is mounting');
  assert.equal(idleCallbacks.filter(Boolean).length, 1, 'one idle callback is scheduled');
  await flush(() => { for (const cb of idleCallbacks.splice(0)) cb?.({ didTimeout: false, timeRemaining: () => 10 }); });
  assert.equal(warmCalls, 1, 'idle: the load starts, before anyone has pointed at an inbox');
  assert.equal(view.title(), null, 'and nothing is opened by it');
});

test('idle preload: leaving the dashboard before it is idle cancels it', async (t) => {
  const view = await renderInboxes(t);
  assert.equal(idleCallbacks.filter(Boolean).length, 1);
  await view.unmount();
  assert.equal(idleCallbacks.filter(Boolean).length, 0, 'cancelled on unmount');
  assert.equal(warmCalls, 0);
});

test('idle preload: without requestIdleCallback (Safari) a short timer does the same job', async (t) => {
  const saved = [window.requestIdleCallback, window.cancelIdleCallback];
  delete window.requestIdleCallback;
  delete window.cancelIdleCallback;
  t.after(() => { [window.requestIdleCallback, window.cancelIdleCallback] = saved; });
  await renderInboxes(t);
  assert.equal(warmCalls, 0, 'not during mount');
  await waitFor(() => warmCalls === 1, { message: 'the timer fallback', timeout: 3000 });
});
