/**
 * Records, streaks and milestones: the arithmetic behind the Records strip on
 * /admin/growth.
 *
 * WHY THIS EXISTS AT ALL. The rest of the page answers "how are we doing",
 * which is a question about levels and rates. This module answers "has anything
 * ever been better than today", which is a question about the shape of the
 * whole series, and it is the only thing on the page that gives a single good
 * day somewhere to land. That is not decoration: at sixty signups a week the
 * difference between a normal Tuesday and the best day this product has ever
 * had is four people, and nothing else on the page makes that visible.
 *
 * Pure functions with no Supabase import, so the counting rules can be unit
 * tested without a database. Same convention as cash-math.ts and revenue-math.ts.
 *
 * TWO RULES THAT MATTER MORE THAN THEY LOOK.
 *
 * 1. TODAY IS PARTIAL. Every series here is keyed by UTC day and the last row
 *    is a day still in progress. A record computed naively will therefore never
 *    be today's, which is fine, but a STREAK computed naively breaks the moment
 *    it is read at 00:30 UTC before the day's first signup. `streak()` takes
 *    the trailing day as an argument rather than assuming it, and the caller
 *    decides whether an unfinished day may end a run (see `streakFromRows`).
 *
 * 2. A RECORD IS ONLY A RECORD OVER THE WINDOW IT WAS READ FROM. `activity_log`
 *    is purged at 90 days, so a "busiest day" taken from it is the busiest day
 *    of the last quarter and nothing more. Callers pass the window into the
 *    label; nothing in here claims all-time on its own.
 */

/** One UTC day and whatever is being counted on it. */
export type DayCount = { day: string; count: number };

export type StreakSummary = {
  /** Consecutive days ending at the last COMPLETE day of the series. */
  current: number;
  /** Longest run anywhere in the series, current run included. */
  longest: number;
  /** Last day of the longest run, so it can be dated. Null when there is none. */
  longestEndedOn: string | null;
  /** True when today already counts, so the caller can say "including today". */
  todayCounts: boolean;
};

/**
 * Consecutive days with at least one event.
 *
 * `rows` must be gapless and oldest first, which is what
 * `growth_user_signup_days` returns by contract. A gap in the input would be
 * read as "no day there" rather than "zero that day", and would silently
 * lengthen every run that spans it.
 *
 * The final row is treated as TODAY and is allowed to extend a run but never to
 * break one. A day that has not finished cannot prove a streak ended, and the
 * alternative is a number that reads as a collapse every night at midnight and
 * repairs itself by lunchtime.
 */
export function streak(rows: DayCount[]): StreakSummary {
  if (rows.length === 0) {
    return { current: 0, longest: 0, longestEndedOn: null, todayCounts: false };
  }

  const today = rows[rows.length - 1];
  const settled = rows.slice(0, -1);
  const todayCounts = today.count > 0;

  let longest = 0;
  let longestEndedOn: string | null = null;
  let run = 0;
  for (const row of settled) {
    run = row.count > 0 ? run + 1 : 0;
    if (run > longest) {
      longest = run;
      longestEndedOn = row.day;
    }
  }

  // `run` is now the streak standing at the end of the last COMPLETE day.
  const current = run + (todayCounts ? 1 : 0);
  if (current > longest) {
    longest = current;
    longestEndedOn = today.day;
  }

  return { current, longest, longestEndedOn, todayCounts };
}

/**
 * The single best day in the series, ties going to the most recent.
 *
 * Recency wins ties on purpose: two equal records are read as "we did it again",
 * and dating that to the older of the two is the less useful of the two true
 * answers. Days with a count of zero never win, so an all-quiet series returns
 * null rather than a meaningless first row.
 */
export function recordDay(rows: DayCount[]): DayCount | null {
  let best: DayCount | null = null;
  for (const row of rows) {
    if (row.count <= 0) continue;
    if (!best || row.count >= best.count) best = row;
  }
  return best;
}

/**
 * The round number a figure is currently walking towards.
 *
 * The ladder is 1, 5, 10, 25, 50, 100, 250, 500 and so on: the numbers people
 * actually celebrate. A plain "next multiple of 100" ladder puts a business at
 * $23 MRR 77 dollars from its next milestone, which is both true and useless;
 * this puts it two dollars from $25.
 *
 * Returns null past the top of the ladder rather than inventing a target.
 */
export function nextMilestone(value: number): { target: number; remaining: number; percent: number } | null {
  if (!Number.isFinite(value) || value < 0) return null;
  for (const target of MILESTONE_LADDER) {
    if (target > value) {
      return {
        target,
        remaining: target - value,
        percent: Math.max(0, Math.min(100, (value / target) * 100)),
      };
    }
  }
  return null;
}

/** 1, 5, 10, 25, 50, 100, 250, 500, 1k, 2.5k, 5k … up to ten million. */
const MILESTONE_LADDER: readonly number[] = (() => {
  const rungs: number[] = [];
  for (let power = 0; power <= 7; power += 1) {
    const decade = 10 ** power;
    for (const step of [1, 2.5, 5]) {
      const value = step * decade;
      if (Number.isInteger(value)) rungs.push(value);
    }
  }
  return rungs.sort((a, b) => a - b);
})();

/**
 * How long the remaining distance takes at the pace of the recent past.
 *
 * Deliberately refuses to answer rather than extrapolating from nothing: a zero
 * or negative pace has no honest arrival date, and "never" printed next to a
 * progress bar reads as a verdict on the business rather than as an absence of
 * data. Capped at three years, past which the answer is not a forecast.
 */
export function daysToTarget(remaining: number, perDay: number): number | null {
  if (!Number.isFinite(remaining) || !Number.isFinite(perDay)) return null;
  if (remaining <= 0) return 0;
  if (perDay <= 0) return null;
  const days = Math.ceil(remaining / perDay);
  return days > 1095 ? null : days;
}

/** Whole days between two instants, floored. Negative when `to` precedes `from`. */
export function daysBetween(from: string | number | Date, to: string | number | Date = Date.now()): number | null {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.floor((end - start) / 86_400_000);
}

/**
 * "today" / "yesterday" / "12 days ago", for a date that is being reported
 * rather than compared. Null in, null out, so a caller can pass a nullable
 * timestamp straight through.
 */
export function agoLabel(when: string | null | undefined, now: number = Date.now()): string | null {
  if (!when) return null;
  const days = daysBetween(when, now);
  if (days === null) return null;
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** `2026-09-03` as `3 Sep 2026`. Fixed to UTC: every day key on this page is. */
export function formatDayKey(day: string | null | undefined): string | null {
  if (!day) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return DAY_FORMAT.format(parsed);
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
