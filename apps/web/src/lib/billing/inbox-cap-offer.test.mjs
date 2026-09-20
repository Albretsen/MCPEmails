import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buysAnnual,
  inboxCapOffer,
  sharedIntervalChoice,
  splitSharedFeatures,
} from './inbox-cap-offer.mjs';
import { parseUpgradeIntent } from './upgrade-intent.mjs';
import { isBusinessShapedWorkspace } from '../segment/consumer-domains.mjs';

const BUSINESS = { businessShaped: true };
const CONSUMER = { businessShaped: false };

function readMessages(file) {
  return JSON.parse(readFileSync(new URL(`../../../messages/en/${file}`, import.meta.url), 'utf8'));
}

function lookup(messages, dottedKey) {
  return dottedKey.split('.').reduce((node, part) => node?.[part], messages);
}

test('a Free cap of one inbox is cleared by Personal, not by Pro', () => {
  // Sending someone to $15 to add a SECOND mailbox prices the upgrade far
  // above the problem they actually have.
  const offer = inboxCapOffer(1);
  assert.equal(offer.plan, 'personal');
  assert.equal(offer.ctaKey, 'connect.personalUpgradeCta');
});

test('a Personal cap of three inboxes is cleared by Pro, never by Personal', () => {
  // Offering Personal to a Personal subscriber sells them the plan they hold.
  const offer = inboxCapOffer(3);
  assert.equal(offer.plan, 'solo');
  assert.equal(offer.ctaKey, 'connect.viewUpgradeOptions');
});

test('an unknown cap falls back to the Free assumption', () => {
  // The 402 body always carries a cap, but the client-side prop can be null
  // before plan limits have loaded. Assuming Free matches what the panel's
  // own "connects one inbox" heading already says.
  for (const unknown of [null, undefined]) {
    assert.equal(inboxCapOffer(unknown).plan, 'personal');
  }
});

test('every cap above one is treated as a Personal subscriber, not a Free one', () => {
  // Guards the boundary: a cap of 2 is not a Free workspace, and quoting it
  // Personal would sell a plan that may not clear the cap that was just hit.
  assert.equal(inboxCapOffer(2).plan, 'solo');
});

test('both offers name a plan the checkout route will accept', () => {
  // The CTA renders as checkoutStartHref(offer.plan). A plan id outside the
  // purchasable allowlist would send a blocked user to a refusal redirect
  // instead of to Stripe, which is the failure this whole surface exists to
  // avoid.
  const purchasable = new Set(['personal', 'solo', 'pro']);
  for (const cap of [1, 3]) {
    assert.ok(purchasable.has(inboxCapOffer(cap).plan));
  }
});

test('the modal and the page notice cannot drift, because there is one rule', () => {
  // Both surfaces call this with the same cap and must get the same plan: a
  // user who reads $5 in the modal, closes it, and sees $15 on the page behind
  // has been given two prices for one block, and neither is now trustworthy.
  for (const cap of [1, 3, null]) {
    assert.deepEqual(inboxCapOffer(cap), inboxCapOffer(cap));
  }
});

// ---------------------------------------------------------------------------
// The business-shaped exception
// ---------------------------------------------------------------------------

test('a CONSUMER Free workspace still gets Personal alone, exactly as before', () => {
  // The whole point of scoping the change to a segment: the person adding a
  // second personal mailbox must not start being shown a $15 plan.
  for (const context of [undefined, {}, CONSUMER, { businessShaped: undefined }]) {
    const offer = inboxCapOffer(1, context);
    assert.equal(offer.dual, false);
    assert.equal(offer.offers.length, 1);
    assert.equal(offer.offers[0].plan, 'personal');
    assert.equal(offer.plan, 'personal');
    assert.equal(offer.titleKey, 'connect.personalUpgradeTitle');
    assert.equal(offer.bodyKey, 'connect.personalUpgradeBody');
    assert.equal(offer.ctaKey, 'connect.personalUpgradeCta');
    assert.equal(offer.noticeBodyKey, 'inboxes.capBodyPersonal');
    assert.deepEqual(offer.featureKeys, [
      'connect.personalFeatureInboxes',
      'connect.personalFeatureRateLimit',
      'connect.featureTeam',
      'connect.featureSupport',
    ]);
  }
});

test('a BUSINESS Free workspace is offered Personal AND Pro, in that fixed order', () => {
  // Personal stays, and stays first: most customers buy it. The change is that
  // Pro stops being reachable only through "Compare all plans".
  const offer = inboxCapOffer(1, BUSINESS);
  assert.equal(offer.dual, true);
  assert.deepEqual(offer.offers.map(o => o.plan), ['personal', 'solo']);
  // Stable across calls: the order is a rule, not an accident of object keys.
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(inboxCapOffer(1, BUSINESS).offers.map(o => o.plan), ['personal', 'solo']);
  }
});

test('the business offer leads with the company-mailbox copy, not the consumer copy', () => {
  const offer = inboxCapOffer(1, BUSINESS);
  assert.equal(offer.titleKey, 'connect.businessUpgradeTitle');
  assert.equal(offer.bodyKey, 'connect.businessUpgradeBody');
  assert.equal(offer.noticeBodyKey, 'inboxes.capBodyBusiness');
  assert.notEqual(offer.bodyKey, inboxCapOffer(1, CONSUMER).bodyKey);
  // Each card has its own pitch and its own buy label, on both surfaces.
  const [personal, pro] = offer.offers;
  assert.equal(personal.pitchKey, 'connect.businessPersonalPitch');
  assert.equal(personal.ctaKey, 'connect.personalUpgradeCta');
  assert.equal(personal.noticeCtaKey, 'inboxes.capCtaPersonal');
  assert.equal(pro.pitchKey, 'connect.businessProPitch');
  assert.equal(pro.ctaKey, 'connect.viewUpgradeOptions');
  assert.equal(pro.noticeCtaKey, 'inboxes.capCtaPro');
});

test('the primary offer of a dual panel is still Personal, so `.plan` readers are unaffected', () => {
  // check-inbox-limit.ts builds `upgrade_url` from `.plan` alone, with no
  // shape. Its answer for a Free cap has to stay `personal` whatever else is
  // on the object.
  const offer = inboxCapOffer(1, BUSINESS);
  assert.equal(offer.plan, 'personal');
  assert.equal(offer.ctaKey, 'connect.personalUpgradeCta');
  assert.equal(offer.plan, offer.offers[0].plan);
  assert.equal(inboxCapOffer(1).plan, 'personal');
});

test('a Personal cap gets Pro alone REGARDLESS of shape', () => {
  // From three inboxes there is one way forward. Showing a Personal
  // subscriber "Personal and Pro" would offer them the plan they already hold.
  for (const cap of [2, 3, 5]) {
    for (const context of [undefined, CONSUMER, BUSINESS]) {
      const offer = inboxCapOffer(cap, context);
      assert.equal(offer.dual, false, `cap ${cap} must never be dual`);
      assert.deepEqual(offer.offers.map(o => o.plan), ['solo']);
      assert.equal(offer.plan, 'solo');
      assert.equal(offer.titleKey, 'connect.upgradeTitle');
      assert.equal(offer.bodyKey, 'connect.upgradeBody');
      assert.equal(offer.noticeBodyKey, 'inboxes.capBodyPro');
    }
  }
});

test('an unknown cap follows the Free rule for both shapes', () => {
  for (const unknown of [null, undefined]) {
    assert.deepEqual(inboxCapOffer(unknown, CONSUMER).offers.map(o => o.plan), ['personal']);
    assert.deepEqual(inboxCapOffer(unknown, BUSINESS).offers.map(o => o.plan), ['personal', 'solo']);
    assert.deepEqual(inboxCapOffer(unknown, BUSINESS), inboxCapOffer(1, BUSINESS));
  }
  // A cap of zero is below the Free cap, not above it.
  assert.deepEqual(inboxCapOffer(0, BUSINESS).offers.map(o => o.plan), ['personal', 'solo']);
});

test('only a literal `true` widens the offer: garbage context is the consumer paywall', () => {
  // A mis-wired prop must not quietly change what a paywall sells.
  for (const garbage of [
    null, 0, 1, 'true', 'yes', [], {}, () => true,
    { businessShaped: 'true' }, { businessShaped: 1 }, { businessShaped: {} },
    { businessShaped: [] }, { businessShaped: null }, { business: true },
  ]) {
    const offer = inboxCapOffer(1, garbage);
    assert.equal(offer.dual, false, `${JSON.stringify(garbage)} must not widen the offer`);
    assert.deepEqual(offer.offers.map(o => o.plan), ['personal']);
  }
});

test('garbage caps never throw and never produce an empty offer', () => {
  for (const cap of [NaN, -1, 0, 1.5, Infinity, '1', '3', 'abc', {}, []]) {
    for (const context of [undefined, CONSUMER, BUSINESS]) {
      const offer = inboxCapOffer(cap, context);
      assert.ok(offer.offers.length >= 1);
      assert.equal(offer.dual, offer.offers.length > 1);
      assert.equal(offer.plan, offer.offers[0].plan);
    }
  }
});

test('EVERY offered plan is one the checkout route will accept, at both intervals', () => {
  // Uses the real allowlist the checkout-start route validates against, not a
  // copy of it, so the two cannot drift.
  for (const cap of [null, 0, 1, 2, 3]) {
    for (const context of [CONSUMER, BUSINESS]) {
      for (const planOffer of inboxCapOffer(cap, context).offers) {
        for (const interval of ['month', 'year']) {
          assert.notEqual(
            parseUpgradeIntent(planOffer.plan, interval),
            null,
            `${planOffer.plan}/${interval} is not purchasable`,
          );
        }
      }
    }
  }
});

test('no offer ever sells Team, and no plan appears twice on one panel', () => {
  for (const cap of [null, 1, 3]) {
    for (const context of [CONSUMER, BUSINESS]) {
      const plans = inboxCapOffer(cap, context).offers.map(o => o.plan);
      assert.equal(plans.includes('pro'), false, 'internal `pro` is Team, $79');
      assert.equal(new Set(plans).size, plans.length);
    }
  }
});

test('the modal and the page get IDENTICAL offers from identical inputs', () => {
  // The two surfaces are two callers of one function with the same two
  // arguments (App.jsx hands both the same cap and the same boolean).
  for (const cap of [null, 1, 3]) {
    for (const context of [CONSUMER, BUSINESS]) {
      const modal = inboxCapOffer(cap, { ...context });
      const page = inboxCapOffer(cap, { ...context });
      assert.deepEqual(modal, page);
    }
  }
});

test('one caller mutating its offer cannot change what the other surface sells', () => {
  const first = inboxCapOffer(1, BUSINESS);
  first.offers.pop();
  first.offers[0].plan = 'pro';
  first.offers[0].featureKeys.length = 0;
  first.featureKeys.length = 0;
  const second = inboxCapOffer(1, BUSINESS);
  assert.deepEqual(second.offers.map(o => o.plan), ['personal', 'solo']);
  assert.equal(second.offers[0].featureKeys.length, 4);
  assert.equal(second.featureKeys.length, 4);
});

test('the classifier and the rule compose: mixed workspace in, both plans out', () => {
  // End to end through the two pure halves, the way App.jsx wires them.
  const offerFor = (inboxes, ownerEmail) =>
    inboxCapOffer(1, { businessShaped: isBusinessShapedWorkspace({ inboxes, ownerEmail }) })
      .offers.map(o => o.plan);

  assert.deepEqual(offerFor([{ address: 'ada@gmail.com' }]), ['personal']);
  assert.deepEqual(offerFor([{ address: 'ada@yahoo.in' }]), ['personal']);
  assert.deepEqual(offerFor([{ address: 'ada@hotmail.no' }]), ['personal']);
  assert.deepEqual(offerFor([{ address: 'ada@rogers.com' }]), ['personal']);
  assert.deepEqual(offerFor([{ address: 'info@acme.example' }]), ['personal', 'solo']);
  assert.deepEqual(
    offerFor([{ address: 'ada@gmail.com' }, { address: 'info@acme.example' }]),
    ['personal', 'solo'],
  );
  assert.deepEqual(offerFor([{ address: 'ada@gmail.com' }], 'ada@acme.example'), ['personal', 'solo']);
  assert.deepEqual(offerFor([], undefined), ['personal']);
  assert.deepEqual(offerFor(undefined, 'garbage'), ['personal']);
});

test('every copy key the rule can return exists in the English messages', () => {
  // A key with no message renders as the raw key path on the one screen built
  // to take money. `connect.*` keys live in dashboardChrome, `inboxes.*` in
  // dashboard.
  const chrome = readMessages('dashboardChrome.json');
  const dashboard = readMessages('dashboard.json');
  const messageFor = key => lookup(key.startsWith('inboxes.') ? dashboard : chrome, key);

  for (const cap of [1, 3]) {
    for (const context of [CONSUMER, BUSINESS]) {
      const offer = inboxCapOffer(cap, context);
      const keys = [offer.titleKey, offer.bodyKey, offer.ctaKey, offer.noticeBodyKey, ...offer.featureKeys];
      for (const planOffer of offer.offers) {
        keys.push(planOffer.ctaKey, planOffer.noticeCtaKey, ...planOffer.featureKeys);
        if (offer.dual) keys.push(planOffer.pitchKey);
      }
      for (const key of keys) {
        assert.equal(typeof messageFor(key), 'string', `${key} has no English message`);
      }
    }
  }
});

test('a dual card always has a pitch; a single offer never needs one', () => {
  for (const planOffer of inboxCapOffer(1, BUSINESS).offers) {
    assert.equal(typeof planOffer.pitchKey, 'string');
  }
  assert.equal(inboxCapOffer(1, CONSUMER).offers[0].pitchKey, null);
  assert.equal(inboxCapOffer(3, BUSINESS).offers[0].pitchKey, null);
});

// ---------------------------------------------------------------------------
// splitSharedFeatures
// ---------------------------------------------------------------------------

test('dual cards keep only the lines that tell the plans apart', () => {
  const { shared, byPlan } = splitSharedFeatures(inboxCapOffer(1, BUSINESS).offers);
  assert.deepEqual(shared, ['connect.featureTeam', 'connect.featureSupport']);
  assert.deepEqual(byPlan.personal, [
    'connect.personalFeatureInboxes',
    'connect.personalFeatureRateLimit',
  ]);
  assert.deepEqual(byPlan.solo, ['connect.featureInboxes', 'connect.featureRateLimit']);
});

test('no feature line is lost or duplicated by the split', () => {
  const offers = inboxCapOffer(1, BUSINESS).offers;
  const { shared, byPlan } = splitSharedFeatures(offers);
  for (const planOffer of offers) {
    assert.deepEqual(
      [...byPlan[planOffer.plan], ...shared].sort(),
      [...planOffer.featureKeys].sort(),
    );
  }
});

test('a single offer shares nothing, and garbage splits to nothing', () => {
  const single = splitSharedFeatures(inboxCapOffer(1, CONSUMER).offers);
  assert.deepEqual(single.shared, []);
  assert.equal(single.byPlan.personal.length, 4);
  assert.deepEqual(splitSharedFeatures(undefined), { shared: [], byPlan: {} });
  assert.deepEqual(splitSharedFeatures([]), { shared: [], byPlan: {} });
});

// ---------------------------------------------------------------------------
// One interval choice over two buy buttons
// ---------------------------------------------------------------------------

const ANNUAL_20 = { savingPercent: 20 };
const ANNUAL_17 = { savingPercent: 17 };
const ANNUAL_FLAT = { savingPercent: null };

test('annual is offered only when EVERY plan on the panel can be bought yearly', () => {
  assert.equal(sharedIntervalChoice([ANNUAL_20, ANNUAL_20]).annualAvailable, true);
  assert.equal(sharedIntervalChoice([ANNUAL_20, null]).annualAvailable, false);
  assert.equal(sharedIntervalChoice([null, ANNUAL_20]).annualAvailable, false);
  assert.equal(sharedIntervalChoice([undefined, ANNUAL_20]).annualAvailable, false);
  assert.equal(sharedIntervalChoice([null, null]).annualAvailable, false);
  assert.equal(sharedIntervalChoice([]).annualAvailable, false);
  assert.equal(sharedIntervalChoice(undefined).annualAvailable, false);
  assert.equal(sharedIntervalChoice(null).annualAvailable, false);
});

test('one saving badge only when every plan saves the same percent', () => {
  assert.equal(sharedIntervalChoice([ANNUAL_20, ANNUAL_20]).savingPercent, 20);
  // Two different savings under one badge would overstate one of them.
  assert.equal(sharedIntervalChoice([ANNUAL_20, ANNUAL_17]).savingPercent, null);
  assert.equal(sharedIntervalChoice([ANNUAL_20, ANNUAL_FLAT]).savingPercent, null);
  assert.equal(sharedIntervalChoice([ANNUAL_FLAT, ANNUAL_FLAT]).savingPercent, null);
  assert.equal(sharedIntervalChoice([{}, {}]).savingPercent, null);
  assert.equal(sharedIntervalChoice([ANNUAL_20, null]).savingPercent, null);
});

test('MONTHLY IS THE DEFAULT: a button buys annual only on an explicit year it can sell', () => {
  assert.equal(buysAnnual('year', ANNUAL_20), true);
  assert.equal(buysAnnual('month', ANNUAL_20), false);
  // The shared interval says year, but THIS plan has no yearly price.
  assert.equal(buysAnnual('year', null), false);
  assert.equal(buysAnnual('year', undefined), false);
  for (const notYear of [undefined, null, '', 'Year', 'YEAR', 'annual', 'yearly', true, 1]) {
    assert.equal(buysAnnual(notYear, ANNUAL_20), false, `${String(notYear)} must buy monthly`);
  }
});
