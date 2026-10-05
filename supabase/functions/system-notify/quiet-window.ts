// Operator vacation: which system events stay silent, and until when.
//
// Pure on purpose, like ./checkout-feedback.ts: index.ts asks, this file
// answers from a clock it is handed, so the window is covered by a plain node
// test (apps/web/src/lib/analytics/system-notify-quiet-window.test.ts).
//
// The window is a pair of fixed instants, not a flag someone has to remember to
// flip back. When `until` passes, mail resumes on the next event with no deploy
// and no cron job. Remove this file once the trip is over; nothing else depends
// on it.
//
// Only events that report GOOD news or customer behaviour are muted.
// automation.auto_disabled stays on: it is a failure alert, and some of its
// error codes (invalid_filter, invalid_action) are our bugs. The synthetic
// monitor is a separate function and is untouched.

// 2026-10-06 00:00 and 2026-10-14 00:00 in Europe/Oslo (CEST, UTC+2 until Oct 25).
export const QUIET_FROM = "2026-10-05T22:00:00.000Z";
export const QUIET_UNTIL = "2026-10-13T22:00:00.000Z";

export const QUIET_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.signup",
  "checkout.feedback",
]);

// Written to system_events.error so a muted row is findable afterwards.
export const QUIET_MARKER = "muted_operator_vacation";

export function isQuiet(eventType: string, now: Date): boolean {
  if (!QUIET_EVENT_TYPES.has(eventType)) return false;
  const t = now.getTime();
  return t >= Date.parse(QUIET_FROM) && t < Date.parse(QUIET_UNTIL);
}
