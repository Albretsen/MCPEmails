// ---------------------------------------------------------------------------
// The billing card's "Change or pause your plan" block (PlanChangeBlock.jsx).
//
// Run with: npm run test:plan-change-ui
//
// Renders the real component with the real English messages; `fetch` is the
// only thing replaced. Pinned: nothing renders while both routes answer 404
// (flags off); the pause dialog states the resume date and amount and sends
// confirm: true with the picked inbox; the banners for a booked pause and a
// booked switch; the reason card hides itself when its route is missing.
// Only reserved example domains appear below.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, waitFor, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis.window;

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const { default: PlanChangeBlock } = await import('./PlanChangeBlock.jsx');
const dashboard = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const pc = dashboard.billing.planChange;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const PAUSE_QUOTE = {
  state: 'none',
  pausedFrom: null,
  billsAt: null,
  months: 0,
  planId: 'solo',
  interval: 'month',
  amountCents: 1500,
  currency: 'usd',
  periodEnd: '2026-11-10T12:00:00.000Z',
  cancelScheduled: false,
  canPause: true,
  pauseOptions: [
    { months: 1, billsAt: '2026-12-10T12:00:00.000Z' },
    { months: 2, billsAt: '2027-01-10T12:00:00.000Z' },
  ],
  canExtend: false,
  extendOptions: [],
  inboxes: {
    cap: 1,
    overCap: true,
    inboxes: [
      { id: A, email: 'a@example.com', workspaceId: 'w', keep: true },
      { id: B, email: 'b@example.com', workspaceId: 'w', keep: false },
    ],
  },
};

const DOWNGRADE_QUOTE = {
  pending: null,
  canDowngrade: true,
  downgrade: { fromPlan: 'solo', toPlan: 'personal', interval: 'month', amountCents: 900, currency: 'usd', effectiveAt: '2026-11-10T12:00:00.000Z', inboxCap: 3 },
  canSwitchFree: true,
  cancelScheduled: false,
  periodEnd: '2026-11-10T12:00:00.000Z',
  inboxes: { cap: 3, overCap: false, inboxes: [] },
};

function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function render(t, routes) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const handler = routes[url];
    return handler ? handler(body) : respond(404, { error: 'Not found' });
  };
  const view = await mount(createElement(AppLocaleProvider, null, createElement(PlanChangeBlock, { toast: () => {} })));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
  });
  await flush();
  return { view, calls };
}

const text = (view) => view.container.textContent;
/** The date as the component prints it in English. */
const day = (iso) => new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const buttonWith = (view, label) => [...view.container.ownerDocument.querySelectorAll('button')].find((b) => b.textContent.includes(label));

test('both flags off: nothing renders', async (t) => {
  const { view } = await render(t, {});
  assert.equal(text(view), '');
});

test('the block offers pause, Personal and Free', async (t) => {
  const { view } = await render(t, {
    '/api/billing/pause': () => respond(200, PAUSE_QUOTE),
    '/api/billing/downgrade': () => respond(200, DOWNGRADE_QUOTE),
  });
  await waitFor(() => text(view).includes(pc.title));
  assert.ok(text(view).includes(pc.pause));
  assert.ok(text(view).includes(pc.switchTo.replace('{plan}', 'Personal')));
  assert.ok(text(view).includes(pc.switchToFree));
});

test('the pause dialog shows the resume date and amount, and confirms with the kept inbox', async (t) => {
  const { view, calls } = await render(t, {
    '/api/billing/pause': (body) => respond(200, body?.confirm ? { ...PAUSE_QUOTE, changed: true } : PAUSE_QUOTE),
    '/api/billing/downgrade': () => respond(200, DOWNGRADE_QUOTE),
  });
  await waitFor(() => Boolean(buttonWith(view, pc.pause)));
  buttonWith(view, pc.pause).click();
  await waitFor(() => text(view).includes(pc.pauseTitle));
  assert.ok(text(view).includes(day('2026-12-10T12:00:00.000Z')), 'the one-month resume date');
  assert.ok(text(view).includes('$15.00'));
  assert.ok(text(view).includes('a@example.com'), 'the inbox picker is shown above the cap');

  // Keep b instead of a: one inbox at Free's cap, so the pick replaces.
  const b = view.container.ownerDocument.querySelector(`input[data-inbox-id="${B}"]`);
  b.click();
  await flush();
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = () => 0; // no reload in the test
  t.after(() => { window.setTimeout = originalSetTimeout; });
  buttonWith(view, pc.pauseConfirm).click();
  await waitFor(() => calls.some((c) => c.body?.confirm === true));
  const sent = calls.find((c) => c.body?.confirm === true).body;
  assert.equal(sent.action, 'pause');
  assert.equal(sent.months, 1);
  assert.deepEqual(sent.keepInboxIds, [B]);
});

test('a booked pause shows its banner with Resume early, and no new offers', async (t) => {
  const { view } = await render(t, {
    '/api/billing/pause': () => respond(200, { ...PAUSE_QUOTE, state: 'paused', billsAt: '2027-01-10T12:00:00.000Z', canPause: false, canExtend: true, extendOptions: [{ months: 1, billsAt: '2027-02-10T12:00:00.000Z' }] }),
    '/api/billing/downgrade': () => respond(200, { ...DOWNGRADE_QUOTE, canDowngrade: false, canSwitchFree: false }),
  });
  await waitFor(() => text(view).includes(day('2027-01-10T12:00:00.000Z')));
  assert.ok(text(view).includes(pc.resumeEarly));
  assert.ok(text(view).includes(pc.extend));
  assert.equal(text(view).includes(pc.title), false);
});

test('a booked switch shows Keep Pro', async (t) => {
  const { view } = await render(t, {
    '/api/billing/downgrade': () => respond(200, { ...DOWNGRADE_QUOTE, canDowngrade: false, pending: { fromPlan: 'solo', toPlan: 'personal', effectiveAt: '2026-11-10T12:00:00.000Z' } }),
  });
  await waitFor(() => text(view).includes(day('2026-11-10T12:00:00.000Z')));
  assert.ok(text(view).includes(pc.keepPlan.replace('{plan}', 'Pro')));
});

test('the reason card shows after a cancel and hides itself when its route is missing', async (t) => {
  try { window.localStorage.clear(); } catch { /* no storage */ }
  const { view, calls } = await render(t, {
    '/api/billing/downgrade': () => respond(200, { ...DOWNGRADE_QUOTE, canDowngrade: false, canSwitchFree: false, cancelScheduled: true }),
  });
  await waitFor(() => text(view).includes(dashboard.billing.cancelReason.prompt));
  const reason = view.container.querySelector('[data-reason="too_expensive"]').closest('button');
  reason.click();
  await waitFor(() => calls.some((c) => c.url === '/api/billing/feedback'));
  assert.deepEqual(calls.find((c) => c.url === '/api/billing/feedback').body, { reason: 'too_expensive', source: 'billing_card' });
  await waitFor(() => !text(view).includes(dashboard.billing.cancelReason.prompt));
});

// ── Keep my plan (POST /api/billing/keep) ───────────────────────────────────

const KEEP_QUOTE = {
  cancelScheduled: true,
  endsAt: '2026-11-16T12:00:00.000Z',
  canKeep: true,
  keepRefusal: null,
  planId: 'personal',
  interval: 'month',
  amountCents: 900,
  currency: 'usd',
};

function noReload(t) {
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = () => 0;
  t.after(() => { window.setTimeout = originalSetTimeout; });
}

function withSearch(t, search) {
  window.history.replaceState(null, '', `/dashboard/settings${search}`);
  t.after(() => window.history.replaceState(null, '', '/dashboard/settings'));
}

const modalOpen = (view) => Boolean(view.container.ownerDocument.querySelector('.modal'));
const modalButton = (view, label) =>
  [...view.container.ownerDocument.querySelectorAll('.modal-foot button')].find((b) => b.textContent.includes(label));

test('a scheduled stop shows the end date and Keep my plan, which confirms with source billing_page', async (t) => {
  const { view, calls } = await render(t, {
    '/api/billing/keep': (body) => respond(200, body?.confirm ? { ...KEEP_QUOTE, canKeep: false, changed: true } : KEEP_QUOTE),
  });
  await waitFor(() => text(view).includes(pc.keepMyPlan));
  assert.ok(text(view).includes(pc.endsBanner.replace('{plan}', 'Personal').replace('{date}', day(KEEP_QUOTE.endsAt))));
  buttonWith(view, pc.keepMyPlan).click();
  await waitFor(() => text(view).includes('$9.00'));
  noReload(t);
  modalButton(view, pc.keepMyPlan).click();
  await waitFor(() => calls.some((c) => c.url === '/api/billing/keep' && c.body?.confirm === true));
  assert.deepEqual(calls.find((c) => c.body?.confirm === true).body, { action: 'keep', source: 'billing_page', confirm: true });
});

test('no keep banner while the keep route is off (404)', async (t) => {
  const { view } = await render(t, {
    '/api/billing/downgrade': () => respond(200, { ...DOWNGRADE_QUOTE, canDowngrade: false, canSwitchFree: false, cancelScheduled: true }),
  });
  await flush();
  assert.equal(text(view).includes(pc.keepMyPlan), false);
});

test('an email link with plan_action=keep opens the keep dialog, attributed to the email, and nothing is sent until confirm', async (t) => {
  withSearch(t, '?plan_action=keep&src=plan_ending_email');
  const { view, calls } = await render(t, {
    '/api/billing/keep': (body) => respond(200, body?.confirm ? { ...KEEP_QUOTE, changed: true } : KEEP_QUOTE),
  });
  await waitFor(() => modalOpen(view));
  assert.equal(calls.some((c) => c.body?.confirm === true), false, 'opening the link changes nothing');
  assert.equal(window.location.search, '', 'the action is cleared from the address bar');
  noReload(t);
  modalButton(view, pc.keepMyPlan).click();
  await waitFor(() => calls.some((c) => c.body?.confirm === true));
  assert.equal(calls.find((c) => c.body?.confirm === true).body.source, 'plan_ending_email');
});

test('an email link with plan_action=pause opens the pause dialog and the pause carries the source', async (t) => {
  withSearch(t, '?plan_action=pause&src=cancel_email');
  const { view, calls } = await render(t, {
    '/api/billing/pause': (body) => respond(200, body?.confirm ? { ...PAUSE_QUOTE, changed: true } : { ...PAUSE_QUOTE, cancelScheduled: true }),
  });
  await waitFor(() => text(view).includes(pc.pauseTitle));
  noReload(t);
  buttonWith(view, pc.pauseConfirm).click();
  await waitFor(() => calls.some((c) => c.body?.confirm === true));
  const sent = calls.find((c) => c.body?.confirm === true).body;
  assert.equal(sent.action, 'pause');
  assert.equal(sent.source, 'cancel_email');
});

test('a keep link for a plan that no longer has a scheduled end opens nothing', async (t) => {
  withSearch(t, '?plan_action=keep&src=plan_ending_email');
  const { view } = await render(t, {
    '/api/billing/keep': () => respond(200, { ...KEEP_QUOTE, cancelScheduled: false, canKeep: false, endsAt: null }),
    '/api/billing/downgrade': () => respond(200, DOWNGRADE_QUOTE),
  });
  await waitFor(() => text(view).includes(pc.title));
  assert.equal(modalOpen(view), false);
});
