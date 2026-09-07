/**
 * The panel behind the Active users tile.
 *
 * THE PATTERN EVERY PANEL IN THIS DIRECTORY FOLLOWS, written out once here.
 *
 *  1. One `Promise.all`, like the boards. A panel opened by a finger is being
 *     waited for, but it is still one paint: a panel that assembles itself in
 *     four stages on a wall reads as a page that is broken.
 *  2. A FAILED FETCH IS NOT A ZERO, ever. `TileError` says which query did not
 *     answer, in words, because a blank tile on a wall reads as "nobody used
 *     it today" and that reading sends somebody off to investigate a query
 *     timeout as though it were a collapse in usage.
 *  3. The window is clamped where the data is clamped. Anything derived from
 *     `activity_log` has nothing older than 90 days to return, so it is asked
 *     for `activityDays(days)` and the tile says which window it actually got.
 *  4. Aggregates only. This screen hangs on a wall in a room with other people
 *     in it: no workspace names, no owner addresses, in any panel.
 *
 * WHAT THIS ONE ANSWERS. The tile says how many people were active in the
 * window and whether that is up or down. The question standing at the glass is
 * always the same: up from what, and is it the same people twice or twice as
 * many people once. So: the run of active users week by week, how that sits
 * against the population it is drawn from, and the distribution of how many
 * days each returning workspace actually showed up.
 */

import {
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchLifecycleCounts,
  fetchPeopleCounts,
} from '@/lib/analytics/growth-queries';
import { formatCount, ratio } from '../../charts';
import { BarList, BigNumber, FactRow, GroupedColumns, Tile, TileError } from '../primitives';
import { calendarWeekBuckets, CHART_WEEKS } from '../shared';
import {
  activityDays,
  isActivityCapped,
  isPeopleCapped,
  PEOPLE_MAX_DAYS,
  peopleDays,
  windowShort,
} from '../windows';
import type { KioskDetailProps } from './registry';

export async function ActiveUsersDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  // Not `days`: the people RPC reports this window and the one before it, so it
  // clamps its own argument at 45 days, and it does so without saying so. Asked
  // for 400 it would answer for 45 and this panel would label that "all time".
  const peopleWindow = peopleDays(days);
  const [people, daily, bands, life] = await Promise.all([
    fetchPeopleCounts(peopleWindow),
    fetchDailyMetrics(activity),
    fetchEngagementBands(activity),
    fetchLifecycleCounts(),
  ]);

  return (
    <>
      {people.ok ? (
        <Tile
          label="Active in the window"
          aside={isPeopleCapped(days) ? `${PEOPLE_MAX_DAYS}d max` : windowShort(days)}
          span={4}
          tone="good"
        >
          <BigNumber
            value={people.data.active_users}
            caption={
              <>
                <strong>{formatCount(people.data.active_users_7d)}</strong> of them in the last 7 days
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Previous window', value: people.data.prev_active_users },
              { label: 'Of all signups', value: ratio(people.data.active_users, people.data.total_users) },
              { label: 'Ever reached a mailbox', value: people.data.activated_users },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Active in the window" message={people.error} span={4} />
      )}

      {/* The workspace-level series, not the people one: `activity_log` records
          a workspace rather than the human who made the call, and the rolling
          28 day figure it carries is the closest thing to this tile that has a
          day-by-day history at all. Labelled as workspaces for that reason. */}
      {daily.ok ? (
        <Tile
          label="Active workspaces, week by week"
          aside={isActivityCapped(days) ? '90d max' : windowShort(days)}
          span={8}
        >
          {daily.data.length === 0 ? (
            <p className="kiosk-empty">No activity has been recorded in this window.</p>
          ) : (
            <GroupedColumns
              buckets={calendarWeekBuckets(daily.data, CHART_WEEKS, (row) => [row.active_7d, row.value_activations])}
              series={[
                { name: 'Active (7d rolling, week peak)', color: 'var(--kiosk-accent)' },
                { name: 'First mailbox reached', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Active workspaces, week by week" message={daily.error} span={8} />
      )}

      {bands.ok ? (
        <Tile label="Days showed up" aside={isActivityCapped(days) ? '90d max' : windowShort(days)} span={6}>
          <BarList
            rows={bands.data
              .filter((row) => row.metric === 'active_days')
              .map((row) => ({ name: `${row.band} day${row.band === '1' ? '' : 's'}`, count: row.workspaces }))}
            emptyLabel="No workspace was active in this window"
            color="var(--kiosk-accent)"
          />
        </Tile>
      ) : (
        <TileError label="Days showed up" message={bands.error} span={6} />
      )}

      {life.ok ? (
        <Tile
          label="The state of the base"
          aside="all time"
          span={6}
          tone={life.data.at_risk > 0 ? 'warn' : 'default'}
        >
          <BarList
            rows={[
              { name: 'Active last 7d', count: life.data.active_7d, color: 'var(--kiosk-good)' },
              { name: 'Active last 28d', count: life.data.active_28d, color: 'var(--kiosk-accent)' },
              { name: 'Silent 14d+', count: life.data.at_risk, color: 'var(--kiosk-warn)' },
              { name: 'Tried once, left', count: life.data.one_and_done, color: 'var(--kiosk-bad)' },
            ]}
            emptyLabel="Nobody has reached a mailbox yet"
          />
          <FactRow facts={[{ label: 'Ever reached a mailbox', value: life.data.value_activated }]} />
        </Tile>
      ) : (
        <TileError label="The state of the base" message={life.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        Active means a successful MCP call. The headline counts PEOPLE, by the workspaces they own;
        the weekly chart counts WORKSPACES, because that is what the activity log records. Our own
        accounts are excluded from the people counts and included in the workspace series, where they
        are real load. The people counts stop at {PEOPLE_MAX_DAYS} days whatever the switch says,
        because that query reports this window and the one before it and both have to stay inside the
        90 day purge.
        {isActivityCapped(days)
          ? ' Anything drawn from the activity log stops at 90 days: older rows are deleted, so a longer window would show real counts beside zeroed activity.'
          : ''}
      </p>
    </>
  );
}
