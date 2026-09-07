/**
 * The four panels behind the acquisition tiles: who arrives, where from, how
 * far they get, and who is left to sell to.
 *
 * The pattern is the one written out in full at the top of audience.tsx: one
 * `Promise.all` per panel so it paints once, a `TileError` rather than a zero
 * whenever a query does not answer, windows clamped where the data is clamped,
 * and aggregates only because this screen hangs on a wall in a room with other
 * people in it.
 *
 * WHAT THE FOUR ARE FOR, in one line each, because the board deliberately shows
 * only the headline of each and the question that follows a glance is always
 * "compared to what":
 *
 *   SignupsDetail    the arrivals themselves: how many, which weeks, which days
 *   ChannelsDetail   first touch, and what each channel did afterwards
 *   ActivationDetail every rung between a signup and a mailbox, not just three
 *   ConvertDetail    the free population, and which part of it can ever pay
 *
 * TWO SOURCES, AND THE SEAM BETWEEN THEM, since it decides every window on this
 * page. Signups, attribution, the onboarding ladder and the plan counts all come
 * from durable columns (`users.created_at`, `workspaces.acquisition_source`, the
 * `onboarding_*_at` timestamps, `user_billing`), so the whole window is honest
 * however far back the switch is turned. Anything counted out of `activity_log`
 * has nothing older than 90 days to return, because a pg_cron job deletes it,
 * and any tile that leans on it says so.
 */

import {
  fetchAcquisitionChannels,
  fetchActivationFunnel,
  fetchInboxDistribution,
  fetchOAuthAbandonment,
  fetchPeopleCounts,
  fetchProviderFunnel,
  fetchRevenueCounts,
  fetchUserSignupDays,
  fetchUtilizationBands,
} from '@/lib/analytics/growth-queries';
import type {
  GrowthActivationFunnelRow,
  GrowthUserSignupDayRow,
} from '@/lib/analytics/growth-types';
import { formatCount, ratio } from '../../charts';
import {
  BarList,
  BigNumber,
  FactRow,
  FunnelSteps,
  GroupedColumns,
  Tile,
  TileError,
} from '../primitives';
import {
  CHART_WEEKS,
  FUNNEL_DAYS,
  prettyChannel,
  prettyProvider,
  signupWeeks,
  sum,
  trend,
} from '../shared';
import { isActivityCapped, windowShort } from '../windows';
import type { KioskDetailProps } from './registry';

/* ===================================================================== who */

/**
 * The panel behind "Signed up".
 *
 * The tile says a cumulative total with the window's arrivals under it. The
 * two questions that follow are "is that a good few weeks" and "when do people
 * actually turn up", so this panel is the run of weeks, the window's own count
 * against the window before it, and the day-of-week shape.
 *
 * WHY THE SERIES IS ASKED FOR MORE DAYS THAN THE WINDOW. Two reasons, and both
 * would be a lie if done the other way. The chart is eight CALENDAR weeks by
 * definition, so on a 7 day window it would otherwise be a single bar labelled
 * as eight weeks of history. And a trend needs the window before this one to
 * compare against: taking the extra days here means the comparison is computed
 * from the same gapless daily series as the headline rather than from a second
 * RPC with its own clamp. Where the series is not long enough to hold two whole
 * windows (90 days and up), the trend is dropped rather than computed against a
 * short stretch, which would read as a collapse that never happened.
 *
 * NOTHING HERE IS CLAMPED AT 90 DAYS. `growth_user_signup_days` reads
 * `users.created_at` and `onboarding_value_activated_at`, neither of which is
 * purged, so "All" really is all.
 */
export async function SignupsDetail({ days }: KioskDetailProps) {
  const seriesDays = Math.max(days, CHART_WEEKS * 7);
  const [people, series] = await Promise.all([
    fetchPeopleCounts(days),
    fetchUserSignupDays(seriesDays),
  ]);

  const rows = series.ok ? series.data : [];
  // The series is gapless by construction (a quiet day is a zero, not a missing
  // row), so the last `days` entries are exactly the window and the `days`
  // before those are exactly the window before it. That is only true because it
  // is gapless; on a sparse series this slice would silently widen.
  const windowRows = rows.slice(-days);
  const priorRows = rows.length >= days * 2 ? rows.slice(-days * 2, -days) : null;
  const arrived = sum(windowRows, 'new_users');
  const reached = sum(windowRows, 'activated_users');
  const quietDays = windowRows.filter((row) => row.new_users === 0).length;
  const busiest = windowRows.reduce((best, row) => Math.max(best, row.new_users), 0);

  return (
    <>
      {people.ok ? (
        <Tile label="Signed up, all time" aside="people" span={4} tone="good">
          <BigNumber
            value={people.data.total_users}
            caption={
              <>
                <strong>{formatCount(people.data.activated_users)}</strong> have reached a mailbox
              </>
            }
          />
          {/* Every fact here is all-time or a fixed 7 days, on purpose.
              `growth_people_counts` clamps its own `p_days` at 45 (it looks
              back twice, and the second look would land in purged activity),
              so a windowed figure from this RPC beside an "All" switch would
              be a 45 day number wearing a 400 day label. */}
          <FactRow
            facts={[
              { label: 'Reached a mailbox', value: ratio(people.data.activated_users, people.data.total_users) },
              { label: 'Active, last 7d', value: people.data.active_users_7d },
              { label: 'Ours, excluded', value: people.data.internal_users },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Signed up, all time" message={people.error} span={4} />
      )}

      {series.ok ? (
        <Tile label="Arrivals week by week" aside={`${CHART_WEEKS} calendar weeks`} span={8}>
          {rows.length === 0 ? (
            <p className="kiosk-empty">Nobody has signed up yet.</p>
          ) : (
            <GroupedColumns
              buckets={signupWeeks(rows)}
              series={[
                { name: 'Signed up', color: 'var(--kiosk-accent)' },
                { name: 'Reached a mailbox', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Arrivals week by week" message={series.error} span={8} />
      )}

      {series.ok ? (
        <Tile label="Arrivals in the window" aside={windowShort(days)} span={6}>
          <BigNumber
            value={arrived}
            trend={priorRows ? trend(arrived, sum(priorRows, 'new_users'), 'up') : null}
            caption={
              priorRows ? (
                <>
                  Previous {days} days: <strong>{formatCount(sum(priorRows, 'new_users'))}</strong>
                </>
              ) : (
                <>No earlier window of the same length to compare against</>
              )
            }
            spark={windowRows.map((row) => row.new_users)}
          />
          <FactRow
            facts={[
              { label: 'Busiest day', value: busiest },
              { label: 'Days with nobody', value: quietDays },
              { label: 'First mailbox reached', value: reached },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Arrivals in the window" message={series.error} span={6} />
      )}

      {series.ok ? (
        <Tile label="Which day they arrive" aside={`${windowShort(days)}, UTC`} span={6}>
          <BarList
            rows={weekdayRows(windowRows)}
            emptyLabel="Nobody signed up in this window"
          />
        </Tile>
      ) : (
        <TileError label="Which day they arrive" message={series.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        These count PEOPLE, not workspaces, and our own accounts are excluded from every number on
        this panel. The green series is not the same cohort as the blue one: it counts people whose
        FIRST mailbox operation fell in that week, whenever they signed up, so a week can show more
        activations than arrivals and that is a good week rather than a broken chart. Days are UTC,
        so a Friday evening signup in California lands on Saturday. The current week is drawn hollow
        because it is not over.
      </p>
    </>
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Arrivals by UTC weekday, Monday first and all seven rows always present.
 *
 * Empty days are kept rather than dropped: "nobody has ever signed up on a
 * Sunday" is the finding, and a list that quietly omits Sunday looks like a
 * list that has not got round to it yet. Monday first for the same reason
 * `mondayOf` exists in shared.ts: every other week boundary on this board is an
 * ISO one, and a chart that started on Sunday would disagree with the one
 * directly above it.
 */
function weekdayRows(rows: GrowthUserSignupDayRow[]): { name: string; count: number }[] {
  const counts = new Array<number>(7).fill(0);
  for (const row of rows) {
    const date = new Date(`${row.day.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    counts[(date.getUTCDay() + 6) % 7] += row.new_users;
  }
  return WEEKDAYS.map((name, index) => ({ name, count: counts[index] }));
}

/* ================================================================== where */

/**
 * The panel behind "Where they come from".
 *
 * ATTRIBUTION ONLY EXISTS FROM 2026-08-05 and lands null on a share of signups,
 * so "Unknown" is a row here rather than a silent omission: the rows have to sum
 * to the signup count or they will eventually be read as if they did. It is
 * greyed everywhere it appears, because it is a gap in our own measurement and
 * not a channel, and on a bar chart the biggest bar is the winner unless it is
 * visibly painted as not being one.
 *
 * ONE RPC, ONE ERROR TILE. Every tile below is a different cut of the same
 * `growth_acquisition_channels` call, so four separate TileErrors would report
 * one failed query four times and imply four broken things. The panel says it
 * once, full width, and keeps the note under it so the reader still learns what
 * the missing numbers would have meant.
 *
 * THE WINDOW IS THE FULL ONE, WITH ONE EXCEPTION SPELLED OUT. Signups,
 * activation and paying all come from durable workspace columns, so a 400 day
 * cohort is a real 400 day cohort. The "came back" column is the exception: it
 * counts distinct active days out of `activity_log`, which is purged at 90, so
 * for an older cohort it is a floor rather than a count. It is kept because
 * knowing which channel sends people who return is the whole reason to look at
 * a channel table, and the shortfall is named in the note rather than hidden by
 * shrinking everyone else's window to match.
 */
export async function ChannelsDetail({ days }: KioskDetailProps) {
  const channels = await fetchAcquisitionChannels(days);

  if (!channels.ok) {
    return (
      <>
        <TileError label="Where they come from" message={channels.error} span={12} />
        <p className="kiosk-detail-note">
          Every tile on this panel is a cut of the same first-touch attribution query, so one
          failure takes all of them. Nothing here is zero; it is unknown.
        </p>
      </>
    );
  }

  const ranked = channels.data.slice().sort((a, b) => b.signups - a.signups);
  const total = ranked.reduce((count, row) => count + row.signups, 0);
  const unknown = ranked.find((row) => row.source === 'unattributed')?.signups ?? 0;
  const named = ranked.filter((row) => row.source !== 'unattributed');
  const attributed = total - unknown;

  return (
    <>
      <Tile
        label="Signups we can attribute"
        aside={windowShort(days)}
        span={4}
        tone={attributed > unknown ? 'good' : 'warn'}
      >
        <BigNumber
          value={attributed}
          caption={
            <>
              <strong>{ratio(attributed, total)}</strong> covered by first-touch attribution
            </>
          }
        />
        <FactRow
          facts={[
            { label: 'No first touch', value: unknown },
            { label: 'Named channels', value: named.length },
            { label: 'Workspaces in window', value: total },
          ]}
        />
      </Tile>

      <Tile label="First touch, by channel" aside={windowShort(days)} span={8}>
        <BarList
          rows={ranked.slice(0, 8).map((row) => ({
            name: prettyChannel(row.source),
            count: row.signups,
            color: row.source === 'unattributed' ? 'var(--fg-4)' : undefined,
          }))}
          emptyLabel="No workspace was created in this window"
        />
      </Tile>

      {/* A table rather than four more bar lists. The interesting comparison
          here is ACROSS a row (did this channel's signups get anywhere) and not
          down a column, and four aligned columns are the only shape that lets
          someone standing at the glass read a row left to right. */}
      <Tile label="What each channel did next" aside={`${windowShort(days)} cohort`} span={7}>
        {ranked.length === 0 ? (
          <p className="kiosk-empty">No workspace was created in this window.</p>
        ) : (
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="is-num">Signups</th>
                <th className="is-num">Mailbox</th>
                <th className="is-num">Came back</th>
                <th className="is-num">Paying</th>
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 9).map((row) => (
                <tr key={row.source}>
                  <td>{prettyChannel(row.source)}</td>
                  <td className="is-num">{formatCount(row.signups)}</td>
                  {/* Counts, not rates, in the body. `ratio` already refuses to
                      print a percentage below a denominator of ten, and at this
                      volume nearly every row is below ten: a column of "2 of 5"
                      strings is wider and says less than the two numbers it is
                      derived from, which are both already on the row. */}
                  <td className="is-num">{formatCount(row.activated)}</td>
                  <td className="is-num">{formatCount(row.returned)}</td>
                  <td className="is-num">{formatCount(row.paying)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tile>

      {/* Paying on its own, and named channels only. An "Unknown" bar winning
          this chart would be the single most useless true statement the board
          can make: the point of the tile is which channel to spend the next
          week on, and "we do not know" is not somewhere to spend a week. */}
      <Tile label="Paying customers by channel" aside={`${windowShort(days)} cohort`} span={5}>
        <BarList
          rows={named
            .filter((row) => row.paying > 0)
            .map((row) => ({ name: prettyChannel(row.source), count: row.paying, color: 'var(--kiosk-good)' }))}
          emptyLabel="No attributed channel has produced a paying customer in this window"
        />
      </Tile>

      <p className="kiosk-detail-note">
        First touch, recorded when the workspace was created, so a person who found us on Reddit and
        signed up a fortnight later from a bookmark counts as Reddit and not as Direct. Attribution
        only exists from 2026-08-05, which is why &quot;Unknown&quot; is large and why it is greyed rather than
        dropped: the rows sum to the signup count. These count WORKSPACES, including ours, unlike the
        people counts on the signups panel.
        {isActivityCapped(days)
          ? ' "Came back" is counted from the activity log, which is deleted past 90 days, so for a window this long it is a floor and not a count.'
          : ''}
      </p>
    </>
  );
}

/* ============================================================== how far */

/** Onboarding stage ids as a person would say them, in funnel order. */
const STAGE_LABELS: Record<string, string> = {
  signup: 'Created a workspace',
  client_selected: 'Picked an MCP client',
  inbox_connected: 'Connected an inbox',
  connection_verified: 'Connection verified',
  credential_issued: 'Took an API key',
  technical_activation: 'Made a first call',
  value_activation: 'Used their mailbox',
};

/**
 * The panel behind "Road to a paying customer".
 *
 * THE BOARD SHOWS THREE RUNGS OF THIS AND THE PANEL SHOWS ALL SEVEN. That is
 * the whole reason it is tappable. `milestoneSteps` in shared.ts collapses the
 * ladder to signup, inbox connected, mailbox used, and then continues past it
 * into the money, which is the right shape for a tile read from a doorway. It
 * also hides the four rungs where onboarding actually fails: picking a client,
 * verifying the connection, taking a key, and making the first call. Those are
 * the ones somebody can fix, so this panel draws the funnel unabridged and
 * puts the biggest single drop beside it.
 *
 * ALL TIME, NOT THE BOARD'S WINDOW. The ladder reads `workspaces.created_at`
 * and the durable `onboarding_*_at` columns, so `FUNNEL_DAYS` (400, longer than
 * the product has existed) really is every account. A windowed version would be
 * worse than useless here: a workspace created yesterday has not failed to
 * activate, it has not finished arriving.
 *
 * THE SERIES CANNOT GO UP, BY CONSTRUCTION. Several onboarding timestamps were
 * backfilled in migration 20260805010000 and can set a late stage on a workspace
 * with no timestamp for an earlier one, so the RPC counts each stage as "reached
 * this stage OR any later one". That over-counts the early rungs slightly rather
 * than drawing an impossible funnel, and it means a rung is a ceiling on the one
 * below it and not an independent measurement.
 */
export async function ActivationDetail({ days }: KioskDetailProps) {
  const [funnel, providers, oauth] = await Promise.all([
    fetchActivationFunnel(FUNNEL_DAYS),
    fetchProviderFunnel(FUNNEL_DAYS),
    fetchOAuthAbandonment(),
  ]);

  const steps = funnel.ok ? [...funnel.data].sort((a, b) => a.stage_index - b.stage_index) : [];
  const drops = dropOffRows(steps);

  return (
    <>
      {funnel.ok ? (
        <Tile label="Every rung" aside="workspaces, all time" span={6}>
          {steps.length === 0 ? (
            <p className="kiosk-empty">No workspace has been created yet.</p>
          ) : (
            <FunnelSteps
              steps={steps.map((step, index) => ({
                label: STAGE_LABELS[step.stage] ?? step.stage,
                value: step.workspaces,
                // The share of the rung ABOVE, not of the top of the funnel.
                // Against the top, every rung after the second reads as a
                // disaster and the one step that is actually leaking is
                // indistinguishable from the four that are fine.
                note: index === 0 ? 'everyone' : `${ratio(step.workspaces, steps[index - 1].workspaces)} from the rung above`,
              }))}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Every rung" message={funnel.error} span={6} />
      )}

      {funnel.ok ? (
        <Tile
          label="Where it narrows"
          aside="workspaces lost at each step"
          span={6}
          // Amber only when there is actually a loss to look at. A tile painted
          // as a warning over an empty list is the board crying wolf, and this
          // one is next to a funnel that would already be showing the problem.
          tone={drops.length > 0 ? 'warn' : 'default'}
        >
          {/* The losses, drawn as their own list rather than left to be worked
              out from the funnel beside it. Subtraction across seven rows is
              exactly the arithmetic nobody does while standing up, and the
              largest gap is the only number on this panel that names what to
              work on next. */}
          <BarList rows={drops} emptyLabel="Nobody has dropped out yet" color="var(--kiosk-bad)" />
        </Tile>
      ) : (
        <TileError label="Where it narrows" message={funnel.error} span={6} />
      )}

      {providers.ok ? (
        <Tile label="Connecting an inbox, by provider" aside="all time" span={7}>
          {providers.data.length === 0 ? (
            <p className="kiosk-empty">No connection has been attempted yet.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="is-num">Tried</th>
                  <th className="is-num">Connected</th>
                  <th>Most common failure</th>
                </tr>
              </thead>
              <tbody>
                {providers.data
                  .slice()
                  .sort((a, b) => b.workspaces_attempted - a.workspaces_attempted)
                  .slice(0, 8)
                  .map((row) => (
                    <tr key={row.provider}>
                      <td>{prettyProvider(row.provider)}</td>
                      {/* The deduplicated workspace counts, not the raw attempt
                          counts on the same row. One person retrying a bad
                          password nine times is nine attempts and one workspace
                          that could not connect, and only the second of those
                          is a drop-off. */}
                      <td className="is-num">{formatCount(row.workspaces_attempted)}</td>
                      <td className="is-num">{formatCount(row.workspaces_connected)}</td>
                      <td>{row.top_error ?? 'none'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Connecting an inbox, by provider" message={providers.error} span={7} />
      )}

      {oauth.ok ? (
        <Tile
          label="Consent screens never returned from"
          aside="all time"
          span={5}
          tone={oauth.data.some((row) => row.abandoned > 0) ? 'warn' : 'default'}
        >
          {oauth.data.length === 0 ? (
            <p className="kiosk-empty">No OAuth consent has been started yet.</p>
          ) : (
            /* This leak leaves NO funnel event at all, which is why it is
               measured separately and why it belongs on this panel: a person
               who bounced off Google's consent screen never reached the
               "connected an inbox" rung and never failed a rung either, so the
               ladder above simply cannot see them. */
            <GroupedColumns
              buckets={oauth.data
                .slice()
                .sort((a, b) => b.abandoned - a.abandoned)
                .slice(0, 4)
                .map((row) => ({
                  label: prettyProvider(row.provider),
                  values: [row.connected, row.abandoned],
                }))}
              series={[
                { name: 'Came back connected', color: 'var(--kiosk-good)' },
                { name: 'Never came back', color: 'var(--kiosk-bad)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Consent screens never returned from" message={oauth.error} span={5} />
      )}

      <p className="kiosk-detail-note">
        Every number here counts WORKSPACES over all time, our own accounts included, so the top rung
        will not match the &quot;Signed up&quot; tile: that one counts external people. The board&rsquo;s window
        switch ({windowShort(days)}) is deliberately ignored on this panel, because a workspace
        created this morning has not failed to activate. A rung is a ceiling on the one below it
        rather than an independent count (stages are recorded as &quot;reached this or any later stage&quot; to
        survive a 2026-08 backfill), so a small gap between two rungs can be a timestamp that was
        never written rather than a person who never got there. Abandoned consents are surviving
        `oauth_states` rows: a floor, since anyone who consented and failed afterwards is counted as
        having come back.
      </p>
    </>
  );
}

/**
 * The rungs written as the thing that did not happen, for the drop-off list.
 *
 * A second table rather than lower-casing `STAGE_LABELS`, because the obvious
 * shortcut turns "Picked an MCP client" into "picked an mcp client". These are
 * also better sentences: what a loss row has to say is what those people never
 * did, not which pair of rungs the gap sits between.
 */
const NEVER_LABELS: Record<string, string> = {
  client_selected: 'Never picked a client',
  inbox_connected: 'Never connected an inbox',
  connection_verified: 'Connection never verified',
  credential_issued: 'Never took an API key',
  technical_activation: 'Never made a call',
  value_activation: 'Never touched a mailbox',
};

/**
 * The loss at each step, largest first.
 *
 * Steps with no loss are dropped: a row of zeroes on a chart about where people
 * are lost is noise stacked on top of the one row that matters. An empty list
 * is therefore a real answer ("nobody has dropped out yet") and not a gap.
 */
function dropOffRows(steps: GrowthActivationFunnelRow[]): { name: string; count: number }[] {
  const rows: { name: string; count: number }[] = [];
  for (let index = 1; index < steps.length; index += 1) {
    const lost = steps[index - 1].workspaces - steps[index].workspaces;
    if (lost <= 0) continue;
    rows.push({
      name: NEVER_LABELS[steps[index].stage] ?? `Never reached ${steps[index].stage}`,
      count: lost,
    });
  }
  return rows.sort((a, b) => b.count - a.count);
}

/* ================================================================ who is left */

/**
 * The panel behind "Still to convert".
 *
 * The tile is one number, the count of free workspaces, and read on its own it
 * invites exactly the wrong conclusion: that there are two hundred-odd people
 * one good email away from paying. Most of that population cannot be charged at
 * all. Some hold the permanent grandfather from the 2026-08-19 repricing and
 * keep unlimited inboxes free forever; some are comped; some have never
 * connected anything and so have never met the paywall. This panel splits the
 * number into those populations, because a conversion rate computed against a
 * population that cannot convert is the most flattering wrong number the board
 * could show.
 *
 * NO WINDOW, ON PURPOSE. A free workspace is free now, whenever it was created:
 * this is a snapshot of live rows, not a cohort, and the header says so.
 */
export async function ConvertDetail({ days }: KioskDetailProps) {
  const [counts, inboxes, utilisation] = await Promise.all([
    fetchRevenueCounts(),
    fetchInboxDistribution(),
    fetchUtilizationBands(),
  ]);

  const bands = inboxes.ok ? [...inboxes.data].sort((a, b) => a.band_index - b.band_index) : [];
  // Exempt workspaces holding more than the free single inbox: revenue that was
  // given away permanently and by decision, not lost. It is separated out so
  // nobody counts it twice, once as an opportunity here and once as churn risk
  // somewhere else.
  const exemptOverFree = bands
    .filter((band) => band.band_index >= 2)
    .reduce((total, band) => total + band.exempt, 0);
  const atCeiling = bands.find((band) => band.band_index === 1)?.capped ?? 0;
  const neverConnected = bands.find((band) => band.band_index === 0)?.capped ?? 0;

  return (
    <>
      {counts.ok ? (
        <Tile label="Free workspaces" aside="live rows" span={4}>
          <BigNumber
            value={counts.data.free_workspaces}
            caption={
              <>
                <strong>{formatCount(counts.data.paying_workspaces)}</strong> already pay
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Comped', value: counts.data.comped_workspaces },
              { label: 'Ours', value: counts.data.internal_workspaces },
              { label: 'Paying owners', value: counts.data.paying_owners },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Free workspaces" message={counts.error} span={4} />
      )}

      {inboxes.ok ? (
        <Tile label="Inboxes held, by population" aside="live workspaces" span={8}>
          {bands.length === 0 ? (
            <p className="kiosk-empty">No live workspace to classify.</p>
          ) : (
            /* Three series over the same histogram rather than one merged bar
               per band. Merged, "97% of workspaces are on Free" reads as demand
               for a paid plan, when most of that bar is a grandfather clause
               that can never be charged. The populations are priced completely
               differently and so they are drawn apart. */
            <GroupedColumns
              buckets={bands.map((band) => ({
                label: band.band,
                values: [band.capped, band.exempt, band.paid],
              }))}
              series={[
                { name: 'Free, the cap applies', color: 'var(--kiosk-accent)' },
                { name: 'Free, exempt forever', color: 'var(--fg-4)' },
                { name: 'Paid', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Inboxes held, by population" message={inboxes.error} span={8} />
      )}

      {inboxes.ok ? (
        <Tile label="Who the paywall can actually reach" aside="live workspaces" span={6}>
          {/* The three rows are kept even at zero, unlike the drop-off list on
              the activation panel. There, an empty row is noise; here, "nobody
              is at the ceiling" is the finding, and a row that disappears when
              it reaches zero is a row nobody notices reaching zero. */}
          {bands.length === 0 ? (
            <p className="kiosk-empty">No live workspace to classify.</p>
          ) : (
            <BarList
              rows={[
                { name: 'At the free ceiling: 1 inbox', count: atCeiling, color: 'var(--kiosk-warn)' },
                { name: 'Free, never connected anything', count: neverConnected, color: 'var(--kiosk-accent)' },
                { name: 'Exempt, already over the free cap', count: exemptOverFree, color: 'var(--fg-4)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Who the paywall can actually reach" message={inboxes.error} span={6} />
      )}

      {utilisation.ok ? (
        <Tile label="Action allowance used" aside="this billing period" span={6}>
          <BarList
            rows={utilisation.data.map((band) => ({ name: band.band, count: band.workspaces }))}
            emptyLabel="No workspace has a metered period yet"
          />
        </Tile>
      ) : (
        <TileError label="Action allowance used" message={utilisation.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        Workspaces, not people, and a snapshot rather than a cohort: the board&rsquo;s window switch
        ({windowShort(days)}) does not apply to any number here. &quot;Exempt forever&quot; is the permanent
        grandfather from the 2026-08-19 repricing plus live comps, and it is revenue given away by
        decision, not revenue lost, so it must never be counted as an opportunity. The allowance tile
        covers EVERY live workspace including paid ones, and workspaces with an unlimited
        entitlement land in the bottom band because they have no cap to be measured against; it is
        also no longer the paywall, which since August is the inbox count, so a full bottom band is
        the expected picture and not a demand signal.
      </p>
    </>
  );
}
