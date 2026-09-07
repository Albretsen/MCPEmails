/**
 * The four panels behind the stickiness tiles: the habit, the curve, the
 * comeback, and the client people started from.
 *
 * The pattern is written out in full at the top of `audience.tsx` and is
 * followed here without restating it: one `Promise.all` per panel so the whole
 * thing paints once, `TileError` rather than a zero when a query does not
 * answer, `activityDays(days)` wherever the numbers come from `activity_log`,
 * and aggregates only.
 *
 * WHAT THESE FOUR HAVE IN COMMON, and it is the thing that makes them easy to
 * read wrong: three of them count WORKSPACES over a rolling window and one of
 * them counts workspaces over WEEKS SINCE THEIR OWN first mailbox. Those are
 * different clocks. A workspace that value-activated yesterday is in every
 * band on the engagement panel and in no row of the retention curve, because
 * its first week has not finished. Each panel says which clock it is on in its
 * own note, because the board's window switch sits above all four and looks
 * like it governs all four.
 *
 * VOCABULARY, used verbatim in the copy below:
 *   - “value activation” is the first successful call that TOUCHED A MAILBOX,
 *     not the first successful call of any kind.
 *   - Retention is measured on EXTERNAL accounts only. Our own synthetic
 *     monitor calls the product every five minutes; leaving it in lifted the
 *     tail of the curve to 50% in weeks where no external workspace had ever
 *     come back at all.
 *   - The engagement RPC bands active days as '1', '2-3', '4-7', '8+' (with en
 *     dashes in the SQL literals), and “came back” is every band except '1'.
 *     Nothing here types those literals: `returningWorkspaces` and the local
 *     `notOnce` both match on “not '1'”, which stays correct if a band is ever
 *     added and cannot be broken by a hyphen typed where a dash belongs.
 */

import {
  fetchActiveWorkspaces,
  fetchClientMix,
  fetchCohortRetention,
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchLifecycleCounts,
  fetchRetentionCurve,
} from '@/lib/analytics/growth-queries';
import type {
  GrowthActiveWorkspaceRow,
  GrowthCohortCellRow,
  GrowthEngagementBandRow,
} from '@/lib/analytics/growth-types';
import { NO_DATA, formatCount, ratio } from '../../charts';
import { BarList, BigNumber, FactRow, GroupedColumns, Tile, TileError } from '../primitives';
import { CHART_WEEKS, calendarWeekBuckets, returningWorkspaces, sumBy } from '../shared';
import { activityDays, isActivityCapped, windowLabel, windowShort } from '../windows';
import type { KioskDetailProps } from './registry';

/**
 * Weeks of retention to draw, and it is deliberately NOT the board's window.
 *
 * Twelve is one quarter, it is what the fold below the board already shows, and
 * it is also very close to the longest honest answer available: the cohort grid
 * reads `activity_log`, whose rows are deleted at 90 days, and twelve weeks is
 * 84. A fourteen week grid would print two columns of zeros that mean "the rows
 * were purged" while looking exactly like “nobody came back”.
 */
const RETENTION_WEEKS = 12;

/** Columns of the cohort grid, week 0 first. Beyond six a row stops fitting. */
const COHORT_COLUMNS = [0, 1, 2, 3, 4, 5];

/** Cohorts shown, newest first. Older ones are all zeros for the reason above. */
const COHORT_ROWS = 8;

/* ============================================================== engagement */

/**
 * How many days people showed up: the shape of the habit.
 *
 * The tile on the board is one bar list. This is the version that answers the
 * two questions somebody asks after reading it: is a “day” a real return or one
 * long sitting split across midnight, and how much work sits behind the bars.
 */
export async function EngagementDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const [bands, daily] = await Promise.all([
    fetchEngagementBands(activity),
    fetchDailyMetrics(activity),
  ]);

  const capped = isActivityCapped(days);
  const windowAside = capped ? '90d max' : windowShort(days);

  const dayBands = bands.ok ? bandRows(bands.data, 'active_days') : [];
  const activeWorkspaces = totalOf(dayBands);
  const returning = bands.ok ? returningWorkspaces(bands.data) : 0;
  const successes = daily.ok ? sumBy(daily.data, (row) => row.successes) : 0;

  return (
    <>
      {/* The one-day band is painted in the flat foreground colour and the rest
          in the good one. It is not decoration: that band is every workspace
          that tried the product inside this window and has not been back, and
          giving it the same colour as the others turns the single most
          important shape on the panel into a bar like any other. */}
      {bands.ok ? (
        <Tile label="Days showed up" aside={windowAside} span={7}>
          <BarList
            rows={dayBands.map((row) => ({
              name: `${row.band} ${row.band === '1' ? 'day' : 'days'}`,
              count: row.workspaces,
              color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-good)',
            }))}
            emptyLabel="No workspace made a successful call in this window"
          />
          <FactRow
            facts={[
              { label: 'Workspaces active', value: activeWorkspaces },
              { label: 'Came back', value: returning },
              { label: 'Of those active', value: ratio(returning, activeWorkspaces) },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Days showed up" message={bands.error} span={7} />
      )}

      {/* SESSIONS ARE THE CONTROL ON THE PANEL NEXT DOOR. A session is a run of
          successful calls with no gap of 30 minutes or more, so a workspace on
          one active day and six sessions spent a whole evening with it, and a
          workspace on four active days and four sessions has a habit. Days
          alone cannot tell those apart, and reading days as if they could is
          how a single long evening gets counted as stickiness. */}
      {bands.ok ? (
        <Tile label="Separate sittings" aside={windowAside} span={5}>
          <BarList
            rows={bandRows(bands.data, 'sessions').map((row) => ({
              name: `${row.band} ${row.band === '1' ? 'sitting' : 'sittings'}`,
              count: row.workspaces,
              color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-accent)',
            }))}
            emptyLabel="No workspace made a successful call in this window"
          />
        </Tile>
      ) : (
        <TileError label="Separate sittings" message={bands.error} span={5} />
      )}

      {/* Successes rather than calls, and summed per day rather than taken from
          a rolling column: a daily count adds up across a week, and a rolling
          28 day figure does not. Adding seven rolling numbers together is how a
          chart ends up claiming several times the traffic that existed. */}
      {daily.ok ? (
        <Tile label="Successful calls, week by week" aside={windowAside} span={7}>
          {daily.data.length === 0 ? (
            <p className="kiosk-empty">No activity has been recorded in this window.</p>
          ) : (
            <GroupedColumns
              buckets={calendarWeekBuckets(daily.data, CHART_WEEKS, (row) => [row.successes])}
              series={[{ name: 'Successful calls', color: 'var(--kiosk-good)' }]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Successful calls, week by week" message={daily.error} span={7} />
      )}

      {/* Both halves of this tile are measured over the same window, which is
          the only reason the division is allowed: the bands count workspaces
          with a SUCCESSFUL call in the window and the numerator counts those
          same successful calls. Dividing window traffic by an all-time
          workspace count, or by the rolling 28 day one, would quietly shrink
          the number every time the window got shorter. */}
      {bands.ok && daily.ok ? (
        <Tile label="How much each one did" aside={windowAside} span={5}>
          <BigNumber
            value={activeWorkspaces > 0 ? Math.round(successes / activeWorkspaces) : NO_DATA}
            caption="Successful calls per workspace that showed up"
            spark={daily.data.map((row) => row.successes)}
            sparkColor="var(--kiosk-good)"
          />
          <FactRow
            facts={[
              { label: 'Successful calls', value: successes },
              { label: 'Attempted', value: sumBy(daily.data, (row) => row.calls) },
              { label: 'Refused at a limit', value: sumBy(daily.data, (row) => row.rate_limited) },
            ]}
          />
        </Tile>
      ) : (
        <TileError
          label="How much each one did"
          message={bands.ok ? (daily.ok ? 'unavailable' : daily.error) : bands.error}
          span={5}
        />
      )}

      <p className="kiosk-detail-note">
        These are WORKSPACES, not people, and not customers: the activity log records the workspace
        a call was made for, and our own accounts are in it because they are real load on the same
        service. A band is not a cohort either. Every workspace in the window is banded on the days
        it was active INSIDE the window, so a workspace that has used the product every week for a
        month sits in the same band as one that arrived on Monday and stayed a week. “Attempted”
        includes calls refused at a rate limit or a plan cap, which never reached a tool at all.
        {capped
          ? ' Everything here is drawn from the activity log, which keeps 90 days: a wider window would put real workspace counts beside zeroed activity.'
          : ''}
      </p>
    </>
  );
}

/* =============================================================== retention */

/**
 * Retention after the first mailbox: which week it falls off.
 *
 * FIXED AT TWELVE WEEKS ON PURPOSE, whatever the board's switch says. The curve
 * is measured in weeks since each workspace's OWN value activation, so it has
 * no relationship to a rolling window at all: asking it for “the last 7 days”
 * is a category error, and rendering it under a 7d label would be a lie the
 * switch above it makes look authoritative.
 */
export async function RetentionDetail({ days }: KioskDetailProps) {
  const [curve, cohorts, life] = await Promise.all([
    fetchRetentionCurve(RETENTION_WEEKS),
    fetchCohortRetention(RETENTION_WEEKS),
    fetchLifecycleCounts(),
  ]);

  const points = curve.ok ? curve.data : [];
  const firstWeek = points.find((point) => point.week_index === 1) ?? null;
  const drop = steepestDrop(points);
  const lastReturn = [...points].reverse().find((point) => point.retained > 0) ?? null;

  return (
    <>
      {/* Eligible is drawn beside retained rather than a bare percentage per
          week. At this size a week can hold three workspaces, and "33%" over
          three is a sentence about one person changing their mind. The pair of
          bars makes the denominator impossible to miss. */}
      {curve.ok ? (
        <Tile label="Week by week after the first mailbox" aside="external accounts" span={12}>
          {points.length === 0 ? (
            <p className="kiosk-empty">No cohort has aged into a full week yet.</p>
          ) : (
            <GroupedColumns
              buckets={points.map((point) => ({
                label: `W${point.week_index}`,
                values: [point.eligible, point.retained],
              }))}
              series={[
                { name: 'Eligible', color: 'var(--fg-4)' },
                { name: 'Came back', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Week by week after the first mailbox" message={curve.error} span={12} />
      )}

      {/* Every week, not the first eight. The fold below the board slices this
          table because it is competing with five others for one screen; a panel
          opened by a finger has room for the quarter, and the weeks that get
          cut are exactly the ones somebody walked over to check. */}
      {curve.ok ? (
        <Tile label="The exact numbers" aside={`${RETENTION_WEEKS} weeks`} span={7}>
          {points.length === 0 ? (
            <p className="kiosk-empty">No cohort has aged into a full week yet.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="is-num">Eligible</th>
                  <th className="is-num">Came back</th>
                  <th className="is-num">Rate</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.week_index}>
                    <td>W{point.week_index}</td>
                    <td className="is-num">{formatCount(point.eligible)}</td>
                    <td className="is-num">{formatCount(point.retained)}</td>
                    <td className="is-num">{ratio(point.retained, point.eligible)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="The exact numbers" message={curve.error} span={7} />
      )}

      {/* The question in the panel's own title, answered in one number. The
          steepest fall is reported as a week PAIR rather than a single week,
          because “retention falls off at week 3” is ambiguous about whether
          week 3 is the last good one or the first bad one. */}
      {curve.ok ? (
        <Tile label="Where it falls off" aside="external accounts" span={5}>
          {points.length === 0 ? (
            <p className="kiosk-empty">No cohort has aged into a full week yet.</p>
          ) : (
            <>
              <BigNumber
                value={firstWeek ? ratio(firstWeek.retained, firstWeek.eligible) : NO_DATA}
                caption={
                  firstWeek
                    ? <>Came back in their first week, of <strong>{formatCount(firstWeek.eligible)}</strong> whose week has finished</>
                    : 'No workspace has finished its first week yet'
                }
              />
              <FactRow
                facts={[
                  { label: 'Steepest fall', value: drop ? `W${drop.from} to W${drop.to}` : NO_DATA },
                  { label: 'Last week anyone returned', value: lastReturn ? `W${lastReturn.week_index}` : 'none yet' },
                  { label: 'Weeks measured', value: points.length },
                ]}
              />
            </>
          )}
        </Tile>
      ) : (
        <TileError label="Where it falls off" message={curve.error} span={5} />
      )}

      {/* A DIFFERENT CLOCK AND A DIFFERENT POPULATION, which is why it is a
          separate tile and not another column above. These cohorts are by
          SIGNUP week, week 0 is the signup week itself, and the RPC applies no
          internal filter, so our own accounts are in here and are not in the
          curve. It earns its place anyway: the curve can only speak about
          workspaces that reached a mailbox, and the interesting failure is the
          cohort that signed up and never got that far. An empty cell is a week
          that has not started, printed as the empty marker rather than as a
          zero: a week nobody has lived through yet is not a week nobody
          returned in. */}
      {cohorts.ok ? (
        <Tile label="Signup cohorts, week by week" aside={`${RETENTION_WEEKS} weeks, ours included`} span={12}>
          {cohorts.data.length === 0 ? (
            <p className="kiosk-empty">Nobody has signed up in the last {RETENTION_WEEKS} weeks.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Signed up</th>
                  <th className="is-num">Size</th>
                  {COHORT_COLUMNS.map((index) => (
                    <th key={index} className="is-num">W{index}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohortGrid(cohorts.data).map((row) => (
                  <tr key={row.week}>
                    <td>{cohortLabel(row.week)}</td>
                    <td className="is-num">{formatCount(row.size)}</td>
                    {COHORT_COLUMNS.map((index) => {
                      const retained = row.weeks.get(index);
                      return (
                        <td key={index} className="is-num">
                          {retained === undefined ? NO_DATA : ratio(retained, row.size)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Signup cohorts, week by week" message={cohorts.error} span={12} />
      )}

      {/* The blunt version, for the weeks when the curve is three workspaces
          wide. These are counts of the whole base with no cohort arithmetic in
          them at all, so they cannot be swung by one workspace the way a weekly
          rate can. */}
      {life.ok ? (
        <Tile label="Retention without a curve" aside="all time" span={12} tone={life.data.one_and_done > life.data.active_28d ? 'warn' : 'default'}>
          <BarList
            rows={[
              { name: 'Ever reached a mailbox', count: life.data.value_activated, color: 'var(--kiosk-accent)' },
              { name: 'Active last 28d', count: life.data.active_28d, color: 'var(--kiosk-good)' },
              { name: 'Silent 14d+', count: life.data.at_risk, color: 'var(--kiosk-warn)' },
              { name: 'Tried once, never came back', count: life.data.one_and_done, color: 'var(--kiosk-bad)' },
            ]}
            emptyLabel="Nobody has reached a mailbox yet"
          />
        </Tile>
      ) : (
        <TileError label="Retention without a curve" message={life.error} span={12} />
      )}

      <p className="kiosk-detail-note">
        The curve is measured in WEEKS SINCE EACH WORKSPACE&rsquo;S OWN value activation, the first
        successful call that touched a mailbox, so the board&rsquo;s window ({windowLabel(days)}) does
        not move it and is not printed on it. A workspace only enters Eligible once its whole week
        has elapsed, which is why the last bar is never a half-lived week pretending to be a cliff,
        and why a workspace that reached its first mailbox yesterday is in none of these rows. The
        curve is external accounts only. The cohort grid below it is not: it is by signup week, it
        counts our own accounts, and it reads the activity log, which keeps 90 days, so twelve weeks
        is as far back as it can be asked without inventing zeros.
      </p>
    </>
  );
}

/* =============================================================== returning */

/**
 * Came back: who used it on more than one day.
 *
 * The board tile is a single count. What it cannot say, and what this panel is
 * for, is what the count is a share OF, and what the same population looks like
 * measured in sittings rather than in days.
 */
export async function ReturningDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const [bands, life] = await Promise.all([
    fetchEngagementBands(activity),
    fetchLifecycleCounts(),
  ]);

  const capped = isActivityCapped(days);
  const windowAside = capped ? '90d max' : windowShort(days);

  const dayBands = bands.ok ? bandRows(bands.data, 'active_days') : [];
  const sessionBands = bands.ok ? bandRows(bands.data, 'sessions') : [];
  const active = totalOf(dayBands);
  const returning = bands.ok ? returningWorkspaces(bands.data) : 0;
  const onceOnly = active - returning;

  return (
    <>
      {/* Tone is 'goal' rather than 'bad' at zero. Nobody coming back inside a
          short window is a target we have not hit yet, not a fault that has
          appeared, and a red tile on a wall means somebody should be doing
          something about it this morning. */}
      {bands.ok ? (
        <Tile label="Came back" aside={windowAside} span={4} tone={returning > 0 ? 'good' : 'goal'}>
          <BigNumber
            value={returning}
            caption="Workspaces active on two or more separate days"
          />
          <FactRow
            facts={[
              { label: 'Workspaces active', value: active },
              { label: 'One day only', value: onceOnly },
              { label: 'Of those active', value: ratio(returning, active) },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Came back" message={bands.error} span={4} />
      )}

      {/* The same population split rather than summarised. “Came back” is every
          band except the first, so showing the bands is showing the working:
          three of the four bars ARE the headline, and how the returners split
          between two days and eight is the difference between a product people
          remember and one they use. */}
      {bands.ok ? (
        <Tile label="How the returners split" aside={windowAside} span={8}>
          <BarList
            rows={dayBands.map((row) => ({
              name: `${row.band} ${row.band === '1' ? 'day' : 'days'}`,
              count: row.workspaces,
              color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-good)',
            }))}
            emptyLabel="No workspace made a successful call in this window"
          />
        </Tile>
      ) : (
        <TileError label="How the returners split" message={bands.error} span={8} />
      )}

      {/* Coming back on another DAY and coming back in another SITTING are two
          different claims, and the second is much weaker: a sitting is a gap of
          30 minutes, so two sittings can both be this afternoon. This tile
          exists so the stronger number on the left is never read as if it were
          the weaker one. */}
      {bands.ok ? (
        <Tile label="More than one sitting" aside={windowAside} span={6}>
          <BigNumber
            value={notOnce(sessionBands)}
            caption="Workspaces with two or more sittings, 30 minutes apart"
          />
          <BarList
            rows={sessionBands.map((row) => ({
              name: `${row.band} ${row.band === '1' ? 'sitting' : 'sittings'}`,
              count: row.workspaces,
              color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-accent)',
            }))}
            emptyLabel="No workspace made a successful call in this window"
          />
        </Tile>
      ) : (
        <TileError label="More than one sitting" message={bands.error} span={6} />
      )}

      {/* The all-time counterpart, and the reason the panel does not end at the
          headline. “One day only” on the left is a fact about this window: a
          loyal workspace that happened to be on holiday lands in it. "Tried
          once, never came back" below is a fact about the whole life of the
          account, and it is the one that should worry somebody. */}
      {life.ok ? (
        <Tile
          label="The same question, all time"
          aside="all time"
          span={6}
          tone={life.data.one_and_done > life.data.active_28d ? 'warn' : 'default'}
        >
          <BarList
            rows={[
              { name: 'Active last 7d', count: life.data.active_7d, color: 'var(--kiosk-good)' },
              { name: 'Active last 28d', count: life.data.active_28d, color: 'var(--kiosk-accent)' },
              { name: 'Silent 14d+', count: life.data.at_risk, color: 'var(--kiosk-warn)' },
              { name: 'Tried once, never came back', count: life.data.one_and_done, color: 'var(--kiosk-bad)' },
            ]}
            emptyLabel="Nobody has reached a mailbox yet"
          />
          <FactRow facts={[{ label: 'Ever reached a mailbox', value: life.data.value_activated }]} />
        </Tile>
      ) : (
        <TileError label="The same question, all time" message={life.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        &ldquo;Came back&rdquo; counts WORKSPACES with a successful call on two or more separate UTC
        days inside this window, which is not the same as loyal customers: our own accounts are in
        it, a workspace can be one person or five, and a day that straddles midnight in Bergen is two
        days here. It is also not a cohort measure. Somebody who signed up two months ago and
        somebody who signed up on Monday are counted the same way, so a short window flatters nobody
        and a long one flatters the old accounts. The all-time tile is the only thing on this panel
        that survives the window changing.
        {capped
          ? ' The banded numbers come from the activity log, which keeps 90 days, so a wider window would add workspaces without adding the days they were active.'
          : ''}
      </p>
    </>
  );
}

/* ================================================================= clients */

/**
 * MCP client on first success: what people connect from.
 *
 * The board tile shows the top six all-time. The panel keeps the whole list and
 * adds the question the list itself cannot answer: whether the client somebody
 * arrived on has anything to do with whether they are still here.
 */
export async function ClientsDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const [clients, life, roster] = await Promise.all([
    fetchClientMix(),
    fetchLifecycleCounts(),
    fetchActiveWorkspaces(activity),
  ]);

  const mix = clients.ok ? [...clients.data].sort((a, b) => b.workspaces - a.workspaces) : [];
  const recorded = sumBy(mix, (row) => row.workspaces);
  const top = mix[0] ?? null;
  // Folded once, before the markup, rather than per table row: the roster is
  // the largest thing either query returns and a lookup built inside the map
  // would rebuild it for every client on the panel.
  const stillActive = roster.ok ? activeByClient(roster.data) : new Map<string, number>();

  return (
    <>
      {/* The whole list, not the top six. The tail is the point of opening the
          panel: a client with two workspaces is either noise or the first sign
          of a directory listing that started working, and the board has no room
          to let anyone tell the difference. */}
      {clients.ok ? (
        <Tile label="Client on first success" aside="all time" span={7}>
          <BarList
            rows={mix.map((row) => ({ name: clientLabel(row.client), count: row.workspaces }))}
            emptyLabel="No workspace has made a successful call yet"
          />
        </Tile>
      ) : (
        <TileError label="Client on first success" message={clients.error} span={7} />
      )}

      {/* THE COUNTS HERE DO NOT TOTAL THE ESTATE and the facts say so out loud.
          A client is recorded on the first SUCCESSFUL tool call, so every
          workspace that signed up and never got a call through is missing from
          every bar on this panel. Presented as a share of signups it would read
          as a mix; presented against the mailbox count it reads as what it is. */}
      {clients.ok && life.ok ? (
        <Tile label="What the mix is made of" aside="all time" span={5}>
          <BigNumber
            value={mix.length}
            caption={mix.length === 1 ? 'Distinct client, ever' : 'Distinct clients, ever'}
          />
          <FactRow
            facts={[
              { label: 'Workspaces with a client', value: recorded },
              { label: 'Ever reached a mailbox', value: life.data.value_activated },
              { label: 'Biggest share', value: top ? ratio(top.workspaces, recorded) : NO_DATA },
            ]}
          />
        </Tile>
      ) : (
        <TileError
          label="What the mix is made of"
          message={clients.ok ? (life.ok ? 'unavailable' : life.error) : clients.error}
          span={5}
        />
      )}

      {/* WHICH STARTING CLIENT STAYS, and the column heading has to be read
          carefully, which is why the note repeats it. Both sides of this table
          key on the FIRST client a workspace ever succeeded with; we do not
          record what it is connecting from today. So the last column is "of the
          workspaces that started here, how many are still active", not "how
          many still use this client". The share is also the one number on the
          panel that moves with the board's window, so the column says which
          window it was counted over. */}
      {clients.ok && roster.ok ? (
        <Tile label="Which starting client stays" aside={isActivityCapped(days) ? '90d max' : windowShort(days)} span={12}>
          {mix.length === 0 ? (
            <p className="kiosk-empty">No workspace has made a successful call yet.</p>
          ) : (
            <>
              <table className="kiosk-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="is-num">Started here</th>
                    <th className="is-num">Active in window</th>
                    <th className="is-num">Of theirs</th>
                  </tr>
                </thead>
                <tbody>
                  {mix.map((row) => {
                    const active = stillActive.get(row.client) ?? 0;
                    return (
                      <tr key={row.client}>
                        <td>{clientLabel(row.client)}</td>
                        <td className="is-num">{formatCount(row.workspaces)}</td>
                        <td className="is-num">{formatCount(active)}</td>
                        <td className="is-num">{ratio(active, row.workspaces)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <FactRow
                facts={[
                  { label: 'Active in window', value: roster.data.length },
                  { label: 'Active, no client recorded', value: unmatchedActive(roster.data, mix.map((row) => row.client)) },
                ]}
              />
            </>
          )}
        </Tile>
      ) : (
        <TileError
          label="Which starting client stays"
          message={clients.ok ? (roster.ok ? 'unavailable' : roster.error) : clients.error}
          span={12}
        />
      )}

      <p className="kiosk-detail-note">
        This is the client a workspace made its FIRST successful call from, not the one it uses now:
        nothing here tracks a switch from one client to another, so a row falling is a statement
        about arrivals, never about people leaving a client. The counts do not add up to signups
        either, because a workspace that never got a call through has no client recorded at all. The
        last column divides an all-time count of arrivals by activity in the last
        {' '}{windowLabel(activity)}, so it is a floor on how well a client retains rather than a
        retention rate. Aggregates only: the roster it is computed from carries account identity and
        is reduced to counts here before anything is drawn.
      </p>
    </>
  );
}

/* ================================================================ helpers */

/** One metric out of the engagement RPC, which always returns both. */
function bandRows(rows: GrowthEngagementBandRow[], metric: 'active_days' | 'sessions') {
  return rows.filter((row) => row.metric === metric);
}

function totalOf(rows: GrowthEngagementBandRow[]): number {
  return rows.reduce((total, row) => total + row.workspaces, 0);
}

/**
 * Everything except the first band.
 *
 * The sessions twin of `returningWorkspaces` in shared.ts, and it matches the
 * same way, on “not '1'” rather than on the three band literals. The literals
 * carry en dashes; a hyphen typed here instead would silently count nobody.
 */
function notOnce(rows: GrowthEngagementBandRow[]): number {
  return rows.filter((row) => row.band !== '1').reduce((total, row) => total + row.workspaces, 0);
}

/**
 * The biggest week-to-week fall in the retention rate, as a pair of weeks.
 *
 * Weeks with nobody eligible are skipped rather than treated as a fall to zero:
 * an empty week is a week the cohorts have not aged into, and letting it count
 * would make “where it falls off” point at the end of the curve every time.
 */
function steepestDrop(points: { week_index: number; eligible: number; retained: number }[]) {
  const rates = points
    .filter((point) => point.eligible > 0)
    .map((point) => ({ week: point.week_index, rate: point.retained / point.eligible }));
  let worst: { from: number; to: number; fall: number } | null = null;
  for (let index = 1; index < rates.length; index += 1) {
    const fall = rates[index - 1].rate - rates[index].rate;
    if (fall > 0 && (!worst || fall > worst.fall)) {
      worst = { from: rates[index - 1].week, to: rates[index].week, fall };
    }
  }
  return worst;
}

/**
 * Cohort cells folded into one row per signup week, newest first.
 *
 * Newest first because the recent cohorts are the ones anything can still be
 * done about, and because the old ones are the ones the 90 day activity purge
 * hollows out: putting them at the top would open the table on its least
 * trustworthy rows.
 */
function cohortGrid(cells: GrowthCohortCellRow[]) {
  const byCohort = new Map<string, { size: number; weeks: Map<number, number> }>();
  for (const cell of cells) {
    const key = cell.cohort_week.slice(0, 10);
    const entry = byCohort.get(key) ?? { size: cell.cohort_size, weeks: new Map<number, number>() };
    entry.size = cell.cohort_size;
    entry.weeks.set(cell.week_index, cell.retained);
    byCohort.set(key, entry);
  }
  return [...byCohort.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, COHORT_ROWS)
    .map(([week, entry]) => ({ week, size: entry.size, weeks: entry.weeks }));
}

const COHORT_WEEK_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** A `YYYY-MM-DD` Monday as a person would say it. */
function cohortLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? dayKey : COHORT_WEEK_LABEL.format(date);
}

/**
 * Active workspaces counted by the client they first succeeded with.
 *
 * The roster is the one reporting row on the page that carries a workspace name
 * and an owner address. It is reduced to a count per client here, in the server
 * component, and nothing but the count reaches the markup: this board hangs on
 * a wall in a room with other people in it.
 */
function activeByClient(rows: GrowthActiveWorkspaceRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.client, (counts.get(row.client) ?? 0) + 1);
  }
  return counts;
}

/**
 * Active workspaces whose client is not one of the all-time mix rows.
 *
 * The RPC coalesces a missing client to 'unknown' on the roster and omits it
 * entirely from the mix, so those workspaces would otherwise vanish between the
 * table and the total beside it. A number that does not add up is fine on a
 * wall; a number that does not add up and does not say so is not.
 */
function unmatchedActive(rows: GrowthActiveWorkspaceRow[], known: string[]): number {
  const set = new Set(known);
  return rows.filter((row) => !set.has(row.client)).length;
}

/** A raw client id as a person would say it. Empty and 'unknown' read alike. */
function clientLabel(client: string): string {
  const value = client.trim();
  if (!value || value.toLowerCase() === 'unknown') return 'Unknown';
  return value;
}
