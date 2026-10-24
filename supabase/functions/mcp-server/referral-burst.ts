/**
 * The per-minute ceiling for a Free workspace whose owner earned a referral
 * month of Personal (migration 20261025090000_referrals.sql).
 *
 * The allowance SQL meters such a workspace as Personal; this makes the burst
 * ceiling agree, so the month is not Personal's allowance at Free's speed.
 *
 * WHAT IS READ. The month is `user_usage_entitlements.referral_personal_until`,
 * honored on any row except a comped one (comped already bursts higher; the
 * caller checks it first). mcp_tools_call_gate returns it with `kind` and
 * `expires_at` (section 8 of the migration), and the per-query path selects
 * the same three columns, so both paths decide alike (request-pipeline.test.ts
 * holds them to parity). A row with kind 'referral_personal' and an
 * `expires_at` in the future also counts: grant_referral_personal() keeps
 * that pair equal to the month's end for a user who had no row, and it keeps
 * a gate or reader that predates the column in step.
 */

export interface ReferralBurstInput {
  /** workspaces.plan as stored. Only 'free' can be lifted. */
  storedPlan: string;
  entitlement: { kind?: unknown; expires_at?: unknown; referral_personal_until?: unknown } | null;
  now?: Date;
}

function future(value: unknown, now: number): boolean {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now;
}

export function referralPersonalActive(input: ReferralBurstInput): boolean {
  if (input.storedPlan !== "free") return false;
  const e = input.entitlement;
  if (!e || e.kind === "comped_scale") return false;
  const now = (input.now ?? new Date()).getTime();
  if (future(e.referral_personal_until, now)) return true;
  return e.kind === "referral_personal" && future(e.expires_at, now);
}
