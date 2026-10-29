import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachRefusalReason,
  cardFingerprintMatch,
  isDisposableEmail,
  normalizeEmail,
  type AttachCheckInput,
} from './fraud.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function input(over: Partial<AttachCheckInput> = {}): AttachCheckInput {
  return {
    referrerUserId: 'u-referrer',
    friendUserId: 'u-friend',
    referrerEmail: 'referrer@example.com',
    friendEmail: 'friend@example.org',
    friendCreatedAt: new Date(NOW.getTime() - DAY),
    now: NOW,
    friendHasPaidHistory: false,
    friendAlreadyReferred: false,
    referrerIsMemberOfFriendWorkspace: false,
    codeDisabled: false,
    ...over,
  };
}

test('normalizeEmail: case, whitespace and plus tags on every domain', () => {
  assert.equal(normalizeEmail('  Jane.Doe+news@Example.COM '), 'jane.doe@example.com');
  assert.equal(normalizeEmail('a+b+c@fastmail.com'), 'a@fastmail.com');
});

test('normalizeEmail: Gmail dots and the googlemail alias', () => {
  assert.equal(normalizeEmail('J.a.n.e@gmail.com'), 'jane@gmail.com');
  assert.equal(normalizeEmail('jane.doe+x@googlemail.com'), 'janedoe@gmail.com');
  assert.equal(normalizeEmail('jane.doe@gmail.com'), normalizeEmail('JaneDoe+ref@GoogleMail.com'));
});

test('normalizeEmail: dots are kept outside Gmail', () => {
  assert.equal(normalizeEmail('jane.doe@outlook.com'), 'jane.doe@outlook.com');
  assert.notEqual(normalizeEmail('jane.doe@outlook.com'), normalizeEmail('janedoe@outlook.com'));
});

test('normalizeEmail: something that is not an address is only trimmed and lowercased', () => {
  assert.equal(normalizeEmail(' NotAnEmail '), 'notanemail');
  assert.equal(normalizeEmail('@gmail.com'), '@gmail.com');
});

test('isDisposableEmail uses the shared disposable list', () => {
  assert.equal(isDisposableEmail('x@mailinator.com'), true);
  assert.equal(isDisposableEmail('X@YopMail.com'), true);
  assert.equal(isDisposableEmail('x@sub.guerrillamail.com'), true);
  assert.equal(isDisposableEmail('x@gmail.com'), false);
  assert.equal(isDisposableEmail('x@notmailinator.com'), false);
  assert.equal(isDisposableEmail('garbage'), false);
});

test('a clean new friend is accepted', () => {
  assert.equal(attachRefusalReason(input()), null);
});

test('self-referral by id or by workspace membership', () => {
  assert.equal(attachRefusalReason(input({ friendUserId: 'u-referrer' })), 'self');
  assert.equal(attachRefusalReason(input({ referrerIsMemberOfFriendWorkspace: true })), 'self');
});

test('same person, second address', () => {
  assert.equal(
    attachRefusalReason(input({ referrerEmail: 'jane.doe@gmail.com', friendEmail: 'janedoe+2@googlemail.com' })),
    'same_email',
  );
});

test('disposable friend or referrer address', () => {
  assert.equal(attachRefusalReason(input({ friendEmail: 'f@10minutemail.com' })), 'disposable');
  assert.equal(attachRefusalReason(input({ referrerEmail: 'r@temp-mail.org' })), 'disposable');
});

test('existing customers and old accounts are refused', () => {
  assert.equal(attachRefusalReason(input({ friendHasPaidHistory: true })), 'paid_before');
  assert.equal(
    attachRefusalReason(input({ friendCreatedAt: new Date(NOW.getTime() - 31 * DAY) })),
    'not_new',
  );
  assert.equal(
    attachRefusalReason(input({ friendCreatedAt: new Date(NOW.getTime() - 30 * DAY) })),
    null,
  );
  assert.equal(attachRefusalReason(input({ friendCreatedAt: new Date('invalid') })), 'not_new');
});

test('one referral per friend, and disabled codes', () => {
  assert.equal(attachRefusalReason(input({ friendAlreadyReferred: true })), 'already_referred');
  assert.equal(attachRefusalReason(input({ codeDisabled: true })), 'code_disabled');
});

test('card fingerprints', () => {
  assert.equal(cardFingerprintMatch('fp_a', ['fp_b', 'fp_a']), true);
  assert.equal(cardFingerprintMatch('fp_a', ['fp_b']), false);
  assert.equal(cardFingerprintMatch(null, ['fp_a']), false);
  assert.equal(cardFingerprintMatch('', ['']), false);
  assert.equal(cardFingerprintMatch('fp_a', []), false);
});
