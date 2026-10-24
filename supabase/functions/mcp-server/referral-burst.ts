/**
 * The per-minute ceiling for a Free workspace whose owner earned a referral
 * month of Personal (migration 20261025090000_referrals.sql).
 *
 * The allowance SQL meters such a workspace as Personal; this makes the burst
 * ceiling agree for the common case, so the month is not Personal's allowance
 * at Free's speed.
 *
 * WHAT IS READ, AND WHY ONLY THAT. The month is
 * `user_usage_entitlements.referral_personal_until`. mcp_tools_call_gate
 * (20261020214737) returns only the row's `kind` and `expires_at`, and the
 * per-query path must decide exactly what the gate path decides
 * (request-pipeline.test.ts holds the two to parity). So both read the same
 * pair: a user who had no entitlement row gets one from
 * grant_referral_personal() with kind 'referral_personal' and `expires_at`
 * kept equal to the month's end, which is every account created after
 * 2026-08-19. An account from before then holds a 'standard' row whose kind
 * the grant does not change; its month is metered as Personal but bursts at
 * Free's ceiling until the gate also returns `referral_personal_until`.
 */

export interface ReferralBurstInput {
  /** workspaces.plan as stored. Only 'free' can be lifted. */
  storedPlan: string;
  entitlement: { kind?: unknown; expires_at?: unknown } | null;
  now?: Date;
}

export function referralPersonalActive(input: ReferralBurstInput): boolean {
  if (input.storedPlan !== "free") return false;
  const e = input.entitlement;
  if (e?.kind !== "referral_personal") return false;
  if (typeof e.expires_at !== "string") return false;
  const until = Date.parse(e.expires_at);
  return Number.isFinite(until) && until > (input.now ?? new Date()).getTime();
}
