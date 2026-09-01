/**
 * How far back a workspace's analytics history reaches, resolved from its plan.
 *
 * WHY THIS MODULE EXISTS. `PlanLimits.analyticsRetentionDays` was dead config
 * for months: it was declared, given a value on all four tiers, and read by
 * nothing. Meanwhile the dashboard charted a hardcoded 30-day window for every
 * plan and `/api/security/audit-log` paged back through the ENTIRE activity
 * history with no lower bound at all. The published copy nonetheless promised
 * "7-day analytics" on Free, "30-day" on Personal, "90-day" on Pro and a
 * one-year audit log on Team, so every one of those numbers was a claim the
 * product did not implement: Free saw four times what it was sold, Pro and Team
 * saw a third and a twelfth of it, and the audit log was unbounded on the free
 * tier. This module is the single place that turns the plan into a window, so
 * the promise and the query can no longer drift apart.
 *
 * The retention window is deliberately NOT a hard delete. Rows stay in
 * `activity_log`; what the plan buys is how much of that history the dashboard
 * will show. Nothing here should ever be used to justify destroying data, and
 * the audit trail a security incident needs is still on disk.
 */

import type { PlanLimits } from '@/lib/stripe/plans';

/**
 * The retention window for a set of resolved plan limits, in whole UTC days.
 *
 * Falls back to the most restrictive real window (7 days, the Free tier) rather
 * than to unlimited, so a limits object that somehow arrives without the field
 * under-serves rather than silently handing out history nobody paid for.
 */
export function retentionDays(limits: Pick<PlanLimits, 'analyticsRetentionDays'>): number {
  const days = limits?.analyticsRetentionDays;
  return Number.isFinite(days) && (days as number) > 0 ? (days as number) : 7;
}

/**
 * The oldest timestamp a workspace on this window may see, as an ISO string.
 *
 * Anchored to the START of the UTC day `days - 1` days ago, not to "now minus
 * N*24h". A window counted from the current instant would slide through the day
 * and make the oldest bucket a partial day, so a 7-day chart would show eight
 * columns with a stub at each end. Anchoring to midnight means a 7-day window
 * is exactly seven whole UTC days, today included, which is what the daily
 * series the Usage page renders is bucketed by.
 */
export function retentionCutoffISO(days: number, now: Date = new Date()): string {
  const whole = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (whole - 1)),
  ).toISOString();
}
