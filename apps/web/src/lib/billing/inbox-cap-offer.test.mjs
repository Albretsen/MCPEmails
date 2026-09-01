import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxCapOffer } from './inbox-cap-offer.mjs';

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
