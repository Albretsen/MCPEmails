import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRO_PRICE_CHANGE,
  formatUsdCents,
  proPriceNoticeVisible,
  proSoldAmounts,
} from './pro-price-change.ts';
import {
  PRO_PRICE_NOTICE_LOCALES,
  proPriceNoticeCopy,
  proPriceNoticeValues,
} from './pro-price-notice-copy.mjs';
import { PLANS, getPlanByStripePriceId, retainedPriceGenerationId } from './plans.ts';

const SWITCH_AT = Date.parse(PRO_PRICE_CHANGE.switchAt);
const DAY = 24 * 60 * 60 * 1000;

test('the price is live: Pro sells $19 / $182.40 and the notice is down', () => {
  assert.equal(PRO_PRICE_CHANGE.priceLive, true);
  // With the new price live there is nothing left to announce, whatever
  // `announce` says.
  assert.equal(proPriceNoticeVisible(SWITCH_AT - DAY), false);
  // Pro sells $19 / $182.40 from the _V2 variables; the unsuffixed $15 / $144
  // pair is the legacy pair every earlier subscriber keeps.
  assert.deepEqual(proSoldAmounts(), PRO_PRICE_CHANGE.next);
  assert.equal(PLANS.solo.monthlyPriceCents, 1900);
  assert.equal(PLANS.solo.yearlyPriceCents, 18240);
});

test('the amounts are the announced ones, and yearly is 12 months less exactly 20%', () => {
  assert.deepEqual(PRO_PRICE_CHANGE.current, { monthlyCents: 1500, yearlyCents: 14400 });
  assert.deepEqual(PRO_PRICE_CHANGE.next, { monthlyCents: 1900, yearlyCents: 18240 });
  for (const gen of [PRO_PRICE_CHANGE.current, PRO_PRICE_CHANGE.next]) {
    assert.equal(gen.yearlyCents, gen.monthlyCents * 12 * 0.8);
  }
});

test('the switch instant is midnight in Oslo on the switch date, the day after the last lock-in day', () => {
  const oslo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  assert.equal(oslo.format(SWITCH_AT), `${PRO_PRICE_CHANGE.switchDate}, 00:00`);
  assert.equal(oslo.format(SWITCH_AT - 1).slice(0, 10), PRO_PRICE_CHANGE.lastLockInDate);
});

test('the notice shows only while announced, before the switch, and with the old price still sold', () => {
  const on = { announce: true, priceLive: false, switchAt: PRO_PRICE_CHANGE.switchAt };
  assert.equal(proPriceNoticeVisible(SWITCH_AT - DAY, on), true);
  assert.equal(proPriceNoticeVisible(SWITCH_AT - 1, on), true);
  // At and after the instant it is gone, whatever the switches say: a late
  // cutover never leaves a passed deadline on screen.
  assert.equal(proPriceNoticeVisible(SWITCH_AT, on), false);
  assert.equal(proPriceNoticeVisible(SWITCH_AT + DAY, on), false);
  // Once the new price is live there is nothing left to announce.
  assert.equal(proPriceNoticeVisible(SWITCH_AT - DAY, { ...on, priceLive: true }), false);
  assert.equal(proPriceNoticeVisible(SWITCH_AT - DAY, { ...on, announce: false }), false);
  assert.equal(proPriceNoticeVisible(SWITCH_AT - DAY, { ...on, switchAt: 'not a date' }), false);
});

test('the price switch sells the next amounts', () => {
  assert.deepEqual(
    proSoldAmounts({ ...PRO_PRICE_CHANGE, priceLive: true }),
    PRO_PRICE_CHANGE.next,
  );
});

test('every locale quotes both prices and both dates, computed from the constants', () => {
  for (const locale of PRO_PRICE_NOTICE_LOCALES) {
    const v = proPriceNoticeValues(locale);
    const copy = proPriceNoticeCopy(locale);
    for (const value of [v.next, v.nextYear, v.cur, v.curYear, v.switchDate]) {
      assert.ok(copy.pricing.includes(value), `${locale} pricing line lacks ${value}`);
      assert.ok(copy.faq.a.includes(value), `${locale} FAQ answer lacks ${value}`);
    }
    assert.ok(copy.pricing.includes(v.lastDate), `${locale} pricing line lacks ${v.lastDate}`);
    for (const value of [v.next, v.cur, v.switchDate, v.lastDate]) {
      assert.ok(copy.app.includes(value), `${locale} app line lacks ${value}`);
    }
    // No urgency theatre and no before-price.
    for (const line of [copy.pricing, copy.app, copy.faq.a]) {
      assert.doesNotMatch(line, /—|%|<|\bwas\b|hurry|last chance/i, `${locale}: ${line}`);
    }
  }
  assert.equal(proPriceNoticeValues('en').switchDate, '8 December 2026');
  assert.equal(proPriceNoticeValues('en').lastDate, '7 December');
  assert.equal(proPriceNoticeValues('en').nextYear, '$182.40');
  assert.equal(proPriceNoticeValues('fr').nextYear, '182,40 $');
  // zh is frozen and reads English.
  assert.equal(proPriceNoticeCopy('zh').pricing, proPriceNoticeCopy('en').pricing);
});

test('formatUsdCents writes whole dollars bare and cents with two places', () => {
  assert.equal(formatUsdCents(1900), '$19');
  assert.equal(formatUsdCents(18240), '$182.40');
});

test('a retained Pro subscriber switching interval stays on their own generation', () => {
  const retained = ['price_old_month', 'price_old_year'];
  assert.equal(retainedPriceGenerationId('price_old_month', 'solo', 'year', retained), 'price_old_year');
  assert.equal(retainedPriceGenerationId('price_old_year', 'solo', 'month', retained), 'price_old_month');
  // Leaving Pro, or not being on the retained pair, gets the sold price.
  assert.equal(retainedPriceGenerationId('price_old_month', 'pro', 'year', retained), null);
  assert.equal(retainedPriceGenerationId('price_old_month', 'personal', 'month', retained), null);
  assert.equal(retainedPriceGenerationId('price_sold_month', 'solo', 'year', retained), null);
  assert.equal(retainedPriceGenerationId(null, 'solo', 'year', retained), null);
  // An unset half is never returned as a price.
  assert.equal(retainedPriceGenerationId('price_old_month', 'solo', 'year', ['price_old_month', '']), null);
  // An id that is not on the retained pair gets the sold price.
  assert.equal(retainedPriceGenerationId('anything', 'solo', 'year'), null);
});

test('after the cutover the retained $15 / $144 ids still resolve to Pro, so every earlier subscriber stays mapped', () => {
  // The retained pair occupies the last two legacy slots, monthly then yearly.
  const legacy = PLANS.solo.legacyStripePriceIds;
  assert.equal(legacy.length % 2, 0);
  const [m, y] = legacy.slice(-2);
  if (m) assert.deepEqual(getPlanByStripePriceId(m), { plan: PLANS.solo, interval: 'month' });
  if (y) assert.deepEqual(getPlanByStripePriceId(y), { plan: PLANS.solo, interval: 'year' });
});
