// ---------------------------------------------------------------------------
// The referral program in the dashboard: Invite page, Overview tile, code field.
//
// Run with: npm run test:referral-ui
//
// Renders the real InvitePanel, ReferralTile and ReferralCodeEntry against a
// stubbed /api/referrals and asserts through the DOM and the requests:
//   - the link and code are shown, Copy writes the link and sends one
//     `copied` beacon, and the page sends one `viewed` beacon;
//   - an empty list says so; each status reads as the agreed line;
//   - no friend identity reaches the DOM, even if the API sent one;
//   - credit renders as USD and the reward count against the cap;
//   - the code field POSTs the code, confirms on 200, and shows one line on
//     a refusal and another on a network failure;
//   - the tile's eligibility rule, and that a dismissal is remembered;
//   - the Billing credit line shows only for a positive credit, and its link
//     opens the Invite section.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount, flush, waitFor } from '../../scripts/test-dom.mjs';

installDom();
// next/link schedules its prefetch through requestIdleCallback, which reads `self`.
globalThis.self ??= globalThis.window;

const { default: AppLocaleProvider } = await import('../i18n/AppLocaleProvider.jsx');
const {
  InvitePanel, ReferralTile, ReferralCodeEntry, BillingReferralCredit, referralTileEligible, TILE_DISMISSED_KEY,
} = await import('./InvitePanel.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const R = en.referral;

const LINK = 'https://mcpemails.com/r/ABCD2345';
const FRIEND_EMAIL = 'friend.person@example.net';

function summary(overrides = {}) {
  return {
    enabled: true,
    code: 'ABCD2345',
    link: LINK,
    creditBalanceCents: 1500,
    rewardsLast365d: 2,
    cap: 6,
    canEnterCode: false,
    referrals: [],
    ...overrides,
  };
}

/** Stubs fetch for the two referral endpoints; records every call. */
function stubFetch(t, { get = summary(), postStatus = 200, postThrows = false } = {}) {
  const requests = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(url), method, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (String(url) === '/api/analytics/referral') return json(204, null);
    if (String(url) !== '/api/referrals') return json(404, {});
    if (method === 'GET') return json(200, get);
    if (postThrows) throw new TypeError('network down');
    return json(postStatus, postStatus === 200 ? { ok: true } : { error: 'refused' });
  };
  t.after(() => { globalThis.fetch = previous; });
  return requests;
}

function stubClipboard(t) {
  const written = [];
  const previous = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text) => { written.push(text); } },
    configurable: true,
  });
  t.after(() => Object.defineProperty(navigator, 'clipboard', { value: previous, configurable: true }));
  return written;
}

async function render(t, element) {
  const view = await mount(createElement(AppLocaleProvider, null, element));
  t.after(() => view.unmount());
  return view;
}

async function renderPanel(t, get) {
  const requests = stubFetch(t, { get });
  const view = await render(t, createElement(InvitePanel));
  await waitFor(() => !view.container.textContent.includes(R.loading), { message: 'summary loaded' });
  return { view, requests };
}

const beacons = (requests, action) =>
  requests.filter((r) => r.url === '/api/analytics/referral' && r.body?.action === action).length;

test('link, code, rules, USD credit and the reward count against the cap', async (t) => {
  const { view, requests } = await renderPanel(t);
  const text = view.container.textContent;
  assert.equal(view.container.querySelector('[data-referral-link]')?.textContent, LINK);
  assert.ok(text.includes('ABCD2345'));
  assert.ok(text.includes('Up to 6 free months a year'));
  assert.equal(view.container.querySelector('[data-referral-credit]')?.textContent, '$15.00');
  assert.equal(view.container.querySelector('[data-referral-rewards]')?.textContent, '2 of 6');
  await waitFor(() => beacons(requests, 'viewed') === 1, { message: 'viewed beacon' });
});

test('Copy writes the link, says so, and sends one copied beacon', async (t) => {
  const written = stubClipboard(t);
  const { view, requests } = await renderPanel(t);
  const button = [...view.container.querySelectorAll('button')].find((b) => b.textContent === R.copy);
  assert.ok(button, 'copy button');
  await flush(async () => { button.click(); });
  assert.deepEqual(written, [LINK]);
  await waitFor(() => view.container.textContent.includes(R.copied), { message: 'copied label' });
  assert.equal(beacons(requests, 'copied'), 1);
});

test('no referrals: the empty line', async (t) => {
  const { view } = await renderPanel(t);
  assert.equal(view.container.querySelector('[data-referral-empty]')?.textContent, R.empty);
  assert.equal(view.container.querySelectorAll('[data-referral-status]').length, 0);
});

test('each status reads as its line, and every row is "A friend"', async (t) => {
  const rows = [
    { id: 'r1', status: 'attached', attached_at: '2026-11-02T10:00:00Z', qualifies_at: null },
    { id: 'r2', status: 'charged', attached_at: '2026-11-03T10:00:00Z', qualifies_at: '2026-11-26T10:00:00Z' },
    { id: 'r3', status: 'qualified', attached_at: '2026-11-04T10:00:00Z', reward_kind: 'stripe_credit', reward_cents: 900 },
    { id: 'r4', status: 'qualified', attached_at: '2026-11-05T10:00:00Z', reward_kind: 'personal_month', entitlement_until: '2026-12-20T00:00:00Z' },
    { id: 'r5', status: 'capped', attached_at: '2026-11-06T10:00:00Z' },
    { id: 'r6', status: 'voided', attached_at: '2026-11-07T10:00:00Z' },
  ];
  const { view } = await renderPanel(t, summary({ referrals: rows }));
  const lines = [...view.container.querySelectorAll('[data-referral-status]')].map((li) => li.textContent);
  assert.equal(lines.length, 6);
  for (const line of lines) assert.ok(line.startsWith('A friend, joined '), line);
  assert.ok(lines[0].endsWith(R.statusWaiting));
  assert.ok(lines[1].endsWith('Reward on Nov 26, 2026'), lines[1]);
  assert.ok(lines[2].endsWith(R.statusQualifiedCredit));
  assert.ok(lines[3].endsWith('Month of Personal until Dec 20, 2026'), lines[3]);
  assert.ok(lines[4].endsWith(R.statusCapped));
  assert.ok(lines[5].endsWith(R.statusVoided));
});

test('no friend identity in the DOM, even when the API sends one', async (t) => {
  const leaky = {
    id: 'r1', status: 'attached', attached_at: '2026-11-02T10:00:00Z',
    friend_email: FRIEND_EMAIL, friend_name: 'Friend Person', friend_user_id: 'u-friend-0001',
  };
  const { view } = await renderPanel(t, summary({ referrals: [leaky] }));
  const html = view.container.innerHTML;
  assert.equal(html.includes(FRIEND_EMAIL), false);
  assert.equal(html.includes('Friend Person'), false);
  assert.equal(html.includes('u-friend-0001'), false);
  assert.equal(html.includes('r1'), false, 'not even the row id');
});

test('flag off: no link and no beacon', async (t) => {
  const { view, requests } = await renderPanel(t, { enabled: false });
  assert.equal(view.container.querySelectorAll('[data-referral-link]').length, 0);
  assert.equal(beacons(requests, 'viewed'), 0);
});

async function renderCodeEntry(t, opts) {
  const requests = stubFetch(t, opts);
  const view = await render(t, createElement(ReferralCodeEntry));
  const input = view.container.querySelector('input');
  await flush(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ' abcd2345 ');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const button = view.container.querySelector('button[type="submit"]');
  await flush(async () => { button.click(); });
  return { view, requests };
}

test('code entry: 200 posts the trimmed code and confirms', async (t) => {
  const { view, requests } = await renderCodeEntry(t, { postStatus: 200 });
  await waitFor(() => view.container.textContent.includes(R.codeEntryApplied), { message: 'applied' });
  const post = requests.find((r) => r.method === 'POST' && r.url === '/api/referrals');
  assert.deepEqual(post?.body, { code: 'abcd2345' });
  assert.equal(view.container.querySelectorAll('input').length, 0);
});

test('code entry: a refusal is one line and the field stays', async (t) => {
  const { view } = await renderCodeEntry(t, { postStatus: 400 });
  await waitFor(() => view.container.querySelector('[role="alert"]')?.textContent === R.codeEntryError, { message: 'refusal line' });
  assert.equal(view.container.querySelectorAll('input').length, 1);
});

test('code entry: a network failure says to try again', async (t) => {
  const { view } = await renderCodeEntry(t, { postThrows: true });
  await waitFor(() => view.container.querySelector('[role="alert"]')?.textContent === R.codeEntryNetwork, { message: 'network line' });
});

test('tile eligibility: paid needs 10 sends and 14 paid days; Free needs 5 active days', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const paid15 = '2026-11-16T00:00:00Z';
  const paid13 = '2026-11-18T00:00:00Z';
  assert.equal(referralTileEligible({ plan: 'solo', successfulSends: 10, paidSince: paid15, now }), true);
  assert.equal(referralTileEligible({ plan: 'solo', successfulSends: 9, paidSince: paid15, now }), false);
  assert.equal(referralTileEligible({ plan: 'personal', successfulSends: 50, paidSince: paid13, now }), false);
  assert.equal(referralTileEligible({ plan: 'pro', successfulSends: 50, paidSince: null, now }), false);
  const days = (n) => Array.from({ length: 7 }, (_, i) => ({ date: `d${i}`, count: i < n ? 3 : 0 }));
  assert.equal(referralTileEligible({ plan: 'free', dailyCounts: days(5), now }), true);
  assert.equal(referralTileEligible({ plan: 'free', dailyCounts: days(4), now }), false);
});

test('tile: opens the Invite page, and a dismissal is remembered', async (t) => {
  try { window.localStorage.removeItem(TILE_DISMISSED_KEY); } catch { /* jsdom has storage */ }
  t.after(() => { try { window.localStorage.removeItem(TILE_DISMISSED_KEY); } catch { /* ignore */ } });
  let opened = 0;
  const view = await render(t, createElement(ReferralTile, { onOpen: () => { opened++; } }));
  await waitFor(() => view.container.querySelector('[data-referral-tile]'), { message: 'tile shown' });
  const cta = [...view.container.querySelectorAll('button')].find((b) => b.textContent === R.tileCta);
  await flush(async () => { cta.click(); });
  assert.equal(opened, 1);
  await flush(async () => { view.container.querySelector('[data-referral-tile-dismiss]').click(); });
  assert.equal(view.container.querySelectorAll('[data-referral-tile]').length, 0);
  assert.equal(window.localStorage.getItem(TILE_DISMISSED_KEY), '1');

  const again = await render(t, createElement(ReferralTile, { onOpen: () => {} }));
  await flush();
  assert.equal(again.container.querySelectorAll('[data-referral-tile]').length, 0);
});

test('Billing credit line: the amount and an Invite link, only when credit is above zero', async (t) => {
  stubFetch(t, { get: summary({ creditBalanceCents: 1500 }) });
  let opened = 0;
  const view = await render(t, createElement(BillingReferralCredit, { onOpenInvite: () => { opened += 1; } }));
  await waitFor(() => view.container.querySelector('[data-billing-referral-credit]'), { message: 'credit line' });
  const line = view.container.querySelector('[data-billing-referral-credit]').textContent;
  assert.ok(line.includes(R.billingCredit.replace('{amount}', '$15.00')), line);
  const link = view.container.querySelector('[data-billing-referral-link]');
  assert.equal(link.getAttribute('href'), '/dashboard/invite');
  assert.equal(link.textContent, R.billingCreditLink);
  await flush(async () => { link.click(); });
  assert.equal(opened, 1);
});

for (const [name, get] of [
  ['no credit', summary({ creditBalanceCents: 0 })],
  ['a failed balance read', summary({ creditBalanceCents: null })],
  ['the program off', { enabled: false }],
]) {
  test(`Billing credit line: nothing for ${name}`, async (t) => {
    const requests = stubFetch(t, { get });
    const view = await render(t, createElement(BillingReferralCredit));
    await waitFor(() => requests.some((r) => r.url === '/api/referrals'), { message: 'summary requested' });
    await flush(async () => {});
    assert.equal(view.container.querySelector('[data-billing-referral-credit]'), null);
    assert.equal(view.container.textContent, '');
  });
}

test('credit is shown in the currency the API returns', async (t) => {
  const { view } = await renderPanel(t, summary({ creditBalanceCents: 900, creditCurrency: 'eur' }));
  assert.equal(view.container.querySelector('[data-referral-credit]')?.textContent, '€9.00');
});

test('Billing credit line: a EUR credit reads in EUR', async (t) => {
  stubFetch(t, { get: summary({ creditBalanceCents: 900, creditCurrency: 'eur' }) });
  const view = await render(t, createElement(BillingReferralCredit));
  await waitFor(() => view.container.querySelector('[data-billing-referral-credit]'), { message: 'credit line' });
  assert.ok(view.container.textContent.includes('€9.00'), view.container.textContent);
});
