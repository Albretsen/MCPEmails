/**
 * Is signup growth over? The arithmetic behind the signup trend tile.
 *
 * WHY WEEKLY AND NOTHING SHORTER. Daily new workspaces swing about 40% inside
 * a single healthy week (a Thursday of 55 beside a Friday of 34), and every
 * weekend is quieter than the week around it. A quiet weekend on 2026-10-19
 * read as "growth is ending" when it was the best weekend so far. So the
 * state below is decided by completed Mon-Sun UTC weeks only. The current
 * week is shown beside the same point in earlier weeks, as information, and
 * can never move the state.
 *
 * THE RULE, against each completed week's trailing average of the four
 * completed weeks before it:
 *
 *   ALARM  the latest completed week is more than 20% below its trailing
 *          average, or it and the week before are both below theirs.
 *   WATCH  the latest completed week is below its trailing average.
 *   OK     otherwise.
 *
 * A trailing average lags a growing series, so in a growth phase it is a
 * lenient bar: a week that merely repeats the last one still clears it. That
 * is deliberate. The question is whether growth has stopped, not whether it
 * slowed, and a board that cries wolf on a flat week gets ignored on the week
 * that matters.
 *
 * Pure: reads only its arguments, so the tests can pin every boundary.
 */

export type SignupTrendRow = {
  /** Monday of the UTC week, YYYY-MM-DD. */
  week_start: string;
  workspaces: number;
  by_now: number;
  as_of: string;
};

export type SignupTrendState = 'ok' | 'watch' | 'alarm' | 'unknown';

export type TrendWeek = {
  weekStart: string;
  count: number;
  /** Mean of the four completed weeks before this one, or null without four. */
  baseline: number | null;
  /** Percent above (+) or below (-) the baseline, or null without one. */
  vsBaseline: number | null;
  below: boolean;
  /** More than DEEP_DROP below the baseline. */
  deep: boolean;
};

export type SignupTrend = {
  state: SignupTrendState;
  headline: string;
  reason: string;
  /** The completed weeks to draw, oldest first, at most `show` of them. */
  weeks: TrendWeek[];
  /** Latest completed week over the one before, percent, or null. */
  weekOverWeek: number | null;
  current: {
    weekStart: string;
    soFar: number;
    /** Each of the previous weeks at the same offset into the week, oldest first. */
    samePoint: { weekStart: string; count: number }[];
    samePointAvg: number | null;
    vsSamePoint: number | null;
    asOf: string;
  } | null;
};

/** Completed weeks in the trailing average. */
export const BASELINE_WEEKS = 4;
/** "More than 20% below" the trailing average. */
export const DEEP_DROP = 0.2;
/** Completed weeks the tile draws. */
export const SHOW_WEEKS = 8;
/** History the RPC is asked for: enough that every drawn week has a baseline. */
export const FETCH_WEEKS = SHOW_WEEKS + BASELINE_WEEKS;

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentVs(value: number, base: number | null): number | null {
  if (base === null || base <= 0) return null;
  return ((value - base) / base) * 100;
}

/** "Oct 12", from a YYYY-MM-DD in UTC. */
export function weekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function signedPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** Each completed week with its trailing baseline. */
export function completedWeeks(counts: { weekStart: string; count: number }[]): TrendWeek[] {
  return counts.map((week, index) => {
    const prior = counts.slice(Math.max(0, index - BASELINE_WEEKS), index).map((entry) => entry.count);
    const baseline = prior.length === BASELINE_WEEKS ? mean(prior) : null;
    const below = baseline !== null && week.count < baseline;
    const deep = baseline !== null && week.count < baseline * (1 - DEEP_DROP);
    return { weekStart: week.weekStart, count: week.count, baseline, vsBaseline: percentVs(week.count, baseline), below, deep };
  });
}

/** The verdict from the completed weeks alone. Exported for the tests. */
export function trendState(weeks: TrendWeek[]): { state: SignupTrendState; headline: string; reason: string } {
  const latest = weeks[weeks.length - 1];
  const previous = weeks[weeks.length - 2];
  if (!latest || latest.baseline === null) {
    return {
      state: 'unknown',
      headline: 'Not enough history',
      reason: `Needs ${BASELINE_WEEKS + 1} completed weeks to compare against a trailing average.`,
    };
  }
  const avg = Math.round(latest.baseline);
  const pct = signedPercent(latest.vsBaseline ?? 0);
  const label = weekLabel(latest.weekStart);
  if (latest.deep) {
    return {
      state: 'alarm',
      headline: 'Alarm: signups fell',
      reason: `Week of ${label}: ${latest.count}, ${pct} against its 4-week average of ${avg}.`,
    };
  }
  if (latest.below && previous?.below) {
    return {
      state: 'alarm',
      headline: 'Alarm: two weeks below trend',
      reason: `Weeks of ${weekLabel(previous.weekStart)} and ${label} both came in under their 4-week averages (${label}: ${latest.count} vs ${avg}).`,
    };
  }
  if (latest.below) {
    return {
      state: 'watch',
      headline: 'Watch: one week below trend',
      reason: `Week of ${label}: ${latest.count}, ${pct} against its 4-week average of ${avg}. A second week below makes it an alarm.`,
    };
  }
  return {
    state: 'ok',
    headline: 'Growth is on',
    reason: `Week of ${label}: ${latest.count}, ${pct} against its 4-week average of ${avg}.`,
  };
}

/**
 * The whole tile from the RPC rows (oldest first, current week last).
 * Rows are trusted to be gapless; the SQL generates the week series.
 */
export function signupTrend(rows: SignupTrendRow[], show = SHOW_WEEKS): SignupTrend {
  const ordered = [...rows].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const currentRow = ordered[ordered.length - 1] ?? null;
  const completedRows = ordered.slice(0, -1);
  const all = completedWeeks(completedRows.map((row) => ({ weekStart: row.week_start, count: row.workspaces })));
  const verdict = trendState(all);

  const latest = all[all.length - 1];
  const previous = all[all.length - 2];
  const weekOverWeek = latest && previous ? percentVs(latest.count, previous.count) : null;

  let current: SignupTrend['current'] = null;
  if (currentRow) {
    const samePoint = completedRows
      .slice(-BASELINE_WEEKS)
      .map((row) => ({ weekStart: row.week_start, count: row.by_now }));
    const samePointAvg = samePoint.length > 0 ? mean(samePoint.map((entry) => entry.count)) : null;
    current = {
      weekStart: currentRow.week_start,
      soFar: currentRow.workspaces,
      samePoint,
      samePointAvg,
      vsSamePoint: percentVs(currentRow.workspaces, samePointAvg),
      asOf: currentRow.as_of,
    };
  }

  return { ...verdict, weeks: all.slice(-show), weekOverWeek, current };
}
