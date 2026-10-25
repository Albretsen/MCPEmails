/**
 * Attach-time and qualification-time fraud checks for referrals. Pure: the
 * caller looks everything up and passes plain values in.
 *
 * Refusals are quiet. The caller shows one generic message whatever the
 * reason, and records the reason only in `referral_attach_refused`.
 */

import { DISPOSABLE_EMAIL_DOMAINS, emailDomain } from '../segment/consumer-domains.mjs';
import { CODE_ENTRY_WINDOW_DAYS } from './constants.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DISPOSABLE_SET: ReadonlySet<string> = new Set(DISPOSABLE_EMAIL_DOMAINS);
const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * One canonical form per mailbox, so a second address for the same person
 * compares equal: lower case, trimmed, `+tag` removed on every domain, and for
 * Gmail the dots removed and googlemail.com read as gmail.com. Not an address
 * to send to: only for comparing two addresses.
 */
export function normalizeEmail(email: string): string {
  const trimmed = String(email ?? '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus !== -1) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/** True for an address on a throwaway-inbox service, or one of its subdomains. */
export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE_SET.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export type AttachRefusalReason =
  | 'self'
  | 'same_email'
  | 'disposable'
  | 'not_new'
  | 'paid_before'
  | 'already_referred'
  | 'code_disabled';

export interface AttachCheckInput {
  referrerUserId: string;
  friendUserId: string;
  referrerEmail: string;
  friendEmail: string;
  friendCreatedAt: Date;
  now: Date;
  friendHasPaidHistory: boolean;
  friendAlreadyReferred: boolean;
  referrerIsMemberOfFriendWorkspace: boolean;
  codeDisabled: boolean;
}

/**
 * Why this friend may not be attached to this code, or null when they may.
 * The first matching rule wins, in the order below. A referrer who belongs to
 * one of the friend's workspaces counts as `self`: it is the same team
 * referring itself.
 */
export function attachRefusalReason(input: AttachCheckInput): AttachRefusalReason | null {
  if (input.codeDisabled) return 'code_disabled';
  if (input.referrerUserId === input.friendUserId) return 'self';
  if (input.referrerIsMemberOfFriendWorkspace) return 'self';
  if (normalizeEmail(input.referrerEmail) === normalizeEmail(input.friendEmail)) {
    return 'same_email';
  }
  if (isDisposableEmail(input.friendEmail) || isDisposableEmail(input.referrerEmail)) {
    return 'disposable';
  }
  if (input.friendAlreadyReferred) return 'already_referred';
  if (input.friendHasPaidHistory) return 'paid_before';
  const ageMs = input.now.getTime() - input.friendCreatedAt.getTime();
  if (!(ageMs <= CODE_ENTRY_WINDOW_DAYS * DAY_MS)) return 'not_new';
  return null;
}

/**
 * True when the friend paid with a card the referrer also holds. A missing
 * fingerprint (not a card, or not reported) never matches.
 */
export function cardFingerprintMatch(friendFp: string | null, referrerFps: string[]): boolean {
  if (!friendFp) return false;
  return referrerFps.some(fp => Boolean(fp) && fp === friendFp);
}
