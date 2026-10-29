import assert from 'node:assert/strict';
import test from 'node:test';

import { MIN_CHARGE_CENTS, QUALIFY_DAYS, REWARD_CAP_PER_YEAR, VELOCITY_HOLD_PER_DAY } from './constants.ts';
import { decideQualification, type QualificationInput } from './qualify.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHARGED_AT = new Date('2026-10-01T09:00:00Z');
const QUALIFIES_AT = new Date(CHARGED_AT.getTime() + QUALIFY_DAYS * DAY);

function input(over: Partial<QualificationInput> = {}): QualificationInput {
  return {
    now: QUALIFIES_AT,
    qualifiesAt: QUALIFIES_AT,
    chargeAmountCents: 900,
    chargeRefunded: false,
    chargeAmountRefunded: 0,
    chargeDisputed: false,
    friendFingerprint: 'fp_friend',
    referrerFingerprints: ['fp_referrer'],
    ipHashMatch: false,
    velocityCount24h: 1,
    referrerRewardsLast365d: 0,
    friendSubscriptionActive: true,
    ...over,
  };
}

test('14-day boundary: 13d23h waits, 14d qualifies', () => {
  const early = decideQualification(input({ now: new Date(CHARGED_AT.getTime() + 13 * DAY + 23 * HOUR) }));
  assert.deepEqual(early, { outcome: 'wait', rewardReferrer: false, rewardFriend: false });
  assert.deepEqual(decideQualification(input()), {
    outcome: 'qualified',
    rewardReferrer: true,
    rewardFriend: true,
  });
});

test('waiting comes first, even for a charge that would be voided', () => {
  const r = decideQualification(input({ now: new Date(QUALIFIES_AT.getTime() - 1), chargeDisputed: true }));
  assert.equal(r.outcome, 'wait');
});

test('refunded charges void, by flag or by full amount', () => {
  assert.deepEqual(decideQualification(input({ chargeRefunded: true, chargeAmountRefunded: 900 })), {
    outcome: 'voided',
    reason: 'refunded',
    rewardReferrer: false,
    rewardFriend: false,
  });
  assert.equal(decideQualification(input({ chargeAmountRefunded: 900 })).reason, 'refunded');
});

test('a partial refund voids', () => {
  const r = decideQualification(input({ chargeAmountRefunded: 100 }));
  assert.equal(r.outcome, 'voided');
  assert.equal(r.reason, 'partially_refunded');
});

test('a disputed charge voids', () => {
  const r = decideQualification(input({ chargeDisputed: true }));
  assert.equal(r.outcome, 'voided');
  assert.equal(r.reason, 'disputed');
});

test('a charge under the minimum voids; the minimum itself qualifies', () => {
  const small = decideQualification(input({ chargeAmountCents: MIN_CHARGE_CENTS - 1 }));
  assert.equal(small.outcome, 'voided');
  assert.equal(small.reason, 'charge_too_small');
  assert.equal(decideQualification(input({ chargeAmountCents: MIN_CHARGE_CENTS })).outcome, 'qualified');
});

test('the referrer card voids', () => {
  const r = decideQualification(input({ friendFingerprint: 'fp_referrer' }));
  assert.equal(r.outcome, 'voided');
  assert.equal(r.reason, 'same_card');
});

test('friend cancelled: referrer rewarded, friend not', () => {
  assert.deepEqual(decideQualification(input({ friendSubscriptionActive: false })), {
    outcome: 'qualified',
    rewardReferrer: true,
    rewardFriend: false,
  });
});

test('cap reached: capped, referrer not rewarded, friend still rewarded while subscribed', () => {
  assert.deepEqual(decideQualification(input({ referrerRewardsLast365d: REWARD_CAP_PER_YEAR })), {
    outcome: 'capped',
    reason: 'cap_reached',
    rewardReferrer: false,
    rewardFriend: true,
  });
  const cancelled = decideQualification(
    input({ referrerRewardsLast365d: REWARD_CAP_PER_YEAR, friendSubscriptionActive: false }),
  );
  assert.equal(cancelled.outcome, 'capped');
  assert.equal(cancelled.rewardFriend, false);
  assert.equal(
    decideQualification(input({ referrerRewardsLast365d: REWARD_CAP_PER_YEAR - 1 })).outcome,
    'qualified',
  );
});

test('holds: same network, and velocity above the daily limit', () => {
  assert.deepEqual(decideQualification(input({ ipHashMatch: true })), {
    outcome: 'held',
    reason: 'same_network',
    rewardReferrer: false,
    rewardFriend: false,
  });
  const fast = decideQualification(input({ velocityCount24h: VELOCITY_HOLD_PER_DAY + 1 }));
  assert.equal(fast.outcome, 'held');
  assert.equal(fast.reason, 'velocity');
  assert.equal(decideQualification(input({ velocityCount24h: VELOCITY_HOLD_PER_DAY })).outcome, 'qualified');
});

test('order: void beats hold, hold beats cap', () => {
  assert.equal(decideQualification(input({ chargeDisputed: true, ipHashMatch: true })).outcome, 'voided');
  assert.equal(
    decideQualification(input({ ipHashMatch: true, referrerRewardsLast365d: REWARD_CAP_PER_YEAR })).outcome,
    'held',
  );
});
