// ---------------------------------------------------------------------------
// Overview > Get started > step 2, "Waiting for your first call".
//
// Run with: npm run test:first-call-guide-ui
//
// Renders the real GettingStartedGuide against a stubbed fetch (GET
// /api/onboarding for the poll, POST /api/analytics/activation-event for the
// beacons) and asserts through the DOM and the recorded requests:
//   - with an inbox and no tool call ever, step 2 is the waiting state: three
//     copyable prompts, and waiting_state_shown is recorded once;
//   - "Connect your AI app" is done when a credential exists, and flips live
//     when the poll sees a credential issued after the page loaded;
//   - copying a prompt writes it to the clipboard and records
//     first_call_prompt_copied with the client;
//   - Claude and ChatGPT get their in-chat switch line, others none;
//   - the poll flips the step to "It works" when the first call lands, and
//     gives up after its maximum lifetime;
//   - a workspace that has called before, or has no inbox, sees the plain
//     setup step and is never polled;
//   - every locale has every key, without '<' or an em dash, and the key
//     reveal modal reads the shared prompt list.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { GettingStartedGuide } = await import('./Pages.jsx');
const {
  FIRST_CALL_PROMPT_KEYS,
  clientToggleKey,
  guideStep2Mode,
} = await import('../../src/lib/onboarding/first-call-prompts.mjs');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const G = en.guide;

const INBOX = { id: 'ib-0001', label: 'box', address: 'box@example.invalid', provider: 'imap', status: 'active' };
const KEY = { id: 'key-0001', name: 'OAuth: Claude', scopes: [] };

/**
 * Answers GET /api/onboarding from `answers` in order (the last one repeats),
 * or from `answers(i)` when it is a function, and records every request.
 * Beacons answer 204.
 */
function stubFetch(t, answers = [{}]) {
  const requests = [];
  const previous = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    if (String(url) === '/api/onboarding' && method === 'GET') {
      const payload = typeof answers === 'function' ? answers(i) : answers[Math.min(i, answers.length - 1)];
      i += 1;
      return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = previous; });
  return {
    requests,
    events: (stage) => requests.filter(r => r.url === '/api/analytics/activation-event' && r.body?.stage === stage),
    polls: () => requests.filter(r => r.url === '/api/onboarding' && r.method === 'GET').length,
  };
}

async function render(t, props = {}) {
  const view = await mount(createElement(AppLocaleProvider, null, createElement(GettingStartedGuide, {
    inboxes: [INBOX],
    inboxCount: 1,
    callsThisMonth: 0,
    mcpUrl: 'https://mcpemails.com/api/mcp',
    onConnect: () => {},
    onGoToKeys: () => {},
    apiKeys: [],
    firstToolUsed: false,
    ...props,
  })));
  t.after(() => view.unmount());
  return view;
}

const mode = view => view.container.querySelector('[data-guide-step2]')?.getAttribute('data-guide-step2');
const title = view => view.container.querySelector('[data-guide-step2-title]')?.textContent ?? '';
const prompts = view => [...view.container.querySelectorAll('[data-first-call-prompt]')];
const connectDone = view => view.container.querySelector('[data-guide-substep="connect"]')?.getAttribute('data-done');
const toggleLine = view => view.container.querySelector('[data-client-toggle]')?.textContent ?? '';
const pickerTiles = view => view.container.querySelectorAll('[data-client-tile]').length;

test('the pure helpers', () => {
  assert.equal(guideStep2Mode({ inboxCount: 0, firstToolUsed: false, activatedLive: false }), 'setup');
  assert.equal(guideStep2Mode({ inboxCount: 1, firstToolUsed: false, activatedLive: false }), 'waiting');
  assert.equal(guideStep2Mode({ inboxCount: 1, firstToolUsed: true, activatedLive: false }), 'setup');
  assert.equal(guideStep2Mode({ inboxCount: 1, firstToolUsed: false, activatedLive: true }), 'works');
  assert.equal(clientToggleKey('claude'), 'guide.clientToggle.claude');
  assert.equal(clientToggleKey('chatgpt'), 'guide.clientToggle.chatgpt');
  assert.equal(clientToggleKey('cursor'), null);
  assert.equal(clientToggleKey(null), null);
  assert.equal(clientToggleKey('toString'), null);
  assert.equal(FIRST_CALL_PROMPT_KEYS.length, 3);
});

test('an inbox and no call ever: the waiting state, three prompts, one shown event', async (t) => {
  const net = stubFetch(t, [{ onboarding_client: 'claude' }]);
  const view = await render(t, { initialClient: 'claude', pollMs: 60_000 });
  await waitFor(() => net.polls() >= 1, { message: 'the first poll' });
  assert.equal(mode(view), 'waiting');
  assert.equal(title(view), G.waitingTitle);
  assert.deepEqual(prompts(view).map(li => li.textContent), [G.prompts.unread, G.prompts.bank, G.prompts.draftReply]);
  assert.equal(connectDone(view), 'false');
  assert.ok(pickerTiles(view) > 0, 'the client picker sits under "Connect your AI app"');
  assert.equal(toggleLine(view), G.clientToggle.claude);
  const shown = net.events('waiting_state_shown');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].body.client, 'claude');
});

test('a credential on the page marks "Connect your AI app" done and hides the picker', async (t) => {
  stubFetch(t, [{}]);
  const view = await render(t, { apiKeys: [KEY], pollMs: 60_000 });
  assert.equal(connectDone(view), 'true');
  assert.equal(pickerTiles(view), 0);
});

test('a credential issued while the page is open flips the sub-step; an old one does not', async (t) => {
  let issued = '2020-01-01T00:00:00Z';
  const net = stubFetch(t, () => ({ onboarding_credential_issued_at: issued }));
  const view = await render(t, { pollMs: 20 });
  await waitFor(() => net.polls() >= 3, { message: 'three polls' });
  assert.equal(connectDone(view), 'false', 'a credential from 2020 that is not in apiKeys was revoked');
  issued = new Date(Date.now() + 1000).toISOString();
  await waitFor(() => connectDone(view) === 'true', { message: 'the live credential' });
});

test('copying a prompt writes it and records first_call_prompt_copied with the client', async (t) => {
  const net = stubFetch(t, [{}]);
  const written = [];
  const previous = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { written.push(s); } }, configurable: true });
  t.after(() => Object.defineProperty(navigator, 'clipboard', { value: previous, configurable: true }));
  const view = await render(t, { initialClient: 'chatgpt', pollMs: 60_000 });
  assert.equal(toggleLine(view), G.clientToggle.chatgpt);
  await flush(async () => { prompts(view)[1].querySelector('button').click(); });
  assert.deepEqual(written, [G.prompts.bank]);
  const copied = net.events('first_call_prompt_copied');
  assert.equal(copied.length, 1);
  assert.equal(copied[0].body.client, 'chatgpt');
});

test('a client with no in-chat switch gets no line; the event names the client', async (t) => {
  const net = stubFetch(t, [{}]);
  const view = await render(t, { initialClient: 'cursor', pollMs: 60_000 });
  assert.equal(toggleLine(view), '');
  await waitFor(() => net.events('waiting_state_shown').length === 1, { message: 'the shown event' });
  assert.equal(net.events('waiting_state_shown')[0].body.client, 'cursor');

  const view2 = await render(t, { pollMs: 60_000 });
  assert.equal(toggleLine(view2), '');
});

test('the client stored on the workspace preselects the switch line', async (t) => {
  stubFetch(t, [{ onboarding_client: 'claude' }]);
  const view = await render(t, { pollMs: 60_000 });
  await waitFor(() => toggleLine(view) === G.clientToggle.claude, { message: 'the stored client' });
  assert.equal(view.container.querySelector('[data-client-tile="claude"]')?.getAttribute('aria-pressed'), 'true');
});

test('the poll flips the step to "It works" when the first call lands', async (t) => {
  const net = stubFetch(t, [{}, {}, { onboarding_technical_activated_at: new Date().toISOString() }]);
  const view = await render(t, { pollMs: 20 });
  await waitFor(() => mode(view) === 'works', { message: 'the It works state' });
  assert.equal(title(view), G.itWorksTitle);
  assert.equal(prompts(view).length, 0);
  assert.equal(net.polls(), 3, 'polled until the call landed');
  const after = net.polls();
  await flush(() => new Promise(r => setTimeout(r, 100)));
  assert.equal(net.polls(), after, 'and stopped polling');
});

test('the poll gives up after its maximum lifetime', async (t) => {
  const net = stubFetch(t, [{}]);
  const view = await render(t, { pollMs: 10, pollMaxMs: 60 });
  await waitFor(() => view.container.querySelector('[data-guide-poll]')?.getAttribute('data-guide-poll') === 'stopped', { message: 'the poll to stop' });
  assert.equal(view.container.querySelector('[data-guide-poll]').textContent, G.waitingStopped);
  const after = net.polls();
  await flush(() => new Promise(r => setTimeout(r, 80)));
  assert.equal(net.polls(), after);
  assert.equal(mode(view), 'waiting');
});

test('called before, or no inbox yet: the plain setup step, never polled', async (t) => {
  const net = stubFetch(t, [{}]);
  const before = await render(t, { firstToolUsed: true, pollMs: 10 });
  const noInbox = await render(t, { inboxes: [], inboxCount: 0, pollMs: 10 });
  await flush(() => new Promise(r => setTimeout(r, 60)));
  assert.equal(mode(before), 'setup');
  assert.equal(mode(noInbox), 'setup');
  assert.equal(title(before), G.step2Title);
  assert.equal(net.polls(), 0);
  assert.equal(net.events('waiting_state_shown').length, 0);
});

test('every locale has every new key, without < or an em dash', async () => {
  const keys = ['waitingTitle', 'waitingDesc', 'connectAppTitle', 'connectAppDesc', 'connectAppDone', 'askTitle', 'askDesc', 'copyPrompt', 'itWorksTitle', 'itWorksDesc', 'waitingLive', 'waitingStopped'];
  for (const locale of ['en', 'de', 'es', 'fr', 'nb', 'zh']) {
    const m = (await import(`../../messages/${locale}/dashboard.json`, { with: { type: 'json' } })).default;
    const values = [
      ...keys.map(k => m.guide[k]),
      ...FIRST_CALL_PROMPT_KEYS.map(k => k.split('.').reduce((o, p) => o?.[p], m)),
      m.guide.clientToggle?.claude,
      m.guide.clientToggle?.chatgpt,
    ];
    for (const v of values) {
      assert.equal(typeof v, 'string', `${locale}: a key is missing`);
      assert.ok(v.length > 0);
      assert.ok(!v.includes('<'), `${locale}: ${v}`);
      assert.ok(!v.includes('—'), `${locale}: ${v}`);
    }
    assert.equal(m.apiKeys.revealModal.nextPrompt, undefined, `${locale}: the old single prompt key is gone`);
  }
});

test('a client tile opens its guide with the one-click install button above the steps', async (t) => {
  const net = stubFetch(t, [{}]);
  const view = await render(t, { inboxes: [], inboxCount: 0, pollMs: 60_000 });
  view.container.querySelector('[data-client-tile="claude"]').click();
  await flush();
  const action = () => document.querySelector('[data-install-action] a.btn-primary');
  await waitFor(() => action() !== null, { message: 'the Claude install button' });
  const href = action().getAttribute('href');
  assert.equal(new URL(href).searchParams.get('connectorUrl'), 'https://mcpemails.com/api/mcp');
  assert.equal(action().getAttribute('target'), '_blank');
  assert.match(document.querySelector('[data-install-action]').textContent, /one custom connector/);
  action().addEventListener('click', (e) => e.preventDefault());
  action().click();
  await waitFor(() => net.events('install_link_clicked').length === 1, { message: 'the install_link_clicked beacon' });
  assert.equal(net.events('install_link_clicked')[0].body.client, 'claude');
});

test('the key reveal modal reads the shared prompt list', () => {
  const source = readFileSync(new URL('./Pages.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('t(FIRST_CALL_PROMPT_KEYS[0])'));
  assert.ok(!source.includes('revealModal.nextPrompt'));
});
