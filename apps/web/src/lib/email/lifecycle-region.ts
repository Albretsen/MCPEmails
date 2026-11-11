/**
 * Which kind of lifecycle email an owner may get, decided in one place for
 * the paywall follow-up, the abandoned-checkout reminder and the monthly Free
 * reset email (owner decision 2026-11-11).
 *
 * THE ARMS.
 *   consented      users.marketing_consent_at is set: the full promotional
 *                  email, wherever the owner lives (unchanged behaviour).
 *   soft_opt_in    no consent, but the owner is POSITIVELY known to be outside
 *                  Europe: the same promotional email, unsubscribe still works.
 *   service_notice no consent and the owner is in Europe or we do not know
 *                  where they are: only a plain, informative notice about
 *                  something their own action caused, or nothing at all.
 *
 * THE REGION RULE. "Europe" is EUROPEAN_COUNTRIES from
 * src/lib/stripe/portal-configuration.ts (EU + IS LI NO CH GB). The only
 * stored location signal is workspaces.acquisition_country (checked
 * 2026-11-11: morning_briefs and onboarding_morning_brief_optins carry a time
 * zone but have no rows, Stripe addresses are not stored). An owner is
 * non-European only when at least one of their workspaces has a known
 * country and none of them has a European one. Unknown falls to Europe, so a
 * mistake can only make an email quieter, never louder.
 *
 * THE START. Everything new (the soft opt-in arm, the service notice, the
 * holdouts and the reset email) waits for LIFECYCLE_EXPANSION_START_AT. Unset
 * or unparseable means nobody, exactly like ACTIVATION_HELP_START_AT. Until
 * LIFECYCLE_EXPANSION_DRY_RUN is exactly `false` the new arms are decided and
 * reported but nothing is written or sent for them.
 */

import { isEuropeanCountry } from '@/lib/stripe/portal-configuration';
import { sanitizedCountry } from '@/lib/acquisition-country.mjs';

export type OwnerRegion = 'non_european' | 'european' | 'unknown';
export type LifecycleArm = 'consented' | 'soft_opt_in' | 'service_notice';

/** The owner's region from the countries recorded on their workspaces. Pure. */
export function ownerRegion(countries: ReadonlyArray<string | null | undefined>): OwnerRegion {
  const known = countries.map((c) => sanitizedCountry(c)).filter((c): c is string => c !== null);
  if (known.length === 0) return 'unknown';
  if (known.some((c) => isEuropeanCountry(c))) return 'european';
  return 'non_european';
}

/** The arm for an owner. `consented` means consent covers this trigger. Pure. */
export function lifecycleArm(input: { consented: boolean; region: OwnerRegion }): LifecycleArm {
  if (input.consented) return 'consented';
  return input.region === 'non_european' ? 'soft_opt_in' : 'service_notice';
}

/** True for the arms that may carry promotional content (prices, offers). */
export function mayPromote(arm: LifecycleArm): boolean {
  return arm !== 'service_notice';
}

export interface ExpansionConfig {
  /** Nothing new happens for triggers before this. Null = nobody. */
  startAt: Date | null;
  /** True only when LIFECYCLE_EXPANSION_DRY_RUN is exactly `false` (or `off`). */
  live: boolean;
}

type Env = Record<string, string | undefined>;

/** LIFECYCLE_EXPANSION_START_AT as a date, or null when unset or not a date. */
export function expansionStartAt(env: Env = process.env): Date | null {
  const raw = (env.LIFECYCLE_EXPANSION_START_AT ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Read at call time, never at module scope. */
export function expansionConfig(env: Env = process.env): ExpansionConfig {
  const dry = (env.LIFECYCLE_EXPANSION_DRY_RUN ?? '').trim().toLowerCase();
  return { startAt: expansionStartAt(env), live: dry === 'false' || dry === 'off' };
}

/** True when a trigger at `atMs` is at or after the start. */
export function expansionCovers(config: ExpansionConfig, atMs: number): boolean {
  if (!config.startAt) return false;
  const start = config.startAt.getTime();
  return Number.isFinite(start) && Number.isFinite(atMs) && atMs >= start;
}

/** The unsubscribe footer reason per arm, English. */
export function unsubscribeReasonFor(arm: LifecycleArm, trigger: 'paywall' | 'reset'): string {
  if (arm === 'consented') {
    return 'You are getting this because you asked for product tips and offers when you signed up.';
  }
  return trigger === 'paywall'
    ? 'You are getting this because your MCPEmails workspace reached a Free plan limit.'
    : 'You are getting this because your MCPEmails workspace reached its Free monthly limit last month.';
}
