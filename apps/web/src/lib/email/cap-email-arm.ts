/**
 * Which version of the Free allowance emails (usage_warning_80,
 * usage_limit_reached, automation_paused_limit) an owner gets. Owner decision
 * 2026-11-24: make the upgrade the obvious next step wherever the law allows,
 * and measure it against the old email.
 *
 * THE ARMS.
 *   control  the pre-2026-11-24 email, unchanged. Only with the kill switch
 *            off, or a row without a workspace or owner. No holdout: owner
 *            decision 2026-11-24, everyone eligible gets the new email.
 *   promote  the upgrade is the primary button and goes straight to Stripe
 *            Checkout; the yearly price is offered next to it; the footer
 *            carries a working opt-out from upgrade offers. Only for owners who
 *              - ticked the marketing consent box (users.marketing_consent_at),
 *                anywhere in the world, or
 *              - are positively known to be in the United States (every
 *                workspace with a known acquisition_country is US).
 *            Never for an owner who unsubscribed globally or from 'lifecycle'.
 *   notice   everyone else, Europe and unknown included: an account notice.
 *            Facts first, then the two options stated as facts (wait for the
 *            reset, or switch to Personal) with a plain link, no buy button,
 *            no selling copy, no unsubscribe (it is about their own service).
 *
 * WHY THE US AND NOT "OUTSIDE EUROPE". The paywall follow-up uses the broader
 * lifecycle-region rule. This email differs: it goes to every capped Free
 * owner, including Canada (CASL: promotional content needs consent), Japan
 * (opt-in law) and Australia (consent, inferred or express). The US is the
 * clear opt-out regime: under CAN-SPAM a message whose transactional content
 * comes first and whose subject line is not promotional keeps a transactional
 * primary purpose (16 CFR 316.3), and the opt-out link is offered anyway.
 *
 * WHY NOT THE EU SOFT OPT-IN. CJEU C-654/23 Inteligo Media (2025-11-13) lets a
 * free account in a freemium model count as a "sale" for the ePrivacy Art.
 * 13(2) soft opt-in, which Norwegian mfl. § 15(3) mirrors. But that exception
 * also requires the owner to have been offered an opt-out WHEN the address was
 * collected. Our signup offers an opt-in box, not that notice, so existing
 * European owners without consent stay on the notice. Adding the opt-out
 * notice at signup would let new European signups move to `promote` later.
 *
 * Unknown country falls to `notice`, so a mistake can only make an email
 * quieter, never louder (same principle as lifecycle-region.ts).
 *
 * KILL SWITCH. CAP_EMAIL_ARMS=off sends everyone the control email.
 */

import { sanitizedCountry } from '@/lib/acquisition-country.mjs';

export type CapEmailArm = 'control' | 'promote' | 'notice';

/** True only when at least one country is known and every known one is US. Pure. */
export function knownUnitedStates(countries: ReadonlyArray<string | null | undefined>): boolean {
  const known = countries.map((c) => sanitizedCountry(c)).filter((c): c is string => c !== null);
  return known.length > 0 && known.every((c) => c === 'US');
}

export interface CapEmailArmInput {
  workspaceId: string;
  /** users.marketing_consent_at is set. */
  consented: boolean;
  /** Globally unsubscribed, or 'lifecycle' in unsubscribed_categories. */
  unsubscribed: boolean;
  /** acquisition_country of every workspace the owner has. */
  ownerCountries: ReadonlyArray<string | null | undefined>;
  /** The owner has a users.unsubscribe_token, so an opt-out link can work. */
  hasUnsubscribeToken: boolean;
  /** Read at call time: CAP_EMAIL_ARMS. */
  enabled: boolean;
}

/** The arm for one email. Pure. */
export function capEmailArm(input: CapEmailArmInput): CapEmailArm {
  if (!input.enabled) return 'control';
  // A promotional email whose opt-out we cannot honour is not sent as one.
  if (input.unsubscribed || !input.hasUnsubscribeToken) return 'notice';
  if (input.consented) return 'promote';
  return knownUnitedStates(input.ownerCountries) ? 'promote' : 'notice';
}

/** CAP_EMAIL_ARMS, read at call time. Anything but `off` is on. */
export function capEmailArmsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CAP_EMAIL_ARMS ?? '').trim().toLowerCase() !== 'off';
}
