// ---------------------------------------------------------------------------
// The inbox-cap offer: the WIRING, on both surfaces.
//
// Run with: npm run test:inbox-cap-ui
//
// WHY THIS EXISTS, SEPARATELY FROM inbox-cap-offer.test.mjs. That suite proves
// the rule: a business-shaped Free workspace is offered Pro and Personal, a
// consumer one Personal alone. It cannot fail for any of the ways the rule can
// be right and the screen still wrong: App.jsx forgetting to hand the boolean
// to one of the two surfaces, a buy button whose label says "$5/mo" while its
// href says `interval=year`, the interval toggle governing one card and not the
// other, a third CTA left in the modal footer, or the paywall beacon firing
// again because the panel now re-renders when the interval flips.
//
// So this renders the REAL dashboard (`DashboardApp` in the real
// `AppLocaleProvider`, real English messages) and reads the DOM. `fetch` is the
// only thing replaced, and it doubles as the beacon counter.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
// The cap notice renders a next/link ("Compare all plans"), which decides when
// to prefetch by watching the viewport. jsdom has no IntersectionObserver, and
// without one next/link falls back to `self.requestIdleCallback` and then sets
// state from a timer, outside `act`: in a bare Node process that is first a
// ReferenceError (no `self`) and then a wall of act() warnings. A browser has
// both globals, so this completes the environment and works around nothing. An
// observer that never reports an intersection means nothing is ever prefetched,
// which is what a test wants anyway.
globalThis.self ??= globalThis.window;
//
// It is also what the second-mailbox invitation waits on before it reports
// `shown`, so this one is controllable: nothing intersects until a test calls
// `scrollIntoView(node)`.
const observers = new Set();
const FakeIntersectionObserver = class {
  constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.add(this); }
  observe(node) { this.nodes.add(node); }
  unobserve(node) { this.nodes.delete(node); }
  disconnect() { this.nodes.clear(); observers.delete(this); }
};
globalThis.IntersectionObserver = FakeIntersectionObserver;

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const WORKSPACE_ID = 'ws-0001';

const PRICES = {
  personal: { monthlyCents: 500, yearlyCents: 4800, yearlyPriceConfigured: true },
  solo: { monthlyCents: 1500, yearlyCents: 14400, yearlyPriceConfigured: true },
  pro: { monthlyCents: 7900, yearlyCents: 75600, yearlyPriceConfigured: true },
};

let nextInboxId = 1;
function inbox(address) {
  const id = `ib-${String(nextInboxId++).padStart(4, '0')}`;
  return {
    id,
    label: address.split('@')[0],
    address,
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
  };
}

async function renderInboxes(t, {
  addresses,
  maxInboxes = 1,
  plan = 'free',
  userEmail = 'ada@gmail.com',
  isOwner = true,
  stripePrices = PRICES,
  route = 'inboxes',
  overviewStats = {},
  inboxPatch = null,
}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: route,
      user: { displayName: 'Ada', email: userEmail, initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID,
        slug: 'acme',
        plan,
        compedScale: null,
        displayName: 'Acme',
        isOwner,
        draftEditorEnabled: false,
        draftEditorHidden: false,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: isOwner ? 'owner' : 'member',
      planLimits: { maxInboxes, historyDays: 30 },
      stripePrices,
      overviewStats,
      activityFeed: [],
      inboxes: addresses.map(inbox).map(ib => (inboxPatch ? { ...ib, ...inboxPatch } : ib)),
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

  return {
    ...view,
    beacons: () => requests.filter(r => r.url === '/api/analytics/paywall'),
    promptBeacons: () => requests
      .filter(r => r.url === '/api/analytics/multi-inbox-prompt')
      .map(r => JSON.parse(r.body).action),
    /** `entry_point` of every paywall beacon, null where it had no body. */
    paywallEntries: () => requests
      .filter(r => r.url === '/api/analytics/paywall')
      .map(r => (r.body ? JSON.parse(r.body).entry_point ?? null : null)),
    /** Bodies of the `provider_selected` posts to /api/onboarding. */
    providerSelections: () => requests
      .filter(r => r.url === '/api/onboarding')
      .map(r => JSON.parse(r.body))
      .filter(b => b.action === 'provider_selected'),
  };
}

/** Every buy button inside `root`, as plain data. */
function buyButtons(root) {
  return [...root.querySelectorAll('a[data-cap-offer-plan]')].map(a => ({
    plan: a.getAttribute('data-cap-offer-plan'),
    href: a.getAttribute('href'),
    label: a.textContent,
  }));
}

const checkoutHref = (plan, interval) => `/api/stripe/checkout/start?plan=${plan}&interval=${interval}`;

const modalOf = view => view.container.querySelector('[role="dialog"]');

async function click(node) {
  await flush(async () => { node.click(); });
}

/** Lets the paywall beacon's `setTimeout(0)` run. */
async function settle() {
  await flush(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
}

async function openConnectModal(view) {
  const button = [...view.container.querySelectorAll('button')]
    .find(b => b.textContent.includes(dashboard.inboxes.connectInbox));
  assert.ok(button, 'the Inboxes page should have its connect button');
  await click(button);
  assert.ok(modalOf(view) !== null, 'the connect modal should be open');
}

function intervalButton(root, label) {
  return [...root.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.startsWith(label));
}

// ===========================================================================
// The cap notice on the Inboxes page
// ===========================================================================

test('page: a CONSUMER Free workspace is offered Personal alone, monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['ada@gmail.com'] });

  assert.deepEqual(buyButtons(view.container), [{
    plan: 'personal',
    href: checkoutHref('personal', 'month'),
    label: dashboard.inboxes.capCtaPersonal,
  }]);
  assert.ok(view.container.textContent.includes(dashboard.inboxes.capBodyPersonal));
  assert.equal(view.container.textContent.includes(dashboard.inboxes.capBodyBusiness), false);
});

test('page: a BUSINESS Free workspace is offered Pro then Personal, both monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });

  assert.deepEqual(buyButtons(view.container), [
    { plan: 'solo', href: checkoutHref('solo', 'month'), label: dashboard.inboxes.capCtaPro },
    { plan: 'personal', href: checkoutHref('personal', 'month'), label: dashboard.inboxes.capCtaPersonal },
  ]);
  assert.ok(view.container.textContent.includes(dashboard.inboxes.capBodyBusiness));
  assert.equal(view.container.textContent.includes(dashboard.inboxes.capBodyPersonal), false);
});

test('page: regional consumer variants and ISPs stay on the consumer offer', async (t) => {
  for (const address of ['ada@yahoo.in', 'ada@hotmail.no', 'ada@rogers.com']) {
    const view = await renderInboxes(t, { addresses: [address] });
    assert.deepEqual(buyButtons(view.container).map(b => b.plan), ['personal'], address);
  }
});

test('page: the OWNER\'s company address makes a Gmail-only workspace business-shaped', async (t) => {
  const owner = await renderInboxes(t, {
    addresses: ['ada@gmail.com'],
    userEmail: 'ada@acme.example',
    isOwner: true,
  });
  assert.deepEqual(buyButtons(owner.container).map(b => b.plan), ['solo', 'personal']);

  // A member's own address says nothing about who pays.
  const member = await renderInboxes(t, {
    addresses: ['ada@gmail.com'],
    userEmail: 'ada@acme.example',
    isOwner: false,
  });
  assert.deepEqual(buyButtons(member.container).map(b => b.plan), ['personal']);
});

test('page: a Personal cap sells Pro alone, even to a business', async (t) => {
  const view = await renderInboxes(t, {
    addresses: ['info@acme.example', 'sales@acme.example', 'billing@acme.example'],
    maxInboxes: 3,
    plan: 'personal',
  });
  assert.deepEqual(buyButtons(view.container), [{
    plan: 'solo',
    href: checkoutHref('solo', 'month'),
    label: dashboard.inboxes.capCtaPro,
  }]);
});

test('page: ONE interval choice moves BOTH buy buttons, label and href together', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });

  const monthly = intervalButton(view.container, chrome.connect.intervalMonthly);
  const annual = intervalButton(view.container, chrome.connect.intervalAnnual);
  assert.equal(monthly.getAttribute('aria-pressed'), 'true', 'Monthly must be the default');
  assert.equal(annual.getAttribute('aria-pressed'), 'false');

  await click(annual);

  const buttons = buyButtons(view.container);
  assert.deepEqual(buttons.map(b => b.href), [
    checkoutHref('solo', 'year'),
    checkoutHref('personal', 'year'),
  ]);
  // The label quotes what the card is charged: the annual total, per plan.
  assert.ok(buttons[1].label.includes('$48'), buttons[1].label);
  assert.ok(buttons[1].label.includes('Personal'), buttons[1].label);
  assert.ok(buttons[0].label.includes('$144'), buttons[0].label);
  assert.ok(buttons[0].label.includes('Pro'), buttons[0].label);

  // And back again.
  await click(intervalButton(view.container, chrome.connect.intervalMonthly));
  assert.deepEqual(buyButtons(view.container).map(b => b.href), [
    checkoutHref('solo', 'month'),
    checkoutHref('personal', 'month'),
  ]);
});

test('page: no annual toggle when EITHER plan has no yearly price, and both stay monthly', async (t) => {
  const view = await renderInboxes(t, {
    addresses: ['info@acme.example'],
    stripePrices: {
      ...PRICES,
      solo: { monthlyCents: 1500, yearlyCents: 14400, yearlyPriceConfigured: false },
    },
  });
  assert.equal(intervalButton(view.container, chrome.connect.intervalAnnual) === undefined, true);
  assert.deepEqual(buyButtons(view.container).map(b => b.href), [
    checkoutHref('solo', 'month'),
    checkoutHref('personal', 'month'),
  ]);
});

test('page: with no live prices at all, both plans are still sold, monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], stripePrices: null });
  assert.deepEqual(buyButtons(view.container).map(b => b.href), [
    checkoutHref('solo', 'month'),
    checkoutHref('personal', 'month'),
  ]);
});

// ===========================================================================
// The paywall panel in the connect modal
// ===========================================================================

test('modal: a CONSUMER Free workspace gets the Personal panel with one footer CTA', async (t) => {
  const view = await renderInboxes(t, { addresses: ['ada@gmail.com'] });
  await openConnectModal(view);
  const modal = modalOf(view);

  assert.deepEqual(buyButtons(modal), [{
    plan: 'personal',
    href: checkoutHref('personal', 'month'),
    label: chrome.connect.personalUpgradeCta,
  }]);
  assert.ok(modal.textContent.includes(chrome.connect.personalUpgradeTitle));
  assert.ok(modal.textContent.includes(chrome.connect.personalUpgradeBody));
  assert.equal(modal.querySelector('[data-cap-offer="dual"]') === null, true);
});

test('modal: a BUSINESS Free workspace gets two cards, each with its own checkout', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });
  await openConnectModal(view);
  const modal = modalOf(view);

  // Exactly two buy buttons in the whole dialog: no third one left in the footer.
  assert.deepEqual(buyButtons(modal), [
    { plan: 'solo', href: checkoutHref('solo', 'month'), label: chrome.connect.viewUpgradeOptions },
    { plan: 'personal', href: checkoutHref('personal', 'month'), label: chrome.connect.personalUpgradeCta },
  ]);
  const cards = modal.querySelector('[data-cap-offer="dual"]');
  assert.ok(cards !== null, 'the dual card row should render');
  assert.equal(buyButtons(cards).length, 2, 'both buy buttons live inside the cards');

  const text = modal.textContent;
  assert.ok(text.includes(chrome.connect.businessUpgradeTitle));
  assert.ok(text.includes(chrome.connect.businessUpgradeBody));
  assert.ok(text.includes(chrome.connect.businessPersonalPitch));
  assert.ok(text.includes(chrome.connect.businessProPitch));
  // The consumer sentence is gone from this panel.
  assert.equal(text.includes(chrome.connect.personalUpgradeBody), false);
  // Each plan's own deltas, and the shared lines exactly once.
  assert.ok(text.includes(chrome.connect.personalFeatureInboxes));
  assert.ok(text.includes(chrome.connect.featureInboxes));
  assert.equal(text.split(chrome.connect.featureSupport).length - 1, 1);
  // The way out and the comparison are still there.
  assert.ok(text.includes(chrome.connect.cancel));
  assert.ok(text.includes(chrome.connect.comparePlans));
});

test('modal and page show the SAME offer for the same workspace', async (t) => {
  for (const addresses of [['ada@gmail.com'], ['info@acme.example']]) {
    const view = await renderInboxes(t, { addresses });
    const onPage = buyButtons(view.container).map(b => [b.plan, b.href]);
    await openConnectModal(view);
    const inModal = buyButtons(modalOf(view)).map(b => [b.plan, b.href]);
    assert.deepEqual(inModal, onPage);
  }
});

test('modal: ONE interval choice moves BOTH cards, and the default is monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });
  await openConnectModal(view);
  const modal = modalOf(view);

  assert.equal(intervalButton(modal, chrome.connect.intervalMonthly).getAttribute('aria-pressed'), 'true');
  // No annual charge is described while Monthly is selected.
  assert.equal(modal.textContent.includes('once a year'), false);

  await click(intervalButton(modal, chrome.connect.intervalAnnual));

  const buttons = buyButtons(modalOf(view));
  assert.deepEqual(buttons.map(b => b.href), [
    checkoutHref('solo', 'year'),
    checkoutHref('personal', 'year'),
  ]);
  assert.ok(buttons[1].label.includes('$48'), buttons[1].label);
  assert.ok(buttons[0].label.includes('$144'), buttons[0].label);
  // Each card states its own annual charge before the click.
  const text = modalOf(view).textContent;
  assert.ok(text.includes('Billed $48 once a year.'));
  assert.ok(text.includes('Billed $144 once a year.'));
});

test('modal: the interval picked in the modal does not leak into the page notice', async (t) => {
  // Two surfaces, two pieces of state, as before this change. Flipping one
  // must not silently turn the other's $5 button into a $48 one.
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });
  await openConnectModal(view);
  await click(intervalButton(modalOf(view), chrome.connect.intervalAnnual));

  const modal = modalOf(view);
  const pageHrefs = [...view.container.querySelectorAll('a[data-cap-offer-plan]')]
    .filter(a => !modal.contains(a))
    .map(a => a.getAttribute('href'));
  assert.deepEqual(pageHrefs, [checkoutHref('solo', 'month'), checkoutHref('personal', 'month')]);
  assert.deepEqual(buyButtons(modal).map(b => b.href), [
    checkoutHref('solo', 'year'),
    checkoutHref('personal', 'year'),
  ]);
});

test('modal: the paywall beacon still fires exactly ONCE per open, dual panel included', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });
  assert.equal(view.beacons().length, 0, 'the passive page notice must not fire the beacon');

  await openConnectModal(view);
  await settle();
  assert.equal(view.beacons().length, 1);

  // Re-render the panel a few times: the interval flips state in the modal.
  await click(intervalButton(modalOf(view), chrome.connect.intervalAnnual));
  await click(intervalButton(modalOf(view), chrome.connect.intervalMonthly));
  await click(intervalButton(modalOf(view), chrome.connect.intervalAnnual));
  await settle();
  assert.equal(view.beacons().length, 1, 'a re-render is not a second paywall hit');

  const consumer = await renderInboxes(t, { addresses: ['ada@gmail.com'] });
  await openConnectModal(consumer);
  await settle();
  assert.equal(consumer.beacons().length, 1);
});

// ===========================================================================
// Pro is the RECOMMENDATION for a business, on both surfaces
// ===========================================================================

function variants(root) {
  return [...root.querySelectorAll('a[data-cap-offer-plan]')].map(a => [
    a.getAttribute('data-cap-offer-plan'),
    a.getAttribute('data-cap-offer-variant'),
  ]);
}

test('page and modal: Pro is the filled button and Personal the outlined one, for a business', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });
  assert.deepEqual(variants(view.container), [['solo', 'primary'], ['personal', 'secondary']]);

  await openConnectModal(view);
  const modal = modalOf(view);
  assert.deepEqual(variants(modal), [['solo', 'primary'], ['personal', 'secondary']]);
  // Exactly one card is badged, and it is Pro's.
  const badged = [...modal.querySelectorAll('[data-cap-offer-recommended="true"]')];
  assert.equal(badged.length, 1);
  assert.ok(badged[0].textContent.includes(chrome.connect.recommendedBadge));
  assert.ok(badged[0].querySelector('a[data-cap-offer-plan="solo"]') !== null);
});

test('a consumer, and a Personal cap, see one filled button and no badge', async (t) => {
  const consumer = await renderInboxes(t, { addresses: ['ada@gmail.com'] });
  assert.deepEqual(variants(consumer.container), [['personal', 'primary']]);
  await openConnectModal(consumer);
  assert.equal(modalOf(consumer).querySelector('[data-cap-offer-recommended]'), null);
  assert.equal(modalOf(consumer).textContent.includes(chrome.connect.recommendedBadge), false);

  const capped = await renderInboxes(t, {
    addresses: ['info@acme.example', 'sales@acme.example', 'billing@acme.example'],
    maxInboxes: 3,
    plan: 'personal',
  });
  assert.deepEqual(variants(capped.container), [['solo', 'primary']]);
});

// ===========================================================================
// The second-work-mailbox invitation: Overview header and Inboxes page
// ===========================================================================

const promptsOf = view => [...view.container.querySelectorAll('[data-multi-inbox-prompt]')];
const promptOf = view => promptsOf(view)[0] ?? null;
const connectEntryOf = view => view.container.querySelector('[data-connect-entry]')?.getAttribute('data-connect-entry') ?? null;
const inviteButton = prompt => [...prompt.querySelectorAll('button')].find(b => b.textContent.includes(dashboard.guide.multiInboxCta));
const buttonIn = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent.includes(label));
/** True when `a` comes before `b` in the document. */
const precedes = (a, b) => (a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** Report `node` as inside the viewport to whatever is observing it. */
async function scrollIntoView(node) {
  await flush(async () => {
    for (const observer of [...observers]) {
      if (observer.nodes.has(node)) observer.callback([{ target: node, isIntersecting: true }], observer);
    }
  });
  await settle();
}

test('overview: a business workspace with one mailbox is invited under the header, told it is paid, and nothing opens by itself', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview' });
  const prompts = promptsOf(view);
  assert.equal(prompts.length, 1, 'exactly one copy of the invitation on the Overview');
  const prompt = prompts[0];
  assert.equal(prompt.getAttribute('data-multi-inbox-prompt'), 'upgrade');
  assert.equal(prompt.getAttribute('data-multi-inbox-placement'), 'overview');
  assert.ok(prompt.textContent.includes(dashboard.guide.multiInboxTitle));
  assert.ok(prompt.textContent.includes(dashboard.guide.multiInboxOptional));
  assert.ok(prompt.textContent.includes(dashboard.guide.multiInboxCompactUpgrade));
  // Above the stat grid, so above the guide and everything else on the page.
  assert.ok(precedes(prompt, view.container.querySelector('.stat-grid')));
  // Not the page's primary action, and not a numbered step.
  assert.ok(inviteButton(prompt).className.includes('secondary'));

  // Rendering it is not a paywall view and opens nothing.
  await settle();
  assert.equal(modalOf(view), null);
  assert.deepEqual(view.beacons(), []);

  await scrollIntoView(prompt);
  assert.deepEqual(view.promptBeacons(), ['shown']);

  // The button opens the connect modal, which at the cap is the paywall
  // panel recommending Pro, and the paywall row says which control it was.
  await click(inviteButton(prompt));
  await settle();
  assert.deepEqual(view.promptBeacons(), ['shown', 'clicked']);
  const modal = modalOf(view);
  assert.ok(modal !== null);
  assert.deepEqual(buyButtons(modal).map(b => b.plan), ['solo', 'personal']);
  assert.equal(connectEntryOf(view), 'multi_inbox_overview');
  assert.deepEqual(view.paywallEntries(), ['multi_inbox_overview']);
});

test('overview: `shown` waits for the invitation to be in the viewport, and fires once', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview' });
  const prompt = promptOf(view);
  await settle();
  await settle();
  assert.deepEqual(view.promptBeacons(), [], 'mounted but never seen: no beacon');

  // Something else on the page scrolling into view is not this.
  await scrollIntoView(view.container.querySelector('.stat-grid'));
  assert.deepEqual(view.promptBeacons(), []);

  await scrollIntoView(prompt);
  await scrollIntoView(prompt);
  assert.deepEqual(view.promptBeacons(), ['shown']);
});

test('overview: with no IntersectionObserver, `shown` falls back to firing on mount', async (t) => {
  globalThis.IntersectionObserver = undefined;
  t.after(() => { globalThis.IntersectionObserver = FakeIntersectionObserver; });
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview', maxInboxes: null, plan: 'solo' });
  assert.ok(promptOf(view) !== null);
  await settle();
  assert.deepEqual(view.promptBeacons(), ['shown']);
});

test('overview: the invitation is still there after the first tool call, when the guide is gone', async (t) => {
  const before = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview' });
  assert.ok(before.container.textContent.includes(dashboard.guide.title), 'no calls yet: the guide is on screen');
  assert.equal(promptsOf(before).length, 1, 'and the guide carries no second copy');

  const after = await renderInboxes(t, {
    addresses: ['info@acme.example'],
    route: 'overview',
    overviewStats: { callsToday: 2, callsThisMonth: 9 },
  });
  assert.equal(after.container.textContent.includes(dashboard.guide.title), false, 'calls made: the guide is gone');
  assert.equal(promptsOf(after).length, 1);
  assert.equal(promptOf(after).getAttribute('data-multi-inbox-placement'), 'overview');
});

test('overview: an uncapped business workspace gets the plain ask, with no mention of paying', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview', maxInboxes: null, plan: 'solo' });
  const prompt = promptOf(view);
  assert.equal(prompt.getAttribute('data-multi-inbox-prompt'), 'open');
  assert.ok(prompt.textContent.includes(dashboard.guide.multiInboxCompact));
  assert.equal(prompt.textContent.includes(dashboard.guide.multiInboxCompactUpgrade), false);

  await click(inviteButton(prompt));
  await settle();
  assert.equal(connectEntryOf(view), 'multi_inbox_overview');
  assert.deepEqual(view.beacons(), [], 'not capped: the modal is the provider picker, not a paywall');
});

test('inboxes: the invitation sits under the mailbox list, once, in both variants', async (t) => {
  const capped = await renderInboxes(t, { addresses: ['info@acme.example'] });
  assert.equal(promptsOf(capped).length, 1);
  const prompt = promptOf(capped);
  assert.equal(prompt.getAttribute('data-multi-inbox-prompt'), 'upgrade');
  assert.equal(prompt.getAttribute('data-multi-inbox-placement'), 'inboxes');
  assert.ok(prompt.textContent.includes(dashboard.guide.multiInboxDescUpgrade));
  const row = [...capped.container.querySelectorAll('*')].find(n => n.children.length === 0 && n.textContent === 'info@acme.example');
  assert.ok(row, 'the mailbox is listed');
  assert.ok(precedes(row, prompt), 'the invitation comes after the list');

  await settle();
  assert.deepEqual(capped.beacons(), [], 'rendering the invitation is not a paywall view');
  assert.deepEqual(capped.promptBeacons(), []);
  await scrollIntoView(prompt);
  assert.deepEqual(capped.promptBeacons(), ['shown']);

  await click(inviteButton(prompt));
  await settle();
  assert.deepEqual(capped.promptBeacons(), ['shown', 'clicked']);
  assert.equal(connectEntryOf(capped), 'multi_inbox_inboxes');
  assert.deepEqual(capped.paywallEntries(), ['multi_inbox_inboxes']);
  assert.deepEqual(buyButtons(modalOf(capped)).map(b => b.plan), ['solo', 'personal']);

  const open = await renderInboxes(t, { addresses: ['info@acme.example'], maxInboxes: null, plan: 'solo' });
  assert.equal(promptsOf(open).length, 1);
  assert.equal(promptOf(open).getAttribute('data-multi-inbox-prompt'), 'open');
  assert.ok(promptOf(open).textContent.includes(dashboard.guide.multiInboxDesc));
  assert.equal(promptOf(open).textContent.includes(dashboard.guide.multiInboxDescUpgrade), false);
});

test('a consumer never sees the invitation on either page, and no beacon fires', async (t) => {
  for (const route of ['overview', 'inboxes']) {
    for (const overviewStats of [{}, { callsThisMonth: 4 }]) {
      const view = await renderInboxes(t, { addresses: ['ada@gmail.com'], route, overviewStats });
      assert.equal(promptsOf(view).length, 0, `${route}: no invitation`);
      await settle();
      assert.deepEqual(view.promptBeacons(), []);
      assert.deepEqual(view.beacons(), []);
    }
  }
});

test('two mailboxes, or none, means no invitation on either page', async (t) => {
  for (const route of ['overview', 'inboxes']) {
    const two = await renderInboxes(t, { addresses: ['info@acme.example', 'sales@acme.example'], route, maxInboxes: null });
    assert.equal(promptsOf(two).length, 0);
    const none = await renderInboxes(t, { addresses: [], userEmail: 'ada@acme.example', route });
    assert.equal(promptsOf(none).length, 0);
  }
});

// ===========================================================================
// Which control opened the connect modal
// ===========================================================================

test('entry point: the Overview header button is `header`, and the paywall row carries it', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], route: 'overview' });
  const header = view.container.querySelector('.page-header');
  await click(buttonIn(header, dashboard.overview.connectInbox));
  await settle();
  assert.equal(connectEntryOf(view), 'header');
  assert.deepEqual(view.paywallEntries(), ['header']);
});

test('entry point: the guide step is `guide`', async (t) => {
  const view = await renderInboxes(t, { addresses: [], route: 'overview' });
  const guide = [...view.container.querySelectorAll('.card')].find(c => c.textContent.includes(dashboard.guide.title));
  await click(buttonIn(guide, dashboard.guide.connectInbox));
  assert.equal(connectEntryOf(view), 'guide');
});

test('entry point: the Inboxes header and its empty state are `inboxes_page`', async (t) => {
  const capped = await renderInboxes(t, { addresses: ['ada@gmail.com'] });
  await click(buttonIn(capped.container.querySelector('.page-header'), dashboard.inboxes.connectInbox));
  await settle();
  assert.equal(connectEntryOf(capped), 'inboxes_page');
  assert.deepEqual(capped.paywallEntries(), ['inboxes_page']);

  const empty = await renderInboxes(t, { addresses: [] });
  await click(buttonIn(empty.container.querySelector('.empty'), dashboard.inboxes.connectInbox));
  assert.equal(connectEntryOf(empty), 'inboxes_page');
});

test('entry point: a reconnect is `reconnect` and never a paywall view', async (t) => {
  const view = await renderInboxes(t, { addresses: ['ada@gmail.com'], inboxPatch: { status: 'error', lastError: 'Authentication failed' } });
  await click(buttonIn(view.container, dashboard.inboxes.reconnect));
  await settle();
  assert.equal(connectEntryOf(view), 'reconnect');
  assert.deepEqual(view.beacons(), []);
});

test('entry point: picking a provider sends it on `provider_selected`', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], maxInboxes: null, plan: 'solo' });
  await click(inviteButton(promptOf(view)));
  const next = buttonIn(modalOf(view), chrome.connect.enterCredentials);
  assert.ok(next, 'step 1 should have its primary button');
  await click(next);
  await settle();
  const sent = view.providerSelections();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].entry_point, 'multi_inbox_inboxes');
});

test('entry point: closing the modal forgets it, so the next opener names itself', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], maxInboxes: null, plan: 'solo' });
  await click(inviteButton(promptOf(view)));
  assert.equal(connectEntryOf(view), 'multi_inbox_inboxes');
  await click(modalOf(view).querySelector(`button[aria-label="${chrome.connect.close}"]`));
  assert.equal(connectEntryOf(view), null);
  await click(buttonIn(view.container.querySelector('.page-header'), dashboard.inboxes.connectInbox));
  assert.equal(connectEntryOf(view), 'inboxes_page');
});
