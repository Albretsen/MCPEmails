/**
 * Referral program constants (referral_v1). The full design is the referral
 * plan of 2026-10-24; these numbers are the approved decisions.
 *
 * The code alphabet is mirrored by the CHECK constraint on
 * `referral_codes.code` (migration 20261025090000_referrals.sql). Change both
 * together or not at all.
 */

/** Days a friend's first charge must stand before anyone is rewarded. */
export const QUALIFY_DAYS = 14;
/** A first charge below this (USD cents) never qualifies a referral. */
export const MIN_CHARGE_CENTS = 500;
/** Rewards one referrer can earn in any rolling 365 days. */
export const REWARD_CAP_PER_YEAR = 6;

/** Cookie set by /r/[code], read once at signup. */
export const REF_COOKIE = 'mcpe_ref';
export const REF_COOKIE_DAYS = 60;
/** A code can be typed in by hand this many days after signup, at most. */
export const CODE_ENTRY_WINDOW_DAYS = 30;
/** Length of the Personal entitlement a Free referrer earns per reward. */
export const PERSONAL_MONTH_DAYS = 30;
/** More referrals than this reaching `charged` in 24 hours are held for review. */
export const VELOCITY_HOLD_PER_DAY = 3;

export const CODE_LENGTH = 8;
/** 31 characters: A-Z and 2-9 without 0, O, 1, I and L, which read alike. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
