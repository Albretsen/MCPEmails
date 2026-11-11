/**
 * How long Stripe keeps retrying a failed renewal before it cancels the
 * subscription. ONE constant, read by the dunning schedule, the dunning copy
 * ("about N days of retries left"), the final notice's timing and the admin
 * dunning board.
 *
 * IT MUST MATCH THE STRIPE DASHBOARD. Billing > Revenue recovery > Retries:
 * "Smart Retries: retry up to 8 times within <window>", then "Cancel the
 * subscription". Nothing in the API exposes that setting, so nothing can check
 * it from code: if someone changes the Dashboard, change this number in the
 * same hour, or the emails start promising days of retries that do not exist.
 *
 * History:
 *   until 2026-11-11  "within 2 weeks"  -> 14
 *   from  2026-11-11  "within 1 month"  -> 30
 *
 * Stripe does not document "1 month" as a day count (checked 2026-11-11,
 * docs.stripe.com/billing/revenue-recovery/smart-retries: the subscription is
 * cancelled "after the maximum number of days defined in the retry schedule").
 * 30 is the working assumption, and the copy built on it says "about", never
 * an exact date. Smart Retries may also make its last attempt before the
 * window ends and cancel then, which the webhook handles: the deletion is the
 * real end, whatever the calendar says.
 */
export const STRIPE_RETRY_WINDOW_DAYS = 30;

/**
 * The final dunning notice (template id `dunning_14`, kept for the ledger and
 * the unique index) goes out this many days before the window ends: in its
 * last week.
 */
export const FINAL_NOTICE_DAYS_BEFORE_END = 7;

/** Day offset of the final notice from the first failed charge. */
export function finalNoticeDayOffset(windowDays: number = STRIPE_RETRY_WINDOW_DAYS): number {
  return Math.max(0, windowDays - FINAL_NOTICE_DAYS_BEFORE_END);
}

/** Whole days of retries left on `dayOffset`, never below zero. */
export function retryDaysLeft(dayOffset: number, windowDays: number = STRIPE_RETRY_WINDOW_DAYS): number {
  return Math.max(0, Math.round(windowDays - dayOffset));
}

/**
 * The window in words for "the card gets retried automatically over the next
 * ___": "two weeks" for 14, "month" for 28 to 31, otherwise "N days".
 */
export function retryWindowPhrase(windowDays: number = STRIPE_RETRY_WINDOW_DAYS): string {
  if (windowDays >= 28 && windowDays <= 31) return 'month';
  if (windowDays === 14) return 'two weeks';
  if (windowDays === 21) return 'three weeks';
  if (windowDays === 7) return 'week';
  return `${windowDays} days`;
}

/** "about 27 days", "about a week", "a day or so". */
export function daysLeftPhrase(days: number): string {
  if (days <= 1) return 'a day or so';
  if (days === 7) return 'about a week';
  return `about ${days} days`;
}
