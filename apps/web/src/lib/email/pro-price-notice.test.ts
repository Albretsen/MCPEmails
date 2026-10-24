import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeProPriceNotice,
  decideNotice,
  noticeSendAllowed,
  proPriceNoticeTriggerKey,
  type NoticeCandidate,
} from './pro-price-notice.ts';

const NOW = new Date('2026-11-17T09:00:00Z');

const eligible: NoticeCandidate = {
  userId: 'u1',
  email: 'reader@example.com',
  marketingConsentAt: '2026-10-01T10:00:00Z',
  unsubscribedAt: null,
  unsubscribedCategories: [],
  unsubscribeToken: 'tok-1',
  internal: false,
  ownedPlans: ['free'],
  subscriptionStatus: null,
  lastActiveAt: '2026-11-10T10:00:00Z',
  alreadyClaimed: false,
};

test('an active, consenting Free owner gets the notice', () => {
  assert.deepEqual(decideNotice(eligible, NOW), { send: true });
});

test('every exclusion holds on its own', () => {
  const cases: Array<[Partial<NoticeCandidate>, string]> = [
    [{ email: null }, 'no_email'],
    [{ marketingConsentAt: null }, 'no_consent'],
    [{ unsubscribedAt: '2026-11-01T00:00:00Z' }, 'unsubscribed'],
    [{ unsubscribedCategories: ['product_update'] }, 'unsubscribed'],
    [{ unsubscribeToken: null }, 'no_token'],
    [{ internal: true }, 'internal'],
    [{ subscriptionStatus: 'active' }, 'subscribed'],
    [{ subscriptionStatus: 'past_due' }, 'subscribed'],
    [{ ownedPlans: ['free', 'solo'] }, 'not_free'],
    [{ ownedPlans: [] }, 'not_free'],
    [{ lastActiveAt: '2026-09-01T00:00:00Z' }, 'inactive'],
    [{ lastActiveAt: null }, 'inactive'],
    [{ alreadyClaimed: true }, 'already_sent'],
  ];
  for (const [patch, reason] of cases) {
    assert.deepEqual(decideNotice({ ...eligible, ...patch }, NOW), { send: false, reason }, JSON.stringify(patch));
  }
  // A lapsed subscription is not a reason to skip a Free owner.
  assert.deepEqual(decideNotice({ ...eligible, subscriptionStatus: 'canceled' }, NOW), { send: true });
  // Unsubscribing from a different category does not stop this one.
  assert.deepEqual(decideNotice({ ...eligible, unsubscribedCategories: ['research'] }, NOW), { send: true });
});

test('the email states both prices and the date, carries a working opt-out, and no pressure', () => {
  const mail = composeProPriceNotice('tok-1');
  assert.ok(mail);
  assert.equal(mail.subject, 'Pro goes to $19 on 8 December');
  for (const fact of ['$15', '$19', '$182.40', '$144', '8 December 2026', 'for as long as your subscription stays active']) {
    assert.ok(mail.text.includes(fact), `text lacks ${fact}`);
  }
  assert.match(mail.text, /\/api\/email\/unsubscribe\?token=tok-1&c=product_update/);
  assert.match(mail.headers['List-Unsubscribe'], /token=tok-1/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.doesNotMatch(mail.text, /—|%|\bwas\b|hurry|last chance|only \d+ days/i);
  assert.match(mail.html, /Unsubscribe from these/);
  assert.equal(composeProPriceNotice(null), null);
});

test('nothing can be sent while the notice is off, which is how it ships', () => {
  assert.equal(noticeSendAllowed(NOW.getTime()), false);
  assert.equal(proPriceNoticeTriggerKey(), '2026-12-08');
});
