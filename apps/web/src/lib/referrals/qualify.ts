/**
 * The qualification decision for one `charged` referral. Pure: the daily
 * dispatcher re-reads the charge from Stripe, counts what it needs, and asks
 * this function what to do.
 *
 * ORDER. Too early waits, whatever else is true: a refund or dispute inside
 * the 14 days is the webhook's job, and the charge is re-read here anyway.
 * After that, a reason to void beats a reason to hold, and a hold beats the
 * cap, so a referral is only ever `capped` when it was otherwise clean.
 */

import { MIN_CHARGE_CENTS, REWARD_CAP_PER_YEAR, VELOCITY_HOLD_PER_DAY } from './constants.ts';
import { cardFingerprintMatch } from './fraud.ts';

export interface QualificationInput {
  now: Date;
  qualifiesAt: Date;
  chargeAmountCents: number;
  chargeRefunded: boolean;
  chargeAmountRefunded: number;
  chargeDisputed: boolean;
  friendFingerprint: string | null;
  referrerFingerprints: string[];
  ipHashMatch: boolean;
  velocityCount24h: number;
  referrerRewardsLast365d: number;
  friendSubscriptionActive: boolean;
}

export type QualificationOutcome = 'wait' | 'qualified' | 'voided' | 'held' | 'capped';

export type QualificationReason =
  | 'refunded'
  | 'partially_refunded'
  | 'disputed'
  | 'charge_too_small'
  | 'same_card'
  | 'same_network'
  | 'velocity'
  | 'cap_reached';

export interface QualificationDecision {
  outcome: QualificationOutcome;
  reason?: QualificationReason;
  rewardReferrer: boolean;
  rewardFriend: boolean;
}

function nobodyRewarded(
  outcome: QualificationOutcome,
  reason?: QualificationReason,
): QualificationDecision {
  return reason
    ? { outcome, reason, rewardReferrer: false, rewardFriend: false }
    : { outcome, rewardReferrer: false, rewardFriend: false };
}

export function decideQualification(input: QualificationInput): QualificationDecision {
  if (input.now.getTime() < input.qualifiesAt.getTime()) return nobodyRewarded('wait');

  // Void: the money did not stay, or it was the referrer's own card.
  if (input.chargeDisputed) return nobodyRewarded('voided', 'disputed');
  if (input.chargeRefunded || input.chargeAmountRefunded >= input.chargeAmountCents) {
    return nobodyRewarded('voided', 'refunded');
  }
  if (input.chargeAmountRefunded > 0) return nobodyRewarded('voided', 'partially_refunded');
  if (input.chargeAmountCents < MIN_CHARGE_CENTS) {
    return nobodyRewarded('voided', 'charge_too_small');
  }
  if (cardFingerprintMatch(input.friendFingerprint, input.referrerFingerprints)) {
    return nobodyRewarded('voided', 'same_card');
  }

  // Hold for a person to look at: legitimate often enough not to void.
  if (input.ipHashMatch) return nobodyRewarded('held', 'same_network');
  if (input.velocityCount24h > VELOCITY_HOLD_PER_DAY) return nobodyRewarded('held', 'velocity');

  // A friend who cancelled already paid a month; they get nothing to spend.
  const rewardFriend = input.friendSubscriptionActive;
  if (input.referrerRewardsLast365d >= REWARD_CAP_PER_YEAR) {
    return { outcome: 'capped', reason: 'cap_reached', rewardReferrer: false, rewardFriend };
  }
  return { outcome: 'qualified', rewardReferrer: true, rewardFriend };
}
