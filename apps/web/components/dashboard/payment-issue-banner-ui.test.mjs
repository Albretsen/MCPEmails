// ---------------------------------------------------------------------------
// The failed-payment banner (PaymentIssueBanner.jsx).
//
// Run with: npm run test:payment-issue-ui
//
// Pins: shown to the owner on past_due and unpaid, hidden on active and for a
// member, the confirm variant on `authentication_required`, the button goes to
// /api/stripe/payment-fix, and the Norwegian copy renders from messages/nb.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { installDom, mount } from '../../scripts/test-dom.mjs';

installDom();

const { NextIntlClientProvider } = await import('next-intl');
const { PaymentIssueBanner, paymentIssueVariant } = await import('./PaymentIssueBanner.jsx');
const en = (await import('../../messages/en/dashboardChrome.json', { with: { type: 'json' } })).default;
const nb = (await import('../../messages/nb/dashboardChrome.json', { with: { type: 'json' } })).default;

async function render(t, props, { locale = 'en', messages = en } = {}) {
  const view = await mount(
    createElement(NextIntlClientProvider, { locale, messages: { dashboardChrome: messages } },
      createElement(PaymentIssueBanner, props)),
  );
  t.after(() => view.unmount());
  return view;
}

const banner = (view) => view.container.querySelector('[data-payment-issue]');
const variantOf = (view) => banner(view)?.getAttribute('data-payment-issue') ?? 'none';

test('past_due: the owner sees the generic line and an Update payment link', async (t) => {
  const view = await render(t, { isOwner: true, subscriptionStatus: 'past_due', lastDeclineCode: 'insufficient_funds' });
  assert.equal(variantOf(view), 'declined');
  assert.equal(view.container.textContent.includes(en.app.paymentIssueDeclined), true);
  const link = view.container.querySelector('a');
  assert.equal(link?.getAttribute('href') ?? '', '/api/stripe/payment-fix');
  assert.equal(link?.textContent.trim() ?? '', 'Update payment');
});

test('unpaid also shows the banner', async (t) => {
  const view = await render(t, { isOwner: true, subscriptionStatus: 'unpaid', lastDeclineCode: null });
  assert.equal(variantOf(view), 'declined');
});

test('active: nothing is rendered', async (t) => {
  const view = await render(t, { isOwner: true, subscriptionStatus: 'active', lastDeclineCode: 'insufficient_funds' });
  assert.equal(variantOf(view), 'none');
  assert.equal(view.container.textContent, '');
});

test('a member never sees it, even while past_due', async (t) => {
  const view = await render(t, { isOwner: false, subscriptionStatus: 'past_due', lastDeclineCode: null });
  assert.equal(variantOf(view), 'none');
});

test('authentication_required: the confirm variant', async (t) => {
  const view = await render(t, { isOwner: true, subscriptionStatus: 'past_due', lastDeclineCode: 'authentication_required' });
  assert.equal(variantOf(view), 'confirm');
  assert.equal(view.container.textContent.includes(en.app.paymentIssueConfirm), true);
  assert.equal(view.container.querySelector('a')?.textContent.trim() ?? '', 'Confirm payment');
});

test('Norwegian locale renders the Norwegian copy', async (t) => {
  const view = await render(
    t,
    { isOwner: true, subscriptionStatus: 'past_due', lastDeclineCode: null },
    { locale: 'nb', messages: nb },
  );
  assert.equal(view.container.textContent.includes(nb.app.paymentIssueDeclined), true);
  assert.notEqual(nb.app.paymentIssueDeclined, en.app.paymentIssueDeclined);
});

test('the decision helper', () => {
  assert.equal(paymentIssueVariant({ isOwner: true, subscriptionStatus: 'trialing' }), null);
  assert.equal(paymentIssueVariant({ isOwner: true, subscriptionStatus: null }), null);
  assert.equal(paymentIssueVariant({ subscriptionStatus: 'past_due' }), null);
  assert.equal(paymentIssueVariant({ isOwner: true, subscriptionStatus: 'past_due', lastDeclineCode: 'card_declined' }), 'declined');
});

test('no message contains a literal angle bracket, in any locale', async () => {
  for (const locale of ['en', 'nb', 'es', 'fr', 'de', 'zh']) {
    const messages = (await import(`../../messages/${locale}/dashboardChrome.json`, { with: { type: 'json' } })).default;
    for (const key of ['paymentIssueDeclined', 'paymentIssueDeclinedCta', 'paymentIssueConfirm', 'paymentIssueConfirmCta']) {
      const value = messages.app[key];
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.equal(/[<>]/.test(value), false, `${locale}.${key}`);
    }
  }
});
