/**
 * The live health read behind the kiosk's alarm.
 *
 * Deliberately NOT routed through `cachedSection` like every other number on
 * the board. Growth metrics move in days and a ten minute cache is free
 * accuracy; an outage moves in seconds, and a board that showed a ten minute
 * old "all green" through an incident would be worse than a board with no
 * health panel at all, because the room would believe it. Everything here is
 * read fresh on every request, which is affordable precisely because it is ten
 * small indexed reads rather than an aggregate over the estate. Three further
 * counts are added only on an hour where one workspace owns a third of the
 * failures, which on a healthy hour never happens.
 *
 * TWO WITNESSES, one verdict. `synthetic_monitor_runs` says whether the public
 * MCP endpoint answers; `activity_log` over the last hour says whether real
 * calls are succeeding. health-math.ts holds the argument for why neither is
 * sufficient alone and where the thresholds come from.
 *
 * NOTHING HERE THROWS. The caller is a route handler polled every 45 seconds
 * by a display nobody is watching, and a rejected promise there would blank
 * the one panel whose whole job is to be believed. A failed read degrades to
 * an explicitly unknown snapshot, which the board paints amber and labels, so
 * "we cannot tell" never renders as "we are fine".
 *
 * The monitor tables are not in the generated `Database` types (they are
 * service-role only and were added outside the type generation), so the client
 * is cast locally, the same convention growth-queries.ts uses for RPCs.
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  classifyHealth,
  CONCENTRATION_SHARE,
  type CallWindow,
  type ErrorConcentration,
  type HealthFacts,
  type MonitorFacts,
  type RestWindow,
  type SystemHealth,
} from '@/lib/analytics/health-math';

/**
 * The live window, in minutes.
 *
 * Sixty, because production does roughly 250 calls an hour and the classifier
 * refuses to compute a rate under 20 calls. A fifteen minute window would sit
 * below that floor whenever traffic dipped, which would silently disable the
 * error-rate witness at exactly the quiet hours when the other one matters
 * most. The synthetic monitor covers the shorter timescale: it writes two
 * `tools/call` rows every five minutes, so this window can never be empty
 * while the monitor is alive.
 */
export const LIVE_WINDOW_MINUTES = 60;

/** The context window under the headline. A day is what "is this normal" needs. */
export const DAY_WINDOW_MINUTES = 24 * 60;

/**
 * Monitor runs pulled per read. Twenty runs is a hundred minutes at the five
 * minute cadence: enough to count a run of consecutive failures and to take a
 * median duration, small enough to be one index-ordered page.
 */
const MONITOR_HISTORY = 20;

type MonitorRunRow = {
  status: 'running' | 'succeeded' | 'failed' | 'internal_error';
  failure_class: string | null;
  failed_step: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
};

/**
 * The whole health snapshot.
 *
 * Every query runs in parallel and every one of them is allowed to fail on its
 * own: a broken monitor table must not take the error rate down with it, since
 * the two exist precisely to cover each other.
 */
export async function fetchSystemHealth(now: number = Date.now()): Promise<SystemHealth> {
  try {
    const [monitor, live, day, lastCallAt] = await Promise.all([
      fetchMonitorFacts(),
      // Only the live window is profiled for concentration. It is the only one
      // the classifier escalates on, and the day window would cost a much
      // larger error page to answer a question nobody asks of it.
      fetchCallWindow(LIVE_WINDOW_MINUTES, now, true),
      fetchCallWindow(DAY_WINDOW_MINUTES, now),
      fetchLastCallAt(),
    ]);
    const facts: HealthFacts = { monitor, live, day, lastCallAt };
    return { ...facts, ...classifyHealth(facts, now), checkedAt: new Date(now).toISOString() };
  } catch (error) {
    // Reached only if Promise.all itself rejects, which the helpers below are
    // written not to do. Kept anyway: this function is the last thing between
    // a database blip and a wall display showing a stack trace.
    console.error('[kiosk-health]', 'snapshot failed', error);
    return unknownHealth(now, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The snapshot to show when we cannot produce one.
 *
 * Exported because the client polls this route and needs the same shape when
 * the fetch itself fails, which is its own useful signal: a board that cannot
 * reach the site is either looking at a dead site or sitting on a dead
 * network, and both are worth a colour on the wall.
 */
export function unknownHealth(now: number, reason: string): SystemHealth {
  return {
    monitor: emptyMonitor(),
    live: emptyWindow(LIVE_WINDOW_MINUTES),
    day: emptyWindow(DAY_WINDOW_MINUTES),
    lastCallAt: null,
    level: 'unknown',
    headline: 'NO SIGNAL',
    reason,
    since: null,
    checkedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------------------------------------- the monitor */

async function fetchMonitorFacts(): Promise<MonitorFacts> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;

  const [runs, incidents] = await Promise.all([
    service
      .from('synthetic_monitor_runs')
      .select('status,failure_class,failed_step,started_at,completed_at,duration_ms')
      .order('started_at', { ascending: false })
      .limit(MONITOR_HISTORY),
    service
      .from('synthetic_monitor_incidents')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open'),
  ]);

  if (runs.error) {
    console.error('[kiosk-health]', 'monitor runs unreadable', runs.error.message);
    return emptyMonitor();
  }

  const history = (runs.data ?? []) as MonitorRunRow[];
  // A run still in flight proves the scheduler fired, which is what staleness
  // is asking about, but it has no verdict yet and must not be read as one.
  const finished = history.filter((run) => run.status !== 'running');
  const latest = finished[0] ?? null;

  let consecutiveFailures = 0;
  for (const run of finished) {
    if (run.status === 'succeeded') break;
    consecutiveFailures += 1;
  }

  const durations = finished
    .filter((run) => run.status === 'succeeded' && typeof run.duration_ms === 'number')
    .map((run) => run.duration_ms as number)
    .sort((a, b) => a - b);

  return {
    lastRunAt: history[0]?.started_at ?? null,
    lastStatus: latest?.status ?? null,
    lastSuccessAt: finished.find((run) => run.status === 'succeeded')?.completed_at ?? null,
    consecutiveFailures,
    failedStep: latest && latest.status !== 'succeeded' ? latest.failed_step : null,
    failureClass: latest && latest.status !== 'succeeded' ? latest.failure_class : null,
    medianDurationMs: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
    openIncidents: incidents.error ? 0 : incidents.count ?? 0,
  };
}

function emptyMonitor(): MonitorFacts {
  return {
    lastRunAt: null,
    lastStatus: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    failedStep: null,
    failureClass: null,
    medianDurationMs: null,
    openIncidents: 0,
  };
}

/* ------------------------------------------------------- customer traffic */

/**
 * Failed rows we are willing to pull back to see whose failures they are.
 *
 * The live window normally holds under thirty errors and held twenty in the
 * 2026-09-01 16:26 burst, so four hundred is more than ten times the worst
 * hour on record and still one small indexed page, comfortably under the
 * PostgREST cap. It is a budget rather than a limit: the tally below only
 * trusts itself when the page came back SHORT of it, which is what makes
 * "we got everything" provable rather than assumed.
 */
const CONCENTRATION_ROW_BUDGET = 400;

/**
 * Call outcomes over a window, as counted queries rather than one page of rows.
 *
 * PostgREST caps a response at 1000 rows and truncates silently past it (see
 * project_postgrest_1000_row_cap), and a day of traffic is already six times
 * that, so tallying returned rows in Node would quietly under-report the
 * denominator on exactly the busiest days. `head: true` with an exact count
 * asks Postgres to do the counting, which is both correct and cheaper.
 *
 * Rate limited calls are derived rather than counted, so the base stays at
 * three queries. They have never once been recorded in production; the field
 * exists so that if that changes the board does not silently fold throttling
 * into the failure rate, which would paint an abuse guard doing its job as an
 * outage.
 *
 * `withConcentration` adds the only read here that is not a count, and the
 * comment on `fetchConcentration` covers why that is safe and why it could not
 * be done any other way on this project.
 */
async function fetchCallWindow(minutes: number, now: number, withConcentration = false): Promise<CallWindow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const since = new Date(now - minutes * 60_000).toISOString();
  const scoped = () => service.from('activity_log').select('id', { count: 'exact', head: true }).gte('created_at', since);

  const [all, ok, bad, errorRows] = await Promise.all([
    scoped(),
    scoped().eq('status', 'success'),
    scoped().eq('status', 'error'),
    withConcentration
      ? service
          .from('activity_log')
          .select('workspace_id')
          .gte('created_at', since)
          .eq('status', 'error')
          // One over the budget on purpose: a full page is how we detect that
          // there were more failures than we can honestly account for.
          .limit(CONCENTRATION_ROW_BUDGET + 1)
      : null,
  ]);

  if (all.error || ok.error || bad.error) {
    const message = (all.error ?? ok.error ?? bad.error).message;
    console.error('[kiosk-health]', 'activity counts unreadable', message);
    return emptyWindow(minutes);
  }

  const calls = all.count ?? 0;
  const successes = ok.count ?? 0;
  const errors = bad.count ?? 0;
  const concentration = errorRows ? await fetchConcentration(service, since, errors, errorRows) : null;
  return {
    minutes,
    calls,
    successes,
    errors,
    rateLimited: Math.max(0, calls - successes - errors),
    concentration,
  };
}

/**
 * Whose failures they were.
 *
 * WHY THIS IS A PAGE OF ROWS AND NOT AN AGGREGATE. It should have been
 * `select=workspace_id,id.count()`, which is one grouped query and no rows in
 * Node at all. Tried against production on 2026-09-01: PostgREST answers 400
 * PGRST123, "Use of aggregate functions is not allowed". Aggregates are off on
 * this project, and turning them on is a database-wide switch that widens the
 * anon surface for one wall display. A view or an RPC would also do it, and is
 * the right answer the day this needs a second consumer, but it puts a
 * migration between a measurement fix and a board that is currently lying.
 *
 * WHY THE 1000 ROW CAP CANNOT BITE. The cap is dangerous because it truncates
 * in silence, so this never asks a question whose answer might be truncated.
 * It requests one row more than the budget and refuses to tally at all if the
 * page comes back that full: fewer rows than the limit is a proof that we hold
 * every failure in the window, not a hope. Above the budget the tally is
 * abandoned and concentration reads null, which escalates the window normally.
 * That is the correct direction anyway, since four hundred failures in an hour
 * is not one customer's mail host, it is us.
 *
 * The counterfactual window is three more counts and is only paid for when
 * somebody actually dominates, which on a healthy hour is never. It uses
 * exactly the share the classifier uses, imported rather than repeated, so the
 * fetch can never gate on a threshold the judgement disagrees with.
 */
async function fetchConcentration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: any,
  since: string,
  errors: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorRows: { data: any[] | null; error: { message: string } | null },
): Promise<ErrorConcentration | null> {
  if (errorRows.error) {
    console.error('[kiosk-health]', 'error attribution unreadable', errorRows.error.message);
    return null;
  }
  const rows = (errorRows.data ?? []) as { workspace_id: string | null }[];
  if (rows.length === 0) return null;
  if (rows.length > CONCENTRATION_ROW_BUDGET) {
    console.error('[kiosk-health]', 'error attribution skipped, window over budget', rows.length);
    return null;
  }

  const perWorkspace = new Map<string, number>();
  for (const row of rows) {
    if (!row.workspace_id) continue;
    perWorkspace.set(row.workspace_id, (perWorkspace.get(row.workspace_id) ?? 0) + 1);
  }

  let worstWorkspace: string | null = null;
  let worstWorkspaceErrors = 0;
  for (const [workspace, count] of perWorkspace) {
    if (count > worstWorkspaceErrors) {
      worstWorkspace = workspace;
      worstWorkspaceErrors = count;
    }
  }
  if (!worstWorkspace) return null;

  // The exact count is the denominator the classifier will use, so the gate
  // uses it too. It can differ from the page by a row that landed between the
  // two queries; either way an off-by-one here only ever costs us the
  // counterfactual, which fails towards escalating rather than towards quiet.
  const dominant = worstWorkspaceErrors >= errors * CONCENTRATION_SHARE;

  return {
    workspaces: perWorkspace.size,
    worstWorkspaceErrors,
    rest: dominant ? await fetchRestWindow(service, since, worstWorkspace) : null,
  };
}

/**
 * The same window with one workspace's traffic taken out, counted in Postgres.
 *
 * Three counts with a `neq`, which is the same shape as the window itself and
 * for the same reason: the classifier needs a real success rate for everyone
 * else, and a rate derived by subtracting known failures from unknown totals
 * would quietly flatter a heavy workspace that fails half its calls.
 */
async function fetchRestWindow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: any,
  since: string,
  workspaceId: string,
): Promise<RestWindow | null> {
  const scoped = () =>
    service
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .neq('workspace_id', workspaceId);

  const [all, ok, bad] = await Promise.all([
    scoped(),
    scoped().eq('status', 'success'),
    scoped().eq('status', 'error'),
  ]);

  if (all.error || ok.error || bad.error) {
    const message = (all.error ?? ok.error ?? bad.error).message;
    console.error('[kiosk-health]', 'rest-of-estate counts unreadable', message);
    return null;
  }

  return { calls: all.count ?? 0, successes: ok.count ?? 0, errors: bad.count ?? 0 };
}

function emptyWindow(minutes: number): CallWindow {
  return { minutes, calls: 0, successes: 0, errors: 0, rateLimited: 0, concentration: null };
}

/**
 * When the product last did anything for anyone.
 *
 * Not a health input on its own: at this volume a genuinely quiet hour exists,
 * and painting it red would be a false alarm every night. It is shown as a
 * fact because it is the fastest way to tell a dead endpoint from a dead
 * scheduler when both witnesses are unhappy at once.
 */
async function fetchLastCallAt(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const { data, error } = await service
    .from('activity_log')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('[kiosk-health]', 'last call unreadable', error.message);
    return null;
  }
  return data?.[0]?.created_at ?? null;
}

/* ---------------------------------------------------------- incident history */

/** One closed or still-open monitor incident, flattened for a table. */
export type MonitorIncident = {
  fingerprint: string;
  status: 'open' | 'resolved';
  failureClass: string;
  failedStep: string;
  firstFailureAt: string;
  lastFailureAt: string;
  resolvedAt: string | null;
  consecutiveFailures: number;
};

/**
 * The last few incidents, newest first, for the detail section below the fold.
 *
 * WHY IT IS WORTH A TILE. The board above answers "is it up right now", which
 * is the only question that matters when it is down and a useless one the
 * other 99% of the time. This answers the question someone actually walks over
 * to ask: whether this morning's blip was the fourth this week or the first
 * since June. An incident row is also the only durable record on either half
 * of this page. `activity_log` is purged at 90 days and the run history is
 * noise, but an incident is a deduplicated, human-sized fact about a time the
 * product stopped working.
 *
 * Returns an empty list rather than throwing, for the reason every read in
 * this module does: a wall display renders what it has.
 */
export async function fetchRecentIncidents(limit = 6): Promise<MonitorIncident[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const { data, error } = await service
    .from('synthetic_monitor_incidents')
    .select('fingerprint,status,failure_class,failed_step,first_failure_at,last_failure_at,resolved_at,consecutive_failures')
    .order('last_failure_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[kiosk-health]', 'incidents unreadable', error.message);
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => ({
    fingerprint: row.fingerprint,
    status: row.status,
    failureClass: row.failure_class,
    failedStep: row.failed_step,
    firstFailureAt: row.first_failure_at,
    lastFailureAt: row.last_failure_at,
    resolvedAt: row.resolved_at,
    consecutiveFailures: row.consecutive_failures,
  }));
}
