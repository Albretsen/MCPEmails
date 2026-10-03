// ---------------------------------------------------------------------------
// The signature editor, as the inbox detail modal mounts it: what a person
// sees, and exactly what a save sends.
//
// Run with: npm run test:signature-editor-ui
//
// WHY THIS EXISTS. The editor is TipTap + ProseMirror + DOMPurify, the largest
// single piece of the dashboard's JavaScript, and it is only ever seen inside a
// collapsed "Signature & sending" panel of one modal. Anything that changes HOW
// that code reaches the browser must leave what it DOES untouched, and "it
// still renders" is not that. What matters is the markup a save PATCHes, byte
// for byte, because that string is injected raw into outgoing mail.
//
// So this renders the REAL `DashboardApp` inside the real `AppLocaleProvider`,
// opens the modal by clicking the inbox row, and drives the real editor. The
// assertion surface is the PATCH body, the live preview and the editor's DOM.
// `fetch` is the only thing replaced.
//
// ON DRIVING TIPTAP. jsdom has no layout and no real selection, so a keystroke
// cannot be typed into a contenteditable. TipTap hangs its own instance on the
// editable element (`element.editor`), and these tests insert text and select
// through that instance's commands: the same transaction path a keystroke
// takes, including the `onUpdate` that feeds the live preview. Every FORMATTING
// action is a real click on the real toolbar button.
//
// ON WAITING. Every read that depends on the editor being there goes through
// `waitFor`, never a fixed sleep and never "it is synchronous today". The
// values asserted are exact; only the moment they appear is left open.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

const window = installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const COPY = en.inboxes.detail.signature;
const WORKSPACE_ID = 'ws-0001';
const INBOX_ID = 'ib-0001';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const STORED_HTML = '<p>Ada <strong>Lovelace</strong></p><p><a href="https://acme.com">acme.com</a></p>';
/** STORED_HTML after TipTap has loaded it: the Link extension adds target/rel. */
const STORED_HTML_AS_EDITED =
  '<p>Ada <strong>Lovelace</strong></p><p><a target="_blank" rel="noopener noreferrer" href="https://acme.com">acme.com</a></p>';
const STORED_TEXT = 'Ada Lovelace\nacme.com';

/**
 * Renders the dashboard on the Inboxes page and records every request.
 * A PATCH is answered the way the route answers it: the saved signature echoed
 * back under `signature`, which App.jsx merges into the inbox.
 */
async function renderInboxes(t, { inboxes = [inbox()], respond } = {}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const request = { url: String(url), method: init.method ?? 'GET', body, raw: init.body };
    requests.push(request);
    if (respond) return respond(request);
    return {
      ok: true,
      status: 200,
      json: async () => ({ signature: { ...body, signature_source: 'manual' } }),
    };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
      user: { displayName: 'Ada', email: 'ada@acme.com', initials: 'A', id: 'u-0001' },
      workspace: { id: WORKSPACE_ID, slug: 'acme', plan: 'pro', compedScale: null, displayName: 'Acme', isOwner: true },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
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
  });

  const c = view.container;
  const api = {
    ...view,
    requests,
    patches: () => requests.filter((r) => r.method === 'PATCH'),
    panel: () => c.querySelector('details.inbox-sending-details'),
    editorBox: () => c.querySelector('.sig-editor'),
    /** The live ProseMirror element, once TipTap has mounted. */
    pm: () => c.querySelector('.sig-content .ProseMirror'),
    textarea: () => c.querySelector('textarea.sig-html-textarea'),
    preview: () => c.querySelector('.sig-preview-body'),
    button: (label) => [...c.querySelectorAll('button')].find((b) => b.textContent === label),
    toolbar: (title) => c.querySelector(`.sig-toolbar button[title="${title}"]`),
    tab: (label) => [...c.querySelectorAll('.sig-mode-tab')].find((b) => b.textContent === label),
    /** Opens the inbox detail modal by clicking the row, as a person does. */
    async open() {
      const row = c.querySelector('tr[role="button"]');
      assert.ok(row, 'the inboxes table should have a clickable row');
      await flush(() => { row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    },
    /** Opens the modal and waits until the editor is usable in either mode. */
    async openReady() {
      await api.open();
      await waitFor(() => api.pm() || api.textarea(), { message: 'the signature editor to mount' });
    },
    async close() {
      const x = c.querySelector(`button[aria-label="${en.inboxes.detail.close}"]`);
      assert.ok(x, 'the modal has a close button');
      await flush(() => x.click());
    },
    /** Clicks Save and returns the PATCH it produced. */
    async save() {
      const before = api.patches().length;
      await flush(() => api.button(COPY.save).click());
      await waitFor(() => api.patches().length > before, { message: 'the signature PATCH' });
      return api.patches().at(-1);
    },
    async click(el) {
      assert.ok(el, 'the element to click exists');
      await flush(() => el.click());
    },
    /** Runs TipTap commands on the mounted editor (see the header note). */
    async edit(fn) {
      const pm = await waitFor(() => api.pm(), { message: 'the rich editor' });
      assert.ok(pm.editor, 'TipTap exposes its instance on the editable element');
      await flush(() => { fn(pm.editor); });
    },
    /** Types into the HTML source textarea the way React's onChange sees it. */
    async typeSource(value) {
      const ta = await waitFor(() => api.textarea(), { message: 'the HTML source textarea' });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      await flush(() => {
        setter.call(ta, value);
        ta.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async toSourceMode() {
      await api.click(api.tab(COPY.modeHtml));
      await waitFor(() => api.textarea(), { message: 'HTML source mode' });
    },
    async toRichMode() {
      await api.click(api.tab(COPY.modeRich));
      await waitFor(() => api.pm(), { message: 'rich mode' });
    },
  };
  return api;
}

// ===========================================================================
// Mounting
// ===========================================================================

test('mount: the editor renders inside the collapsed "Signature & sending" panel, complete', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();

  const panel = view.panel();
  assert.ok(panel, 'the panel is a <details>');
  assert.equal(panel.open, false, 'and it starts collapsed');
  assert.ok(panel.contains(view.editorBox()), 'the editor lives inside it');

  assert.equal(view.container.querySelectorAll('.sig-editor').length, 1, 'exactly one editor box');
  assert.equal(view.container.querySelector('.sig-editor--loading'), null, 'no placeholder is left behind');

  const tabs = [...view.container.querySelectorAll('.sig-mode-tab')];
  assert.deepEqual(tabs.map((b) => b.textContent), [COPY.modeRich, COPY.modeHtml]);
  assert.deepEqual(tabs.map((b) => b.getAttribute('aria-selected')), ['true', 'false']);
  assert.equal(view.container.querySelector('.sig-mode-tabs').getAttribute('aria-label'), COPY.modeLabel);

  const titles = [...view.container.querySelectorAll('.sig-toolbar .sig-tb-btn')].map((b) => b.getAttribute('title'));
  assert.deepEqual(titles, [
    'Bold', 'Italic', 'Underline',
    'Heading', 'Bullet list', 'Numbered list',
    'Align left', 'Align center', 'Align right',
    'Add / edit link', 'Text color', 'Insert image',
  ]);
  assert.equal(view.container.querySelectorAll('.sig-toolbar .sig-tb-sep').length, 4);
  assert.equal(view.container.querySelector('.sig-toolbar input[type="color"]').value, '#0b1020');
  assert.equal(view.container.querySelector('.sig-toolbar input[type="file"]').getAttribute('accept'),
    'image/png,image/jpeg,image/gif,image/webp');

  const pm = view.pm();
  assert.equal(pm.getAttribute('contenteditable'), 'true');
  assert.equal(pm.getAttribute('role'), 'textbox');
  assert.equal(pm.innerHTML, '<p><br class="ProseMirror-trailingBreak"></p>', 'an inbox with no signature opens empty');

  assert.ok(view.button(COPY.save), 'the save button is there');
  assert.equal(view.button(COPY.save).disabled, false);
});

test('mount: the pieces of the signature form come in a fixed order', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  const order = [
    view.container.querySelector('.review-mode'),
    view.editorBox(),
    view.container.querySelector('.sig-preview'),
    view.container.querySelector('select.input'),
    view.button(COPY.save),
  ];
  for (const el of order) assert.ok(el, 'every part of the form is rendered');
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      order[i - 1].compareDocumentPosition(order[i]) & window.Node.DOCUMENT_POSITION_FOLLOWING,
      `part ${i} follows part ${i - 1}`,
    );
  }
  // The editor and its preview share the wrapper that dims when disabled.
  assert.equal(view.editorBox().parentElement, view.container.querySelector('.sig-preview').parentElement);
  assert.equal(view.editorBox().nextElementSibling, view.container.querySelector('.sig-preview'));
});

// ===========================================================================
// Loading an existing signature
// ===========================================================================

test('load: a stored HTML signature is in the editor and in the preview', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT })] });
  await view.openReady();
  assert.equal(view.pm().innerHTML, STORED_HTML_AS_EDITED);
  await waitFor(() => view.preview().innerHTML === STORED_HTML_AS_EDITED, { message: 'the preview to show the editor HTML' });
  assert.equal(view.tab(COPY.modeRich).getAttribute('aria-selected'), 'true');
});

test('load: a text-only signature becomes one paragraph per line', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: null, signatureText: 'Ada <Lovelace>\n\nAcme & Co' })] });
  await view.openReady();
  // The blank line is `<br>` from textToHtml, which TipTap wraps in its own
  // paragraph: a hard break plus ProseMirror's trailing break in the DOM.
  assert.equal(view.pm().innerHTML, '<p>Ada &lt;Lovelace&gt;</p><p><br><br class="ProseMirror-trailingBreak"></p><p>Acme &amp; Co</p>');
  await waitFor(() => view.preview().innerHTML === '<p>Ada &lt;Lovelace&gt;</p><p><br></p><p>Acme &amp; Co</p>',
    { message: 'the preview to show the text-seeded signature' });
});

test('load: a Gmail-imported signature shows the hint and loads its HTML', async (t) => {
  const view = await renderInboxes(t, {
    inboxes: [inbox({ signatureSource: 'gmail_import', signatureHtml: '<div>Ada</div><div>Acme</div>', signatureText: null })],
  });
  await view.openReady();
  assert.ok(view.container.textContent.includes(COPY.importedHint));
  assert.equal(view.pm().innerHTML, '<p>Ada</p><p>Acme</p>');
});

test('load: a signature with a table opens in HTML source mode, untouched', async (t) => {
  const table = '<table><tbody><tr><td>Ada</td><td>Acme</td></tr></tbody></table>';
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: table, signatureText: 'Ada\nAcme' })] });
  await view.openReady();
  assert.equal(view.tab(COPY.modeHtml).getAttribute('aria-selected'), 'true');
  assert.equal(view.textarea().value, table);
  assert.equal(view.textarea().getAttribute('placeholder'), COPY.htmlSourcePlaceholder);
  assert.ok(view.container.textContent.includes(COPY.htmlSourceTableHint));
  assert.equal(view.container.querySelector('.sig-toolbar'), null, 'no rich toolbar in source mode');
  await waitFor(() => view.preview().innerHTML === table, { message: 'the preview to show the table' });
});

test('load: stored HTML is sanitised before it reaches the editor or the preview', async (t) => {
  const dirty = '<p onclick="alert(1)">Ada</p><script>alert(1)</script><img src="http://evil.example/x.png"><p><a href="javascript:alert(1)">x</a></p>';
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: dirty, signatureText: null })] });
  await view.openReady();
  assert.equal(view.pm().innerHTML, '<p>Ada</p><p>x</p>');
  await waitFor(() => view.preview().innerHTML === '<p>Ada</p><p>x</p>', { message: 'the sanitised preview' });
  assert.equal(view.container.querySelector('.sig-preview-body script'), null);
  assert.equal(view.container.querySelector('.sig-preview-body img'), null);
});

// ===========================================================================
// Typing and formatting
// ===========================================================================

test('typing: inserted text reaches the live preview and the save', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.edit((editor) => editor.commands.insertContent('Ada Lovelace'));
  assert.equal(view.pm().innerHTML, '<p>Ada Lovelace</p>');
  await waitFor(() => view.preview().innerHTML === '<p>Ada Lovelace</p>', { message: 'the live preview' });

  const patch = await view.save();
  assert.equal(patch.url, `/api/inboxes/${INBOX_ID}`);
  assert.deepEqual(patch.body, {
    signature_html: '<p>Ada Lovelace</p>',
    signature_text: 'Ada Lovelace',
    signature_enabled: true,
    signature_reply_mode: 'first_only',
    send_review_mode: 'off',
    send_approval_required: false,
  });
});

/** Types one line, selects it, clicks one toolbar button, and saves. */
async function formatAndSave(t, title) {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.edit((editor) => { editor.commands.insertContent('Ada'); editor.commands.selectAll(); });
  await view.click(view.toolbar(title));
  const active = view.toolbar(title).className.includes('is-active');
  const patch = await view.save();
  return { html: patch.body.signature_html, text: patch.body.signature_text, active };
}

// The trailing `<p></p>` after a heading or a list is TipTap's own: StarterKit
// keeps an empty paragraph after a final non-paragraph block so the caret has
// somewhere to go. It is part of what a save sends today, so it is pinned.
// The plain-text half is TipTap's getText(), which puts a blank line at every
// block boundary, nested ones included: hence the leading newlines for a list.
//
// Last column: whether the toolbar button reads as pressed afterwards. With
// everything selected, a block-level change leaves the selection spanning the
// new block AND that trailing paragraph, so TipTap reports the block type as
// not active; a mark or an alignment applies to the whole selection and is.
const FORMATS = [
  ['Bold', '<p><strong>Ada</strong></p>', 'Ada', true],
  ['Italic', '<p><em>Ada</em></p>', 'Ada', true],
  ['Underline', '<p><u>Ada</u></p>', 'Ada', true],
  ['Heading', '<h2>Ada</h2><p></p>', 'Ada\n\n', false],
  ['Bullet list', '<ul><li><p>Ada</p></li></ul><p></p>', '\n\n\n\nAda\n\n', false],
  ['Numbered list', '<ol><li><p>Ada</p></li></ol><p></p>', '\n\n\n\nAda\n\n', false],
  ['Align center', '<p style="text-align: center">Ada</p>', 'Ada', true],
  ['Align right', '<p style="text-align: right">Ada</p>', 'Ada', true],
];

for (const [title, expected, expectedText, expectedActive] of FORMATS) {
  test(`formatting: ${title} saves exactly ${expected}`, async (t) => {
    const { html, text, active } = await formatAndSave(t, title);
    assert.equal(html, expected);
    assert.equal(text, expectedText);
    assert.equal(active, expectedActive, 'the pressed state of the toolbar button');
  });
}

test('formatting: Align left on default text saves an explicit left alignment', async (t) => {
  const { html } = await formatAndSave(t, 'Align left');
  assert.equal(html, '<p style="text-align: left">Ada</p>');
});

test('formatting: a text colour is saved as an inline style', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.edit((editor) => { editor.commands.insertContent('Ada'); editor.commands.selectAll(); });
  const picker = view.container.querySelector('.sig-toolbar input[type="color"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await flush(() => {
    setter.call(picker, '#ff0000');
    picker.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const patch = await view.save();
  assert.equal(patch.body.signature_html, '<p><span style="color: rgb(255, 0, 0)">Ada</span></p>');
});

test('formatting: a link is added through the prompt, and a cancelled prompt changes nothing', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.edit((editor) => { editor.commands.insertContent('Ada'); editor.commands.selectAll(); });

  const previousPrompt = window.prompt;
  t.after(() => { window.prompt = previousPrompt; });

  window.prompt = () => null; // Cancel.
  await view.click(view.toolbar('Add / edit link'));
  assert.equal(view.pm().innerHTML, '<p>Ada</p>', 'cancelling the prompt leaves the text alone');

  window.prompt = () => 'ftp://acme.com';
  await view.click(view.toolbar('Add / edit link'));
  assert.equal(view.pm().innerHTML, '<p>Ada</p>', 'a scheme outside http/https/mailto is refused');
  assert.equal(view.container.querySelector('.sig-editor-error').textContent,
    'Links must start with http://, https:// or mailto:');

  window.prompt = () => ' https://acme.com ';
  await view.click(view.toolbar('Add / edit link'));
  const patch = await view.save();
  assert.equal(patch.body.signature_html,
    '<p><a target="_blank" rel="noopener noreferrer" href="https://acme.com">Ada</a></p>');
});

test('formatting: an uploaded image is inserted by its returned URL', async (t) => {
  const view = await renderInboxes(t, {
    respond: async (request) => {
      if (request.url.endsWith('/signature/image')) {
        return { ok: true, status: 200, json: async () => ({ url: 'https://cdn.example.com/logo.png' }) };
      }
      return { ok: true, status: 200, json: async () => ({ signature: request.body }) };
    },
  });
  await view.openReady();
  const input = view.container.querySelector('.sig-toolbar input[type="file"]');

  const pick = async (file) => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await flush(() => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  };

  await pick(new window.File(['x'], 'notes.txt', { type: 'text/plain' }));
  assert.equal(view.container.querySelector('.sig-editor-error').textContent,
    'Unsupported image type. Use PNG, JPEG, GIF or WebP.');
  assert.equal(view.requests.length, 0, 'an unsupported file is never uploaded');

  await pick(new window.File(['x'], 'logo.png', { type: 'image/png' }));
  await waitFor(() => view.pm().querySelector('img'), { message: 'the uploaded image' });
  const upload = view.requests.find((r) => r.url === `/api/inboxes/${INBOX_ID}/signature/image`);
  assert.ok(upload, 'the image went to the inbox signature image route');
  assert.equal(upload.method, 'POST');

  const patch = await view.save();
  assert.equal(patch.body.signature_html, '<img src="https://cdn.example.com/logo.png"><p></p>');
});

// ===========================================================================
// HTML source mode, and what the sanitiser lets through on save
// ===========================================================================

/**
 * Each row: what is pasted into HTML source mode, and the exact
 * `signature_html` / `signature_text` the save sends. Source mode never
 * round-trips through TipTap, so this is the sanitiser's own output.
 */
const SANITISE_ON_SAVE = [
  {
    name: 'plain formatting passes through',
    input: '<p>Ada <strong>Lovelace</strong></p><p><em>Acme</em></p>',
    html: '<p>Ada <strong>Lovelace</strong></p><p><em>Acme</em></p>',
    text: 'Ada Lovelace\nAcme',
  },
  {
    name: 'a <script> is removed, its neighbours kept',
    input: '<p>Ada</p><script>alert(1)</script><p>Acme</p>',
    html: '<p>Ada</p><p>Acme</p>',
    text: 'Ada\nAcme',
  },
  {
    name: 'event handler attributes are dropped',
    input: '<p onclick="alert(1)" onmouseover="x()">Ada</p>',
    html: '<p>Ada</p>',
    text: 'Ada',
  },
  {
    name: 'a javascript: link loses its href',
    input: '<a href="javascript:alert(1)">Ada</a>',
    html: '<a>Ada</a>',
    text: 'Ada',
  },
  {
    name: 'an https link survives, and target=_blank gains rel',
    input: '<a href="https://acme.com" target="_blank">Acme</a>',
    html: '<a href="https://acme.com" target="_blank" rel="noopener noreferrer">Acme</a>',
    text: 'Acme',
  },
  {
    name: 'an http image is dropped, an https image is kept',
    input: '<img src="http://acme.com/a.png"><img src="https://acme.com/b.png" alt="logo" width="80">',
    html: '<img src="https://acme.com/b.png" alt="logo" width="80">',
    text: '',
  },
  {
    name: 'a data: image is dropped',
    input: '<p>Ada</p><img src="data:image/png;base64,AAAA">',
    html: '<p>Ada</p>',
    text: 'Ada',
  },
  {
    name: 'iframe, svg, style, form and object are removed',
    input: '<iframe src="https://x.example"></iframe><svg><circle/></svg><style>p{color:red}</style><form><input></form><object></object><p>Ada</p>',
    html: '<p>Ada</p>',
    text: 'Ada',
  },
  {
    name: 'data-* and unknown attributes are stripped',
    input: '<p data-x="1" id="sig" class="c" title="t">Ada</p>',
    html: '<p>Ada</p>',
    text: 'Ada',
  },
  {
    name: 'an unsafe style declaration is filtered, a safe one kept',
    input: '<p style="color: red; position: fixed; background: url(javascript:alert(1))">Ada</p>',
    html: '<p style="color: red">Ada</p>',
    text: 'Ada',
  },
  {
    name: 'a table layout is preserved exactly',
    input: '<table><tbody><tr><td>Ada Lovelace</td><td>Founder</td></tr><tr><td colspan="2">acme.com</td></tr></tbody></table>',
    html: '<table><tbody><tr><td>Ada Lovelace</td><td>Founder</td></tr><tr><td>acme.com</td></tr></tbody></table>',
    text: 'Ada Lovelace\nFounder\n\nacme.com',
  },
];

for (const row of SANITISE_ON_SAVE) {
  test(`sanitise on save: ${row.name}`, async (t) => {
    const view = await renderInboxes(t);
    await view.openReady();
    await view.toSourceMode();
    await view.typeSource(row.input);
    await waitFor(() => view.preview().innerHTML === row.html, { message: `the live preview to be ${row.html}` });
    const patch = await view.save();
    assert.equal(patch.body.signature_html, row.html);
    assert.equal(patch.body.signature_text, row.text);
  });
}

test('source mode: switching from Rich seeds the textarea with the editor HTML', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT })] });
  await view.openReady();
  await view.toSourceMode();
  assert.equal(view.textarea().value, STORED_HTML_AS_EDITED);
  assert.equal(view.tab(COPY.modeHtml).getAttribute('aria-selected'), 'true');
});

test('source mode: switching back to Rich loads the source, simplifying a table', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.toSourceMode();
  await view.typeSource('<table><tbody><tr><td>Ada</td><td>Acme</td></tr></tbody></table><p><strong>Bye</strong></p>');
  await view.toRichMode();
  assert.equal(view.pm().innerHTML, '<p>AdaAcme</p><p><strong>Bye</strong></p>');
  const patch = await view.save();
  assert.equal(patch.body.signature_html, '<p>AdaAcme</p><p><strong>Bye</strong></p>');
  assert.equal(patch.body.signature_text, 'AdaAcme\n\nBye');
});

test('too large: an oversized signature is refused at save, with the message, and nothing is sent', async (t) => {
  const view = await renderInboxes(t);
  await view.openReady();
  await view.toSourceMode();
  await view.typeSource(`<p>${'a'.repeat(101 * 1024)}</p>`);
  await waitFor(() => view.container.textContent.includes(COPY.previewTooLarge), { message: 'the too-large preview' });
  await view.click(view.button(COPY.save));
  await waitFor(() => view.container.textContent.includes(COPY.tooLarge), { message: 'the too-large error' });
  assert.equal(view.patches().length, 0, 'an oversized signature is never PATCHed');

  // And it blocks the way back to Rich text, with its own message.
  await view.click(view.tab(COPY.modeRich));
  await waitFor(() => view.container.textContent.includes(COPY.htmlSourceTooLarge), { message: 'the mode-switch error' });
  assert.ok(view.textarea(), 'still in source mode');
});

// ===========================================================================
// The surrounding controls ride along in the same save
// ===========================================================================

test('save: the enabled toggle, reply mode and review mode are sent with the signature', async (t) => {
  const view = await renderInboxes(t, {
    inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT, signatureEnabled: true, signatureReplyMode: 'always' })],
  });
  await view.openReady();

  const select = view.container.querySelector('details.inbox-sending-details select.input');
  assert.equal(select.value, 'always');
  await flush(() => {
    select.value = 'never';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  const dashboardRadio = view.container.querySelector('input[name="send-review-mode"][value="dashboard"]');
  await view.click(dashboardRadio);

  const patch = await view.save();
  assert.deepEqual(patch.body, {
    signature_html: STORED_HTML_AS_EDITED,
    signature_text: 'Ada Lovelace\n\nacme.com',
    signature_enabled: true,
    signature_reply_mode: 'never',
    send_review_mode: 'dashboard',
    send_approval_required: true,
  });
});

test('save: unticking Enabled disables the editor and is saved as false', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT })] });
  await view.openReady();
  const enabled = view.panel().querySelector('h3 + label input[type="checkbox"]');
  assert.equal(enabled.checked, true);
  await view.click(enabled);
  await waitFor(() => view.editorBox().className.includes('is-disabled'), { message: 'the editor to dim' });
  // The editable element itself stays contenteditable: TipTap's useEditor
  // deliberately keeps its own `isEditable` when options change. What stops a
  // person typing is the wrapper's `pointer-events: none` asserted below.
  assert.equal(view.pm().getAttribute('contenteditable'), 'true');
  assert.equal(view.toolbar('Bold').disabled, true);
  assert.equal(view.editorBox().parentElement.style.pointerEvents, 'none');

  const patch = await view.save();
  assert.equal(patch.body.signature_enabled, false);
  assert.equal(patch.body.signature_html, STORED_HTML_AS_EDITED, 'a disabled signature still saves its content');
});

test('save: the button shows Saving… and is disabled until the request settles', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const view = await renderInboxes(t, {
    respond: async (request) => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ signature: request.body }) };
    },
  });
  await view.openReady();
  await view.click(view.button(COPY.save));
  const saving = await waitFor(() => view.button(COPY.saving), { message: 'the Saving… label' });
  assert.equal(saving.disabled, true);
  assert.equal(view.patches().length, 1);
  await flush(() => { release(); });
  await waitFor(() => view.button(COPY.save), { message: 'the label to return' });
  assert.equal(view.patches().length, 1, 'one click, one PATCH');
});

// ===========================================================================
// Cancel: closing without saving
// ===========================================================================

test('cancel: closing the modal after an edit sends nothing, and reopening shows the stored signature', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT })] });
  await view.openReady();
  await view.edit((editor) => editor.commands.insertContentAt(editor.state.doc.content.size, '<p>unsaved</p>'));
  assert.ok(view.pm().innerHTML.includes('unsaved'));

  await view.close();
  assert.equal(view.editorBox(), null, 'the modal is gone, and the editor with it');
  assert.equal(view.patches().length, 0, 'closing is not saving');

  await view.openReady();
  assert.equal(view.pm().innerHTML, STORED_HTML_AS_EDITED, 'the discarded edit does not come back');
  await waitFor(() => view.preview().innerHTML === STORED_HTML_AS_EDITED, { message: 'the stored preview' });
  assert.equal(view.patches().length, 0);
});

test('cancel: clicking the scrim closes without saving', async (t) => {
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT })] });
  await view.openReady();
  await view.edit((editor) => editor.commands.insertContent('x'));
  await flush(() => { view.container.querySelector('.scrim').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  assert.equal(view.editorBox(), null);
  assert.equal(view.patches().length, 0);
});

// ===========================================================================
// An immediate save after open
// ===========================================================================

test('immediate save: Save clicked in the same breath as opening sends the STORED signature, never an empty one', async (t) => {
  const view = await renderInboxes(t, {
    inboxes: [inbox({ signatureHtml: STORED_HTML, signatureText: STORED_TEXT, signatureReplyMode: 'always' })],
  });
  // No openReady(): the click on Save comes straight after the click that
  // opens the modal, with no wait for the editor in between.
  await view.open();
  const save = view.button(COPY.save);
  assert.ok(save, 'the Save button is there as soon as the modal is');
  await flush(() => save.click());
  await waitFor(() => view.patches().length > 0, { message: 'the immediate save to be sent' });

  assert.equal(view.patches().length, 1, 'exactly one PATCH');
  assert.deepEqual(view.patches()[0].body, {
    signature_html: STORED_HTML_AS_EDITED,
    signature_text: 'Ada Lovelace\n\nacme.com',
    signature_enabled: true,
    signature_reply_mode: 'always',
    send_review_mode: 'off',
    send_approval_required: false,
  });
});

test('immediate save: a table signature saved straight after opening is sent untouched', async (t) => {
  const table = '<table><tbody><tr><td>Ada</td><td>Acme</td></tr></tbody></table>';
  const view = await renderInboxes(t, { inboxes: [inbox({ signatureHtml: table, signatureText: 'Ada\nAcme' })] });
  await view.open();
  await flush(() => view.button(COPY.save).click());
  await waitFor(() => view.patches().length > 0, { message: 'the immediate save to be sent' });
  assert.equal(view.patches()[0].body.signature_html, table);
  assert.equal(view.patches()[0].body.signature_text, 'Ada\nAcme');
});

test('reopen: a second inbox opens with its own signature, not the first one', async (t) => {
  const view = await renderInboxes(t, {
    inboxes: [
      inbox({ signatureHtml: '<p>First</p>', signatureText: 'First' }),
      inbox({ id: 'ib-0002', label: 'sales', address: 'sales@acme.com', signatureHtml: '<p>Second</p>', signatureText: 'Second' }),
    ],
  });
  await view.openReady();
  assert.equal(view.pm().innerHTML, '<p>First</p>');
  await view.close();

  const rows = view.container.querySelectorAll('tr[role="button"]');
  await flush(() => { rows[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await waitFor(() => view.pm(), { message: 'the second editor' });
  assert.equal(view.pm().innerHTML, '<p>Second</p>');
  await waitFor(() => view.preview().innerHTML === '<p>Second</p>', { message: 'the second preview' });
  const patch = await view.save();
  assert.equal(patch.url, '/api/inboxes/ib-0002');
  assert.equal(patch.body.signature_html, '<p>Second</p>');
});
