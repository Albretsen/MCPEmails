/**
 * The metric catalogue for the internal /admin/growth page.
 *
 * Every clickable metric card has three consumers that have to agree: the card
 * itself (label, target, delta colour), the drill-down drawer (definition,
 * unit, granularity) and the API route that serves the series behind it. When
 * those three drift apart the page starts lying quietly, which is worse than
 * not showing the number at all: an operator then makes a decision on a figure
 * whose definition they have guessed. This module is the one place that
 * definition lives, so a card and its drawer cannot describe the same number
 * differently.
 *
 * The definitions are deliberately written so they can be checked against the
 * SQL in `supabase/migrations/*_growth_analytics_rpcs.sql`. If a metric cannot
 * be described in one honest sentence, it does not belong on the page.
 *
 * Nothing here touches the database, Next.js or the request. It is plain data
 * plus pure functions, which is why the cap projection helper lives here too
 * rather than in growth-queries.ts: keeping it free of the Supabase client is
 * what makes it testable with `node --test`. growth-queries.ts re-exports it,
 * so callers still import it from where they expect.
 *
 * Relative imports below carry an explicit `.ts` extension so the plain
 * `node --test --experimental-strip-types` runner can follow the module graph
 * without a bundler. Same convention as retention.test.ts.
 */

import {
  GMAIL_OAUTH_USER_CAP,
  GMAIL_OAUTH_WARN_AT,
  type GmailCapSummaryRow,
  type GrowthDailyRow,
} from './growth-types.ts';

/** A rising number is good ('up') or bad ('down'). Drives the delta colour. */
export type GoodDirection = 'up' | 'down';
/** 'daily' series are per-day counts, 'window' series are rolling values already. */
export type MetricKind = 'daily' | 'window';
export type MetricUnit = 'count' | 'percent';
export type MetricGranularity = 'daily' | 'monthly';
/** How a period of this series collapses to one number. See summariseSeries. */
export type SeriesAggregate = 'sum' | 'last' | 'mean';

export type GrowthMetric = {
  key: GrowthMetricKey;
  label: string;
  /** Which GrowthDailyRow column the series comes from, when it is a daily metric. */
  column?: keyof GrowthDailyRow;
  goodDirection: GoodDirection;
  /** Plain-language definition shown in the drawer, and the SQL-level meaning. */
  definition: string;
  /** Optional operator target, rendered under the number. null when we have none. */
  target: number | null;
  /**
   * An externally imposed limit, drawn as a rule on the drill-down chart.
   * Deliberately NOT the same field as `target`: a target is something the team
   * chose to aim at, a threshold is a wall someone else built. Labelling
   * Google's 100 user cap as a "target" would read as though hitting it were
   * the goal.
   */
  threshold: { value: number; label: string } | null;
  kind: MetricKind;
  unit: MetricUnit;
  granularity: MetricGranularity;
  /** How the drill-down reduces a period to one number, so it agrees with the card. */
  aggregate: SeriesAggregate;
};

export type GrowthMetricKey =
  | 'active_7d'
  | 'active_28d'
  | 'new_workspaces'
  | 'value_activations'
  | 'technical_activations'
  | 'calls'
  | 'success_rate'
  | 'gmail_grants';

/**
 * Why every `target` below is null.
 *
 * Nothing in this repo commits to a numeric goal for any of these metrics, and
 * the target is rendered under the number as though it were a decision the team
 * had made. Inventing one would turn a guess into an apparent commitment, so
 * null stays until someone actually sets a target. GMAIL_OAUTH_WARN_AT is the
 * single real threshold we have, but it applies to the cumulative Gmail grant
 * total against Google's 100 user cap (see `gmailCapProjection`), not to the
 * monthly new-grant series exposed here, so it is not a target for
 * `gmail_grants` either.
 */
export const GROWTH_METRICS: Record<GrowthMetricKey, GrowthMetric> = {
  active_7d: {
    key: 'active_7d',
    label: 'Active workspaces (7d)',
    column: 'active_7d',
    goodDirection: 'up',
    definition:
      'Distinct workspaces with at least one successful MCP tool call in the 7 UTC days ending on that day. This is a rolling window, so consecutive days overlap heavily and the series must never be summed. Any successful call counts, including connectivity-only calls such as inbox_list, so it is a looser bar than value activation.',
    target: null,
    threshold: null,
    kind: 'window',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'last',
  },
  active_28d: {
    key: 'active_28d',
    label: 'Active workspaces (28d)',
    column: 'active_28d',
    goodDirection: 'up',
    definition:
      'Distinct workspaces with at least one successful MCP tool call in the 28 UTC days ending on that day. Same rolling-window caveat as the 7 day figure: overlapping windows, not addable. With this product\'s volume the 28 day number moves slowly and is the more trustworthy of the two.',
    target: null,
    threshold: null,
    kind: 'window',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'last',
  },
  new_workspaces: {
    key: 'new_workspaces',
    label: 'New workspaces',
    column: 'new_workspaces',
    goodDirection: 'up',
    definition:
      'Workspaces whose created_at falls on that UTC day. This is a signup count, not a surviving-account count: a workspace that never connected an inbox, or that churned the next week, still counts on the day it was created.',
    target: null,
    threshold: null,
    kind: 'daily',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'sum',
  },
  value_activations: {
    key: 'value_activations',
    label: 'Value activations',
    column: 'value_activations',
    goodDirection: 'up',
    definition:
      'Workspaces whose first mailbox-touching success landed on that UTC day: status = success, inbox_id is not null, and tool_name is not inbox_list. This is the same definition as workspaces.onboarding_value_activated_at, reused verbatim so the chart and the column can never disagree. One row per workspace, ever, on the day it first happened.',
    target: null,
    threshold: null,
    kind: 'daily',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'sum',
  },
  technical_activations: {
    key: 'technical_activations',
    label: 'Technical activations',
    column: 'technical_activations',
    goodDirection: 'up',
    definition:
      'Workspaces whose first successful MCP tool call of any kind landed on that UTC day. It proves the endpoint is reachable and the credential works, and nothing else: a workspace can technically activate on inbox_list alone and never read an email. The gap between this and value activations is the drop-off worth chasing.',
    target: null,
    threshold: null,
    kind: 'daily',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'sum',
  },
  calls: {
    key: 'calls',
    label: 'Tool calls',
    column: 'calls',
    goodDirection: 'up',
    definition:
      'Every MCP tool call logged on that UTC day across all workspaces, successful or not. This is a volume number, not a user number: a single looping client can dominate it, so read it next to the active-workspace counts rather than on its own.',
    target: null,
    threshold: null,
    kind: 'daily',
    unit: 'count',
    granularity: 'daily',
    aggregate: 'sum',
  },
  success_rate: {
    key: 'success_rate',
    label: 'Call success rate',
    // Derived in the app from two columns rather than read from one, so there
    // is deliberately no `column` here.
    goodDirection: 'up',
    definition:
      'Successful calls as a percentage of all calls logged on that UTC day (successes / calls * 100), reported as 0 on days with no calls at all. Derived from the successes and calls columns rather than stored. Every logged call is in the denominator, so client-side retries and throttled calls drag it down as much as real server faults.',
    target: null,
    threshold: null,
    kind: 'daily',
    unit: 'percent',
    granularity: 'daily',
    aggregate: 'mean',
  },
  gmail_grants: {
    key: 'gmail_grants',
    label: 'Gmail OAuth grants used',
    // Comes from gmail_oauth_grant_series(), not from the daily table, so no
    // `column` and a monthly granularity.
    goodDirection: 'up',
    definition:
      'Cumulative Gmail OAuth grants at the end of each calendar month, counted as distinct Gmail addresses first seen up to that point (soft-deleted inboxes included, because revoking access does not return a slot on Google\'s side). Monthly, not daily. It is a FLOOR on what Google counts against the 100 user cap for the unverified client: a user who consented and then failed before the inbox row was written burns a slot we cannot see. The series only ever rises, and the dashed rule is the wall it is rising towards.',
    target: null,
    threshold: { value: GMAIL_OAUTH_USER_CAP, label: 'Google 100 user cap' },
    // `kind` only distinguishes per-period counts from rolling windows, and
    // new grants per month is a per-period count. `granularity` carries the
    // fact that the period is a month rather than a day.
    kind: 'daily',
    unit: 'count',
    granularity: 'monthly',
    aggregate: 'last',
  },
};

export const GROWTH_METRIC_KEYS = Object.keys(GROWTH_METRICS) as GrowthMetricKey[];

/** Narrow an untrusted string (a URL segment) to a catalogue key. */
export function isGrowthMetricKey(value: string): value is GrowthMetricKey {
  return Object.prototype.hasOwnProperty.call(GROWTH_METRICS, value);
}

export type SeriesSummary = {
  current: number;
  previous: number;
  deltaAbsolute: number;
  deltaPercent: number;
  min: number;
  max: number;
  average: number;
};

/** Movement worth colouring. Below this the delta is noise and reads neutral. */
export const DELTA_DEAD_ZONE_PERCENT = 2;

function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reduce a time series to the handful of figures the card and drawer render.
 *
 * The series is split in half: the newest half is the current period and the
 * half immediately before it is the comparison period, so the two are always
 * the same length. On an odd-length series the oldest sample is dropped rather
 * than compared against a shorter period.
 *
 * How `current` and `previous` are reduced depends on what the series IS, and
 * getting this wrong is not cosmetic. The hero card shows 34 active workspaces
 * (the latest value of a rolling window) and 76 new workspaces (a sum over the
 * window). If the drawer answered "current" with a period mean for both, the
 * card and its own drill-down would disagree about the same metric, which is
 * precisely the failure this catalogue exists to prevent.
 *
 *   'sum'  per-period counts (new workspaces, calls). Adding them is the
 *          natural total, and it matches what the card prints.
 *   'last' values that are already levels: rolling windows (active_7d) and
 *          cumulative series (Gmail grants). Summing a rolling window
 *          double-counts, and summing a cumulative series is meaningless.
 *   'mean' rates and percentages (success_rate), where neither a sum nor a
 *          single endpoint describes the period.
 *
 * `previous` is always reduced the same way over the immediately preceding
 * period of equal length, so the two are comparable by construction.
 *
 * Every output is finite. The drawer prints these values directly, so a NaN or
 * an Infinity would be rendered to the operator: non-finite inputs are treated
 * as 0, and a zero comparison period yields a 0 percent delta rather than a
 * division by zero. A 0 there means "no basis for comparison", which the caller
 * should read together with `previous`.
 */
export function summariseSeries(values: number[], aggregate: SeriesAggregate = 'mean'): SeriesSummary {
  const clean = (values ?? []).map((value) => (Number.isFinite(value) ? value : 0));
  if (clean.length === 0) {
    return { current: 0, previous: 0, deltaAbsolute: 0, deltaPercent: 0, min: 0, max: 0, average: 0 };
  }

  const min = clean.reduce((lowest, value) => (value < lowest ? value : lowest), clean[0]);
  const max = clean.reduce((highest, value) => (value > highest ? value : highest), clean[0]);
  const average = round(mean(clean));

  const reduce = (window: number[]): number => {
    if (window.length === 0) return 0;
    if (aggregate === 'sum') return window.reduce((total, value) => total + value, 0);
    if (aggregate === 'last') return window[window.length - 1];
    return mean(window);
  };

  const half = Math.floor(clean.length / 2);
  // With a single point there is no prior period at all. Reporting previous as
  // 0 (and therefore a 0 percent delta) is the only answer that cannot be
  // mistaken for a real movement.
  const current = half === 0 ? clean[clean.length - 1] : reduce(clean.slice(clean.length - half));
  const previous = half === 0 ? 0 : reduce(clean.slice(clean.length - 2 * half, clean.length - half));

  return {
    current: round(current),
    previous: round(previous),
    deltaAbsolute: round(current - previous),
    deltaPercent: previous === 0 ? 0 : round(((current - previous) / Math.abs(previous)) * 100),
    min,
    max,
    average,
  };
}

/**
 * Colour for a delta. Small movements read neutral: at this product's volume a
 * one workspace swing can be a double-digit percentage, and colouring that
 * green or red trains the operator to ignore the colour entirely.
 */
export function deltaTone(
  deltaPercent: number,
  goodDirection: GoodDirection,
): 'good' | 'bad' | 'neutral' {
  if (!Number.isFinite(deltaPercent)) return 'neutral';
  if (Math.abs(deltaPercent) < DELTA_DEAD_ZONE_PERCENT) return 'neutral';
  const rising = deltaPercent > 0;
  return rising === (goodDirection === 'up') ? 'good' : 'bad';
}

export type GmailCapProjection = {
  used: number;
  cap: number;
  remaining: number;
  /** Share of the cap consumed, 0 to 100, one decimal. */
  percent: number;
  ratePerMonth: number;
  /** 'YYYY-MM' of the month the cap runs out, null when nothing is moving. */
  projectedExhaustion: string | null;
  level: 'ok' | 'warn' | 'danger';
};

const DAY_MS = 86_400_000;
/** A projection further out than this is arithmetic, not information. */
const MAX_PROJECTION_MONTHS = 1200;

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function monthKey(from: Date, monthsAhead: number): string {
  const offset = Math.min(MAX_PROJECTION_MONTHS, Math.max(0, monthsAhead));
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Turn the raw Gmail cap counters into the numbers the cap panel renders.
 *
 * Google enforces a hard 100 user cap on a published but unverified OAuth
 * client with restricted Gmail scopes, and the count is cumulative: revoking
 * access or deleting an inbox does not give a slot back. Running into that wall
 * stops Gmail signups outright, and verification plus the CASA assessment takes
 * weeks that do not start until someone notices, which is the whole reason this
 * projection exists.
 *
 * `now` is a parameter rather than a call to Date.now() so the function stays
 * pure and testable.
 */
export function gmailCapProjection(
  summary: GmailCapSummaryRow,
  now: Date = new Date(),
): GmailCapProjection {
  // distinct_ever is a floor (a consent that failed before the inbox row was
  // written burns a slot invisibly) while the hand-entered Cloud Console figure
  // is authoritative but can be months stale. The higher of the two is the only
  // value that cannot under-report the slots already spent.
  const used = Math.max(count(summary.distinct_ever), count(summary.google_reported_users));
  const cap = GMAIL_OAUTH_USER_CAP;
  const remaining = Math.max(0, cap - used);
  const percent = cap > 0 ? round((used / cap) * 100, 1) : 0;

  const firstGrantMs = summary.first_grant_at ? new Date(summary.first_grant_at).getTime() : Number.NaN;
  const ageDays = Number.isFinite(firstGrantMs) ? (now.getTime() - firstGrantMs) / DAY_MS : 0;
  // 60 days of history smooths out a single busy week. Below that there is not
  // enough of it, and halving a 60 day count that only covers 20 real days
  // would understate the rate badly, so the 30 day count is used instead.
  const ratePerMonth = ageDays >= 60
    ? round(count(summary.grants_last_60d) / 2, 1)
    : round(count(summary.grants_last_30d), 1);

  // Months of headroom at the current rate. Infinite when nothing is growing.
  const monthsRemaining = ratePerMonth > 0 ? remaining / ratePerMonth : Number.POSITIVE_INFINITY;

  return {
    used,
    cap,
    remaining,
    percent,
    ratePerMonth,
    projectedExhaustion: ratePerMonth > 0 ? monthKey(now, Math.ceil(monthsRemaining)) : null,
    // Level is driven by TIME, not just by the count. Lifting the cap needs
    // Google verification plus the CASA assessment, which take weeks of
    // calendar time and do not pause while the cap keeps filling. A card that
    // reads "ok" at 40 of 100 while the remaining 60 slots are four months
    // from gone would be worse than useless: the moment to start is the moment
    // the runway is shorter than the process, not the moment the bar looks
    // full. The count thresholds are kept as a floor for the case where the
    // rate is briefly zero.
    level:
      used >= GMAIL_OAUTH_WARN_AT + 20 || monthsRemaining <= 3 ? 'danger'
      : used >= GMAIL_OAUTH_WARN_AT || monthsRemaining <= 6 ? 'warn'
      : 'ok',
  };
}
