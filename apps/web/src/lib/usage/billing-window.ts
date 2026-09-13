/**
 * The fallback usage window, and nothing else.
 *
 * The billing period an action allowance is measured over is defined ONCE, in
 * the SQL function `workspace_action_allowance(uuid)` (migration
 * 20260912200000_free_action_cap_150). It knows the Stripe cycle, the calendar
 * month fallback, the Free 7-day grace and the per-workspace exemption, and the
 * MCP edge function, /api/usage and the dashboard all read its row (see
 * src/lib/usage/allowance.ts). The web-side copy of those rules that used to
 * live here is gone: it was the third definition of the same window, and the
 * header of this file once recorded the day two of them disagreed by two
 * actions on the same workspace.
 *
 * What remains is the UTC calendar month, for exactly one caller: the
 * dashboard page's usage-summary query when the allowance call itself fails.
 * That query's period bounds feed a value nothing on the page displays, so a
 * calendar month there is a harmless placeholder, not a second opinion on the
 * billing window.
 */

export type UsageBillingWindow = {
  /** Inclusive ISO lower bound. */
  start: string;
  /** Exclusive ISO upper bound. */
  end: string;
};

/** UTC calendar month containing `now`. */
export function calendarMonthWindow(now: Date = new Date()): UsageBillingWindow {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}
