/**
 * The three panels behind the Uptime tiles: Success rate, What is failing,
 * Outage log.
 *
 * These follow the pattern written out in audience.tsx (one `Promise.all`, a
 * `TileError` rather than a zero, the window clamped where the data is
 * clamped, aggregates only). Two rules matter more on this screen than on any
 * other, so they are restated here rather than left to the shared header.
 *
 * THE DENOMINATOR IS ATTEMPTED CALLS, NEVER RAW CALLS. `calls` includes
 * rate-limited and plan-capped requests, which never reached a tool: the
 * client was told no and nothing was tried. Dividing by them anyway is what
 * made a board tile read 56.7% on an hour where every real call succeeded and
 * one workspace was looping against its own usage cap (2026-09-03). Every rate
 * on these panels goes through `attemptRate` (or `successRate` for the live
 * window, which is the same arithmetic with a minimum call floor), so the
 * board, the health API and these panels cannot drift apart.
 *
 * A BLANK TILE HERE READS AS AN OUTAGE. Everywhere else on the board a failed
 * query renders as a missing number; here it renders as "the product is
 * broken", because that is the question the panel was opened to answer. So
 * every branch that cannot produce a number says so in words, including the
 * health snapshot's own `unknown` verdict, which is a fetch failure wearing a
 * different shape.
 *
 * OUR OWN WORKSPACE IS NOT EXCLUDED. It is real traffic against the real
 * endpoint and it fails for the same reasons everyone else's does, so taking
 * it out of a reliability denominator would flatter the number. Where one
 * account dominates a window's failures that is stated as a fact ("N of M
 * failures are one workspace") and never as a filter, and no workspace id,
 * name or address is printed on this screen.
 */

import {
  fetchDailyMetrics,
  fetchErrorBreakdown,
  fetchUsageVolume,
} from '@/lib/analytics/growth-queries';
import { fetchRecentIncidents, fetchSystemHealth, unknownHealth } from '@/lib/analytics/kiosk-health';
import type { MonitorIncident } from '@/lib/analytics/kiosk-health';
import { MONITOR_STALE_MINUTES, minutesSince } from '@/lib/analytics/health-math';
import type { SystemHealth } from '@/lib/analytics/health-math';
import type { GrowthDailyRow } from '@/lib/analytics/growth-types';
import { NO_DATA, formatCount, formatPercent, ratio } from '../../charts';
import {
  BarList,
  BigNumber,
  EventList,
  FactRow,
  GroupedColumns,
  Tile,
  TileError,
} from '../primitives';
import { attemptRate, calendarWeekBuckets, CHART_WEEKS, sum } from '../shared';
import { activityDays, isActivityCapped, windowShort } from '../windows';
import type { KioskDetailProps } from './registry';

/** Rows in the two long tables. Eight is what fits without the panel scrolling. */
const TABLE_ROWS = 8;

/** Incidents pulled per panel. Twelve is more than the board's eight, which is the point. */
const INCIDENT_LIMIT = 12;

/**
 * The live health snapshot, which by contract degrades rather than throws.
 *
 * The `.catch` is belt and braces for the one path its own try/catch cannot
 * cover, and it degrades the same way: to an explicitly unknown snapshot that
 * the tiles below render as a stated failure. A rejected promise inside the
 * panel's `Promise.all` would take the other three tiles down with it, which
 * on this panel means a wall going blank at exactly the moment somebody is
 * standing in front of it asking whether we are down.
 */
function liveHealth(): Promise<SystemHealth> {
  return fetchSystemHealth().catch((error: unknown) =>
    unknownHealth(Date.now(), error instanceof Error ? error.message : String(error)),
  );
}

/* ======================================================== the success rate */

export async function ReliabilityDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const [daily, usage] = await Promise.all([
    fetchDailyMetrics(activity),
    fetchUsageVolume(activity),
  ]);

  const rows = daily.ok ? daily.data : [];
  const calls = sum(rows, 'calls');
  const successes = sum(rows, 'successes');
  const failures = sum(rows, 'errors');
  const throttled = sum(rows, 'rate_limited');
  const attempted = Math.max(0, calls - throttled);
  const rate = attemptRate(successes, calls, throttled);
  const activityAside = isActivityCapped(days) ? '90d max' : windowShort(days);

  return (
    <>
      {daily.ok ? (
        <Tile
          label="Success rate"
          aside={activityAside}
          span={4}
          // The same thresholds the board tile uses. Two surfaces showing the
          // same percentage in different colours is how a room learns that the
          // colours mean nothing.
          tone={rate === null ? 'default' : rate >= 0.99 ? 'good' : rate >= 0.95 ? 'warn' : 'bad'}
        >
          <BigNumber
            value={rate === null ? NO_DATA : formatPercent(rate, 2)}
            caption={
              <>
                <strong>{formatCount(failures)}</strong> failures in{' '}
                <strong>{formatCount(attempted)}</strong> attempted calls
              </>
            }
            spark={rateSpark(rows)}
            sparkColor="var(--kiosk-good)"
          />
          <FactRow
            facts={[
              { label: 'Attempted', value: attempted },
              { label: 'Failed', value: failures },
              { label: 'Never tried', value: throttled },
              // The wrong arithmetic, printed on purpose and labelled as
              // wrong. It is the number this tile used to show, and while the
              // two agree on a clean window they come apart the moment one
              // client starts hammering a cap it has already hit. Showing the
              // gap is what stops somebody recomputing the headline by hand
              // from the calls total and concluding the tile is broken.
              {
                label: 'If throttling counted',
                value: calls > 0 ? formatPercent(successes / calls, 2) : NO_DATA,
              },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Success rate" message={daily.error} span={4} />
      )}

      {/* Attempted calls beside failures on one scale, which makes the failure
          series a sliver in a healthy window. That is the honest shape and the
          count is printed above each bar, so the small series is still
          readable; drawing failures on their own axis would make an ordinary
          week look like a crisis from four metres away. */}
      {daily.ok ? (
        <Tile label="Calls and failures, week by week" aside={activityAside} span={8}>
          {rows.length === 0 ? (
            <p className="kiosk-empty">No call has been recorded in this window.</p>
          ) : (
            <GroupedColumns
              buckets={calendarWeekBuckets(rows, CHART_WEEKS, (row) => [
                Math.max(0, row.calls - row.rate_limited),
                row.errors,
              ])}
              series={[
                { name: 'Attempted calls', color: 'var(--kiosk-accent)' },
                { name: 'Failed', color: 'var(--kiosk-bad)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Calls and failures, week by week" message={daily.error} span={8} />
      )}

      {/* The excluded bucket, given a tile of its own rather than a footnote.
          It is the single most likely reason somebody standing here thinks the
          headline is wrong, and since the plan-cap rejection logging change
          (2026-09) it can be a large share of a day's calls. Two sources, so
          two possible failures, and neither is allowed to render as zero. */}
      {!daily.ok ? (
        <TileError label="Asked for, never tried" message={daily.error} span={4} />
      ) : !usage.ok ? (
        <TileError label="Asked for, never tried" message={usage.error} span={4} />
      ) : (
        <Tile label="Asked for, never tried" aside={activityAside} span={4}>
          <BigNumber
            value={throttled}
            caption={
              throttled === 0
                ? 'Nothing was rate limited or capped in this window'
                : <>Excluded from the rate above: nothing was attempted</>
            }
          />
          <FactRow
            facts={[
              { label: 'Of all calls', value: ratio(throttled, calls) },
              { label: 'Cap rejections', value: usage.data.cap_rejections },
              { label: 'Workspaces at a cap', value: usage.data.cap_hit_workspaces },
            ]}
          />
        </Tile>
      )}

      {/* Ranked by failure COUNT, not by failure rate. Sorting by rate puts a
          quiet night where one of three calls failed above a Tuesday where
          forty did, which inverts the only ordering anybody wants: how many
          people something went wrong for. The share column keeps the honesty
          rule (`ratio` prints counts rather than a percentage under ten). */}
      {daily.ok ? (
        <Tile label="The days that went wrong" aside={activityAside} span={8}>
          {worstDays(rows).length === 0 ? (
            <p className="kiosk-empty">No day in this window recorded a failure.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="is-num">Attempted</th>
                  <th className="is-num">Failed</th>
                  <th className="is-num">Never tried</th>
                  <th className="is-num">Of attempted</th>
                </tr>
              </thead>
              <tbody>
                {worstDays(rows).map((row) => (
                  <tr key={row.day}>
                    <td>{dayLabel(row.day)}</td>
                    <td className="is-num">{formatCount(Math.max(0, row.calls - row.rate_limited))}</td>
                    <td className="is-num">{formatCount(row.errors)}</td>
                    <td className="is-num">{formatCount(row.rate_limited)}</td>
                    <td className="is-num">{ratio(row.errors, Math.max(0, row.calls - row.rate_limited))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="The days that went wrong" message={daily.error} span={8} />
      )}

      <p className="kiosk-detail-note">
        This is not uptime. It is the share of MCP calls that returned a result, counted per call and
        not per customer, so one busy workspace weighs more than one quiet one. Rate-limited and
        plan-capped calls are excluded from the denominator because nothing was tried: the client was
        told no before a tool ran, and counting an abuse guard doing its job as a product failure once
        put this tile at 56.7% on an hour where every real call succeeded. Our own workspace is
        included: it is real traffic and it breaks for the same reasons everyone else does. Days are
        UTC, so the current one is always short.
        {isActivityCapped(days)
          ? ' Everything here comes from the activity log, which keeps nothing older than 90 days.'
          : ''}
      </p>
    </>
  );
}

/* ====================================================== what is failing */

export async function ErrorsDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const [errors, daily, health] = await Promise.all([
    fetchErrorBreakdown(activity),
    fetchDailyMetrics(activity),
    liveHealth(),
  ]);

  const rows = daily.ok ? daily.data : [];
  const failures = sum(rows, 'errors');
  const attempted = Math.max(0, sum(rows, 'calls') - sum(rows, 'rate_limited'));
  const pairs = errors.ok ? errors.data : [];
  const rankedFailures = pairs.reduce((total, row) => total + row.failures, 0);
  // Taken as a max rather than as the first row. The RPC does return its rows
  // worst first and the bar list below relies on that, but a fact printed as
  // "the worst one" must be the worst one even if the ordering ever changes.
  const worstPair = pairs.reduce((most, row) => Math.max(most, row.failures), 0);
  const activityAside = isActivityCapped(days) ? '90d max' : windowShort(days);
  const live = health.live;
  const concentration = live.concentration;

  return (
    <>
      {/* The headline count comes from the daily series and the breakdown of it
          from the error RPC, which is a seam worth naming: the RPC ranks tool
          and code pairs and can hold fewer failures than the total if a failure
          was logged without a tool name. The fact row prints both so the gap is
          visible rather than reconciled silently. */}
      {!daily.ok ? (
        <TileError label="Failures in the window" message={daily.error} span={4} />
      ) : !errors.ok ? (
        <TileError label="Failures in the window" message={errors.error} span={4} />
      ) : (
        <Tile
          label="Failures in the window"
          aside={activityAside}
          span={4}
          tone={failures > 0 ? 'warn' : 'good'}
        >
          <BigNumber
            value={failures}
            caption={
              failures === 0
                ? 'Every attempted call returned a result'
                : <>Across <strong>{formatCount(pairs.length)}</strong> tool and code pairs</>
            }
            spark={rows.slice(-30).map((row) => row.errors)}
            sparkColor="var(--kiosk-bad)"
          />
          <FactRow
            facts={[
              { label: 'Of attempted', value: ratio(failures, attempted) },
              { label: 'Attributed to a tool', value: rankedFailures },
              {
                label: 'Worst pair owns',
                value: rankedFailures > 0 ? ratio(worstPair, failures) : NO_DATA,
              },
            ]}
          />
        </Tile>
      )}

      {errors.ok ? (
        <Tile label="What is failing" aside={activityAside} span={8}>
          <BarList
            rows={pairs.slice(0, 6).map((row) => ({
              name: `${row.tool_name}${row.error_code ? ` · ${row.error_code}` : ''}`,
              count: row.failures,
              color: 'var(--kiosk-bad)',
            }))}
            emptyLabel="No failure recorded in the window"
          />
        </Tile>
      ) : (
        <TileError label="What is failing" message={errors.error} span={8} />
      )}

      {/* HOW CONCENTRATED, and why the answer covers the last hour rather than
          the window. Failure attribution is only counted on the live window:
          it is the only one the health classifier escalates on, and profiling
          90 days of failures by workspace would be a much larger read to
          answer a question nobody asks of it.

          The point of the tile is that a rate over the whole estate answers
          "what fraction of calls failed", which is only the same question as
          "is the product broken" when the failures are spread. One customer's
          mail host refusing that customer's connections is a fact about that
          customer. It is stated as a count, never used as a filter, and the
          workspace is never named. */}
      {health.level === 'unknown' ? (
        <TileError label="How concentrated, last hour" message={health.reason} span={4} />
      ) : (
        <Tile
          label="How concentrated, last hour"
          aside={`${live.minutes}m`}
          span={4}
          tone={health.concentration ? 'warn' : 'default'}
        >
          {live.errors === 0 ? (
            <p className="kiosk-empty">No call has failed in the last hour.</p>
          ) : (
            <>
              <BigNumber
                value={live.errors}
                caption={
                  concentration
                    ? <>
                        <strong>{formatCount(concentration.worstWorkspaceErrors)}</strong> of them are
                        one workspace
                      </>
                    : 'Failures in the hour, not attributed to a workspace'
                }
              />
              <FactRow
                facts={[
                  {
                    label: 'Workspaces failing',
                    value: concentration ? concentration.workspaces : NO_DATA,
                  },
                  { label: 'Attempted, last hour', value: Math.max(0, live.calls - live.rateLimited) },
                  {
                    // The counterfactual, counted separately rather than
                    // subtracted: we know that workspace's failures but not its
                    // successes, so arithmetic on the totals would assume the
                    // answer in the direction that hides an outage. Absent
                    // whenever nobody dominated the hour, which is most hours.
                    label: 'Everyone else',
                    value: health.concentration
                      ? formatPercent(health.concentration.restRate, 1)
                      : NO_DATA,
                  },
                ]}
              />
            </>
          )}
        </Tile>
      )}

      {errors.ok ? (
        <Tile label="Every failing tool and code" aside={activityAside} span={8}>
          {pairs.length === 0 ? (
            <p className="kiosk-empty">No failure recorded in the window.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Code</th>
                  <th className="is-num">Failed</th>
                  <th className="is-num">Of its calls</th>
                  <th className="is-num">Of all failures</th>
                </tr>
              </thead>
              <tbody>
                {pairs.slice(0, TABLE_ROWS).map((row) => (
                  <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
                    <td>{row.tool_name}</td>
                    <td>{row.error_code ?? NO_DATA}</td>
                    <td className="is-num">{formatCount(row.failures)}</td>
                    {/* Against that tool's own calls, which is the number that
                        says whether the tool is broken. A tool called twice
                        that failed twice is a worse tool than one called ten
                        thousand times that failed nine. */}
                    <td className="is-num">{ratio(row.failures, row.calls)}</td>
                    <td className="is-num">{ratio(row.failures, rankedFailures)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Every failing tool and code" message={errors.error} span={8} />
      )}

      <p className="kiosk-detail-note">
        A failure here is a call that reached a tool and came back with an error, so it is not a count
        of unhappy customers and not a count of outages: a client that retries four times leaves four
        rows. Rate-limited and plan-capped calls are not failures and are not in any of these numbers,
        because nothing was tried. A tool&apos;s own failure rate is against its own calls, so a rarely
        used tool can top the table on two failures. Concentration is measured over the last hour
        only, and only when the failures could be attributed, so an absent figure means we did not
        measure it rather than that nobody dominated.
        {isActivityCapped(days)
          ? ' The breakdown comes from the activity log, which keeps nothing older than 90 days.'
          : ''}
      </p>
    </>
  );
}

/* ============================================================ the outage log */

export async function IncidentsDetail({ days }: KioskDetailProps) {
  const [incidents, health] = await Promise.all([fetchRecentIncidents(INCIDENT_LIMIT), liveHealth()]);

  const open = incidents.filter((incident) => incident.status === 'open');
  const monitor = health.monitor;
  // Aged against when the snapshot was taken rather than against the clock at
  // render time: the two are milliseconds apart, and the first one is a fact
  // the payload carries about itself while the second is a fresh reading taken
  // during a render, which is both impure and a claim the data cannot support.
  const checkedAt = Date.parse(health.checkedAt);
  const silentFor = Number.isFinite(checkedAt) ? minutesSince(monitor.lastRunAt, checkedAt) : null;
  const stale = silentFor === null || silentFor > MONITOR_STALE_MINUTES;
  // The board's window applied to a list that is otherwise all-time. Incidents
  // are rare enough that "12 on record" says nothing about whether this has
  // been a bad month, and this is the only figure on the panel that answers
  // that. It is labelled with the window rather than left to be assumed.
  const inWindow = incidents.filter((incident) => withinDays(incident.lastFailureAt, days)).length;

  return (
    <>
      <Tile
        label="Open right now"
        aside={incidents.length === 0 ? 'never' : open.length === 0 ? 'all resolved' : `${open.length} open`}
        span={4}
        tone={open.length > 0 ? 'bad' : incidents.length === 0 ? 'default' : 'good'}
      >
        <BigNumber
          value={open.length}
          caption={
            open.length > 0
              ? <>Oldest still open since <strong>{dayLabel(oldestOpen(open))}</strong></>
              : 'Nothing the synthetic monitor opened is still unresolved'
          }
        />
        <FactRow
          facts={[
            { label: 'On record', value: incidents.length },
            { label: `Last ${windowShort(days)}`, value: inWindow },
            {
              label: 'Most recent',
              value: incidents.length === 0 ? NO_DATA : daysAgo(incidents[0].lastFailureAt),
            },
          ]}
        />
      </Tile>

      {/* An OPEN incident gets the word OPEN and never a date. The one thing a
          reader must not do with this list is scan a column of dates and
          conclude that everything in it is over. */}
      <Tile label="Incident history" aside="newest first" span={8}>
        <EventList
          rows={incidents.map((incident) => ({
            key: incident.fingerprint,
            title: incident.failedStep,
            note: `${prettyClass(incident.failureClass)} · ${incident.consecutiveFailures}x`,
            when: incident.status === 'open' ? 'OPEN' : daysAgo(incident.resolvedAt ?? incident.lastFailureAt),
            tone: incident.status === 'open' ? 'bad' : 'default',
          }))}
          emptyLabel="The synthetic monitor has never opened an incident."
        />
      </Tile>

      {/* THE TILE THAT MAKES THE EMPTY LOG MEAN SOMETHING. An incident list is
          only evidence of a good quarter if the thing writing it is alive, and
          a silent monitor is not an outage: it means pg_cron, pg_net or the
          Edge Function is broken, which is a real problem and a completely
          different one. Reporting blindness as an outage would send somebody to
          look at the wrong system, so it is amber and says which. */}
      {health.level === 'unknown' ? (
        <TileError label="The monitor itself" message={health.reason} span={4} />
      ) : (
        <Tile label="The monitor itself" aside="every 5m" span={4} tone={stale ? 'warn' : 'good'}>
          <BigNumber
            value={silentFor === null ? NO_DATA : `${formatCount(silentFor)}m`}
            caption={
              stale
                ? <>Nothing recorded for over <strong>{MONITOR_STALE_MINUTES}m</strong>: the monitor, not the product</>
                : 'Since the last run against the public MCP endpoint'
            }
          />
          <FactRow
            facts={[
              { label: 'Last run', value: monitor.lastStatus ? prettyClass(monitor.lastStatus) : NO_DATA },
              { label: 'Failures in a row', value: monitor.consecutiveFailures },
              { label: 'Typical run', value: duration(monitor.medianDurationMs) },
            ]}
          />
        </Tile>
      )}

      {/* "Strikes" is the column that says whether a row was worth waking up
          for. The pager escalates on the first failure for authentication,
          mcp_protocol and internal, and waits for two consecutive failures for
          everything else, so a single strike on a retryable class is somebody
          else's network and is here for completeness rather than for blame. */}
      <Tile label="Every incident on record" aside={`last ${INCIDENT_LIMIT}`} span={8}>
        {incidents.length === 0 ? (
          <p className="kiosk-empty">The synthetic monitor has never opened an incident.</p>
        ) : (
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>What failed</th>
                <th>Cause</th>
                <th className="is-num">Strikes</th>
                <th className="is-num">Started</th>
                <th className="is-num">Ended</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident) => (
                <tr key={incident.fingerprint}>
                  <td>{incident.failedStep}</td>
                  <td>{prettyClass(incident.failureClass)}</td>
                  <td className="is-num">{formatCount(incident.consecutiveFailures)}</td>
                  <td className="is-num">{dayLabel(incident.firstFailureAt)}</td>
                  <td className="is-num">
                    {incident.status === 'open' ? 'OPEN' : daysAgo(incident.resolvedAt ?? incident.lastFailureAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tile>

      <p className="kiosk-detail-note">
        These are what the synthetic monitor caught, not everything that has ever gone wrong. The
        monitor runs four steps against the public MCP endpoint every five minutes, so a failure only
        those four paths would see is in here and a provider that started rejecting one customer&apos;s
        auth is not: that shows up as failed calls on the Success rate panel instead. Rows are
        deduplicated by fingerprint, so one row can stand for many failed runs and the strike count is
        how many. An empty list is only good news while the tile above says the monitor ran recently.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * The daily success-rate trend, with the days nobody called left out.
 *
 * A day with no attempted calls has no success rate, and substituting 100%
 * would draw a perfect day the product never had. Dropping it can make this
 * line a slightly different shape from the board's 30 day strip, which does
 * substitute; the strip is a shape and this panel is where somebody has come
 * to read the number, so it errs the other way.
 */
function rateSpark(rows: GrowthDailyRow[]): number[] {
  return rows
    .slice(-30)
    .map((row) => attemptRate(row.successes, row.calls, row.rate_limited))
    .filter((rate): rate is number => rate !== null)
    .map((rate) => rate * 100);
}

/** The days with the most failed calls, worst first. See the tile for the ordering argument. */
function worstDays(rows: GrowthDailyRow[]): GrowthDailyRow[] {
  return rows
    .filter((row) => row.errors > 0)
    .slice()
    .sort((a, b) => b.errors - a.errors || b.calls - a.calls)
    .slice(0, TABLE_ROWS);
}

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A day key or ISO timestamp as "7 Sep". UTC, like every other date on the board. */
function dayLabel(iso: string | null): string {
  if (!iso) return NO_DATA;
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return NO_DATA;
  return DAY_LABEL.format(date);
}

/** Whole days since an ISO timestamp, phrased for a wall. Matches the board's wording. */
function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** True when a timestamp falls inside the board's current window. */
function withinDays(iso: string, days: number): boolean {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return false;
  return Date.now() - then <= days * 86_400_000;
}

/** `mcp_protocol` becomes `mcp protocol`. Underscores are for logs, not for walls. */
function prettyClass(value: string | null): string {
  if (!value) return 'unknown';
  return value.replace(/_/g, ' ');
}

/** A monitor run duration in the units a person would say it in. */
function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NO_DATA;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** When the oldest still-open incident started. Only called with a non-empty list. */
function oldestOpen(open: MonitorIncident[]): string {
  return open.reduce(
    (oldest, incident) => (incident.firstFailureAt < oldest ? incident.firstFailureAt : oldest),
    open[0].firstFailureAt,
  );
}
