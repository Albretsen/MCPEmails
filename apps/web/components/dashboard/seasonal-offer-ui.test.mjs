// ---------------------------------------------------------------------------
// The dashboard during Black Week 2026: the first-year line on the annual
// upgrade options, and the "switch to annual" card on the billing page.
//
// Run with: npm run test:seasonal-offer-ui
//
// The server decides who gets what (app/dashboard/[[...section]]/page.js
// attaches `seasonalOffer` to the Personal and Pro price entries, and passes
// `workspace.seasonalSwitch` only to a monthly Personal or Pro owner). These
// tests render the REAL dashboard with those props and read the DOM: the line
// appears on annual only, never on Business, every number is the offer
// object's, the switch card appears only for the plan it names and hides on
// annual, Business and a missing offer, and its button asks for a quote rather
// than charging anything.
//
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { DashboardApp } = await import('./App.jsx');
const chrome = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;

const ENDS = '2026-12-01T22:59:59.000Z';
const WORKSPACE_ID = 'ws-0001';

function offer(planId, firstYearCents, normalYearlyCents, endsAt = ENDS) {
  return {
    offerId: 'bw2026', planId, interval: 'year', couponId: `C_${planId}`,
    normalYearlyCents, firstYearCents, savingCents: normalYearlyCents - firstYearCents, endsAt,
  };
}

const BASE_PRICES = {
  personal: { monthlyCents: 900, yearlyCents: 8640, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
  solo: { monthlyCents: 1500, yearlyCents: 14400, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
  pro: { monthlyCents: 3900, yearlyCents: 37440, monthlyPriceConfigured: true, yearlyPriceConfigured: true },
};
const WITH_OFFERS = {
  ...BASE_PRICES,
  personal: { ...BASE_PRICES.personal, seasonalOffer: offer('personal', 5900, 8640) },
  solo: { ...BASE_PRICES.solo, seasonalOffer: offer('solo', 9900, 14400) },
};

async function renderDashboard(t, {
  route = 'settings',
  plan = 'free',
  stripePrices = WITH_OFFERS,
  seasonalSwitch = null,
  isOwner = true,
  addresses = [],
  maxInboxes = 1,
  userEmail = 'ada@gmail.com',
} = {}) {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    if (String(url) === '/api/stripe/checkout') {
      return { ok: true, status: 200, json: async () => ({ confirmation_required: true, plan: 'Personal', plan_id: 'personal', interval: 'year', preview: null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const view = await mount(createElement(AppLocaleProvider, null,
    createElement(DashboardApp, {
      initialRoute: route,
      user: { displayName: 'Ada', email: userEmail, initials: 'A', id: 'u-0001' },
      workspace: {
        id: WORKSPACE_ID, slug: 'acme', plan, compedScale: false, displayName: 'Acme', isOwner,
        draftEditorEnabled: false, draftEditorHidden: false, seasonalSwitch,
      },
      workspaces: [],
      activeWorkspaceId: WORKSPACE_ID,
      mcpUrl: 'https://mcpemails.com/api/mcp',
      userRole: isOwner ? 'owner' : 'member',
      planLimits: { maxInboxes, historyDays: 30 },
      stripePrices,
      overviewStats: {},
      activityFeed: [],
      inboxes: addresses.map((address, i) => ({
        id: `ib-${i}`, label: address.split('@')[0], address, provider: 'imap', service: 'imap', status: 'active',
        lastError: null, hasImap: true, calls: 0, createdAt: '2026-09-01T00:00:00.000Z', lastCallAt: null,
        draftEditorHidden: false, sendReviewMode: 'off', sendApprovalRequired: false,
      })),
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
  return {
    ...view,
    requests,
    lines: () => [...c.querySelectorAll('[data-seasonal-offer]')].map((el) => [el.getAttribute('data-seasonal-offer'), el.textContent]),
    switchCard: () => c.querySelector('[data-seasonal-switch]'),
    intervalButton: (label) => [...c.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.startsWith(label)),
  };
}

const PERSONAL_LINE =
  'Black Week: $59 for your first year, then $86.40 a year. You save $27.40.'
  + 'Ends 1 December 2026, 23:59 Oslo time.';
const PRO_LINE =
  'Black Week: $99 for your first year, then $144 a year. You save $45.'
  + 'Ends 1 December 2026, 23:59 Oslo time.';

// ── Billing page upgrade cards ──────────────────────────────────────────────

test('billing (Free): annual Personal and Pro cards carry the line, Business does not', async (t) => {
  const view = await renderDashboard(t);
  assert.deepEqual(view.lines(), [['personal', PERSONAL_LINE], ['solo', PRO_LINE]]);
});

test('billing (Free): the monthly view hides the line', async (t) => {
  const view = await renderDashboard(t);
  await flush(() => view.intervalButton(dashboard.billing.monthly).click());
  assert.deepEqual(view.lines(), []);
  await flush(() => view.intervalButton(dashboard.billing.annual).click());
  assert.equal(view.lines().length, 2);
});

test('billing: no offer from the server (outside the window) shows nothing', async (t) => {
  const view = await renderDashboard(t, { stripePrices: BASE_PRICES });
  assert.deepEqual(view.lines(), []);
  assert.equal(view.switchCard(), null);
});

test('billing: an offer whose end has passed is not shown', async (t) => {
  const ended = {
    ...BASE_PRICES,
    personal: { ...BASE_PRICES.personal, seasonalOffer: offer('personal', 5900, 8640, '2026-01-01T00:00:00.000Z') },
  };
  const view = await renderDashboard(t, { stripePrices: ended });
  assert.deepEqual(view.lines(), []);
});

test('billing: amounts are the offer object\'s, not typed', async (t) => {
  const odd = { ...BASE_PRICES, personal: { ...BASE_PRICES.personal, seasonalOffer: offer('personal', 1234, 5678) } };
  const view = await renderDashboard(t, { stripePrices: odd });
  assert.equal(view.lines().length, 1);
  assert.match(view.lines()[0][1], /\$12\.34 for your first year, then \$56\.78 a year\. You save \$44\.44\./);
});

// ── The switch card ─────────────────────────────────────────────────────────

test('switch card: a monthly Personal owner sees it, and its button only asks for a quote', async (t) => {
  const view = await renderDashboard(t, { plan: 'personal', seasonalSwitch: offer('personal', 5900, 8640) });
  const card = view.switchCard();
  assert.ok(card, 'the switch card should render');
  assert.equal(card.getAttribute('data-seasonal-switch'), 'personal');
  assert.match(card.textContent, /^Black Week: switch to annual for \$59 your first year, then \$86\.40 a year\. The unused days of your current month are taken off, so you pay a bit less than that today\./);
  assert.match(card.textContent, /Ends 1 December 2026, 23:59 Oslo time\./);

  const button = [...card.querySelectorAll('button')].find((b) => b.textContent === chrome.seasonal.switchCta);
  assert.ok(button);
  await flush(async () => { button.click(); await new Promise((r) => setTimeout(r, 5)); });
  const posts = view.requests.filter((r) => r.url === '/api/stripe/checkout');
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body);
  assert.equal(body.planId, 'personal');
  assert.equal(body.interval, 'year');
  assert.equal(body.confirm, undefined, 'the first request never confirms');
  assert.ok(view.container.querySelector('[role="dialog"]'), 'the quote dialog opens');
});

test('switch card: hidden for annual subscribers (the server sends no switch offer)', async (t) => {
  const view = await renderDashboard(t, { plan: 'personal', seasonalSwitch: null, stripePrices: BASE_PRICES });
  assert.equal(view.switchCard(), null);
});

test('switch card: hidden for Business, and for an offer naming another plan', async (t) => {
  const business = await renderDashboard(t, { plan: 'pro', seasonalSwitch: offer('solo', 9900, 14400) });
  assert.equal(business.switchCard(), null);
  await business.unmount();
  const mismatch = await renderDashboard(t, { plan: 'solo', seasonalSwitch: offer('personal', 5900, 8640) });
  assert.equal(mismatch.switchCard(), null);
});

test('switch card: hidden for a member who does not own the workspace', async (t) => {
  const view = await renderDashboard(t, { plan: 'personal', isOwner: false, seasonalSwitch: offer('personal', 5900, 8640) });
  assert.equal(view.switchCard(), null);
});

test('switch card: a monthly Pro owner sees the Pro numbers', async (t) => {
  const view = await renderDashboard(t, { plan: 'solo', seasonalSwitch: offer('solo', 9900, 14400) });
  assert.match(view.switchCard().textContent, /for \$99 your first year, then \$144 a year\./);
});

// ── The inbox-cap paywall (UpgradeIntervalChoice) ───────────────────────────

test('inbox cap: Annual shows the Black Week badge and line, the button states no amount; Monthly is unchanged', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes', addresses: ['ada@gmail.com'] });
  const annual = view.intervalButton(chrome.connect.intervalAnnual);
  assert.ok(annual, 'the annual option should render');
  assert.match(annual.textContent, /Black Week/);
  // Monthly is the default here, and shows no offer.
  assert.deepEqual(view.lines(), []);

  await flush(() => annual.click());
  assert.deepEqual(view.lines(), [['personal', PERSONAL_LINE]]);
  const buy = view.container.querySelector('a[data-cap-offer-plan="personal"]');
  assert.equal(buy.textContent, 'Upgrade to Personal, annual');
  assert.equal(buy.getAttribute('href'), '/api/stripe/checkout/start?plan=personal&interval=year');

  await flush(() => view.intervalButton(chrome.connect.intervalMonthly).click());
  assert.deepEqual(view.lines(), []);
});

test('inbox cap, two plans (company domain): Black Week badge, one line per plan, no amounts on the buttons', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes', addresses: ['ada@acme.example'], userEmail: 'ada@acme.example' });
  const annual = view.intervalButton(chrome.connect.intervalAnnual);
  assert.match(annual.textContent, /Black Week/);
  await flush(() => annual.click());
  assert.deepEqual(view.lines().map(([plan]) => plan).sort(), ['personal', 'solo']);
  const labels = [...view.container.querySelectorAll('a[data-cap-offer-plan]')].map((a) => a.textContent).sort();
  assert.deepEqual(labels, ['Upgrade to Personal, annual', 'Upgrade to Pro, annual']);
});

test('inbox cap: without an offer the annual option is exactly as before', async (t) => {
  const view = await renderDashboard(t, { route: 'inboxes', addresses: ['ada@gmail.com'], stripePrices: BASE_PRICES });
  const annual = view.intervalButton(chrome.connect.intervalAnnual);
  assert.doesNotMatch(annual.textContent, /Black Week/);
  await flush(() => annual.click());
  assert.deepEqual(view.lines(), []);
  assert.match(view.container.querySelector('a[data-cap-offer-plan="personal"]').textContent, /\$86\.40\/yr/);
});
