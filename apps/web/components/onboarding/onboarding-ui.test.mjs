// ---------------------------------------------------------------------------
// The /onboarding skeleton (WP-C): the client chip, the reused-inbox offer
// after a reset, the dashboard's Finish setup link and Reset card, and the
// onboarding namespace in every locale.
//
// Run with: npm run test:onboarding-ui
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;

const { default: OnboardingLocaleProvider } = await import('../i18n/OnboardingLocaleProvider.jsx');
const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { ClientChip } = await import('./ClientChip.jsx');
const { InboxStep } = await import('./steps/InboxStep.jsx');
const { FinishSetupLink, ResetOnboardingCard } = await import('../dashboard/OnboardingEntry.jsx');
const en = (await import('../../messages/en/onboarding.json', { with: { type: 'json' } })).default;
const enChrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;

async function render(t, element, Provider = OnboardingLocaleProvider) {
  const view = await mount(createElement(Provider, null, element));
  t.after(() => view.unmount());
  return view;
}

const keys = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

test('every locale has every onboarding key, without < or an em dash', async () => {
  const want = keys(en).sort();
  for (const locale of ['en', 'de', 'es', 'fr', 'nb', 'zh']) {
    const messages = (await import(`../../messages/${locale}/onboarding.json`, { with: { type: 'json' } })).default;
    assert.deepEqual(keys(messages).sort(), want, `${locale} has the same keys`);
    const text = JSON.stringify(messages);
    assert.equal(text.includes('<'), false, `${locale}: no literal <`);
    assert.equal(text.includes('—'), false, `${locale}: no em dash`);
    assert.equal(/MCP Emails|30 days/.test(text), false, `${locale}: copy rules`);
    if (locale !== 'en') assert.notEqual(messages.shell.exit, en.shell.exit, `${locale}: translated`);

    const chrome = (await import(`../../messages/${locale}/dashboardChrome.json`, { with: { type: 'json' } })).default;
    assert.deepEqual(keys(chrome.onboardingEntry).sort(), keys(enChrome.onboardingEntry).sort(), `${locale}: onboardingEntry`);
  }
});

test('the chip says which app is in use and swaps without a blocking screen', async (t) => {
  const picked = [];
  const view = await render(t, createElement(ClientChip, { client: 'claude', onChange: (id) => picked.push(id) }));
  const chip = view.container.querySelector('[data-testid="onb-chip"]');
  assert.ok(chip.textContent.includes('Claude'), chip.textContent);
  assert.ok(chip.getAttribute('aria-label').includes('Using Claude'));
  assert.ok(chip.querySelector('.onb-logo svg'), 'the Claude logo');
  assert.equal(view.container.querySelectorAll('[role="menu"]').length, 0);

  await flush(() => view.container.querySelector('.onb-chip-change').click());
  const options = [...view.container.querySelectorAll('[data-client]')].map((b) => b.getAttribute('data-client'));
  assert.deepEqual(options, ['claude', 'chatgpt', 'claude_code', 'cursor', 'vscode']);

  await flush(() => view.container.querySelector('.onb-chip-more').click());
  assert.ok(view.container.querySelectorAll('[data-client]').length > 5);

  await flush(() => view.container.querySelector('[data-client="chatgpt"]').click());
  assert.deepEqual(picked, ['chatgpt']);
  assert.equal(view.container.querySelectorAll('[role="menu"]').length, 0);
});

test('choosing the app already in use does not fire a change', async (t) => {
  const picked = [];
  const view = await render(t, createElement(ClientChip, { client: 'cursor', onChange: (id) => picked.push(id) }));
  await flush(() => view.container.querySelector('.onb-chip-change').click());
  await flush(() => view.container.querySelector('[data-client="cursor"]').click());
  assert.equal(picked.length, 0);
});

test('after a reset the inbox step offers the connected inbox or another one', async (t) => {
  let next = 0;
  const status = { inboxes: { count: 1, sinceReset: 0, items: [{ id: 'i1', address: 'me@example.org' }] } };
  const view = await render(t, createElement(InboxStep, { step: 'inbox', status, clientLabel: 'Claude', goNext: () => { next += 1; } }));
  assert.equal(view.container.querySelectorAll('[data-testid="onb-reuse-inbox"]').length, 1);
  assert.ok(view.container.textContent.includes('Use me@example.org'));
  const [useIt, another] = view.container.querySelectorAll('[data-testid="onb-reuse-inbox"] button');
  await flush(() => useIt.click());
  assert.equal(next, 1);
  await flush(() => another.click());
  assert.equal(view.container.querySelectorAll('[data-testid="onb-reuse-inbox"]').length, 0);
});

test('a fresh workspace sees no reuse offer', async (t) => {
  const status = { inboxes: { count: 0, sinceReset: 0, items: [] } };
  const view = await render(t, createElement(InboxStep, { step: 'inbox', status, clientLabel: 'Claude', goNext: () => {} }));
  assert.equal(view.container.querySelectorAll('[data-testid="onb-reuse-inbox"]').length, 0);
});

test('dashboard: Finish setup only while the new flow is unfinished', async (t) => {
  const on = await render(t, createElement(FinishSetupLink, { onboarding: { flow: 'new', finishSetup: true } }), AppLocaleProvider);
  const link = on.container.querySelector('[data-testid="finish-setup-link"]');
  assert.equal(link?.getAttribute('href'), '/dashboard?setup=1');
  const off = await render(t, createElement(FinishSetupLink, { onboarding: { flow: 'control', finishSetup: false } }), AppLocaleProvider);
  assert.equal(off.container.querySelectorAll('[data-testid="finish-setup-link"]').length, 0);
});

test('dashboard: Reset onboarding is internal-owner only and posts reset', async (t) => {
  const hidden = await render(t, createElement(ResetOnboardingCard, { onboarding: { canReset: false } }), AppLocaleProvider);
  assert.equal(hidden.container.querySelectorAll('[data-testid="reset-onboarding-card"]').length, 0);

  const calls = [];
  const went = [];
  const fetchImpl = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200 }; };
  const view = await render(t, createElement(ResetOnboardingCard, { onboarding: { canReset: true }, fetchImpl, navigate: (h) => went.push(h) }), AppLocaleProvider);
  await flush(() => view.container.querySelector('[data-testid="reset-onboarding-card"] button').click());
  await flush();
  assert.deepEqual(calls, [['/api/onboarding', { action: 'reset' }]]);
  assert.deepEqual(went, ['/onboarding']);
});

// ── Closing the dialog ──────────────────────────────────────────────────────

const { OnboardingApp } = await import('./OnboardingApp.jsx');

const waitStatus = {
  workspaceId: 'ws-1',
  serverTime: new Date().toISOString(),
  resetAt: null,
  completedAt: null,
  client: 'claude',
  inboxes: { count: 1, sinceReset: 1, chosenAt: new Date().toISOString(), items: [{ id: 'i1', address: 'me@example.org', provider: 'imap', status: 'active', createdAt: new Date().toISOString() }] },
  credential: { exists: true, sinceReset: true, latestAt: new Date().toISOString(), scopes: null },
  handshake: { at: null, client: null, clients: [] },
  firstCall: { at: null, tool: null, client: null, reached: false },
  anyCall: { at: null },
  lastFailure: null,
};

/** Mounts the dialog on the wait step; returns the actions it posted and the closes. */
async function mountDialog(t) {
  const posted = [];
  const closes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST' && String(url) === '/api/onboarding') posted.push(JSON.parse(init.body));
    return new Response(JSON.stringify(waitStatus), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const view = await render(t, createElement(OnboardingApp, {
    variant: { flow: 'new', convert: 'off' },
    initialClient: 'claude',
    mcpUrl: 'https://mcpemails.com/api/mcp',
    statusPromise: Promise.resolve(waitStatus),
    requestedStep: 'wait',
    onClose: (href) => closes.push(href),
  }));
  await flush(() => {});
  return { view, posted, closes };
}

const exits = (posted) => posted.filter((body) => body.action === 'exited');

test('closing the dialog with X, Skip or Escape records the step it was closed on', async (t) => {
  const { view, posted, closes } = await mountDialog(t);
  assert.ok(view.container.ownerDocument.querySelector('[data-testid="onb-wait"]'), 'on the wait step');

  await flush(() => view.container.ownerDocument.querySelector('[data-testid="onb-exit"]').click());
  await flush(() => view.container.ownerDocument.querySelector('[data-testid="onb-skip"]').click());
  await flush(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));

  assert.deepEqual(exits(posted), [
    { action: 'exited', step: 'wait' },
    { action: 'exited', step: 'wait' },
    { action: 'exited', step: 'wait' },
  ]);
  assert.equal(closes.length, 3);
});
