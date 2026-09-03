/**
 * Achievements: the milestones this business has already passed, and the ones
 * it is currently walking towards.
 *
 * WHY THIS EXISTS. The rest of /admin/growth answers "how are we doing" and
 * "what needs attention", both of which are questions about the present. This
 * answers a third one: "how far has this come, and what is next". At $35 MRR
 * and six customers the honest present tense is thin enough that a page made
 * only of it reads as a page about a company that is not working, which is a
 * conclusion the numbers do not actually support. A ladder does support it: the
 * same $35 is two rungs up a climb whose next rung is named and countable.
 *
 * IT IS A STATISTICS FEATURE, NOT A GAME. Every entry below is a counted fact
 * with a threshold and, wherever a series can prove one, a date. There is no
 * score, nothing is awarded, and nothing is congratulated. The only thing that
 * makes it an "achievement" rather than a metric is that the threshold was
 * fixed in advance, in the block below, and can be read as a policy.
 *
 * THE DATE IS THE HARD PART, AND MOST OF THEM DO NOT HAVE ONE. Three of the ten
 * ladders sit on a series that can be walked, so their unlock has a real day
 * behind it. The rest are a single number read from Stripe or a lifecycle
 * count, with no history at all, and those return `unlockedOn: null` rather
 * than the day the page happened to be loaded. A guessed date on a milestone
 * card is indistinguishable from a real one, which is why the guess is not
 * offered: see `dateFor` on each ladder, and the test that pins it.
 *
 * NOTHING HERE THROWS AND NOTHING HERE READS. A null source means the ladders
 * that depend on it are not evaluated at all, so `totalCount` shrinks and the
 * ones that are shown stay true. `now` is a parameter, not a clock read, for
 * the same reason `attentionReport` and `streak` take one.
 *
 * PURE, NO I/O, testable with `node --test`. Same convention as
 * growth-records.ts and growth-attention.ts: relative imports carry an explicit
 * `.ts` so the plain strip-types runner can follow the module graph, and the
 * Stripe-derived shapes are imported as types only, so importing this file
 * never constructs a Supabase or Stripe client.
 */

import type { CashCollected, CheckoutFunnel } from './kiosk-revenue.ts';
import type { GrowthDailyRow, GrowthLifecycleRow, GrowthUserSignupDayRow } from './growth-types.ts';
import type { RevenueSummary } from './revenue-math.ts';
import { daysBetween, daysToTarget, recordDay, streak } from './growth-records.ts';
import { formatCount, formatMoney } from '../../../components/admin/charts/format.ts';

/**
 * Four things worth counting, and no fifth. The split exists so the page can
 * group the cards; it carries no ranking, because "money" being listed first
 * is a layout decision and not a claim that $10 MRR matters more than a
 * hundred people reaching a mailbox.
 */
export type AchievementCategory = 'money' | 'people' | 'usage' | 'reliability';

export type Achievement = {
  /** Stable, kebab-case. Used as the React key and to keep sorts deterministic. */
  id: string;
  category: AchievementCategory;
  /** Short, e.g. "First dollar", "$50 MRR", "100 signups". */
  title: string;
  /** One short clause naming what is counted and over what window. */
  detail: string;
  /** The number that has to be reached. */
  target: number;
  /** Where the figure stands now, in the same unit as `target`. */
  current: number;
  /** 0..1, clamped. `current / target`, or 1 when unlocked. */
  progress: number;
  unlocked: boolean;
  /** ISO day (YYYY-MM-DD) it was first reached, when a series can prove it. */
  unlockedOn: string | null;
  /** Days at the recent pace until `target`. Null when not projectable. */
  daysToGo: number | null;
};

export type AchievementReport = {
  /** Unlocked, most recently unlocked first; ones with no date last. */
  unlocked: Achievement[];
  /** Not yet unlocked, closest to done first. Every one of them, not a top few. */
  next: Achievement[];
  /** Counts, so the page can say "21 of 52" without re-deriving them. */
  unlockedCount: number;
  /**
   * Achievements actually EVALUATED, which is `ACHIEVEMENT_COUNT` minus the
   * ladders whose source did not load. A page that quoted the constant instead
   * would report progress against rungs it never looked at.
   */
  totalCount: number;
};

/**
 * Everything the ladders are allowed to look at. `null` means that read failed
 * or was not attempted, which is a different fact from a zero: a zero unlocks
 * nothing, a null is not counted at all.
 */
export type AchievementInput = {
  /** Gapless daily signup series, oldest first, carrying `cumulative_users`. */
  signups: GrowthUserSignupDayRow[] | null;
  /** Daily activity_log metrics. 90 days, because that is when the log is purged. */
  daily: GrowthDailyRow[] | null;
  /** Stripe: the recurring side. */
  revenue: RevenueSummary | null;
  /** Stripe: the cash side, with a per-month series that can date a crossing. */
  cash: CashCollected | null;
  /**
   * The checkout funnel. Deliberately UNREAD by every ladder below, and kept in
   * the input anyway because the caller already holds it and the omission is
   * worth stating: it counts distinct workspaces rather than money or people,
   * and the only timestamp it carries is `lastCompletedAt`, the most recent
   * sale. A most-recent date cannot date a first crossing, so wiring it in
   * would produce exactly the invented unlock date this module refuses to make.
   */
  checkout: CheckoutFunnel | null;
  /** Lifecycle counts: value activation and recent activity. */
  lifecycle: GrowthLifecycleRow | null;
};

/**
 * Every threshold in one block, so the ladders can be read as a policy rather
 * than reverse-engineered from ten call sites.
 *
 * The low rungs are deliberately low. A ladder whose first money rung is $1,000
 * describes a company this is not, and would show a business with real revenue
 * an unbroken row of zeroes; the top rungs are deliberately far out of reach
 * for the opposite reason, so the ladder does not run out.
 */
export const ACHIEVEMENT_POLICY = {
  /**
   * Trailing days the two projectable paces are averaged over. Anchored to
   * `now` rather than to the last row, so a stale series honestly reports a
   * slower pace instead of the pace it had when it stopped being written.
   */
  paceWindowDays: 28,
  targets: {
    /** MRR in MINOR units, to match `revenue.mrrMinor`: $10 through $2,500. */
    mrrMinor: [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000],
    /**
     * Cash collected all time, minor units: the first cent, then $100 through
     * $10,000. The first rung is one cent rather than one dollar because the
     * fact being recorded is "money arrived at all", and a 50 cent charge is
     * that fact just as much as a $5 one.
     */
    cashMinor: [1, 10_000, 25_000, 50_000, 100_000, 500_000, 1_000_000],
    /** Live subscriptions actually paying something. */
    payingCustomers: [1, 5, 10, 25, 50, 100],
    /** External users ever created. */
    signups: [100, 250, 500, 1_000, 2_500, 5_000],
    /** People who have ever reached a mailbox. */
    activated: [50, 100, 250, 500, 1_000],
    /** Workspaces with a successful call in the last 7 days. */
    active7d: [50, 100, 250, 500],
    /** Consecutive days with at least one signup. */
    signupStreakDays: [7, 14, 30, 60, 100, 365],
    /** Tool calls inside the 90 day log window. See `TOOL_CALL_DETAIL`. */
    toolCalls: [10_000, 100_000, 250_000, 1_000_000],
    /** Signups on a single UTC day. */
    signupsInADay: [10, 25, 50, 100],
    /** Consecutive days with at least one successful call. */
    successStreakDays: [30, 90],
  },
} as const;

/**
 * How many rungs exist in total, across every ladder. The report's own
 * `totalCount` is this minus whatever could not be evaluated, and it is the
 * one a page should quote.
 */
export const ACHIEVEMENT_COUNT: number = Object.values(ACHIEVEMENT_POLICY.targets).reduce(
  (sum, ladder) => sum + ladder.length,
  0,
);

/**
 * Said in the ladder's own detail line, not just in a comment here: the tool
 * call total is a 90 day figure wearing an all-time-looking number. Rows older
 * than the purge simply do not exist to be summed, so the true lifetime count
 * is higher and this ladder unlocks LATE rather than early.
 */
const TOOL_CALL_DETAIL = 'Tool calls in the last 90 days, not all time: the log is purged.';

/**
 * Build the report.
 *
 * `now` defaults to the clock but is a parameter, so the two pace figures and
 * anything else time-dependent stay deterministic under test.
 */
export function achievementReport(input: AchievementInput, now: number = Date.now()): AchievementReport {
  const all: Achievement[] = [];
  for (const ladder of ladders(input, now)) all.push(...buildLadder(ladder));

  const unlocked = all.filter((entry) => entry.unlocked).sort(byRecency);
  const next = all.filter((entry) => !entry.unlocked).sort(byCloseness);

  return { unlocked, next, unlockedCount: unlocked.length, totalCount: all.length };
}

/* ----------------------------------------------------------------- ladders */

type Ladder = {
  category: AchievementCategory;
  /** Prefix of the stable id; the target is appended. */
  idPrefix: string;
  targets: readonly number[];
  current: number;
  title: (target: number) => string;
  detail: string;
  /** Dates the crossing of `target`, for the ladders with a series behind them. */
  dateFor?: (target: number) => string | null;
  /** Days to cover `remaining`, for the two ladders with an honest pace. */
  paceFor?: (remaining: number) => number | null;
};

/**
 * Assemble the ladders whose source loaded. A null source contributes nothing,
 * which is how "not evaluated" is expressed: there is no placeholder rung, so
 * a Stripe outage cannot render nine empty money cards that read as failure.
 */
function ladders(input: AchievementInput, now: number): Ladder[] {
  const built: Ladder[] = [];
  const targets = ACHIEVEMENT_POLICY.targets;

  const signupRows = orderedRows(input.signups);
  const dailyRows = orderedRows(input.daily);

  if (input.revenue) {
    const currency = input.revenue.currency;
    built.push({
      category: 'money',
      idPrefix: 'mrr',
      targets: targets.mrrMinor,
      current: finite(input.revenue.mrrMinor),
      title: (target) => `${formatMoney(target, currency)} MRR`,
      detail: 'Normalised MRR from live Stripe subscriptions, external only.',
      // No series: Stripe is read as a snapshot, so there is no month in which
      // MRR first crossed $25 available to this module at any price.
    });
    built.push({
      category: 'money',
      idPrefix: 'paying',
      targets: targets.payingCustomers,
      current: finite(input.revenue.payingCustomers),
      title: (target) => (target === 1 ? 'First paying customer' : `${formatCount(target)} paying customers`),
      detail: 'Live Stripe subscriptions actually paying something, external only.',
    });
  }

  if (input.cash) {
    const currency = input.cash.currency;
    const months = rowsOf(input.cash.months);
    built.push({
      category: 'money',
      idPrefix: 'cash',
      targets: targets.cashMinor,
      current: finite(input.cash.allTimeMinor),
      title: (target) => (target === 1 ? 'First dollar' : `${formatMoney(target, currency)} collected`),
      detail: 'Net cash after refunds, all time. Dated to the month it crossed.',
      /*
       * The cash series is monthly, so the honest answer to "when" is a month.
       * A month key is already `YYYY-MM-01`, which fits the ISO day field
       * without inventing a day-of-month: the 1st here means "some time in
       * this month", and the detail line above says so on the card.
       *
       * When `cash.truncated` the oldest charges were never read, so the
       * running total starts too low and this dates a crossing LATER than it
       * happened. Late is the safe direction; claiming an earlier month than
       * the charges prove would not be.
       */
      dateFor: (target) =>
        runningCrossing(
          months.map((month) => ({ key: month.month, value: finite(month.netMinor) })),
          target,
        ),
    });
  }

  if (signupRows) {
    const cumulative = signupRows.map((row) => ({ key: row.day, value: finite(row.cumulative_users) }));
    const newUsers = signupRows.map((row) => ({ day: row.day, count: finite(row.new_users) }));
    const perDay = recentPerDay(newUsers, now);
    const total = cumulative.length > 0 ? cumulative[cumulative.length - 1].value : 0;

    built.push({
      category: 'people',
      idPrefix: 'signups',
      targets: targets.signups,
      current: total,
      title: (target) => `${formatCount(target)} signups`,
      detail: 'External users ever created, from the daily signup series.',
      // A genuinely dated ladder: `cumulative_users` is all-time on every row,
      // so the first row at or above the target is the day it was crossed.
      dateFor: (target) => cumulativeCrossing(cumulative, target),
      paceFor: (remaining) => daysToTarget(remaining, perDay),
    });

    built.push({
      category: 'people',
      idPrefix: 'signup-streak',
      targets: targets.signupStreakDays,
      current: streak(newUsers).current,
      title: (target) => `${formatCount(target)}-day signup streak`,
      detail: 'Consecutive days with at least one signup, ending today.',
      // A streak is a length, not an event: the day it reached 30 is knowable
      // in principle but is not what `streak()` returns, and re-deriving it
      // here would be a second, disagreeing implementation of the same rule.
    });

    built.push({
      category: 'usage',
      idPrefix: 'record-signup-day',
      targets: targets.signupsInADay,
      current: recordDay(newUsers)?.count ?? 0,
      title: (target) => `${formatCount(target)} signups in one day`,
      detail: 'Most signups on any single UTC day in the series read.',
      // Deliberately undated. `recordDay` knows which day set the record, but
      // that is the day of the CURRENT best, not the day this rung was first
      // cleared, and the two differ the moment the record is beaten.
    });
  }

  if (dailyRows) {
    const calls = dailyRows.map((row) => ({ key: row.day, value: finite(row.calls) }));
    const perDay = recentPerDay(
      dailyRows.map((row) => ({ day: row.day, count: finite(row.calls) })),
      now,
    );
    const total = calls.reduce((sum, row) => sum + row.value, 0);

    built.push({
      category: 'usage',
      idPrefix: 'tool-calls',
      targets: targets.toolCalls,
      current: total,
      title: (target) => `${formatCount(target)} tool calls`,
      detail: TOOL_CALL_DETAIL,
      /*
       * Dated by accumulation, and only true inside the window the rows cover.
       * The running total starts at zero on the oldest row read, while the real
       * lifetime count was already in the hundreds of thousands, so every date
       * this returns is a within-window crossing and not a lifetime one.
       */
      dateFor: (target) => runningCrossing(calls, target),
      paceFor: (remaining) => daysToTarget(remaining, perDay),
    });

    built.push({
      category: 'reliability',
      idPrefix: 'success-streak',
      targets: targets.successStreakDays,
      current: streak(dailyRows.map((row) => ({ day: row.day, count: finite(row.successes) > 0 ? 1 : 0 }))).current,
      title: (target) => `${formatCount(target)} days serving calls`,
      detail: 'Consecutive days with a successful call, last 90 days only.',
    });
  }

  if (input.lifecycle) {
    built.push({
      category: 'people',
      idPrefix: 'activated',
      targets: targets.activated,
      current: finite(input.lifecycle.value_activated),
      title: (target) => `${formatCount(target)} reached a mailbox`,
      detail: 'People who have ever reached a mailbox, all time.',
    });
    built.push({
      category: 'people',
      idPrefix: 'active-7d',
      targets: targets.active7d,
      current: finite(input.lifecycle.active_7d),
      title: (target) => `${formatCount(target)} active in a week`,
      detail: 'Workspaces with a successful call in the last 7 days.',
    });
  }

  return built;
}

/** One ladder into its rungs. Every rung is the same fact at a different height. */
function buildLadder(ladder: Ladder): Achievement[] {
  const current = finite(ladder.current);
  return ladder.targets.map((target) => {
    const unlocked = current >= target;
    return {
      id: `${ladder.idPrefix}-${target}`,
      category: ladder.category,
      title: ladder.title(target),
      detail: ladder.detail,
      target,
      current,
      progress: unlocked ? 1 : clamp01(current / target),
      unlocked,
      unlockedOn: unlocked ? (ladder.dateFor?.(target) ?? null) : null,
      // An unlocked rung has no distance left, and printing "0 days to go" on
      // something cleared in June reads as a countdown rather than as history.
      daysToGo: unlocked ? null : (ladder.paceFor?.(target - current) ?? null),
    };
  });
}

/* ------------------------------------------------------------------- dating */

/**
 * The first day an ALREADY-CUMULATIVE series stood at or above the target.
 *
 * Refuses to answer when the very first row is already there. The signup
 * series is windowed (`growth_user_signup_days(p_days)`) while its
 * `cumulative_users` column is all-time, so a target cleared before the window
 * opened would otherwise be dated to whichever day the window happens to start
 * on, and that date would move every time the window is widened.
 */
function cumulativeCrossing(rows: readonly { key: string; value: number }[], target: number): string | null {
  if (rows.length === 0) return null;
  if (rows[0].value >= target) return null;
  for (const row of rows) {
    if (row.value >= target) return row.key;
  }
  return null;
}

/** The first key at which a running sum of per-period amounts reached the target. */
function runningCrossing(rows: readonly { key: string; value: number }[], target: number): string | null {
  let total = 0;
  for (const row of rows) {
    total += row.value;
    if (total >= target) return row.key;
  }
  return null;
}

/* -------------------------------------------------------------------- pace */

/**
 * Mean per calendar day over the trailing window, anchored to `now`.
 *
 * Divided by the window length rather than by the number of rows found, on
 * purpose: a series that stopped being written ten days ago has genuinely
 * averaged zero on those ten days, and dividing by the rows present would
 * report the pace it used to have as though it still had it.
 */
function recentPerDay(rows: readonly { day: string; count: number }[], now: number): number {
  let sum = 0;
  for (const row of rows) {
    const age = daysBetween(row.day, now);
    if (age === null || age < 0 || age >= ACHIEVEMENT_POLICY.paceWindowDays) continue;
    sum += row.count;
  }
  return sum / ACHIEVEMENT_POLICY.paceWindowDays;
}

/* -------------------------------------------------------------------- sorts */

/** Most recently unlocked first, undated ones last, then the bigger number first. */
function byRecency(a: Achievement, b: Achievement): number {
  if (a.unlockedOn !== b.unlockedOn) {
    if (!a.unlockedOn) return 1;
    if (!b.unlockedOn) return -1;
    return b.unlockedOn.localeCompare(a.unlockedOn);
  }
  return b.target - a.target;
}

/** Closest to done first, then the smaller number first among equals. */
function byCloseness(a: Achievement, b: Achievement): number {
  return b.progress - a.progress || a.target - b.target;
}

/* ------------------------------------------------------------------ guards */

/**
 * These rows are cast from RPC results rather than parsed, so a shape that is
 * not what the type promises is a real possibility and must not throw: this
 * module is rendered inside a page that has twelve other panels on it.
 */
function rowsOf<T>(rows: T[] | null | undefined): T[] {
  return Array.isArray(rows) ? rows : [];
}

/**
 * A defensive copy in day order. `streak()` reads the last row as today and
 * both crossing walks depend on order, so ordering is not left to the caller.
 * Null in, null out, so "did not load" survives the trip.
 */
function orderedRows<T extends { day: string }>(rows: T[] | null): T[] | null {
  if (!Array.isArray(rows)) return null;
  return [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/** Anything not a real number counts as zero rather than poisoning a sum. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}
