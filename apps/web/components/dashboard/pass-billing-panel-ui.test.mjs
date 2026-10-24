// ---------------------------------------------------------------------------
// The Billing panel for a 3-month pass holder (PassBillingPanel in
// PersonalPass.jsx): monthly Personal is a button only once Stripe can anchor
// it to the pass end; before that it is a line with the day it opens, and
// yearly is the button.
//
// Run with: npm run test:pass-billing-ui
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();

const { NextIntlClientProvider } = await import('next-intl');
const { PassBillingPanel } = await import('./PersonalPass.jsx');
const en = (await import('../../messages/en/dashboard.json', { with: { type: 'json' } })).default;
const nb = (await import('../../messages/nb/dashboard.json', { with: { type: 'json' } })).default;

function state(overrides = {}) {
  return {
    currentEndsAt: '2027-03-22T00:00:00.000Z',
    queuedEndsAt: null,
    coveredUntil: '2027-03-22T00:00:00.000Z',
    inLastWeek: false,
    canAddPass: false,
    nextPassEndsAt: '2027-06-22T00:00:00.000Z',
    firstCharge: { month: null, year: '2027-03-22T00:00:00.000Z' },
    monthlyOpensAt: '2027-02-23T00:00:00.000Z',
    ...overrides,
  };
}

async function render(t, passState, { locale = 'en', messages = en } = {}) {
  const calls = [];
  const view = await mount(
    createElement(
      NextIntlClientProvider,
      { locale, messages: { dashboard: messages } },
      createElement(PassBillingPanel, {
        passState,
        stripePrices: null,
        onSubscribe: (planId, interval) => calls.push(`${planId}:${interval}`),
      }),
    ),
  );
  t.after(() => view.unmount());
  return { view, calls };
}

const buttons = (view) => [...view.container.querySelectorAll('button')].map((b) => b.textContent.trim());

test('before the last month: no monthly button, the opening day, and yearly is the button', async (t) => {
  const { view, calls } = await render(t, state());
  const labels = buttons(view);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].startsWith('Yearly'), true, labels[0]);
  assert.equal(labels.some((l) => /monthly/i.test(l)), false);
  const line = view.container.querySelector('[data-pass-monthly="later"]');
  assert.match(line?.textContent ?? '', /^Monthly is available from (23 February 2027|February 23, 2027)\.$/);
  assert.equal(/trial/i.test(view.container.textContent), false);
  view.container.querySelector('button').click();
  assert.deepEqual(calls, ['personal:year']);
});

test('in the last month: the monthly button with its first charge date, and no opening line', async (t) => {
  const { view, calls } = await render(
    t,
    state({ monthlyOpensAt: null, firstCharge: { month: '2027-03-22T00:00:00.000Z', year: '2027-03-22T00:00:00.000Z' } }),
  );
  const labels = buttons(view);
  assert.equal(labels.length, 2);
  assert.equal(labels[0].startsWith('Subscribe monthly'), true, labels[0]);
  assert.match(labels[0], /22 March 2027|March 22, 2027/);
  assert.equal(view.container.querySelector('[data-pass-monthly="later"]') === null, true);
  view.container.querySelector('button').click();
  assert.deepEqual(calls, ['personal:month']);
});

test('the opening line renders in Norwegian', async (t) => {
  const { view } = await render(t, state(), { locale: 'nb', messages: nb });
  const line = view.container.querySelector('[data-pass-monthly="later"]')?.textContent ?? '';
  assert.equal(line.startsWith('Månedlig kan velges fra'), true, line);
});
