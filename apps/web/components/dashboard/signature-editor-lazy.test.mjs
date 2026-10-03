// ---------------------------------------------------------------------------
// The signature editor while its code is still on the way, and when it never
// arrives.
//
// Run with: npm run test:signature-editor-ui
//
// signature-editor-ui.test.mjs pins what the editor does once it is there. The
// editor (TipTap, ProseMirror) and the sanitiser (DOMPurify) are now fetched
// when the inbox modal needs them, so there is a stretch of time that did not
// exist before: the modal is open and the editor is not. Under a test the
// module arrives at once, so that suite never sees it. This one replaces the
// loader with one whose loads this file settles by hand, and pins:
//
//   - the form is whole while it waits, with a placeholder where the editor
//     will be and nothing that jumps when it arrives;
//   - SAVE CLICKED EARLY WAITS. It must never read an editor that is not there
//     and PATCH an empty signature over the stored one;
//   - what the person changed while it loaded is not reset when it arrives;
//   - a load that fails says so, in place, and can be retried;
//   - once loaded, reopening the modal has the editor on the first render.
//
// Everything else is real: DashboardApp, the modal, the editor component and
// the sanitiser the gated loader eventually hands over.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

// The dashboard also asks for the editor when it goes idle. Here idle never
// comes, so every load in this file is one a test started on purpose.
window.requestIdleCallback = () => 1;
window.cancelIdleCallback = () => {};

// The real pair, imported directly: what the gated loader hands over.
const { default: RealEditor } = await import('./SignatureRichEditor.jsx');
const { sanitizeSignatureHtml } = await import('../../src/lib/sanitizeSignatureHtml.js');
const REAL = { SignatureRichEditor: RealEditor, sanitizeSignatureHtml };

/** The pair once it has "arrived", else null. */
let arrived = null;
/** One entry per unsettled loadSignatureEditor() call. */
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
const INBOX_ID = 'ib-0001';
const STORED_HTML = '<p>Ada <strong>Lovelace</strong></p>';
const STORED_TEXT = 'Ada Lovelace';

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
    signatureHtml: STORED_HTML,
    signatureText: STORED_TEXT,
    signatureReplyMode: 'always',
    ...overrides,
  };
}

async function renderInboxes(t, { inboxes = [inbox()], preloaded = false } = {}) {
  arrived = preloaded ? REAL : null;
  gates = [];
  warmCalls = 0;
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    return { ok: true, status: 200, json: async () => ({ signature: { ...body, signature_source: 'manual' } }) };
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

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
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    process.off('unhandledRejection', onUnhandled);
  });

  const c = view.container;
  const api = {
    ...view,
    unhandled,
    patches: () => requests.filter((r) => r.method === 'PATCH'),
    row: () => c.querySelector('tr[role="button"]'),
    panel: () => c.querySelector('details.inbox-sending-details'),
    boxes: () => [...c.querySelectorAll('.sig-editor')],
    placeholder: () => c.querySelector('.sig-editor.sig-editor--loading'),
    pm: () => c.querySelector('.sig-content .ProseMirror'),
    preview: () => c.querySelector('.sig-preview-body'),
    button: (label) => [...c.querySelectorAll('button')].find((b) => b.textContent === label),
    select: () => c.querySelector('details.inbox-sending-details select.input'),
    enabledBox: () => c.querySelector('details.inbox-sending-details h3 + label input[type="checkbox"]'),
    radio: (mode) => c.querySelector(`input[name="send-review-mode"][value="${mode}"]`),
    open: () => flush(() => { api.row().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    close: () => flush(() => c.querySelector(`button[aria-label="${en.inboxes.detail.close}"]`).click()),
    /** The editor's code arrives: every pending load resolves. */
    arrive: () => flush(() => {
      arrived = REAL;
      for (const gate of gates.splice(0)) gate.resolve(REAL);
    }),
    /** The editor's code fails to load: every pending load rejects. */
    fail: () => flush(() => {
      for (const gate of gates.splice(0)) gate.reject(new Error('ChunkLoadError'));
    }),
    pendingLoads: () => gates.length,
  };
  return api;
}

const pause = () => flush(() => new Promise((resolve) => setTimeout(resolve, 20)));

// ===========================================================================
// While the editor is on its way
// ===========================================================================

test('loading: the form is complete, with a placeholder exactly where the editor will be', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await pause();

  assert.equal(view.pendingLoads(), 1, 'opening the modal starts the load, even with the panel collapsed');
  assert.equal(view.panel().open, false);
  assert.equal(view.pm(), null, 'no editor yet');

  const boxes = view.boxes();
  assert.equal(boxes.length, 1, 'one box where the editor goes');
  const placeholder = view.placeholder();
  assert.equal(placeholder, boxes[0]);
  // The editor's own frame, inert and hidden from assistive technology. What
  // is inside it is pinned in signature-editor-inbox-switch.test.mjs.
  assert.equal(placeholder.className, 'sig-editor sig-editor--loading is-disabled');
  assert.equal(placeholder.getAttribute('aria-hidden'), 'true');

  // Everything around it is already there, in order, and usable.
  assert.ok(view.container.querySelector('.review-mode'));
  assert.equal(placeholder.nextElementSibling, view.container.querySelector('.sig-preview'));
  assert.equal(view.preview(), null, 'no empty preview body that would read as "no signature"');
  assert.ok(view.container.querySelector('.sig-preview [aria-busy="true"]'), 'a loading placeholder instead');
  assert.equal(view.select().value, 'always');
  assert.equal(view.select().disabled, false);
  assert.equal(view.button(COPY.save).disabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null, 'loading is not an error');
});

test('loading: the placeholder reserves the height the stylesheet gives the loading box', () => {
  const css = readFileSync(new URL('../../styles/dashboard.css', import.meta.url), 'utf8');
  assert.match(css, /\.sig-editor--loading\s*\{\s*min-height:\s*140px;\s*\}/);
});

test('arrival: the editor replaces the placeholder in place and loads the stored signature', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  const parent = view.placeholder().parentElement;

  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor' });
  assert.equal(view.placeholder(), null, 'the placeholder is gone');
  assert.equal(view.boxes().length, 1);
  assert.equal(view.boxes()[0].parentElement, parent, 'same slot');
  assert.equal(view.boxes()[0].nextElementSibling, view.container.querySelector('.sig-preview'));
  assert.equal(view.pm().innerHTML, STORED_HTML);
  await waitFor(() => view.preview().innerHTML === STORED_HTML, { message: 'the preview' });
  assert.deepEqual(view.unhandled, []);
});

test('arrival: what the person changed while it loaded is kept, not reset', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await flush(() => view.radio('dashboard').click());
  await flush(() => {
    view.select().value = 'never';
    view.select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await flush(() => view.enabledBox().click());

  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor' });
  await pause();
  assert.equal(view.radio('dashboard').checked, true, 'review mode survives the editor arriving');
  assert.equal(view.select().value, 'never');
  assert.equal(view.enabledBox().checked, false);

  await flush(() => view.button(COPY.save).click());
  await waitFor(() => view.patches().length === 1, { message: 'the save' });
  assert.deepEqual(view.patches()[0].body, {
    signature_html: STORED_HTML,
    signature_text: STORED_TEXT,
    signature_enabled: false,
    signature_reply_mode: 'never',
    send_review_mode: 'dashboard',
    send_approval_required: true,
  });
});

// ===========================================================================
// Save clicked before the editor is there
// ===========================================================================

test('early save: nothing is sent until the editor is ready, then the STORED signature is sent, once', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await flush(() => view.button(COPY.save).click());
  await pause();

  assert.deepEqual(view.patches(), [], 'an editor that is not there is never read as an empty signature');
  const saving = view.button(COPY.saving);
  assert.ok(saving, 'the button reads Saving… while it waits');
  assert.equal(saving.disabled, true);
  assert.equal(view.select().disabled, true, 'the other controls lock, as during any save');
  assert.equal(view.enabledBox().disabled, true);
  assert.equal(view.radio('off').disabled, true);

  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: 'the deferred save' });
  await waitFor(() => view.button(COPY.save), { message: 'the button to return' });
  assert.equal(view.patches().length, 1);
  assert.deepEqual(view.patches()[0].body, {
    signature_html: STORED_HTML,
    signature_text: STORED_TEXT,
    signature_enabled: true,
    signature_reply_mode: 'always',
    send_review_mode: 'off',
    send_approval_required: false,
  });
  assert.deepEqual(view.unhandled, []);
});

test('early save: a second click while waiting does not queue a second save', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await flush(() => { view.button(COPY.save).click(); });
  await flush(() => { view.button(COPY.saving).click(); });
  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: 'the deferred save' });
  await pause();
  assert.equal(view.patches().length, 1);
});

test('early save: the editor that mounts during the wait is editable afterwards', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await flush(() => view.button(COPY.save).click());
  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: 'the deferred save' });
  await waitFor(() => view.button(COPY.save), { message: 'the button to return' });
  assert.equal(view.pm().getAttribute('contenteditable'), 'true');
  assert.equal(view.container.querySelector('.sig-toolbar button[title="Bold"]').disabled, false);
  assert.equal(view.boxes()[0].className, 'sig-editor');
});

test('early save: a table signature is sent untouched', async (t) => {
  const table = '<table><tbody><tr><td>Ada</td><td>Acme</td></tr></tbody></table>';
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: table, signatureText: 'Ada\nAcme' })] });
  await view.open();
  await flush(() => view.button(COPY.save).click());
  await view.arrive();
  await waitFor(() => view.patches().length > 0, { message: 'the deferred save' });
  assert.equal(view.patches()[0].body.signature_html, table);
  assert.equal(view.patches()[0].body.signature_text, 'Ada\nAcme');
});

// ===========================================================================
// The editor's code never arrives
// ===========================================================================

test('failure: the editor area says what happened, in place; it is not left blank', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await view.fail();
  await pause();

  const boxes = view.boxes();
  assert.equal(boxes.length, 1, 'the box keeps its place in the form');
  const alert = boxes[0].querySelector('[role="alert"]');
  assert.ok(alert, 'an error is announced');
  assert.equal(alert.textContent, 'The signature editor could not be loaded. Check your connection and try again.');
  assert.ok(alert.querySelector('button'), 'with a way to retry');
  assert.equal(boxes[0].nextElementSibling, view.container.querySelector('.sig-preview'));
  assert.deepEqual(view.unhandled, [], 'the failure is handled');
});

test('failure: Save sends nothing, before or after the failure, and is never silent about it', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await flush(() => view.button(COPY.save).click()); // Waiting on the editor.
  await view.fail();
  await pause();
  assert.deepEqual(view.patches(), [], 'the waiting save is released unsaved');
  assert.ok(view.button(COPY.save), 'and the button is back, not stuck on Saving…');
  assert.equal(view.button(COPY.save).disabled, false);
  assert.ok(view.container.textContent.includes('Not saved.'), 'and the form says nothing was saved');

  // Save again: it retries the load rather than doing nothing.
  await flush(() => view.button(COPY.save).click());
  assert.equal(view.pendingLoads(), 1);
  assert.ok(view.button(COPY.saving));
  await view.fail();
  await pause();
  assert.deepEqual(view.patches(), [], 'a save with no editor is never an empty signature');
  assert.ok(view.button(COPY.save), 'the button does not hang');
  assert.ok(view.container.textContent.includes('Not saved.'));
  assert.deepEqual(view.unhandled, []);
});

test('failure: "try again" loads the editor, and it then works normally', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await view.fail();
  await pause();
  const retry = view.boxes()[0].querySelector('[role="alert"] button');
  await flush(() => retry.click());
  assert.equal(view.pendingLoads(), 1, 'a new load was started');
  assert.ok(view.placeholder(), 'back to the loading placeholder');
  assert.equal(view.container.querySelector('.sig-editor [role="alert"]'), null);

  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor after retry' });
  assert.equal(view.pm().innerHTML, STORED_HTML);
  await flush(() => view.button(COPY.save).click());
  await waitFor(() => view.patches().length === 1, { message: 'the save' });
  assert.equal(view.patches()[0].body.signature_html, STORED_HTML);
});

// ===========================================================================
// Already loaded, and warming
// ===========================================================================

test('already loaded: the editor is there on the very first render of the modal', async (t) => {
  const view = await renderInboxes(t, { preloaded: true });
  await view.open();
  assert.equal(view.pendingLoads(), 0, 'nothing to fetch');
  assert.ok(view.pm(), 'the editor is mounted by the time the opening click has been processed');
  assert.equal(view.placeholder(), null);
  assert.equal(view.pm().innerHTML, STORED_HTML);
});

test('already loaded: closing and reopening does not go back through the placeholder', async (t) => {
  const view = await renderInboxes(t);
  await view.open();
  await view.arrive();
  await waitFor(() => view.pm(), { message: 'the editor' });
  await view.close();
  await view.open();
  assert.ok(view.pm(), 'second open: editor at once');
  assert.equal(view.placeholder(), null);
  assert.equal(view.pendingLoads(), 0);
});

test('warming: hovering or focusing an inbox row starts the fetch and opens nothing', async (t) => {
  const view = await renderInboxes(t);
  assert.equal(warmCalls, 0, 'rendering the page fetches nothing');
  await flush(() => { view.row().dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
  assert.equal(warmCalls, 1);
  await flush(() => { view.row().focus(); });
  assert.equal(warmCalls, 2);
  assert.equal(view.panel(), null, 'the modal is not opened by a hover or a focus');
  assert.equal(view.pendingLoads(), 0, 'and the form itself has not asked for anything');
});
