// ---------------------------------------------------------------------------
// Overview > "Your first week" checklist: the WIRING.
//
// Run with: npm run test:first-week-ui
//
// lib/onboarding/first-week-checklist.test.ts proves the rules. This renders
// the real FirstWeekChecklist in the real AppLocaleProvider with English
// messages, stubs only `fetch`, and checks what reaches the screen:
//   - nothing for a non-owner, and no request either;
//   - nothing when the route says the owner is not eligible;
//   - the items in order, ticked from the counts, with n/3 progress and three
//     copyable starter prompts;
//   - the Reconnect row calls the reconnect flow with that inbox;
//   - Dismiss hides the card at once and POSTs to the route;
//   - every locale has every key, without '<' or an em dash.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { FirstWeekChecklist } = await import('./FirstWeekChecklist.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const F = en.firstWeek;

const INBOX = { id: 'ib-0001', label: 'work', address: 'owner@example.com', provider: 'imap', status: 'active', hasImap: true };

function counts(patch = {}) {
  return {
    paidAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    paid: true,
    dismissed: false,
    successDays: 1,
    recentErrorCodes: [null],
    troubleInboxId: null,
    automationCount: 0,
    ...patch,
  };
}

function stubFetch(t, body) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    if (String(url) !== '/api/onboarding/first-week') return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ((init.method ?? 'GET') === 'GET' ? body : { ok: true }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

async function render(t, props = {}) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(FirstWeekChecklist, {
    inboxes: [INBOX],
    maxInboxes: 1,
    userRole: 'owner',
    ...props,
  })));
  t.after(() => view.unmount());
  return view;
}

const card = (view) => view.container.querySelector('[data-first-week-checklist]');
const itemIds = (view) => [...view.container.querySelectorAll('[data-item]')].map((n) => n.getAttribute('data-item'));
const buttonByText = (view, text) => [...view.container.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

test('every locale has every firstWeek key, without < or an em dash', async () => {
  const want = Object.keys(F).sort();
  for (const locale of ['en', 'de', 'es', 'fr', 'nb', 'zh']) {
    const messages = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    assert.deepEqual(Object.keys(messages.firstWeek ?? {}).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(messages.firstWeek);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|mcpemails(?!\.)/.test(text), false, `${locale}: MCPEmails, one word`);
  }
});

test('a member sees nothing and nothing is fetched', async (t) => {
  const requests = stubFetch(t, { eligible: true, counts: counts() });
  const view = await render(t, { userRole: 'member' });
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(!!card(view), false);
});

test('an owner the route calls not eligible sees nothing', async (t) => {
  const requests = stubFetch(t, { eligible: false });
  const view = await render(t);
  await waitFor(() => requests.length > 0, { message: 'route called' });
  await flush();
  assert.equal(!!card(view), false);
});

test('the items render in order, ticked from the counts, with progress and copyable prompts', async (t) => {
  stubFetch(t, { eligible: true, counts: counts({ successDays: 2, automationCount: 0 }) });
  const view = await render(t, { maxInboxes: 3 });
  await waitFor(() => card(view), { message: 'card shown' });
  assert.deepEqual(itemIds(view), ['first_call', 'active_days', 'automation', 'another_inbox']);
  const done = (id) => view.container.querySelector(`[data-item="${id}"]`).getAttribute('data-done');
  assert.equal(done('first_call'), 'true');
  assert.equal(done('active_days'), 'false');
  assert.equal(done('automation'), 'false');
  assert.equal(view.container.querySelector('[data-progress]').textContent, '2 of 3 days');
  const prompts = [...view.container.querySelectorAll('[data-first-week-prompt]')].map((n) => n.textContent);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[0].startsWith(F.prompt1), true);
  assert.equal(view.container.textContent.includes('your plan includes 3'), true);
  assert.equal(/\$|Personal|Pro\b|Business/.test(view.container.textContent), false, 'no price or plan name');

  const copied = [];
  globalThis.navigator.clipboard = { writeText: async (s) => { copied.push(s); } };
  await flush(() => buttonByText(view, F.copy).click());
  assert.equal(copied[0], F.prompt1);
});

test('the inbox-trouble row calls Reconnect with that inbox', async (t) => {
  stubFetch(t, {
    eligible: true,
    counts: counts({ recentErrorCodes: ['auth_failed', 'auth_failed', null], troubleInboxId: 'ib-0001' }),
  });
  const reconnected = [];
  const view = await render(t, { onReconnect: (ib) => reconnected.push(ib.id) });
  await waitFor(() => card(view), { message: 'card shown' });
  assert.equal(itemIds(view)[0], 'inbox_attention');
  assert.equal(view.container.textContent.includes(F.attentionTitle), true);
  await flush(() => buttonByText(view, F.reconnect).click());
  assert.deepEqual(reconnected, ['ib-0001']);
});

test('Dismiss hides the card at once and saves it', async (t) => {
  const requests = stubFetch(t, { eligible: true, counts: counts() });
  const view = await render(t);
  await waitFor(() => card(view), { message: 'card shown' });
  await flush(() => buttonByText(view, F.dismiss).click());
  assert.equal(!!card(view), false);
  assert.equal(requests.some((r) => r.method === 'POST' && r.url === '/api/onboarding/first-week'), true);
});

test('everything done: no card', async (t) => {
  const requests = stubFetch(t, { eligible: true, counts: counts({ successDays: 3, automationCount: 2 }) });
  const view = await render(t);
  await waitFor(() => requests.length > 0, { message: 'route called' });
  await flush();
  assert.equal(!!card(view), false);
});
