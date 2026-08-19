/**
 * The billing period an action allowance is measured over.
 *
 * There must be exactly one definition of this on the web side. There were
 * three: `/api/usage` resolved it correctly, the dashboard Usage page counted a
 * rolling 30 days against a per-period cap instead, and the MCP edge function
 * has its own copy in `resolveUsageBillingWindow()`. The rolling-30-day one was
 * wrong by construction, not just occasionally: on a workspace whose Stripe
 * period began 2026-08-03, `/api/usage` reported 107 actions used and the
 * dashboard reported 109 on the same day, against the same cap.
 *
 * The rules below mirror the edge function exactly, because the number a
 * customer reads must be the number that gets them blocked:
 *
 *   - Free is defined as the UTC calendar month.
 *   - A paid plan uses its stored Stripe period.
 *   - A paid plan whose stored period is missing, or no longer covers now(),
 *     falls back to the calendar month. That is a legacy row awaiting its next
 *     webhook sync, and a transient fallback beats billing against a window
 *     that ended.
 *
 * The edge copy cannot import this (separate Deno runtime), so if the rules
 * change, both files change. That is why they are stated as rules here rather
 * than left implicit in the expressions.
 */

export type UsageBillingWindow = {
  /** Inclusive ISO lower bound. */
  start: string;
  /** Exclusive ISO upper bound: when the allowance resets. */
  end: string;
};

/** The stored Stripe cycle, as read from `user_billing`. */
export type StoredBillingPeriod = {
  current_period_start?: string | null;
  current_period_end?: string | null;
} | null;

/** UTC calendar month containing `now`. */
export function calendarMonthWindow(now: Date = new Date()): UsageBillingWindow {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** True when a stored Stripe period exists and actually covers `now`. */
export function isActiveBillingPeriod(period: StoredBillingPeriod, now: Date = new Date()): boolean {
  if (!period?.current_period_start || !period.current_period_end) return false;
  const start = new Date(period.current_period_start).getTime();
  const end = new Date(period.current_period_end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= now.getTime() && now.getTime() < end;
}

/**
 * The window the workspace's action allowance is counted over.
 *
 * `plan` is the effective plan, i.e. already comp-adjusted by the caller.
 */
export function resolveUsageBillingWindow(
  plan: string,
  period: StoredBillingPeriod,
  now: Date = new Date(),
): UsageBillingWindow {
  if (plan !== 'free' && isActiveBillingPeriod(period, now)) {
    return { start: period!.current_period_start!, end: period!.current_period_end! };
  }
  return calendarMonthWindow(now);
}
