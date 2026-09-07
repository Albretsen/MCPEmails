/**
 * Constants, arithmetic and the view registry shared by every kiosk board.
 *
 * Split out of board.tsx on 2026-09-01, when the board stopped being one
 * screen and became five. Everything here is pure and framework-free apart
 * from the type imports, so a helper can be reasoned about without loading a
 * board, and so the boards cannot each grow their own subtly different idea of
 * what "this week" or "a trend" means. That is not hypothetical: the seam
 * between a rolling window and a calendar week is exactly where a wall display
 * starts telling two stories about the same number.
 */

import type { CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import type { GrowthDailyRow, GrowthUserSignupDayRow } from '@/lib/analytics/growth-types';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';

/** The board's default reporting window. */
export const KIOSK_WINDOW_DAYS = 28;

/** Weeks of history in the trend charts. Eight fits a tile and two months. */
export const CHART_WEEKS = 8;

/**
 * Days of daily history to pull from `activity_log`-derived series.
 *
 * Ninety is the ceiling: a pg_cron job deletes `activity_log` rows past 90
 * days, so asking for more would return real workspace counts beside zeroed
 * activity and every delta computed against that stretch would be an
 * invention.
 */
export const DAILY_DAYS = 90;

/**
 * Window for the milestone funnel. It reads `workspaces.created_at` and the
 * durable `onboarding_*_at` columns rather than `activity_log`, so the 90 day
 * purge does not apply and a wide window really does mean all-time.
 */
export const FUNNEL_DAYS = 400;

/* ------------------------------------------------------------ the five views */

/**
 * WHY A WALL BOARD HAS A CONTROL AT ALL, having shipped with none.
 *
 * The original argument for zero controls still holds for the panel's resting
 * state: nobody presses anything, and a board that needs configuring before it
 * says something true is a board that eventually says something stale. What
 * changed is that the one screen was being asked to answer five different
 * questions at once, and the tile that had to give way was always the same
 * one: whichever answered the question nobody had asked that morning.
 *
 * So the default view still shows everything at a glance and is what the panel
 * returns to on its own (see KioskLive: ten idle minutes and the board goes
 * home). The other four are for the two minutes somebody is standing in front
 * of it with a specific question. A view is a URL, not client state, so a
 * refresh, a deploy reload and a walk-past all land somewhere defined.
 *
 * NAMES ARE ONE WORD AND ARE NOT CATEGORIES. "Acquisition and growth" and
 * "service health" are the names of dashboards; on a strip of five buttons
 * read from across a room, a label has about four characters of attention.
 * Each of these names a QUESTION rather than a department, and the blurb below
 * it is the sentence the view is trying to answer.
 */
export type KioskViewId = 'pulse' | 'money' | 'growth' | 'stickiness' | 'uptime';

export type KioskView = {
  id: KioskViewId;
  /** What the button says. One word, because that is all a glance affords. */
  label: string;
  /** The question the view answers, shown in the header beside the wordmark. */
  question: string;
};

export const KIOSK_VIEWS: KioskView[] = [
  { id: 'pulse', label: 'Pulse', question: 'how are we doing' },
  { id: 'money', label: 'Money', question: 'what have we earned' },
  { id: 'growth', label: 'Growth', question: 'who is arriving' },
  { id: 'stickiness', label: 'Stickiness', question: 'who stays' },
  { id: 'uptime', label: 'Uptime', question: 'is it working' },
];

export const DEFAULT_KIOSK_VIEW: KioskViewId = 'pulse';

/**
 * An unknown `?view=` falls back to the default rather than 404ing.
 *
 * The panel's URL is typed by hand once, into a Chromium autostart line on a
 * Pi with no keyboard attached. A typo there must leave a working board on the
 * wall, not an error page nobody is present to dismiss.
 */
export function resolveKioskView(raw: string | undefined): KioskViewId {
  const match = KIOSK_VIEWS.find((view) => view.id === raw);
  return match ? match.id : DEFAULT_KIOSK_VIEW;
}

/* ------------------------------------------------------------------ numbers */

// Re-exported rather than redefined: `BigNumber` owns the shape, and two
// structurally identical `Trend` types in one component tree is how a rename
// silently stops type-checking one half of it.
export type { Trend } from './primitives';
import type { Trend } from './primitives';

/**
 * Percentage change, or nothing.
 *
 * A null previous period and a previous period of zero both mean "no honest
 * comparison exists": dividing by zero would render every first-ever signup as
 * an infinite improvement.
 */
export function trend(
  current: number,
  previous: number | null | undefined,
  goodDirection: 'up' | 'down',
): Trend {
  if (previous === null || previous === undefined || previous === 0) return null;
  return { percent: ((current - previous) / previous) * 100, goodDirection };
}

export function sum<T>(rows: T[], key: keyof T): number {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

export function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/**
 * Success rate over ATTEMPTED calls, or null when there is nothing to divide.
 *
 * `calls` includes rate-limited/capped requests, which never reached a tool:
 * the client was told no and nothing was tried. Dividing by raw `calls`
 * anyway is what made a board tile read 56.7% on an hour where every real
 * call succeeded and one workspace was looping against its own usage cap
 * (2026-09-03). Mirrors `successRate` in health-math.ts so every tile on the
 * board that shows a reliability percentage agrees on what it means.
 */
export function attemptRate(successes: number, calls: number, throttled: number): number | null {
  const attempted = calls - throttled;
  return attempted > 0 ? successes / attempted : null;
}

/* ------------------------------------------------------------ calendar weeks */

export type WeekBucket = {
  label: string;
  values: number[];
  /**
   * The week is still being lived. The chart draws these differently, because
   * the whole reason calendar weeks were avoided here until 2026-09-01 is that
   * the current one is always a short bar and always looks like a collapse.
   */
  partial?: boolean;
};

const DAY_MS = 86_400_000;
const WEEK_START_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The UTC Monday on or before a `YYYY-MM-DD` day key. */
export function mondayOf(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  // getUTCDay is 0 for Sunday. Shift so Monday is 0 and Sunday is 6, which is
  // the whole difference between an ISO week and a US one and the single most
  // common way this function is written wrong.
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Trailing CALENDAR weeks, Monday to Sunday, oldest first, ending with the
 * week we are currently in.
 *
 * THIS REPLACED ROLLING 7-DAY BUCKETS on 2026-09-01, at the operator's
 * request, and the trade is worth stating because the old comment here argued
 * the opposite. Rolling buckets anchored on the latest day never end in a
 * partial bar, which is tidy; what they cost is that "last week" on the board
 * and "last week" in somebody's head are different stretches of time, so the
 * chart could never be checked against anything else or talked about out loud.
 * Calendar weeks match how the week is actually discussed, and the partial bar
 * the old comment feared is handled by SAYING it is partial rather than by
 * hiding it: the current week is flagged and drawn differently.
 *
 * A week with no underlying rows at all is DROPPED rather than rendered as
 * zero. A gap in the data and a week where nothing happened are different
 * facts, and on a wall the second one is a finding while the first is a bug.
 */
export function calendarWeekBuckets<T extends { day: string }>(
  rows: T[],
  weeks: number,
  pick: (row: T) => number[],
  todayKey?: string,
): WeekBucket[] {
  if (rows.length === 0) return [];
  const anchor = todayKey ?? rows[rows.length - 1].day.slice(0, 10);
  const thisMonday = new Date(`${mondayOf(anchor)}T00:00:00Z`).getTime();

  // Bucket every row once by its own Monday, so the scan is linear rather than
  // one pass per week.
  const byWeek = new Map<string, number[]>();
  for (const row of rows) {
    const key = mondayOf(row.day.slice(0, 10));
    const values = pick(row);
    const bucket = byWeek.get(key);
    if (!bucket) {
      byWeek.set(key, [...values]);
      continue;
    }
    for (let index = 0; index < values.length; index += 1) {
      bucket[index] = (bucket[index] ?? 0) + values[index];
    }
  }

  const buckets: WeekBucket[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const start = new Date(thisMonday - index * 7 * DAY_MS);
    const key = start.toISOString().slice(0, 10);
    const values = byWeek.get(key);
    if (!values) continue;
    buckets.push({
      label:
        index === 0 ? 'This week'
        : index === 1 ? 'Last week'
        : WEEK_START_LABEL.format(start),
      values,
      partial: index === 0,
    });
  }
  return buckets;
}

/** Convenience for the two series the signups chart draws, in one place. */
export function signupWeeks(rows: GrowthUserSignupDayRow[], weeks = CHART_WEEKS): WeekBucket[] {
  return calendarWeekBuckets(rows, weeks, (row) => [row.new_users, row.activated_users]);
}

/** The same shape from the workspace-level daily series, for the views that use it. */
export function workspaceWeeks(rows: GrowthDailyRow[], weeks = CHART_WEEKS): WeekBucket[] {
  return calendarWeekBuckets(rows, weeks, (row) => [row.new_workspaces, row.value_activations]);
}


/* ------------------------------------------------- funnels shared by boards */

/*
 * The two ladders and their arithmetic, moved here from board.tsx on
 * 2026-09-07 when /admin/growth started drawing the same two funnels.
 *
 * They live in this module for the reason the module exists: a funnel whose
 * rungs are defined twice is a funnel that reports two different conversion
 * rates for the same week, and the seam is invisible because both copies look
 * right on their own page. Everything below is pure and reads only its
 * arguments.
 */

export function stageOf(funnel: { stage: string; workspaces: number }[], name: string): number {
  return funnel.find((row) => row.stage === name)?.workspaces ?? 0;
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Workspaces that came back at least once.
 *
 * The engagement RPC buckets by active days as '1', '2–3', '4–7', '8+', so
 * everything except the first band is a workspace that returned on a different
 * day. Matching on "not 1" rather than listing the other three keeps this
 * correct if a band is ever added.
 */
export function returningWorkspaces(rows: { metric: string; band: string; workspaces: number }[]): number {
  return rows
    .filter((row) => row.metric === 'active_days' && row.band !== '1')
    .reduce((total, row) => total + row.workspaces, 0);
}

/**
 * The milestone ladder, ending at the step that is actually in play.
 *
 * The last three rungs come from outside the activation funnel on purpose: the
 * funnel stops at first value, and the interesting question now is what happens
 * after it.
 *
 * WHY "HIT A PLAN LIMIT" IS GONE. It was the right rung when actions were the
 * value metric. Since the 2026-08-19 repricing the paywall is the inbox count
 * and the action ceiling is a silent abuse guard nobody is meant to reach, so
 * the rung was a permanent zero measuring a paywall that no longer exists. The
 * two rungs that replace it measure the paywall that does.
 *
 * THE ABANDONMENT NOTE IS THE POINT OF THE PANEL. Everything above it is about
 * getting people to want the product. The gap between "started a checkout" and
 * "paid" is the only step where someone had already decided to pay and we lost
 * them anyway, and it is the only number here that can be fixed in an
 * afternoon.
 *
 * TWO SEAMS, both marked in the notes rather than hidden. The first three rungs
 * come from the activation RPC and count WORKSPACES including our own; the
 * pricing and checkout rungs are filtered in Node and exclude ours. Our
 * accounts are roughly a twentieth of signups, so the ladder still reads true;
 * the cleaner fix is to teach `growth_activation_funnel` the same exclusion.
 * The second seam is the window: the pricing and checkout rungs are all-time,
 * "came back" is the rolling 28 days.
 */
export function milestoneSteps(
  funnel: { stage: string; workspaces: number }[],
  retention: { returning: number; oneAndDone: number | null },
  checkout: CheckoutFunnel | null,
  mrr: RevenueSummary | null,
  /**
   * The window `returning` was counted over. A parameter rather than the kiosk
   * constant since /admin/growth reads the same ladder under a switchable 7,
   * 28 or 90 day window, and a note that said "last 28d" beside a 7 day count
   * would be the one line on the panel that is simply false.
   */
  windowDays: number = KIOSK_WINDOW_DAYS,
) {
  const { returning, oneAndDone } = retention;
  const paid = checkout?.checkoutCompleted ?? 0;
  const stillPaying = mrr?.payingCustomers ?? 0;
  return [
    // "Created a workspace", not "Signed up", and the aside says "workspaces".
    // The headline tile three columns to the left says "Signed up 315" and this
    // rung says 308, because they count different things: that one counts
    // external PEOPLE and this one counts WORKSPACES including our own. Both
    // are right and the difference is small, which is precisely what makes it
    // dangerous on a wall — two numbers under the same word, four tiles apart,
    // that never quite agree. Naming the unit is cheaper than reconciling them,
    // and reconciling them properly means teaching growth_activation_funnel the
    // internal exclusion, which is a change to a shared RPC that /admin/growth
    // also reads.
    { label: 'Created a workspace', value: stageOf(funnel, 'signup') },
    { label: 'Connected an inbox', value: stageOf(funnel, 'inbox_connected') },
    { label: 'Used their mailbox', value: stageOf(funnel, 'value_activation') },
    {
      label: 'Came back',
      value: returning,
      note: returning === 0
        ? 'nobody yet'
        : oneAndDone === null
          ? `2+ days, last ${windowDays}d`
          : `2+ days; ${oneAndDone} tried once and left`,
    },
    {
      label: 'Looked at the plans',
      value: checkout?.pricingViewed ?? 0,
      note: checkout ? 'signed in, ever' : 'unavailable',
    },
    {
      label: 'Started a checkout',
      value: checkout?.checkoutStarted ?? 0,
      note: !checkout
        ? 'unavailable'
        : checkout.abandoned > 0
          ? `${checkout.abandoned} left without paying`
          : 'none abandoned',
    },
    {
      label: 'Paid',
      value: paid,
      note: paid === 0
        ? 'the first one is still out there'
        // Ever-paid against still-paying: with the counts this small, one
        // cancellation is the whole retention story and hiding it behind a
        // single number would be the flattering choice.
        : stillPaying === paid ? 'all still paying' : `${stillPaying} still paying`,
    },
  ];
}

/**
 * The checkout ladder on its own, for the Money view.
 *
 * Shares no code with `milestoneSteps` because it deliberately starts later:
 * everything before "looked at the plans" is a product question and this panel
 * is about the four steps after somebody has started thinking about paying.
 */
export function checkoutSteps(funnel: CheckoutFunnel, mrr: RevenueSummary | null) {
  const stillPaying = mrr?.payingCustomers ?? 0;
  return [
    { label: 'Looked at the plans', value: funnel.pricingViewed, note: 'signed in, ever' },
    {
      label: 'Started a checkout',
      value: funnel.checkoutStarted,
      note: funnel.checkoutFailed > 0 ? `${funnel.checkoutFailed} could not start` : 'ever',
    },
    {
      label: 'Abandoned on Stripe',
      value: funnel.abandoned,
      // Reached is forced false: this rung is the LOSS, and the funnel paints a
      // reached rung in the accent colour, which would make the board's worst
      // number its most confident-looking one.
      reached: false,
      note: funnel.abandoned > 0 ? 'had already decided to pay' : 'nobody',
    },
    {
      label: 'Paid',
      value: funnel.checkoutCompleted,
      note: funnel.checkoutCompleted === 0
        ? 'the first one is still out there'
        : stillPaying === funnel.checkoutCompleted ? 'all still paying' : `${stillPaying} still paying`,
    },
    {
      label: 'Opened the billing portal',
      value: funnel.portalOpened,
      note: 'existing subscribers',
    },
  ];
}

/* ---------------------------------------------------------------- providers */

/** Provider ids as a person would say them. */
const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  google: 'Gmail',
  outlook: 'Outlook',
  microsoft: 'Outlook',
  imap: 'IMAP',
  fastmail: 'Fastmail',
  icloud: 'iCloud',
  yandex: 'Yandex',
};

export function prettyProvider(provider: string): string {
  const key = provider.toLowerCase();
  return PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Acquisition channel ids as a person would say them.
 *
 * The table covers the ids worth renaming; everything else falls through to
 * `humanise`, which is what turns a raw `organic_google` into "Organic google"
 * rather than printing the underscore on a wall. Attribution ids are written by
 * whatever set the first-touch cookie, so the fallback matters more here than
 * it does for providers: the list of sources is open-ended by design.
 *
 * `unattributed` is renamed rather than dropped. It is a gap in our own
 * measurement, not a channel, and it has to stay visible because the rows must
 * sum to the signup count or they will eventually be read as if they did.
 */
const CHANNEL_LABELS: Record<string, string> = {
  unattributed: 'Unknown',
  direct: 'Direct',
  organic: 'Search',
  organic_google: 'Google',
  organic_bing: 'Bing',
  organic_duckduckgo: 'DuckDuckGo',
  reddit: 'Reddit',
  hn: 'Hacker News',
  hackernews: 'Hacker News',
  github: 'GitHub',
  x: 'X',
  twitter: 'X',
  linkedin: 'LinkedIn',
  producthunt: 'Product Hunt',
};

export function prettyChannel(source: string): string {
  const key = source.toLowerCase();
  return CHANNEL_LABELS[key] ?? humanise(source);
}

/** `organic_google` becomes `Organic google`. Nothing cleverer: title-casing
 *  every word turns `mcp` into `Mcp`, which reads worse than leaving it. */
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return 'Unknown';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
