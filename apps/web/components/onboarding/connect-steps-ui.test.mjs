// ---------------------------------------------------------------------------
// The /onboarding steps after the inbox (WP-F): add to AI, prompt + live wait,
// It works.
//
// Run with: npm run test:onboarding-connect-ui
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;

const { default: OnboardingLocaleProvider } = await import('../i18n/OnboardingLocaleProvider.jsx');
const { AddToAiStep } = await import('./steps/AddToAiStep.jsx');
const { FirstPromptStep } = await import('./steps/FirstPromptStep.jsx');
const { ItWorksStep } = await import('./steps/ItWorksStep.jsx');

const MCP = 'https://mcpemails.com/api/mcp';
const T0 = '2026-10-26T12:00:00.000Z';
const later = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();

/** Record every fetch; answer from `routes` by URL. */
function stubFetch(t, routes = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const handler = routes[String(url)];
    const res = handler ? handler(body) : { status: 200, json: { ok: true } };
    return { ok: res.status < 400, status: res.status, json: async () => res.json };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function baseStatus(overrides = {}) {
  return {
    serverTime: T0,
    credential: { exists: false, sinceReset: false, latestAt: null, scopes: null },
    handshake: { at: null, client: null, clients: [] },
    firstCall: { at: null, tool: null },
    lastFailure: null,
    ...overrides,
  };
}

function props(overrides = {}) {
  return {
    step: 'add_to_ai',
    status: baseStatus(),
    refreshStatus: async () => null,
    setPolling: () => {},
    client: 'claude',
    clientLabel: 'Claude',
    provider: null,
    variant: { flow: 'new', convert: 'on' },
    mcpUrl: MCP,
    userEmail: 'me@example.org',
    goNext: () => {},
    goTo: () => {},
    finish: () => {},
    ...overrides,
  };
}

async function render(t, Component, p) {
  const view = await mount(createElement(OnboardingLocaleProvider, null, createElement(Component, p)));
  t.after(() => view.unmount());
  return {
    view,
    update: (next) => view.update(createElement(OnboardingLocaleProvider, null, createElement(Component, next))),
  };
}

test('Claude gets one Add to Claude button with the prefilled connector link and the Free note', async (t) => {
  stubFetch(t);
  const polls = [];
  const { view } = await render(t, AddToAiStep, props({ setPolling: (c) => polls.push(c) }));
  const link = view.container.querySelector('[data-testid="onb-install-link"]');
  assert.ok(link, 'install link');
  assert.ok(link.getAttribute('href').startsWith('https://claude.ai/customize/connectors?modal=add-custom-connector'));
  assert.equal(link.textContent, 'Add to Claude');
  assert.equal(link.getAttribute('target'), '_blank', 'Claude opens in a new tab, so the setup stays open');
  assert.ok(view.container.textContent.includes('Claude Free allows one custom connector'));
  assert.equal(typeof polls[0], 'function', 'polls with a cadence');
});

test('the step moves on by itself only for a grant newer than the step', async (t) => {
  stubFetch(t);
  let next = 0;
  const p = props({ goNext: () => { next += 1; }, status: baseStatus({ credential: { exists: true, sinceReset: true, latestAt: later(-60), scopes: null } }) });
  const { update } = await render(t, AddToAiStep, p);
  assert.equal(next, 0, 'an older grant does not skip the step');
  await update({ ...p, status: baseStatus({ serverTime: later(10), credential: { exists: true, sinceReset: true, latestAt: later(5), scopes: null } }) });
  assert.equal(next, 1);
});

test('ChatGPT gets the Plugins steps and the plan note; a command client gets the command', async (t) => {
  stubFetch(t);
  const { view, update } = await render(t, AddToAiStep, props({ client: 'chatgpt', clientLabel: 'ChatGPT' }));
  const steps = view.container.querySelector('[data-testid="onb-chatgpt-steps"]').textContent;
  assert.ok(steps.includes('Plugins') && steps.includes('Add custom MCP server') && steps.includes('@MCPEmails'));
  assert.ok(view.container.textContent.includes('Go plan'));
  await update(props({ client: 'claude_code', clientLabel: 'Claude Code' }));
  assert.ok(view.container.querySelector('[data-testid="onb-command"]').textContent.includes(`claude mcp add --transport http mcpemails ${MCP}`));
});

test('an API-key client gets a Standard key created and shown once in the header', async (t) => {
  const calls = stubFetch(t, {
    '/api/api-keys': () => ({ status: 201, json: { rawKey: 'mcpe_test_123' } }),
  });
  const { view } = await render(t, AddToAiStep, props({ client: 'cline', clientLabel: 'Cline' }));
  await waitFor(() => view.container.querySelector('[data-testid="onb-key-ready"]'), { message: 'key shown' });
  const created = calls.filter((c) => c.url === '/api/api-keys');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body.scopes.sort(), ['manage:contacts', 'manage:drafts', 'read:email', 'search:email', 'send:email']);
  assert.ok(view.container.querySelector('[data-testid="onb-key-value"]').textContent.includes('Authorization: Bearer mcpe_test_123'));
});

test('the prompt step: Reply radar, Open Claude without a prefill, the ladder, and timed help', async (t) => {
  const calls = stubFetch(t);
  const moves = [];
  const p = props({ step: 'first_prompt', goTo: (s) => moves.push(s) });
  const { view, update } = await render(t, FirstPromptStep, p);
  assert.ok(view.container.querySelector('[data-testid="onb-prompt"]').textContent.startsWith('Using MCPEmails, look at my inbox'));
  assert.equal(view.container.querySelector('[data-testid="onb-open-client"]').getAttribute('href'), 'https://claude.ai/new');
  assert.equal(view.container.querySelector('[data-testid="onb-ladder"]').getAttribute('data-rung'), '0');

  await update({ ...p, status: baseStatus({ handshake: { at: later(2), client: 'claude', clients: [] } }) });
  assert.deepEqual(moves, ['wait']);
  assert.equal(view.container.querySelector('[data-testid="onb-ladder"]').getAttribute('data-rung'), '2');
  await waitFor(() => calls.some((c) => c.body?.event === 'handshake_seen'), { message: 'handshake event' });

  await update({ ...p, status: baseStatus({ handshake: { at: later(2), client: 'claude', clients: [] }, firstCall: { at: later(9), tool: 'email_read' } }) });
  assert.deepEqual(moves, ['wait', 'it_works']);
});

test('a failed request from the AI app is not shown: it usually retries by itself', async (t) => {
  stubFetch(t);
  const p = props({ step: 'wait', goTo: () => {} });
  const { view } = await render(t, FirstPromptStep, {
    ...p,
    status: baseStatus({ handshake: { at: later(2), client: 'claude', clients: [] }, lastFailure: { at: later(3), code: 'invalid_params' } }),
  });
  assert.ok(view.container.querySelector('[data-testid="onb-ladder"]'));
  assert.equal(view.container.textContent.includes('did not work'), false);
  assert.equal(view.container.textContent.includes('could not read'), false);
});

test('the no-call help says to switch MCPEmails on in this chat', async (t) => {
  stubFetch(t);
  // A handshake 2 minutes before "now" on the server clock, and a wait that
  // started then too: the 60 s timer is long past.
  const realNow = Date.now;
  const start = realNow();
  t.after(() => { Date.now = realNow; });
  const p = props({ step: 'wait', status: baseStatus({ serverTime: new Date(start).toISOString(), handshake: { at: new Date(start).toISOString(), client: 'claude', clients: [] } }) });
  const { view } = await render(t, FirstPromptStep, p);
  Date.now = () => start + 120_000;
  await waitFor(() => view.container.querySelector('[data-testid="onb-help-no_call"]'), { timeout: 7000, message: 'no-call help' });
  assert.ok(view.container.querySelector('[data-testid="onb-help-no_call"]').textContent.includes('+ > Connectors'));
});

test('It works names the app that made the call, even when the chip says another', async (t) => {
  stubFetch(t, {});
  const { view } = await render(t, ItWorksStep, props({
    step: 'it_works',
    status: baseStatus({ firstCall: { at: T0, tool: 'email_search', client: 'chatgpt' } }),
  }));
  assert.equal(view.container.querySelector('[data-testid="onb-success"]').textContent, 'ChatGPT just searched your inbox.');
});

test('It works names the tool, offers nothing more to paste, then Done', async (t) => {
  const calls = stubFetch(t);
  let finished = 0;
  const { view } = await render(t, ItWorksStep, props({
    step: 'it_works',
    status: baseStatus({ firstCall: { at: T0, tool: 'email_read' } }),
    finish: () => { finished += 1; },
  }));
  assert.equal(view.container.querySelector('[data-testid="onb-success"]').textContent, 'Claude just read your inbox.');
  assert.equal(view.container.querySelectorAll('[data-testid="onb-draft-prompt"], [data-testid="onb-morning-prompt"], [data-testid="onb-optin"]').length, 0);
  await flush(() => view.container.querySelector('[data-testid="onb-finish"]').click());
  assert.equal(finished, 1);
  assert.equal(calls.some((c) => c.body?.action === 'morning_brief'), false);
});

// ── Flow B on It works (WP-H) ────────────────────────────────────────────────

const FLOW_B = {
  plan: 'free',
  createdAt: T0,
  firstCallAt: T0,
  summaryDismissedAt: null,
  graceNoteSeenAt: null,
  graceEndsAt: later(3 * 86400),
  inGrace: true,
  freeCap: 150,
  triedSecondInbox: false,
  inboxCaps: { free: 1, personal: 3, solo: 10 },
  prices: {
    personal: { monthlyCents: 900, yearlyCents: 8640 },
    solo: { monthlyCents: 1500, yearlyCents: 14400 },
  },
};

function itWorks(overrides = {}) {
  return props({
    step: 'it_works',
    status: baseStatus({ firstCall: { at: T0, tool: 'email_read' }, inboxes: { count: 1, sinceReset: 1, items: [{ id: 'i1', address: 'me@gmail.com' }] } }),
    userEmail: 'me@gmail.com',
    flowB: FLOW_B,
    ...overrides,
  });
}

test('B1: at the Free inbox cap the second-inbox card opens the dashboard upgrade panel', async (t) => {
  const calls = stubFetch(t);
  const finishedWith = [];
  let started = 0;
  const { view } = await render(t, ItWorksStep, itWorks({ finish: (href) => { finishedWith.push(href); }, startSecondInbox: () => { started += 1; } }));
  const card = await waitFor(() => view.container.querySelector('[data-testid="onb-second-inbox"]'), { message: 'card (lazy)' });
  assert.equal(card.getAttribute('data-at-cap'), 'true');
  assert.ok(card.textContent.includes('Most people connect a second inbox'));
  await flush(() => view.container.querySelector('[data-testid="onb-second-inbox-open"]').click());
  assert.deepEqual(finishedWith, ['/dashboard/inboxes?connect=second_inbox']);
  assert.equal(started, 0);
  const events = calls.filter((c) => c.body?.action === 'flow_b').map((c) => c.body.event);
  assert.ok(events.includes('second_inbox_prompt_clicked'));
});

test('B1: below the cap the card reopens the inbox step', async (t) => {
  stubFetch(t);
  let started = 0;
  const { view } = await render(t, ItWorksStep, itWorks({
    flowB: { ...FLOW_B, inboxCaps: { ...FLOW_B.inboxCaps, free: 3 } },
    startSecondInbox: () => { started += 1; },
  }));
  const open = await waitFor(() => view.container.querySelector('[data-testid="onb-second-inbox-open"]'), { message: 'card (lazy)' });
  await flush(() => open.click());
  assert.equal(started, 1);
});

test('B2: plan summary, monthly first, annual beside it, Continue on Free hides it', async (t) => {
  const calls = stubFetch(t);
  const { view } = await render(t, ItWorksStep, itWorks());
  const card = await waitFor(() => view.container.querySelector('[data-plan-summary="onboarding"]'), { message: 'card shown (lazy)' });
  assert.ok(card.textContent.includes('Unlimited until'));
  assert.ok(card.textContent.includes('Charged today. Cancel any time. 14-day refund.'));
  assert.equal(card.getAttribute('data-plan-summary-recommended'), 'none', 'a consumer who never tried a second inbox gets no badge');
  const personal = card.querySelector('[data-plan-summary-plan="personal"]');
  assert.equal(personal.getAttribute('data-plan-summary-interval'), 'month');
  assert.ok(personal.getAttribute('href').includes('plan=personal&interval=month'));
  assert.ok(card.textContent.includes('$9/mo'));
  await flush(() => card.querySelector('[data-testid="plan-summary-interval-year"]').click());
  const annual = view.container.querySelector('[data-plan-summary-plan="personal"]');
  assert.ok(annual.getAttribute('href').includes('interval=year'));
  assert.ok(view.container.querySelector('[data-plan-summary="onboarding"]').textContent.includes('$86.40/yr'));
  await flush(() => view.container.querySelector('[data-testid="plan-summary-free"]').click());
  assert.equal(view.container.querySelectorAll('[data-plan-summary="onboarding"]').length, 0);
  const clicked = calls.find((c) => c.body?.event === 'plan_summary_clicked');
  assert.equal(clicked.body.plan, 'free');
});

test('B2: a work domain is recommended Pro; nothing Flow B shows with convert off', async (t) => {
  stubFetch(t);
  const work = itWorks({ userEmail: 'ops@acme-widgets.example' });
  work.status.inboxes.items = [{ id: 'i1', address: 'ops@acme-widgets.example' }];
  const { view } = await render(t, ItWorksStep, work);
  const workCard = await waitFor(() => view.container.querySelector('[data-plan-summary="onboarding"]'), { message: 'card shown (lazy)' });
  assert.equal(workCard.getAttribute('data-plan-summary-recommended'), 'solo');
  const off = await render(t, ItWorksStep, itWorks({ variant: { flow: 'new', convert: 'off' } }));
  assert.equal(off.view.container.querySelectorAll('[data-plan-summary], [data-testid="onb-second-inbox"]').length, 0);
});
