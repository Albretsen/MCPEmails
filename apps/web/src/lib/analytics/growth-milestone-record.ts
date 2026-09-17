/**
 * When each milestone was actually crossed, for the rungs whose own series
 * cannot prove it.
 *
 * WHY THIS FILE EXISTS. `growth-achievements.ts` dates a rung only when the
 * series it is built from can walk back to the crossing, and it refuses to
 * guess otherwise. That refusal is right, and it left eighteen unlocked rungs
 * in a "Reached, day unknown" pile: every MRR and paying-customer rung (Stripe
 * is read as a snapshot), every activation and weekly-active rung (the
 * lifecycle RPC returns counts, not a history), both signup streaks and the
 * record-day rungs (a streak is a length, not an event), and the reliability
 * streak (`activity_log` is purged at 90 days). The day each of those was
 * crossed is not unknowable, it is simply not in the panel's own inputs: it is
 * in `user_billing`, `workspaces.onboarding_value_activated_at`,
 * `users.created_at` and `activity_log`, one query each.
 *
 * So the dates below were reconstructed ONCE, on 2026-09-17, by running those
 * queries against production, and written down here. They are historical facts
 * about crossings that have already happened, so they can never change: a
 * recorded day is not a cache of something the page could compute, it is the
 * answer to a question the page's inputs can no longer be asked.
 *
 * THIS IS NOT A LICENCE TO GUESS. Every entry names the table it came from and
 * a figure that can be checked against it, and `docs/NOTE-milestone-unlock-
 * record-20260917.md` carries the exact SQL that produced each one, with its
 * output. A rung whose day cannot be established that way does not get an
 * entry: it stays in the undated pile, which is still rendered.
 *
 * HOW THE MONEY DATES WERE CHECKED, because they are the ones that had to be
 * rebuilt rather than read. Stripe holds the real prices and this repository's
 * production key is not readable from a laptop, so MRR was reconstructed from
 * `user_billing` start dates priced at the list prices in `stripe/plans.ts`.
 * Two independent facts say the reconstruction matches Stripe exactly: at the
 * 17th subscription it lands on $139.00, the MRR recorded from the live board
 * on 2026-09-15, and summing the same subscriptions as charges lands on $403,
 * the cash Stripe had collected all time on that date. No external
 * subscription carries a coupon, which is the assumption that would break it.
 *
 * A LATE DATE IS ALLOWED, AN EARLY ONE IS NOT. `success-streak-30` is the one
 * entry that is a lower bound rather than a certainty: `activity_log` keeps 90
 * days, so the run of consecutive days serving calls can only be measured from
 * the oldest row that survives. The real crossing is that day or earlier, never
 * later, which is the same direction the cash ladder already errs in.
 *
 * PURE DATA, NO I/O. Imported by `growth-achievements.ts` and by its test.
 */

/** One reconstructed crossing: the day, and the evidence in a single clause. */
export type RecordedUnlock = {
  /** ISO day, UTC, matching the convention of every other date on the board. */
  day: string;
  /**
   * Where it came from and what to check it against. Rendered in the rung's
   * tooltip, so it is a clause a person can read, not a query.
   */
  note: string;
};

export type MilestoneUnlockRecord = Readonly<Record<string, RecordedUnlock>>;

/**
 * Keyed by achievement id (`${idPrefix}-${target}`), which is the same string
 * `buildLadder` produces. A key that matches no rung is a typo or a policy
 * change, and the test pins that it cannot happen quietly.
 */
export const MILESTONE_UNLOCK_RECORD: MilestoneUnlockRecord = Object.freeze({
  /* ------------------------------------------------------------- money */

  'paying-1': {
    day: '2026-08-29',
    note: 'user_billing: the first external subscription, 17:35 UTC',
  },
  'paying-5': {
    day: '2026-09-01',
    note: 'user_billing: the 5th external subscription still live',
  },
  'paying-10': {
    day: '2026-09-07',
    note: 'user_billing: the 10th external subscription still live',
  },
  'mrr-1000': {
    day: '2026-08-31',
    note: 'user_billing at list price: the 3rd subscription took MRR to $14',
  },
  'mrr-2500': {
    day: '2026-09-02',
    note: 'user_billing at list price: the first Pro year took MRR to $35',
  },
  'mrr-5000': {
    day: '2026-09-05',
    note: 'user_billing at list price: three sales that day took MRR to $60',
  },
  'mrr-10000': {
    day: '2026-09-14',
    note: 'user_billing at list price: five sales that day took MRR to $134',
  },

  /* ------------------------------------------------------------ people */

  'activated-50': {
    day: '2026-08-11',
    note: 'workspaces.onboarding_value_activated_at: the 50th first activation',
  },
  'activated-100': {
    day: '2026-08-21',
    note: 'workspaces.onboarding_value_activated_at: the 100th first activation',
  },
  'activated-250': {
    day: '2026-09-11',
    note: 'workspaces.onboarding_value_activated_at: the 250th first activation',
  },
  'active-7d-50': {
    day: '2026-08-17',
    note: 'activity_log: first 7 day window with 50 workspaces served',
  },
  'active-7d-100': {
    day: '2026-08-31',
    note: 'activity_log: first 7 day window with 100 workspaces served',
  },
  'signup-streak-7': {
    day: '2026-06-28',
    note: 'users.created_at: the day the run of daily signups first reached 7',
  },
  'signup-streak-14': {
    day: '2026-08-15',
    note: 'users.created_at: the day the run of daily signups first reached 14',
  },
  'signup-streak-30': {
    day: '2026-08-31',
    note: 'users.created_at: the day the run of daily signups first reached 30',
  },

  /* ------------------------------------------------------------- usage */

  'record-signup-day-10': {
    day: '2026-08-10',
    note: 'users.created_at: the first UTC day with 10 or more signups',
  },
  'record-signup-day-25': {
    day: '2026-09-07',
    note: 'users.created_at: the first UTC day with 25 or more signups',
  },

  /* ------------------------------------------------------- reliability */

  'success-streak-30': {
    day: '2026-07-18',
    note: 'activity_log, earliest provable: the log keeps only 90 days',
  },
});

/** The recorded crossing for a rung, or null. Never invents one. */
export function recordedUnlock(
  id: string,
  record: MilestoneUnlockRecord = MILESTONE_UNLOCK_RECORD,
): RecordedUnlock | null {
  return Object.prototype.hasOwnProperty.call(record, id) ? (record[id] ?? null) : null;
}
