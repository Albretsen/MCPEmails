/**
 * How far back a workspace's analytics history reaches, resolved from its plan.
 *
 * WHY THIS MODULE EXISTS. `PlanLimits.analyticsRetentionDays` was dead config
 * for months: it was declared, given a value on all four tiers, and read by
 * nothing, while the dashboard charted a hardcoded 30-day window for every
 * plan. The published copy meanwhile sold "30-day analytics" on Personal and
 * "90-day" on Pro, so the paid tiers were being under-served against their own
 * marketing. This module is the single place that turns a plan into a window,
 * so the promise and the query cannot drift apart again.
 *
 * TWO THINGS THIS IS NOT.
 *
 * It is not a hard delete. Rows stay in `activity_log`; what the plan buys is
 * how much of that history the Usage page will show.
 *
 * It is not applied to `/api/security/audit-log`. It was, briefly, and that was
 * wrong: an audit log is a security artifact rather than a usage metric, and
 * scaling one by price tier leaves the customers least equipped to detect a
 * compromise holding the least evidence of it. See the note on that route.
 *
 * NO TIER WAS EVER CUT to make a sentence true. Free showed 30 days before any
 * of this was enforced and still does; the copy that said 7 was corrected
 * instead. Pro and Team gained history. That is the only acceptable direction
 * for a change like this on a live product.
 */

import type { PlanLimits } from '@/lib/stripe/plans';

/**
 * The retention window for a set of resolved plan limits, in whole UTC days.
 *
 * Falls back to the smallest window any tier buys (30 days, the Free and
 * Personal floor) rather than to unlimited, so a limits object that somehow
 * arrives without the field under-serves rather than silently handing out
 * history nobody paid for. It must never fall back BELOW that floor either:
 * 30 days is what every account already had before this was enforced.
 */
export const MIN_RETENTION_DAYS = 30;

export function retentionDays(limits: Pick<PlanLimits, 'analyticsRetentionDays'>): number {
  const days = limits?.analyticsRetentionDays;
  return Number.isFinite(days) && (days as number) > 0
    ? Math.max(days as number, MIN_RETENTION_DAYS)
    : MIN_RETENTION_DAYS;
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
  const whole = Number.isFinite(days) && days > 0 ? Math.floor(days) : MIN_RETENTION_DAYS;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (whole - 1)),
  ).toISOString();
}
