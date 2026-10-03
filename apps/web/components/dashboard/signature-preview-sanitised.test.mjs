// ---------------------------------------------------------------------------
// Nothing renders signature HTML unless it came out of the one shared
// sanitiser.
//
// Run with: npm run test:signature-editor-ui
//
// WHY THIS EXISTS. The signature preview is `dangerouslySetInnerHTML`. It is
// safe for exactly one reason: every string that reaches it is the return
// value of `sanitizeSignatureHtml` from src/lib/sanitizeSignatureHtml.js, the
// same function the editor uses on load and on save. That function now arrives
// after the form does. The tempting mistakes that creates are all the same
// mistake: show the stored HTML "just until the sanitiser loads", or seed the
// preview from the raw value, or sanitise with something else in the meantime.
//
// So this replaces the sanitiser MODULE with a recording wrapper around the
// real function (every importer gets the wrapper: the loader, the form and the
// editor), watches the preview with a MutationObserver through whole sessions,
// and holds every string the preview ever contained to the set of strings the
// sanitiser returned. Nothing else is replaced; the loader is the real one.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

/** In order: every sanitiser call and every change of the preview. */
let events = [];
/** Every string the sanitiser has returned. */
let outputs = new Set();

const sanitiserUrl = new URL('../../src/lib/sanitizeSignatureHtml.js', import.meta.url).href;
const real = await import(sanitiserUrl);
const { default: realDefault, ...realNamed } = real;
mock.module(sanitiserUrl, {
  defaultExport: realDefault,
  namedExports: {
    ...realNamed,
    sanitizeSignatureHtml: (dirty) => {
      const clean = real.sanitizeSignatureHtml(dirty); // May throw (>100 KB): then nothing is recorded.
      outputs.add(clean);
      events.push({ type: 'sanitised', input: dirty, output: clean });
      return clean;
    },
  },
});

const { peekSignatureEditor } = await import('./signature-editor-loader.mjs');
const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const COPY = en.inboxes.detail.signature;

/** Markup that must never reach the DOM of the signature panel. */
const HOSTILE = '<p onclick="alert(1)">Ada</p><script>alert(1)</script><img src="http://evil.example/x.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe>';
const FORBIDDEN = ['onclick', 'onerror', '<script', 'javascript:', 'evil.example', '<iframe'];

function inbox(overrides = {}) {
  return {
    id: 'ib-0001', label: 'work', address: 'work@acme.com', provider: 'imap', service: 'imap',
    status: 'active', lastError: null, hasImap: true, calls: 3, createdAt: '2026-09-01T00:00:00.000Z',
    lastCallAt: null, draftEditorHidden: false, sendReviewMode: 'off', sendApprovalRequired: false,
    ...overrides,
  };
}

async function renderInboxes(t, inboxes) {
  events = [];
  outputs = new Set();
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method: init.method ?? 'GET', body });
    return { ok: true, status: 200, json: async () => ({ signature: body }) };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: 'ws-0001', slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true },
      workspaces: [], activeWorkspaceId: 'ws-0001', mcpUrl: 'https://mcpemails.com/api/mcp', userRole: 'owner',
      planLimits: { inboxes: 10, members: 5 }, stripePrices: {}, overviewStats: {}, activityFeed: [],
      inboxes, apiKeys: [], usageData: {}, auditLog: [], members: [], pendingInvites: [],
    })));

  // Record the preview body and the whole panel every time anything in the
  // page changes, so a value that is on screen for one render is still seen.
  const c = view.container;
  const panel = () => c.querySelector('details.inbox-sending-details');
  const snapshot = () => {
    const body = c.querySelector('.sig-preview-body');
    if (body) events.push({ type: 'preview', html: body.innerHTML });
    if (panel()) events.push({ type: 'panel', html: panel().innerHTML });
  };
  const observer = new window.MutationObserver(snapshot);
  observer.observe(c, { childList: true, subtree: true, attributes: true, characterData: true });

  t.after(async () => {
    observer.disconnect();
    await view.unmount();
    globalThis.fetch = previousFetch;
  });

  return {
    ...view,
    snapshot,
    patches: () => requests.filter((r) => r.method === 'PATCH'),
    pm: () => c.querySelector('.sig-content .ProseMirror'),
    textarea: () => c.querySelector('textarea.sig-html-textarea'),
    preview: () => c.querySelector('.sig-preview-body'),
    button: (label) => [...c.querySelectorAll('button')].find((b) => b.textContent === label),
    tab: (label) => [...c.querySelectorAll('.sig-mode-tab')].find((b) => b.textContent === label && !b.disabled),
    open: () => flush(() => { c.querySelector('tr[role="button"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }),
    async typeSource(value) {
      const ta = await waitFor(() => c.querySelector('textarea.sig-html-textarea'), { message: 'the source textarea' });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      await flush(() => { setter.call(ta, value); ta.dispatchEvent(new window.Event('input', { bubbles: true })); });
    },
  };
}

const settle = () => flush(() => new Promise((resolve) => setTimeout(resolve, 30)));

/** Every preview value seen so far was returned by the sanitiser (or is empty). */
function assertPreviewOnlyEverSanitised() {
  const previews = events.filter((e) => e.type === 'preview').map((e) => e.html);
  assert.ok(previews.length > 0, 'the preview was observed');
  for (const html of previews) {
    assert.ok(html === '' || outputs.has(html), `the preview showed a string the sanitiser never returned: ${html.slice(0, 200)}`);
  }
}

function assertNothingHostileEverRendered() {
  const panels = events.filter((e) => e.type === 'panel').map((e) => e.html.toLowerCase());
  assert.ok(panels.length > 0, 'the panel was observed');
  for (const html of panels) {
    for (const needle of FORBIDDEN) {
      assert.ok(!html.includes(needle), `"${needle}" was in the signature panel's DOM`);
    }
  }
}

test('stored hostile HTML: sanitised before anything shows it, and the preview only ever holds sanitiser output', async (t) => {
  const view = await renderInboxes(t, [inbox({ signatureHtml: HOSTILE, signatureText: null })]);
  await view.open();
  await waitFor(() => view.pm() && view.preview()?.innerHTML, { message: 'the editor and its preview' });
  await settle();
  view.snapshot();

  // The stored value went through the sanitiser...
  const firstClean = events.findIndex((e) => e.type === 'sanitised' && e.input === HOSTILE);
  assert.ok(firstClean >= 0, 'the stored HTML was passed to the shared sanitiser');
  // ...and no non-empty preview was shown before that happened.
  const firstShown = events.findIndex((e) => e.type === 'preview' && e.html !== '');
  assert.ok(firstShown > firstClean, 'nothing was previewed before the sanitiser had run');

  assertPreviewOnlyEverSanitised();
  assertNothingHostileEverRendered();
  assert.equal(view.preview().innerHTML, '<p>Ada</p><p>x</p>');
});

test('hostile HTML typed in source mode: the live preview only ever holds sanitiser output', async (t) => {
  const view = await renderInboxes(t, [inbox()]);
  await view.open();
  await waitFor(() => view.pm(), { message: 'the editor' });
  await flush(() => view.tab(COPY.modeHtml).click());
  for (const typed of ['<p>Hi', HOSTILE, `${HOSTILE}<table><tr><td onmouseover="x()">cell</td></tr></table>`, '<svg onload="alert(1)"></svg><b>ok</b>']) {
    await view.typeSource(typed);
    await settle();
  }
  view.snapshot();
  assertPreviewOnlyEverSanitised();
  // The textarea legitimately holds what was typed; the PREVIEW must not.
  const previews = events.filter((e) => e.type === 'preview').map((e) => e.html.toLowerCase());
  for (const html of previews) for (const needle of [...FORBIDDEN, 'onmouseover', 'onload', '<svg']) assert.ok(!html.includes(needle), needle);
  assert.equal(view.preview().innerHTML, '<b>ok</b>');
});

test('what a save sends is sanitiser output too, in both modes', async (t) => {
  const view = await renderInboxes(t, [inbox({ signatureHtml: HOSTILE, signatureText: null })]);
  await view.open();
  await waitFor(() => view.pm(), { message: 'the editor' });
  await flush(() => view.button(COPY.save).click());
  await waitFor(() => view.patches().length === 1, { message: 'the rich-mode save' });
  assert.ok(outputs.has(view.patches()[0].body.signature_html), 'rich mode: the saved HTML was returned by the sanitiser');

  await waitFor(() => view.button(COPY.save), { message: 'the button' });
  await flush(() => view.tab(COPY.modeHtml).click());
  await view.typeSource(HOSTILE);
  await flush(() => view.button(COPY.save).click());
  await waitFor(() => view.patches().length === 2, { message: 'the source-mode save' });
  const saved = view.patches()[1].body.signature_html;
  assert.ok(outputs.has(saved), 'source mode: the saved HTML was returned by the sanitiser');
  for (const needle of FORBIDDEN) assert.ok(!saved.toLowerCase().includes(needle), needle);
});

test('one sanitiser: the form, the loader and the editor all hold the same function', async () => {
  const pair = peekSignatureEditor();
  assert.ok(pair, 'the editor pair has loaded by now');
  const shared = await import(sanitiserUrl);
  assert.equal(pair.sanitizeSignatureHtml, shared.sanitizeSignatureHtml,
    'the function handed to the form is the module export, which here is the recording wrapper');
  // And the editor's own calls went through it: loading stored HTML calls the
  // sanitiser from inside SignatureRichEditor, and those calls were recorded.
  assert.ok(events.some((e) => e.type === 'sanitised'), 'calls were recorded in the last session');
});

test('the source: one dangerouslySetInnerHTML for signatures, fed only by sanitiser output', () => {
  const pages = readFileSync(new URL('./Pages.jsx', import.meta.url), 'utf8');
  const between = (start, end) => {
    const from = pages.indexOf(start);
    assert.ok(from >= 0, `${start} exists`);
    const to = pages.indexOf(end, from + start.length);
    assert.ok(to > from, `${end} follows ${start}`);
    return pages.slice(from, to);
  };

  const preview = between('function SignaturePreview(', '\nfunction ');
  assert.equal(preview.match(/dangerouslySetInnerHTML/g).length, 1);
  assert.match(preview, /dangerouslySetInnerHTML=\{\{ __html: html \|\| '' \}\}/, 'it renders its `html` prop and nothing else');

  const form = between('function SignatureEditor(', '\n/* A label/value line');
  assert.equal((form.match(/dangerouslySetInnerHTML/g) ?? []).length, 0, 'the form itself injects no HTML');
  assert.equal((between('function SignatureEditorPlaceholder(', '\n/** Order matters').match(/dangerouslySetInnerHTML|signatureHtml/g) ?? []).length, 0,
    'the loading placeholder renders nothing from the stored signature');

  // The preview's `html` prop is the `previewHtml` state, and every write to
  // that state is '' or a value that came from the sanitiser.
  assert.match(form, /<SignaturePreview\s+html=\{previewHtml\}/);
  const writes = [...form.matchAll(/setPreviewHtml\(([^)]*)\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(writes, ["''", "''", 'html', 'seed']);
  assert.match(form, /const html = typeof sourceHtml === 'string'\s*\? sanitizeSignatureHtml\(sourceHtml\)\s*: editorRef\.current\.getHTML\(\);/,
    '`html` is the sanitiser\'s return value, or the editor handle\'s getHTML(), which sanitises');
  assert.match(form, /const seed = \(inbox\.signatureHtml && inbox\.signatureHtml\.trim\(\)\)\s*\? sanitizeSignatureHtml\(inbox\.signatureHtml\)\s*: '';/,
    '`seed` is the sanitiser\'s return value');
  assert.equal((form.match(/const \{ sanitizeSignatureHtml \} = /g) ?? []).length, 2,
    'and that sanitiser is taken from the loaded pair both times, never imported or defined locally');

  const editor = readFileSync(new URL('./SignatureRichEditor.jsx', import.meta.url), 'utf8');
  assert.match(editor, /getHTML\(\) \{\s*if \(mode === 'html'\) return sanitizeSignatureHtml\(htmlSource\);\s*if \(!editor\) return '';\s*return sanitizeSignatureHtml\(editor\.getHTML\(\)\);/,
    'the editor handle\'s getHTML() returns sanitiser output in both modes');
});
