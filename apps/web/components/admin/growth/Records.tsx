/**
 * "Has anything ever been better than this": the records row.
 *
 * WHY A PAGE ABOUT A BUSINESS HAS A RECORDS ROW. Everything above it reports
 * levels and rates, which describe where the business is but give a single
 * good day nowhere to land. At sixty signups a week, the difference between an
 * ordinary Tuesday and the best day this product has ever had is four people,
 * and no chart on the page makes that visible. This row does, and it is also
 * the only part of the sheet that is enjoyable to read, which is a legitimate
 * reason for it to exist on a page somebody has to choose to open.
 *
 * THE BAR EVERY ENTRY HAS TO CLEAR: it is a counted fact, it states the window
 * it was counted over, and it is not scored. No trophies, no streak badges, no
 * congratulation. A record is just the largest number in a series, and saying
 * so plainly is what keeps it a statistic rather than a game.
 *
 * WHICH WINDOW EACH ONE HONESTLY HAS. The signup and activation series come
 * from `users.created_at` and the durable onboarding column, so they survive
 * the 90 day purge and really are all-time. The busiest call day comes from
 * `activity_log`, which is purged at 90 days, so it is labelled as the busiest
 * day of the last quarter and nothing more. Getting that distinction wrong is
 * how a page starts printing "all-time" over a rolling quarter.
 *
 * It is last on the sheet, and it is one row of small type, because it is the
 * least decision-bearing thing here. Levels, movements and records are three
 * different animals and are rendered at three different sizes.
 */

import type { CashCollected } from '@/lib/analytics/kiosk-revenue';
import type { GrowthDailyRow, GrowthUserSignupDayRow } from '@/lib/analytics/growth-types';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import {
  agoLabel,
  daysBetween,
  daysToTarget,
  formatDayKey,
  nextMilestone,
  recordDay,
  streak,
} from '@/lib/analytics/growth-records';
import { NO_DATA, formatCount, formatMoney } from '../charts/format';
import { Dead } from './sheet';

type Failed = { error: string };
const failed = <T,>(value: T | Failed): value is Failed =>
  typeof value === 'object' && value !== null && 'error' in (value as Failed);

export type RecordsProps = {
  signups: GrowthUserSignupDayRow[] | Failed;
  daily: GrowthDailyRow[] | Failed;
  revenue: RevenueSummary | Failed;
  cash: CashCollected | Failed;
  /** Days of `activity_log` history the busiest-call figure was read from. */
  callWindowDays: number;
};

type RecordEntry = { value: string; label: string; note: string };

export function Records(props: RecordsProps) {
  const entries: RecordEntry[] = [];

  if (!failed(props.signups) && props.signups.length > 0) {
    const rows = props.signups;
    const run = streak(rows.map((row) => ({ day: row.day, count: row.new_users })));
    const best = recordDay(rows.map((row) => ({ day: row.day, count: row.new_users })));
    const bestActivation = recordDay(rows.map((row) => ({ day: row.day, count: row.activated_users })));
    const total = rows[rows.length - 1]?.cumulative_users ?? 0;

    entries.push({
      value: `${formatCount(run.current)} days`,
      label: 'Signup streak',
      note:
        run.current >= run.longest
          ? `ties or holds the record of ${formatCount(run.longest)}${run.todayCounts ? ', today included' : ''}`
          : `record is ${formatCount(run.longest)}, ended ${formatDayKey(run.longestEndedOn) ?? NO_DATA}`,
    });

    entries.push({
      value: best ? formatCount(best.count) : NO_DATA,
      label: 'Best day for signups',
      note: best ? `${formatDayKey(best.day) ?? best.day}, all time` : 'no signup has been recorded',
    });

    entries.push({
      value: bestActivation ? formatCount(bestActivation.count) : NO_DATA,
      label: 'Best day for first mailboxes',
      note: bestActivation ? `${formatDayKey(bestActivation.day) ?? bestActivation.day}, all time` : 'nobody has reached one yet',
    });

    // The pace that feeds the arrival estimate is the trailing 28 days rather
    // than the whole series: a projection built on a mean that includes the
    // product's first quiet month is a forecast about a company that no longer
    // exists.
    const recent = rows.slice(-28);
    const perDay = recent.length > 0 ? recent.reduce((sum, row) => sum + row.new_users, 0) / recent.length : 0;
    const milestone = nextMilestone(total);
    const days = milestone ? daysToTarget(milestone.remaining, perDay) : null;
    entries.push({
      value: formatCount(total),
      label: 'People, all time',
      note: milestone
        ? `${formatCount(milestone.remaining)} short of ${formatCount(milestone.target)}${
            days === null ? '' : `, about ${formatCount(days)} days at the last 28 days' pace`
          }`
        : 'past the top of the milestone ladder',
    });
  } else if (failed(props.signups)) {
    return <Dead what="The signup history" error={props.signups.error} />;
  }

  if (!failed(props.daily) && props.daily.length > 0) {
    const busiest = recordDay(props.daily.map((row) => ({ day: row.day, count: row.calls })));
    entries.push({
      value: busiest ? formatCount(busiest.count) : NO_DATA,
      label: 'Busiest day for tool calls',
      note: busiest
        ? `${formatDayKey(busiest.day) ?? busiest.day}, last ${formatCount(props.callWindowDays)} days only`
        : `no call recorded in ${formatCount(props.callWindowDays)} days`,
    });
  }

  if (!failed(props.revenue)) {
    const milestone = nextMilestone(props.revenue.mrrMinor / 100);
    entries.push({
      value: formatMoney(props.revenue.mrrMinor, props.revenue.currency),
      label: 'MRR',
      note: milestone
        ? `${formatMoney(milestone.remaining * 100, props.revenue.currency)} short of ${formatMoney(milestone.target * 100, props.revenue.currency)}`
        : 'past the top of the milestone ladder',
    });
  }

  if (!failed(props.cash)) {
    const milestone = nextMilestone(props.cash.allTimeMinor / 100);
    const tradingDays = props.cash.since ? daysBetween(props.cash.since) : null;
    entries.push({
      value: formatMoney(props.cash.allTimeMinor, props.cash.currency),
      label: 'Cash, all time',
      note: milestone
        ? `${formatMoney(milestone.remaining * 100, props.cash.currency)} short of ${formatMoney(milestone.target * 100, props.cash.currency)}`
        : 'past the top of the milestone ladder',
    });
    entries.push({
      value: tradingDays === null ? NO_DATA : formatCount(tradingDays),
      label: 'Days since the first dollar',
      note: props.cash.since ? `first charge ${agoLabel(props.cash.since)}` : 'no charge has landed',
    });
  }

  if (entries.length === 0) return <p className="br-empty">Nothing has been recorded yet</p>;

  return (
    <dl className="br-records">
      {entries.map((entry) => (
        <div key={entry.label}>
          {/* dt before dd, which is the order the spec wants and also the order
              that reads: the label says which record this is, the figure
              answers it, the note dates it and names the window. */}
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
          <p>{entry.note}</p>
        </div>
      ))}
    </dl>
  );
}
