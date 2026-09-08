/**
 * The numbers behind the public status page at /status.
 *
 * ONE SOURCE, AND IT IS THE ONLY ONE ALLOWED HERE. Everything on this page
 * comes from `synthetic_monitor_runs`: the read-mode synthetic monitor that
 * pg_cron fires every five minutes against the real public MCP endpoint and
 * walks through initialize, tools/list, inbox_list and email_read. Nothing on
 * this page may be typed in, rounded up, illustrated or carried over from a
 * previous month. A published uptime figure is a claim a paying customer can
 * hold us to, so if the recorded history cannot support a figure the page
 * omits the figure rather than softening it. Every branch below that cannot
 * prove a number returns null or `ok: false` and the view renders the absence.
 *
 * WHY NOT `activity_log`. Customer traffic is the other witness the internal
 * board uses (see analytics/health-math.ts) and it is deliberately absent
 * here. Two reasons, both fatal for a public page. It carries per-workspace
 * outcomes, so publishing anything derived from it publishes a shape of
 * customer behaviour; and its success rate is only meaningful after two
 * corrections that a reader cannot see being applied (rate-limited and capped
 * calls excluded from the denominator, and the founder's own workspace
 * excluded), which makes it exactly the wrong kind of number to put on a trust
 * page. The synthetic monitor needs no such corrections: it is one client,
 * making one scripted pass, never throttled and never capped.
 *
 * NO SILENT TRUNCATION. PostgREST caps every row-returning select at 1000 rows
 * without telling you, which over a 30 day window at a five minute cadence
 * would quietly turn 8600 checks into 1000 and invent an uptime figure out of
 * whichever slice came back. So the totals and the daily counts are answered
 * by `count: 'exact', head: true` reads that aggregate inside Postgres and
 * return no rows at all, and the one query that does return rows (the failures,
 * normally a couple of dozen a month) carries an explicit budget and refuses
 * to publish anything derived from it if the budget was reached.
 *
 * The monitor tables are service-role only and are not in the generated
 * `Database` types, so the client is cast locally. Same convention as
 * analytics/kiosk-health.ts.
 */

import { unstable_cache } from 'next/cache';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { IMMEDIATE_FAILURE_CLASSES, MONITOR_STALE_MINUTES } from '@/lib/analytics/health-math';

/** The published window. Thirty days is the status-page convention and the record covers it. */
export const WINDOW_DAYS = 30;

/** The cron cadence, from supabase/migrations/20260803140000_schedule_synthetic_monitor.sql. */
export const CADENCE_MINUTES = 5;

/**
 * The monitor's steps, in the order it runs them.
 *
 * The order is load bearing. A run stops at its first failure, so a run that
 * failed at `initialize` never attempted `email_read` and must not be counted
 * against it. That makes each step's denominator the runs that reached it,
 * which is derivable from the failure counts alone without unnesting the
 * `steps` array in SQL, and is verified against the jsonb in the notes below.
 */
export const STEP_ORDER = ['initialize', 'tools_list', 'inbox_list', 'email_read'] as const;
export type StepId = (typeof STEP_ORDER)[number];

/**
 * Failed runs we are willing to read back before refusing to do the arithmetic.
 *
 * A 30 day window holds about 8600 checks. The worst month on record held 23
 * failures. A thousand is more than forty times that and still one indexed
 * page, and the point is not the ceiling but that reaching it is detectable:
 * a full page means PostgREST may have truncated, and a truncated failure list
 * would understate downtime, which is the one direction a status page must
 * never be wrong in.
 */
const FAILED_ROW_BUDGET = 1000;

/** Recent runs read with their step detail, for the per-component "right now" column. */
const RECENT_RUNS = 20;

/** Confirmed incidents listed on the page. Bounds the recovery lookups below. */
const MAX_LISTED_INCIDENTS = 10;

/**
 * Minutes of slack allowed between two failed checks before they are read as
 * two separate incidents rather than one.
 *
 * The cron fires every five minutes, so consecutive failing runs are five
 * minutes apart and anything longer had a passing run between them. Eight
 * gives a run that used most of its budget room to land late without merging
 * two unrelated blips. Checked against the same grouping done in SQL over the
 * live table: it reproduces it exactly on the current history.
 */
const SAME_INCIDENT_GAP_MINUTES = 8;

export type OverallState = 'operational' | 'degraded' | 'down' | 'unknown';
export type ComponentState = 'operational' | 'failing' | 'unknown';

export type StatusComponent = {
  id: StepId;
  /** What the most recent run that actually reached this step reported. */
  state: ComponentState;
  /** Runs in the window that reached this step. */
  attempted: number;
  succeeded: number;
  /** Fraction, or null when nothing in the window reached this step. */
  rate: number | null;
};

export type StatusIncident = {
  /** First failed check of the run of failures. */
  startedAt: string;
  /** Last failed check before recovery. */
  lastFailureAt: string;
  /** First passing check after it, or null when none has been recorded yet. */
  recoveredAt: string | null;
  failedChecks: number;
  failureClass: string;
  failedStep: string;
  /** True when the monitor's own rule pages on the first strike for this class. */
  pagedImmediately: boolean;
};

export type StatusDay = {
  /** UTC calendar date, YYYY-MM-DD. */
  date: string;
  /** Finished checks recorded that day. Zero means the monitor did not report. */
  checks: number;
  failed: number;
};

export type StatusReport = {
  ok: true;
  windowDays: number;
  cadenceMinutes: number;
  /** Oldest recorded run, ever. The honest start of the record. */
  monitoringSince: string | null;
  /** Newest run of any status, used for staleness. */
  lastCheckAt: string | null;
  overall: OverallState;
  /** Finished checks in the window. Running checks have no verdict and are excluded. */
  checks: number;
  succeeded: number;
  failed: number;
  /** Fraction, or null when the window is too empty to divide. */
  uptime: number | null;
  components: StatusComponent[];
  days: StatusDay[];
  /** Confirmed incidents: two or more consecutive failures, or one of a class that pages at once. */
  incidents: StatusIncident[];
  /** Single failed checks that recovered on the next run and never became incidents. */
  singleCheckFailures: number;
  openIncidents: number;
  generatedAt: string;
};

export type StatusUnavailable = {
  ok: false;
  /** Kept for the server log. The page says "we cannot read our monitor", not this. */
  reason: string;
  generatedAt: string;
};

export type StatusSnapshot = StatusReport | StatusUnavailable;

type FailedRun = {
  started_at: string;
  status: string;
  failure_class: string | null;
  failed_step: string | null;
};

type RecentRun = {
  started_at: string;
  status: string;
  failure_class: string | null;
  failed_step: string | null;
  steps: { name?: string; status?: string }[] | null;
};

/**
 * The cached read.
 *
 * Cached rather than read per request for two reasons. The page exists in five
 * locales and none of them is a different question, so one fetch serves all of
 * them instead of five identical passes over the same table. And the read is
 * about three dozen small queries, which is nothing once every five minutes
 * and is a bad idea on every hit of a page whose whole purpose is to still be
 * reachable when something is wrong.
 *
 * Five minutes because that is the monitor's own cadence: a shorter window
 * would re-read the same rows, and a longer one would let the headline lag the
 * evidence. The page stamps the age of the last check on screen either way, so
 * a reader can see the freshness rather than take it on faith.
 */
export const getStatusSnapshot: () => Promise<StatusSnapshot> = unstable_cache(
  fetchStatusSnapshot,
  ['public-status-snapshot', `v1-${WINDOW_DAYS}d`],
  { revalidate: CADENCE_MINUTES * 60 },
);

export async function fetchStatusSnapshot(now: number = Date.now()): Promise<StatusSnapshot> {
  const generatedAt = new Date(now).toISOString();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = createServiceRoleClient() as any;
    const days = utcDays(now, WINDOW_DAYS);
    const windowStart = `${days[0]}T00:00:00.000Z`;

    // Every read is scoped to mode 'read'. The retired outbound canary
    // (mode 'send', unscheduled 2026-08-04) still has rows in this table and
    // measured a code path the product no longer runs on a schedule; counting
    // it would put a dead check's failures into a live uptime figure.
    const head = () =>
      service
        .from('synthetic_monitor_runs')
        .select('id', { count: 'exact', head: true })
        .eq('mode', 'read');
    const rows = (cols: string) =>
      service.from('synthetic_monitor_runs').select(cols).eq('mode', 'read');

    const [finished, succeeded, failedRows, recent, oldest, newest, open, dayCounts] =
      await Promise.all([
        // Aggregated in Postgres, no rows returned, so nothing can be truncated.
        head().neq('status', 'running').gte('started_at', windowStart),
        head().eq('status', 'succeeded').gte('started_at', windowStart),
        rows('started_at,status,failure_class,failed_step')
          .in('status', ['failed', 'internal_error'])
          .gte('started_at', windowStart)
          .order('started_at', { ascending: true })
          .limit(FAILED_ROW_BUDGET),
        rows('started_at,status,failure_class,failed_step,steps')
          .neq('status', 'running')
          .order('started_at', { ascending: false })
          .limit(RECENT_RUNS),
        rows('started_at').order('started_at', { ascending: true }).limit(1),
        rows('started_at').order('started_at', { ascending: false }).limit(1),
        service
          .from('synthetic_monitor_incidents')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'open'),
        // One indexed count per UTC day. Thirty tiny head reads rather than
        // 8600 rows over the wire, and each one is a number Postgres computed.
        Promise.all(
          days.map((date) =>
            Promise.all([
              head()
                .neq('status', 'running')
                .gte('started_at', `${date}T00:00:00.000Z`)
                .lt('started_at', `${nextUtcDay(date)}T00:00:00.000Z`),
              head()
                .in('status', ['failed', 'internal_error'])
                .gte('started_at', `${date}T00:00:00.000Z`)
                .lt('started_at', `${nextUtcDay(date)}T00:00:00.000Z`),
            ]),
          ),
        ),
      ]);

    // The two counts the whole page rests on. If either is unreadable there is
    // no uptime figure to publish and the page must say so rather than guess.
    if (finished.error) return unavailable(`finished count: ${finished.error.message}`, generatedAt);
    if (succeeded.error) return unavailable(`succeeded count: ${succeeded.error.message}`, generatedAt);
    if (failedRows.error) return unavailable(`failed runs: ${failedRows.error.message}`, generatedAt);

    const checks = finished.count ?? 0;
    const ok = succeeded.count ?? 0;
    const failures = (failedRows.data ?? []) as FailedRun[];

    // The budget was a detector, not a limit. A full page means PostgREST may
    // have cut the list, and every figure below is derived from it.
    if (failures.length >= FAILED_ROW_BUDGET) {
      return unavailable(`failed-run list hit the ${FAILED_ROW_BUDGET} row budget`, generatedAt);
    }

    // Cross-check. `checks - ok` is counted by Postgres over the same window
    // as the failure list; if they disagree, something moved between the two
    // reads or a filter is wrong, and the page publishes nothing rather than
    // an uptime figure whose numerator and denominator came from different
    // pictures of the table.
    if (checks - ok !== failures.length) {
      return unavailable(
        `failure counts disagree: ${checks - ok} by count, ${failures.length} by row`,
        generatedAt,
      );
    }

    const recentRuns = recent.error ? [] : ((recent.data ?? []) as RecentRun[]);
    const lastCheckAt = newest.error ? null : (newest.data?.[0]?.started_at ?? null);
    const openIncidents = open.error ? 0 : (open.count ?? 0);
    const groups = buildIncidents(failures);

    return {
      ok: true,
      windowDays: WINDOW_DAYS,
      cadenceMinutes: CADENCE_MINUTES,
      monitoringSince: oldest.error ? null : (oldest.data?.[0]?.started_at ?? null),
      lastCheckAt,
      overall: classifyOverall(recentRuns, lastCheckAt, openIncidents, now),
      checks,
      succeeded: ok,
      failed: checks - ok,
      uptime: checks > 0 ? ok / checks : null,
      components: buildComponents(checks, failures, recentRuns),
      days: buildDays(days, dayCounts),
      // Confirmed first, THEN capped. Capping the raw list would let a run of
      // recent blips push a real incident off the page.
      incidents: await withRecoveries(
        service,
        groups.filter((g) => !isBlip(g)).slice(0, MAX_LISTED_INCIDENTS),
      ),
      singleCheckFailures: groups.filter(isBlip).length,
      openIncidents,
      generatedAt,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error), generatedAt);
  }
}

function unavailable(reason: string, generatedAt: string): StatusUnavailable {
  console.error('[status]', 'snapshot unavailable', reason);
  return { ok: false, reason, generatedAt };
}

/* ------------------------------------------------------------- components */

/**
 * Per-step uptime, derived from the failure counts and the step order.
 *
 * A run stops at its first failed step. So the runs that REACHED step k are
 * every finished run in the window minus the ones that died at an earlier
 * step, and the ones that PASSED it are those minus the ones that died at k.
 * Runs whose failed step is not one of the four (the monitor's own `internal`
 * errors, and the alert-delivery steps that run after the product checks) are
 * removed from every denominator: they say nothing about whether the endpoint
 * answered, and leaving them in would charge a broken monitor to the product.
 *
 * Verified against the same figures computed by unnesting the `steps` jsonb in
 * SQL over the live table on 2026-09-08: 8638 finished runs gave 8638/8634,
 * 8634/8633, 8633/8632 and 8632/8615 by both routes.
 */
function buildComponents(
  checks: number,
  failures: FailedRun[],
  recent: RecentRun[],
): StatusComponent[] {
  const ordered = new Set<string>(STEP_ORDER);
  const offOrder = failures.filter((f) => !f.failed_step || !ordered.has(f.failed_step)).length;
  const base = checks - offOrder;

  let earlier = 0;
  return STEP_ORDER.map((id) => {
    const failedHere = failures.filter((f) => f.failed_step === id).length;
    const attempted = Math.max(0, base - earlier);
    earlier += failedHere;
    const passed = Math.max(0, attempted - failedHere);
    return {
      id,
      state: currentStepState(id, recent),
      attempted,
      succeeded: passed,
      rate: attempted > 0 ? passed / attempted : null,
    };
  });
}

/**
 * What a single step is doing right now.
 *
 * Read from the newest run that actually got as far as this step, because a
 * run that failed at the handshake proves nothing about reading mail. When no
 * recent run reached it the answer is `unknown` and the page says "not checked
 * in the latest runs", never "operational". Not knowing must not render as
 * fine; that is the whole discipline this page is built on.
 */
function currentStepState(id: StepId, recent: RecentRun[]): ComponentState {
  for (const run of recent) {
    const step = Array.isArray(run.steps) ? run.steps.find((s) => s?.name === id) : undefined;
    if (!step || typeof step.status !== 'string') continue;
    return step.status === 'succeeded' ? 'operational' : 'failing';
  }
  return 'unknown';
}

/* -------------------------------------------------------------- incidents */

type Group = {
  startedAt: string;
  lastFailureAt: string;
  failedChecks: number;
  failureClass: string;
  failedStep: string;
};

/**
 * Runs of consecutive failed checks, oldest first in, newest first out.
 *
 * Grouped on the gap between failures rather than on a run counter, because
 * only the failures are read back. At a five minute cadence two failures more
 * than SAME_INCIDENT_GAP_MINUTES apart had a passing check between them, so
 * they are two separate events. A change of failure class also splits a group:
 * the endpoint not answering and the mail provider timing out are different
 * incidents even back to back, and the alerting fingerprints them separately.
 */
function buildIncidents(failures: FailedRun[]): Group[] {
  const groups: Group[] = [];
  for (const run of failures) {
    const cls = run.failure_class ?? 'internal';
    const step = run.failed_step ?? 'internal';
    const last = groups[groups.length - 1];
    const gap = last
      ? (Date.parse(run.started_at) - Date.parse(last.lastFailureAt)) / 60_000
      : Infinity;
    if (last && last.failureClass === cls && last.failedStep === step && gap <= SAME_INCIDENT_GAP_MINUTES) {
      last.lastFailureAt = run.started_at;
      last.failedChecks += 1;
    } else {
      groups.push({
        startedAt: run.started_at,
        lastFailureAt: run.started_at,
        failedChecks: 1,
        failureClass: cls,
        failedStep: step,
      });
    }
  }
  return groups.reverse();
}

/**
 * A single failed check of a class the pager deliberately sleeps through.
 *
 * The monitor pages on the first strike for authentication, mcp_protocol and
 * internal, and waits for a second consecutive failure for everything else,
 * because those other classes can be somebody else's network having a bad
 * second (record_synthetic_monitor_failure, and the reasoning in
 * analytics/health-math.ts). The page follows the same line rather than
 * inventing a public one: a blip nobody was woken for is not called an
 * incident here either. It is still counted in the uptime figure above, and
 * the page says out loud how many there were, so the split hides nothing.
 */
function isBlip(group: Group): boolean {
  return (
    group.failedChecks === 1 &&
    !(IMMEDIATE_FAILURE_CLASSES as readonly string[]).includes(group.failureClass)
  );
}

/**
 * When each listed incident actually recovered.
 *
 * The first passing check after the last failing one, read from the table, not
 * assumed from the cadence. Adding five minutes to the last failure would be a
 * fabricated timestamp on a page whose entire premise is that it contains
 * none, and it would be wrong in exactly the case that matters: an incident
 * that ran on past the last failure the window happens to hold.
 *
 * `synthetic_monitor_incidents.resolved_at` cannot answer this. That table
 * keeps one row per failure fingerprint and rewrites it on every recurrence,
 * so it holds the latest lifecycle of each fingerprint rather than a history.
 */
async function withRecoveries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: any,
  confirmed: Group[],
): Promise<StatusIncident[]> {
  return Promise.all(
    confirmed.map(async (group) => {
      const { data, error } = await service
        .from('synthetic_monitor_runs')
        .select('completed_at,started_at')
        .eq('mode', 'read')
        .eq('status', 'succeeded')
        .gt('started_at', group.lastFailureAt)
        .order('started_at', { ascending: true })
        .limit(1);
      const row = error ? null : (data?.[0] ?? null);
      return {
        startedAt: group.startedAt,
        lastFailureAt: group.lastFailureAt,
        recoveredAt: row ? (row.completed_at ?? row.started_at) : null,
        failedChecks: group.failedChecks,
        failureClass: group.failureClass,
        failedStep: group.failedStep,
        pagedImmediately: (IMMEDIATE_FAILURE_CLASSES as readonly string[]).includes(group.failureClass),
      };
    }),
  );
}

/* ---------------------------------------------------------------- verdict */

/**
 * The headline.
 *
 * Deliberately NOT analytics/health-math.ts `classifyHealth`. That classifier
 * takes a second witness this page is not allowed to use (customer traffic),
 * and it answers a different question: the wall board asks "should someone
 * walk over", this page asks "can a stranger trust the endpoint right now".
 * What is shared is the escalation rule, imported rather than retyped, so the
 * public page can never call something an outage that the pager slept through,
 * or stay green through an incident that woke someone.
 */
function classifyOverall(
  recent: RecentRun[],
  lastCheckAt: string | null,
  openIncidents: number,
  now: number,
): OverallState {
  // A monitor that stopped reporting leaves us blind, which is not the same as
  // an outage and must not be painted as either green or red.
  const staleMinutes = lastCheckAt ? (now - Date.parse(lastCheckAt)) / 60_000 : null;
  if (staleMinutes === null || !Number.isFinite(staleMinutes) || staleMinutes >= MONITOR_STALE_MINUTES) {
    return 'unknown';
  }
  if (recent.length === 0) return 'unknown';

  const latest = recent[0];
  if (latest.status === 'succeeded') return openIncidents > 0 ? 'degraded' : 'operational';

  let consecutive = 0;
  for (const run of recent) {
    if (run.status === 'succeeded') break;
    consecutive += 1;
  }
  const immediate =
    latest.failure_class !== null &&
    (IMMEDIATE_FAILURE_CLASSES as readonly string[]).includes(latest.failure_class);
  return consecutive >= 2 || immediate ? 'down' : 'degraded';
}

/* ------------------------------------------------------------------ dates */

type HeadCount = { count: number | null; error: unknown };

function buildDays(dates: string[], counts: HeadCount[][]): StatusDay[] {
  return dates.map((date, i) => {
    const [total, failed] = counts[i] ?? [];
    // A day whose count could not be read is reported as no data, never as a
    // clean day. An unreadable day painted green is a false claim.
    if (!total || total.error) return { date, checks: 0, failed: 0 };
    return {
      date,
      checks: total.count ?? 0,
      failed: failed && !failed.error ? (failed.count ?? 0) : 0,
    };
  });
}

/** The last `count` UTC calendar dates, oldest first, ending today. */
function utcDays(now: number, count: number): string[] {
  const days: string[] = [];
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function nextUtcDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}
