// ---------------------------------------------------------------------------
// Settings > Workspace > Morning brief (Pro feature morning_brief).
//
// Run with: npm run test:morning-brief-ui
//
// Renders the real MorningBriefSection against a stubbed
// /api/workspaces/[id]/morning-brief and asserts:
//   - NOT VISIBLE (pre-launch): renders nothing and makes no request;
//   - visible on Pro: loads, fills the browser time zone when never saved,
//     saves the whole form in one PUT, shows one line;
//   - visible below Pro: the form shows disabled with an upgrade link, and
//     Save never fires;
//   - a member (not owner/admin) sees it read-only with a note;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { MorningBriefSection, morningBriefAvailable, browserTimeZone } = await import('./MorningBriefSection.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const B = en.settings.morningBrief;

const WS = { id: 'ws-1' };
const INBOXES = [
  { id: '22222222-2222-4222-8222-222222222222', address: 'me@example.org', status: 'active' },
  { id: '33333333-3333-4333-8333-333333333333', address: 'new@example.org', status: 'pending' },
];
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
    if (!String(url).endsWith('/api/workspaces/ws-1/morning-brief')) return json(404, {});
    if (method === 'GET') {
      return json(200, {
        settings: state.stored,
        defaults: { enabled: false, hour: 7, timezone: 'UTC', locale: 'en', inbox_id: null, vip_senders: [] },
        status: null,
        allowed: state.allowed,
        can_manage: state.canManage ?? true,
        max_vips: 50,
      });
    }
    state.stored = { ...body, vip_senders: body.vip_senders.map(v => v.toLowerCase()) };
    return json(200, { settings: state.stored });
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

async function render(t, proFeatures) {
  const view = await mount(
    createElement(AppLocaleProvider, null, createElement(MorningBriefSection, { workspace: WS, inboxes: INBOXES, proFeatures })),
  );
  t.after(() => view.unmount());
  return view;
}

async function renderLoaded(t, proFeatures) {
  const view = await render(t, proFeatures);
  await waitFor(() => view.container.querySelector('[data-field="hour"]'), { message: 'form loaded' });
  return view;
}

const q = (view, sel) => view.container.querySelector(sel);
const saveButton = view => q(view, '[data-morning-brief] button');
const statusText = view => q(view, '[role="status"], [role="alert"]')?.textContent ?? '';

async function setValue(el, value) {
  await flush(async () => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test('every locale has every morning brief key, without < or an em dash', async () => {
  const keys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const want = keys(B).sort();
  for (const locale of ['en', 'es', 'fr', 'nb', 'de']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const section = messages.settings.morningBrief;
    assert.deepEqual(keys(section).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(section);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|30 days/.test(text), false, `${locale}: copy rules`);
    if (locale !== 'en') assert.notEqual(section.title, B.title, `${locale}: translated`);
  }
});

test('not visible: renders nothing and makes no request', async (t) => {
  const requests = stubFetch(t, { stored: null, allowed: false });
  assert.equal(morningBriefAvailable(null), false);
  assert.equal(morningBriefAvailable(HIDDEN), false);
  assert.equal(morningBriefAvailable(FREE), true);
  const view = await render(t, HIDDEN);
  await flush();
  assert.equal(view.container.querySelectorAll('[data-morning-brief]').length, 0);
  assert.equal(requests.length, 0);
});

test('on Pro: never saved fills the browser zone; Save sends the whole form', async (t) => {
  const state = { stored: null, allowed: true };
  const requests = stubFetch(t, state);
  const view = await renderLoaded(t, PRO);
  assert.equal(q(view, '[data-field="timezone"]').value, browserTimeZone());
  assert.equal(view.container.querySelectorAll('[data-pro-upsell]').length, 0);
  // Pending inboxes are not offered as a target.
  const options = [...q(view, '[data-field="inbox"]').options].map(o => o.value);
  assert.deepEqual(options, ['', INBOXES[0].id]);

  await flush(async () => { q(view, '#morning-brief-enabled').click(); });
  await setValue(q(view, '[data-field="hour"]'), '6');
  await setValue(q(view, '[data-field="inbox"]'), INBOXES[0].id);
  await setValue(q(view, '[data-field="vip"]'), 'Boss@Example.com\nvip.example');
  await flush(async () => { saveButton(view).click(); });
  await waitFor(() => statusText(view).length > 0, { message: 'saved line' });
  const put = requests.find(r => r.method === 'PUT');
  assert.deepEqual(put.body, {
    enabled: true,
    hour: 6,
    timezone: browserTimeZone(),
    locale: 'en',
    inbox_id: INBOXES[0].id,
    vip_senders: ['Boss@Example.com', 'vip.example'],
  });
  assert.equal(statusText(view), B.saved);
  assert.equal(q(view, '[data-field="vip"]').value, 'boss@example.com\nvip.example');
});

test('visible below Pro: disabled with an upgrade link, Save never fires', async (t) => {
  const requests = stubFetch(t, { stored: null, allowed: false });
  const view = await renderLoaded(t, FREE);
  assert.equal(view.container.querySelectorAll('[data-pro-upsell]').length, 1);
  assert.equal(q(view, '[data-pro-upsell] a').textContent, B.upgrade);
  assert.equal(q(view, '#morning-brief-enabled').disabled, true);
  assert.equal(q(view, '[data-field="hour"]').disabled, true);
  assert.equal(saveButton(view).disabled, true);
  await flush(async () => { saveButton(view).click(); });
  await flush();
  assert.equal(requests.filter(r => r.method === 'PUT').length, 0);
});

test('a member sees it read-only with a note', async (t) => {
  stubFetch(t, { stored: { enabled: true, hour: 8, timezone: 'Europe/Oslo', locale: 'en', inbox_id: INBOXES[0].id, vip_senders: [] }, allowed: true, canManage: false });
  const view = await renderLoaded(t, PRO);
  assert.equal(q(view, '[role="note"]').textContent, B.roleNote);
  assert.equal(q(view, '[data-field="timezone"]').value, 'Europe/Oslo');
  assert.equal(q(view, '[data-field="hour"]').value, '8');
  assert.equal(saveButton(view).disabled, true);
});
