/**
 * "Is signup growth over?" as one tile: the verdict in words, the completed
 * weeks it was decided from, and the current week beside the same point in
 * the four before it.
 *
 * The current week is drawn hollow and captioned separately because it never
 * decides the verdict (see signup-trend.ts). A Monday morning always looks
 * like a collapse, and the tile says what the week stood at by the same hour
 * in earlier weeks instead of projecting a total.
 */

import { GroupedColumns, Tile } from '../../kiosk/primitives';
import { formatCount } from '../../charts/format';
import { weekLabel, type SignupTrend } from '@/lib/analytics/signup-trend';

const TONE = { ok: 'good', watch: 'warn', alarm: 'bad', unknown: 'default' } as const;

function signed(value: number | null): string {
  if (value === null) return '';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** "Mon 09:19 UTC", the offset into the week `by_now` describes. */
function pointInWeek(asOf: string): string {
  const date = new Date(asOf);
  const day = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day} ${time} UTC`;
}

export function SignupTrendTile({ trend }: { trend: SignupTrend }) {
  const { current } = trend;
  const buckets = [
    ...trend.weeks.map((week) => ({ label: weekLabel(week.weekStart), values: [week.count] })),
    ...(current ? [{ label: weekLabel(current.weekStart), values: [current.soFar], partial: true }] : []),
  ];
  return (
    <Tile
      label="Is signup growth over?"
      aside="new workspaces, Mon-Sun UTC weeks"
      tone={TONE[trend.state]}
    >
      <p className={`gb-trend-state is-${trend.state}`}>
        <b>{trend.headline}</b>
        <span>{trend.reason}</span>
        {trend.weekOverWeek !== null && <span>Week over week {signed(trend.weekOverWeek)}.</span>}
      </p>
      <GroupedColumns buckets={buckets} series={[{ name: 'New workspaces', color: 'var(--cobalt-300)' }]} />
      {current && (
        <p className="kiosk-big-caption">
          This week so far <strong>{formatCount(current.soFar)}</strong> by {pointInWeek(current.asOf)}
          {current.samePointAvg !== null && (
            <>
              {' '}vs <strong>{formatCount(Math.round(current.samePointAvg))}</strong> on average at the same
              point in the last {current.samePoint.length} weeks ({current.samePoint.map((entry) => entry.count).join(', ')}
              {current.vsSamePoint !== null ? `; ${signed(current.vsSamePoint)}` : ''}).
            </>
          )}{' '}
          Only completed weeks decide the state.
        </p>
      )}
    </Tile>
  );
}
