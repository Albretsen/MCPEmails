// ---------------------------------------------------------------------------
// The inbox-cap offer: the WIRING, on both surfaces.
//
// Run with: npm run test:inbox-cap-ui
//
// WHY THIS EXISTS, SEPARATELY FROM inbox-cap-offer.test.mjs. That suite proves
// the rule: a business-shaped Free workspace is offered Personal and Pro, a
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
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: 'inboxes',
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
      overviewStats: {},
      activityFeed: [],
      inboxes: addresses.map(inbox),
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

test('page: a BUSINESS Free workspace is offered Personal then Pro, both monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'] });

  assert.deepEqual(buyButtons(view.container), [
    { plan: 'personal', href: checkoutHref('personal', 'month'), label: dashboard.inboxes.capCtaPersonal },
    { plan: 'solo', href: checkoutHref('solo', 'month'), label: dashboard.inboxes.capCtaPro },
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
  assert.deepEqual(buyButtons(owner.container).map(b => b.plan), ['personal', 'solo']);

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
    checkoutHref('personal', 'year'),
    checkoutHref('solo', 'year'),
  ]);
  // The label quotes what the card is charged: the annual total, per plan.
  assert.ok(buttons[0].label.includes('$48'), buttons[0].label);
  assert.ok(buttons[0].label.includes('Personal'), buttons[0].label);
  assert.ok(buttons[1].label.includes('$144'), buttons[1].label);
  assert.ok(buttons[1].label.includes('Pro'), buttons[1].label);

  // And back again.
  await click(intervalButton(view.container, chrome.connect.intervalMonthly));
  assert.deepEqual(buyButtons(view.container).map(b => b.href), [
    checkoutHref('personal', 'month'),
    checkoutHref('solo', 'month'),
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
    checkoutHref('personal', 'month'),
    checkoutHref('solo', 'month'),
  ]);
});

test('page: with no live prices at all, both plans are still sold, monthly', async (t) => {
  const view = await renderInboxes(t, { addresses: ['info@acme.example'], stripePrices: null });
  assert.deepEqual(buyButtons(view.container).map(b => b.href), [
    checkoutHref('personal', 'month'),
    checkoutHref('solo', 'month'),
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
    { plan: 'personal', href: checkoutHref('personal', 'month'), label: chrome.connect.personalUpgradeCta },
    { plan: 'solo', href: checkoutHref('solo', 'month'), label: chrome.connect.viewUpgradeOptions },
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
    checkoutHref('personal', 'year'),
    checkoutHref('solo', 'year'),
  ]);
  assert.ok(buttons[0].label.includes('$48'), buttons[0].label);
  assert.ok(buttons[1].label.includes('$144'), buttons[1].label);
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
  assert.deepEqual(pageHrefs, [checkoutHref('personal', 'month'), checkoutHref('solo', 'month')]);
  assert.deepEqual(buyButtons(modal).map(b => b.href), [
    checkoutHref('personal', 'year'),
    checkoutHref('solo', 'year'),
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
