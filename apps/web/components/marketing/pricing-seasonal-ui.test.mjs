// ---------------------------------------------------------------------------
// /pricing during Black Week 2026: the first-year line on annual Personal and
// Pro, fetched after mount from /api/seasonal-offer.
//
// Run with: npm run test:pricing-seasonal-ui
//
// The page is prerendered and CDN cached, so the offer is never in its HTML.
// These tests pin the half that runs in the browser: the request is made only
// around the window, the line appears only on the annual Personal and Pro
// cards, every number in it comes from the offer object the server sent, and
// it disappears in the monthly view and once the offer has ended.
//
// The clock is faked (Date only) so "inside the window" does not depend on the
// day the suite runs. The browser Supabase client is mocked as in
// pricing-client-ui.test.mjs; `fetch` answers the offer endpoint and records
// every request.
// ---------------------------------------------------------------------------

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount, flush } from '../../scripts/test-dom.mjs';

installDom();
globalThis.self ??= globalThis;

mock.module(new URL('../../scripts/test-stubs/supabase-client.mjs', import.meta.url).href, {
  namedExports: {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
    }),
  },
});

const { NextIntlClientProvider } = await import('next-intl');
const { default: PricingClient } = await import('./PricingClient.jsx');

function messagesFor(locale) {
  const dir = new URL(`../../messages/${locale}/`, import.meta.url);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]),
  );
}
const en = messagesFor('en');

const INSIDE = Date.parse('2026-11-28T12:00:00Z');
const BEFORE = Date.parse('2026-10-24T12:00:00Z');
const ENDS = '2026-12-01T22:59:59.000Z';

function offer(planId, firstYearCents, normalYearlyCents) {
  return {
    offerId: 'bw2026', planId, interval: 'year', couponId: `C_${planId}`,
    normalYearlyCents, firstYearCents, savingCents: normalYearlyCents - firstYearCents, endsAt: ENDS,
  };
}
const REAL_OFFERS = { personal: offer('personal', 5900, 8640), solo: offer('solo', 9900, 14400) };

async function renderPricing(t, { now = INSIDE, offers = REAL_OFFERS, locale = 'en' } = {}) {
  mock.timers.enable({ apis: ['Date'], now });
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const body = String(url) === '/api/seasonal-offer' ? { offers } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const view = await mount(createElement(
    NextIntlClientProvider,
    { locale, messages: locale === 'en' ? en : messagesFor(locale) },
    createElement(PricingClient, { stripePrices: undefined }),
  ));
  t.after(async () => {
    await view.unmount();
    globalThis.fetch = previousFetch;
    mock.timers.reset();
  });
  await flush(() => new Promise((resolve) => setImmediate(resolve)));
  await flush(() => new Promise((resolve) => setImmediate(resolve)));
  const c = view.container;
  return {
    ...view,
    requests,
    /** plan key -> the offer block's text, for every card that has one. */
    lines: () => Object.fromEntries(
      [...c.querySelectorAll('[data-seasonal-offer]')].map((el) => [el.getAttribute('data-seasonal-offer'), el.textContent]),
    ),
    toggle: (label) => [...c.querySelectorAll('.billing-toggle .billing-opt')].find((b) => b.firstChild.nodeValue === label),
  };
}

test('inside the window: annual Personal and Pro carry the Black Week line, nothing else does', async (t) => {
  const view = await renderPricing(t);
  assert.ok(view.requests.includes('/api/seasonal-offer'));
  const lines = view.lines();
  assert.deepEqual(Object.keys(lines).sort(), ['personal', 'solo']);
  assert.equal(
    lines.personal,
    'Black Week: $59 for your first year, then $86.40 a year. You save $27.40.'
      + 'Ends 1 December 2026, 23:59 Oslo time.',
  );
  assert.equal(
    lines.solo,
    'Black Week: $99 for your first year, then $144 a year. You save $45.'
      + 'Ends 1 December 2026, 23:59 Oslo time.',
  );
});

test('every amount comes from the offer object, never from copy', async (t) => {
  const view = await renderPricing(t, { offers: { personal: offer('personal', 1234, 5678) } });
  assert.deepEqual(Object.keys(view.lines()), ['personal']);
  assert.match(view.lines().personal, /\$12\.34 for your first year, then \$56\.78 a year\. You save \$44\.44\./);
});

test('the monthly view shows no offer; annual brings it back', async (t) => {
  const view = await renderPricing(t);
  await flush(() => view.toggle(en.pricing.billing.monthly).click());
  assert.deepEqual(view.lines(), {});
  await flush(() => view.toggle(en.pricing.billing.annual).click());
  assert.deepEqual(Object.keys(view.lines()).sort(), ['personal', 'solo']);
});

test('outside the window no request is made and nothing is shown', async (t) => {
  const view = await renderPricing(t, { now: BEFORE });
  assert.equal(view.requests.includes('/api/seasonal-offer'), false);
  assert.deepEqual(view.lines(), {});
});

test('the server answering no offers (killed coupon, closed window) shows nothing', async (t) => {
  const view = await renderPricing(t, { offers: {} });
  assert.deepEqual(view.lines(), {});
});

test('an offer that has ended on the reader clock is not shown from a cached answer', async (t) => {
  const view = await renderPricing(t, { now: Date.parse('2026-12-01T23:30:00Z') });
  assert.deepEqual(view.lines(), {});
});

test('Business never gets a line, even if the server sent one', async (t) => {
  const view = await renderPricing(t, { offers: { ...REAL_OFFERS, pro: { ...offer('personal', 100, 200), planId: 'pro' } } });
  assert.deepEqual(Object.keys(view.lines()).sort(), ['personal', 'solo']);
});

test('Norwegian: translated line, Norwegian date and decimal comma', async (t) => {
  const view = await renderPricing(t, { locale: 'nb' });
  assert.equal(
    view.lines().personal,
    'Black Week: $59 det første året, deretter $86,40 i året. Du sparer $27,40.'
      + 'Slutter 1. desember 2026 kl. 23:59 norsk tid.',
  );
});
