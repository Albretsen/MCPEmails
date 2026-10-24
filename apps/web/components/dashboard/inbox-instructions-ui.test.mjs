// ---------------------------------------------------------------------------
// Inboxes > inbox > Advanced > Instructions for your AI (Pro feature
// inbox_instructions).
//
// Run with: npm run test:inbox-instructions-ui
//
// Renders the real InboxInstructionsEditor and InboxAdvancedSection against a
// stubbed /api/inboxes/[id]/instructions and asserts:
//   - NOT VISIBLE (pre-launch): no section for an inbox that had none, no
//     editor inside Advanced, and no request, ever;
//   - visible on Pro: loads, saves {instructions} with one line, clears;
//   - visible below Pro: the field shows disabled with an upgrade link, and
//     Save never fires;
//   - over the cap: Save is disabled and the counter says so;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { useTranslations } from 'next-intl';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
// The upgrade link is a next/link, which watches the viewport to prefetch.
// Same environment completion as inbox-cap-offer-ui.test.mjs: `self`, and an
// IntersectionObserver that never reports, so nothing is prefetched.
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { InboxInstructionsEditor } = await import('./InboxInstructionsEditor.jsx');
const { InboxAdvancedSection, inboxAdvancedAvailable, inboxInstructionsAvailable } = await import('./Pages.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const I = en.inboxes.detail.instructions;

// A Gmail API inbox: no folder choice, no connection type, so Advanced exists
// only because of the instructions.
const GMAIL = { id: 'ib-0002', label: 'support', address: 'support@example.com', provider: 'gmail', status: 'active', hasImap: false, connectionMode: null };

const HIDDEN = { visible: false, allowed: false };
const PRO = { visible: true, allowed: true };
const FREE = { visible: true, allowed: false };

function stubFetch(t, state) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (!String(url).endsWith('/api/inboxes/ib-0002/instructions')) return json(404, {});
    if (method === 'GET') {
      return json(200, { instructions: state.stored, updated_at: null, allowed: state.allowed, can_manage: true, max_chars: 2000 });
    }
    const text = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    state.stored = text === '' ? null : text;
    return json(200, { instructions: state.stored, updated_at: '2026-10-24T10:00:00.000Z' });
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

function Editor({ allowed }) {
  const t = useTranslations('dashboard');
  return createElement(InboxInstructionsEditor, { inbox: GMAIL, t, allowed });
}

function Advanced({ proFeatures }) {
  const t = useTranslations('dashboard');
  return createElement(InboxAdvancedSection, { inbox: GMAIL, t, proFeatures });
}

async function renderEditor(t, allowed) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Editor, { allowed })));
  t.after(() => view.unmount());
  await waitFor(() => view.container.querySelector('textarea')?.placeholder !== I.loading, { message: 'instructions loaded' });
  return view;
}

const textarea = view => view.container.querySelector('textarea');
const saveButton = view => view.container.querySelector('[data-inbox-instructions] button');
const statusText = view => view.container.querySelector('[role="status"], [role="alert"]')?.textContent ?? '';

async function type(el, value) {
  await flush(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('every locale has every Instructions key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(I).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'de']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const section = messages.inboxes.detail.instructions;
    assert.deepEqual(keys(section).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(section);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|mcpemails(?!\.)/.test(text), false, `${locale}: MCPEmails, one word`);
    if (locale !== 'en') assert.notEqual(section.title, I.title, `${locale}: translated, not English`);
  }
});

test('not visible: no Advanced for an inbox that had none, and no editor', () => {
  assert.equal(inboxInstructionsAvailable(GMAIL, null), false);
  assert.equal(inboxInstructionsAvailable(GMAIL, HIDDEN), false);
  assert.equal(inboxAdvancedAvailable(GMAIL), false);
  assert.equal(inboxAdvancedAvailable(GMAIL, HIDDEN), false);
  assert.equal(inboxInstructionsAvailable(GMAIL, FREE), true);
  assert.equal(inboxInstructionsAvailable(GMAIL, PRO), true);
  assert.equal(inboxInstructionsAvailable({ ...GMAIL, status: 'pending' }, PRO), false);
  assert.equal(inboxAdvancedAvailable(GMAIL, PRO), true);
});

test('not visible: opening Advanced fetches nothing and shows no instructions', async (t) => {
  const requests = stubFetch(t, { stored: 'rules', allowed: false });
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Advanced, { proFeatures: HIDDEN })));
  t.after(() => view.unmount());
  const details = view.container.querySelector('details.inbox-advanced-details');
  await flush(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(view.container.querySelectorAll('[data-inbox-instructions]').length, 0);
});

test('visible: nothing fetched until Advanced opens, then the editor loads', async (t) => {
  const requests = stubFetch(t, { stored: null, allowed: true });
  const view = await mount(createElement(AppLocaleProvider, null, createElement(Advanced, { proFeatures: PRO })));
  t.after(() => view.unmount());
  await flush();
  assert.equal(requests.length, 0);
  const details = view.container.querySelector('details.inbox-advanced-details');
  await flush(async () => {
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
  });
  await waitFor(() => view.container.querySelector('[data-inbox-instructions] textarea'), { message: 'editor after opening' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(view.container.querySelector('[data-inbox-instructions] h3').textContent, I.title);
});

test('on Pro: type, save, one line; clearing says so', async (t) => {
  const state = { stored: null, allowed: true };
  const requests = stubFetch(t, state);
  const view = await renderEditor(t, true);
  assert.equal(textarea(view).disabled, false);
  assert.equal(view.container.querySelectorAll('[data-pro-upsell]').length, 0);
  assert.equal(saveButton(view).disabled, true, 'nothing to save yet');

  await type(textarea(view), 'Sign as the Support Team.');
  assert.equal(saveButton(view).disabled, false);
  await flush(async () => { saveButton(view).click(); });
  await waitFor(() => statusText(view).length > 0, { message: 'saved line' });
  assert.deepEqual(requests.find(r => r.method === 'PUT').body, { instructions: 'Sign as the Support Team.' });
  assert.equal(statusText(view), I.saved);
  assert.equal(state.stored, 'Sign as the Support Team.');

  await type(textarea(view), '');
  await flush(async () => { saveButton(view).click(); });
  await waitFor(() => statusText(view) === I.cleared, { message: 'cleared line' });
  assert.equal(state.stored, null);
});

test('below Pro: shown disabled with an upgrade link, never saves', async (t) => {
  const requests = stubFetch(t, { stored: 'kept', allowed: false });
  const view = await renderEditor(t, false);
  assert.equal(textarea(view).disabled, true);
  assert.equal(textarea(view).value, 'kept');
  assert.equal(saveButton(view).disabled, true);
  const upsell = view.container.querySelector('[data-pro-upsell]');
  assert.equal(upsell.textContent.includes(I.proOnly), true);
  const link = upsell.querySelector('a');
  assert.equal(link.textContent, I.upgrade);
  assert.equal(link.getAttribute('href').includes('/pricing'), true);
  await flush(async () => { saveButton(view).click(); });
  assert.equal(requests.filter(r => r.method === 'PUT').length, 0);
});

test('over the cap: Save disabled and the counter turns red', async (t) => {
  stubFetch(t, { stored: null, allowed: true });
  const view = await renderEditor(t, true);
  await type(textarea(view), 'a'.repeat(2001));
  assert.equal(saveButton(view).disabled, true);
  const count = view.container.querySelector('.inbox-instructions-count');
  assert.equal(count.textContent, I.count.replace('{count}', '2001').replace('{max}', '2000'));
  assert.equal(count.style.color, 'var(--red-500)');
  await type(textarea(view), 'a'.repeat(2000));
  assert.equal(saveButton(view).disabled, false);
});
