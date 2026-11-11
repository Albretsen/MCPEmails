// ---------------------------------------------------------------------------
// The monthly-to-annual card and notice (AnnualSwitch.jsx).
//
// Run with: npm run test:annual-switch-ui
//
// Pins: the saving is computed from the price map (never 20% written down);
// no saving, no card; the card's button reports a click and calls onSwitch
// with the plan (it charges nothing itself); the notice hides when the server
// says it was dismissed, and its close button reports the dismissal; every
// locale with dashboardChrome carries the copy.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return new Response('{}', { status: 200 });
};

const { NextIntlClientProvider } = await import('next-intl');
const { AnnualSwitchCard, AnnualSwitchNotice, annualSwitchView } = await import('./AnnualSwitch.jsx');
const en = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const nb = (await import('../../messages/nb/dashboardChrome.json', { with: { type: 'json' } })).default;

const PRICES = {
  personal: { monthlyCents: 900, yearlyCents: 8640, yearlyPriceConfigured: true, monthlyPriceConfigured: true },
  solo: { monthlyCents: 1500, yearlyCents: 18000, yearlyPriceConfigured: true, monthlyPriceConfigured: true },
  pro: { monthlyCents: 3900, yearlyCents: 37440, yearlyPriceConfigured: false, monthlyPriceConfigured: true },
};

async function render(t, element, { locale = 'en', messages = en } = {}) {
  const view = await mount(createElement(NextIntlClientProvider, { locale, messages: { dashboardChrome: messages } }, element));
  t.after(() => view.unmount());
  return view;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the saving comes from the price map; no saving or no yearly price means no card', () => {
  assert.deepEqual(annualSwitchView({ planId: 'personal' }, PRICES), { planId: 'personal', plan: 'Personal', percent: 20 });
  assert.equal(annualSwitchView({ planId: 'solo' }, PRICES), null, '12 x $15 = $180: nothing saved');
  assert.equal(annualSwitchView({ planId: 'pro' }, PRICES), null, 'yearly price not configured');
  assert.equal(annualSwitchView(null, PRICES), null);
  const repriced = { personal: { ...PRICES.personal, yearlyCents: 8100 } };
  assert.equal(annualSwitchView({ planId: 'personal' }, repriced).percent, 25);
});

test('the card states the saving and only hands the plan to onSwitch', async (t) => {
  calls.length = 0;
  const switched = [];
  const view = await render(t, createElement(AnnualSwitchCard, {
    annualSwitch: { planId: 'personal', currency: 'usd', noticeVisible: true },
    stripePrices: PRICES,
    workspaceId: 'ws1',
    onSwitch: (planId) => switched.push(planId),
  }));
  const text = view.container.textContent;
  assert.equal(text.includes('save 20% compared with paying monthly'), true);
  assert.equal(text.includes(en.annualSwitch.current), true);
  await flush();
  view.container.querySelector('button').click();
  await flush();
  assert.deepEqual(switched, ['personal']);
  assert.deepEqual(calls.map((c) => `${c.body.event}/${c.body.surface}`), ['shown/billing', 'clicked/billing']);
  // The card is permanent: no close button.
  assert.equal(view.container.querySelectorAll('button').length, 1);
});

test('the notice hides once dismissed, and reports the dismissal', async (t) => {
  calls.length = 0;
  const hidden = await render(t, createElement(AnnualSwitchNotice, {
    annualSwitch: { planId: 'personal', currency: 'usd', noticeVisible: false },
    stripePrices: PRICES,
    workspaceId: 'ws1',
    onOpenBilling: () => {},
  }));
  assert.equal(hidden.container.textContent, '');

  let opened = 0;
  const view = await render(t, createElement(AnnualSwitchNotice, {
    annualSwitch: { planId: 'personal', currency: 'usd', noticeVisible: true },
    stripePrices: PRICES,
    workspaceId: 'ws1',
    onOpenBilling: () => { opened += 1; },
  }), { locale: 'nb', messages: nb });
  assert.equal(view.container.textContent.includes('20 % mindre'), true);
  await flush();
  view.container.querySelector('[data-annual-switch-close]').click();
  await flush();
  assert.equal(view.container.querySelector('[data-annual-switch-notice]') === null, true);
  assert.equal(opened, 0);
  assert.deepEqual(calls.map((c) => `${c.body.event}/${c.body.surface}`), ['shown/overview', 'dismissed/overview']);
});

test('every dashboardChrome locale except frozen zh has the copy, without em dashes', () => {
  const keys = Object.keys(en.annualSwitch).sort();
  for (const locale of ['de', 'es', 'fr', 'ja', 'nb', 'pt']) {
    const messages = JSON.parse(readFileSync(new URL(`../../messages/${locale}/dashboardChrome.json`, import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(messages.annualSwitch ?? {}).sort(), keys, locale);
    for (const value of Object.values(messages.annualSwitch)) {
      assert.equal(/—|</.test(value), false, `${locale}: ${value}`);
    }
  }
});
