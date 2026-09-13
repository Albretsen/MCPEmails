import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  USAGE_CAP_OFFER,
  usageCapCheckoutHref,
  usageCapCompareHref,
  usageCapOffer,
} from './usage-cap-offer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function lookup(messages, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), messages);
}

test('the action cap is cleared by Personal, never by Pro', () => {
  // $5 removes the monthly cap. Quoting $15 to someone who only wants to keep
  // reading their mail prices the upgrade far above the problem.
  assert.equal(usageCapOffer().plan, 'personal');
  assert.equal(usageCapOffer({ reached: true }).plan, 'personal');
});

test('the offer names a plan the checkout route will accept', () => {
  const purchasable = new Set(['personal', 'solo', 'pro']);
  assert.ok(purchasable.has(usageCapOffer().plan));
});

test('nearly gone and gone are worded differently, with the same CTA', () => {
  const near = usageCapOffer();
  const reached = usageCapOffer({ reached: true });
  assert.notEqual(near.titleKey, reached.titleKey);
  assert.notEqual(near.bodyKey, reached.bodyKey);
  assert.equal(near.ctaKey, reached.ctaKey);
  assert.deepEqual(near.featureKeys, reached.featureKeys);
});

test('every key the offer names exists in every dashboard locale', () => {
  // The offer is rendered through next-intl. A missing key renders as the
  // key itself, on a paywall, in one language only, which nobody notices
  // until a customer in that language does.
  const locales = ['en', 'es', 'fr', 'nb', 'zh'];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(path.resolve(here, `../../../messages/${locale}/dashboard.json`), 'utf8'));
    for (const offer of [usageCapOffer(), usageCapOffer({ reached: true })]) {
      for (const key of [offer.titleKey, offer.bodyKey, offer.ctaKey, ...offer.featureKeys]) {
        assert.equal(typeof lookup(messages, key), 'string', `${locale}: ${key} is missing from dashboard.json`);
      }
    }
  }
});

test('the feature bullets are the Billing card bullets, not a second wording', () => {
  for (const key of usageCapOffer().featureKeys) {
    assert.ok(key.startsWith('billing.plans.'), key);
  }
  assert.ok(usageCapOffer().featureKeys.includes('billing.plans.personalFeatureActions'));
});

test('both links carry plan, interval and the offer name', () => {
  // The 80% and 100% emails link to
  // /dashboard/settings?upgrade=personal&interval=month&offer=usage_cap. The
  // banner buys through the direct checkout route instead (it is already
  // inside the dashboard), but it must carry the same three values, because
  // an interval missing from either URL is an intent App.jsx drops on the
  // floor and an offer missing from either is a click the funnel cannot
  // attribute.
  const plan = usageCapOffer().plan;
  for (const [annual, interval] of [[false, 'month'], [true, 'year']]) {
    const buy = usageCapCheckoutHref(plan, annual);
    assert.ok(buy.startsWith('/api/stripe/checkout/start?'), buy);
    assert.match(buy, new RegExp(`[?&]plan=${plan}(&|$)`));
    assert.match(buy, new RegExp(`[?&]interval=${interval}(&|$)`));
    assert.match(buy, new RegExp(`[?&]offer=${USAGE_CAP_OFFER}(&|$)`));

    const compare = usageCapCompareHref(plan, annual);
    assert.ok(compare.startsWith('/pricing?'), compare);
    assert.match(compare, new RegExp(`[?&]plan=${plan}(&|$)`));
    assert.match(compare, new RegExp(`[?&]interval=${interval}(&|$)`));
    assert.match(compare, new RegExp(`[?&]offer=${USAGE_CAP_OFFER}(&|$)`));
  }
});

test('the default banner interval is the monthly one the copy quotes', () => {
  // The banner says "$5 a month" and preselects Monthly, so annual=false must
  // be the one that produces interval=month.
  assert.match(usageCapCheckoutHref('personal', false), /interval=month/);
  assert.match(usageCapCheckoutHref('personal', true), /interval=year/);
});

test('a plan /pricing will not emphasise still gets a well-formed compare link', () => {
  // pricingCompareHref degrades to a bare /pricing for an unsellable plan, so
  // the offer name has to attach with "?" there and "&" everywhere else.
  assert.equal(usageCapCompareHref('free', false), `/pricing?offer=${USAGE_CAP_OFFER}`);
});
