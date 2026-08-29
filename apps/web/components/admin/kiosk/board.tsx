/**
 * The kiosk board: one screen of numbers, refreshed on a timer, read from
 * across a room.
 *
 * WHY IT IS ONE COMPONENT rather than a Suspense boundary per section like
 * /admin/growth. That page is opened by a person who is waiting for it, so
 * streaming each panel as its query lands is the right trade. This one is
 * unattended: nobody is watching the moment it loads, and a board that paints
 * in nine stages every five minutes is a board that spends its life visibly
 * reassembling itself. One `Promise.all`, one paint, and the previous frame
 * stays on screen until the new one is complete.
 *
 * WHAT IS DELIBERATELY MISSING: the Active accounts roster. It is the only
 * part of /admin/growth that names workspaces and owner email addresses, and
 * this screen hangs on a wall where anyone in the room can read it, reachable
 * with a shared token rather than an operator login. Everything here is an
 * aggregate.
 *
 * WHAT IT IS FOR: the honest state of the business at a glance, framed so that
 * the answer to "how are we doing" is a direction rather than a verdict. Hence
 * the milestone funnel: with zero paying customers, a board that only reported
 * revenue would say the same thing every day forever, and would be ignored
 * within a week. The funnel shows the step actually in play.
 */

import {
  fetchActivationFunnel,
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchGmailCapSummary,
  fetchLifecycleCounts,
  fetchProviderMix,
  fetchRevenueCounts,
  fetchUsageVolume,
  gmailCapProjection,
} from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import type { GmailCapSummaryRow, GrowthDailyRow } from '@/lib/analytics/growth-types';
import { planDisplayName } from '@/lib/stripe/plans';
import { NO_DATA, formatCount, formatPercent, ratio } from '../charts';
import {
  BarList,
  BigNumber,
  FactRow,
  FunnelSteps,
  Gauge,
  GroupedColumns,
  Tile,
  TileError,
  type Trend,
} from './primitives';

/** The board's reporting window. Fixed: a wall display has no controls. */
export const KIOSK_WINDOW_DAYS = 28;

/** Weeks of history in the trend chart. Eight fits the tile and one quarter. */
const CHART_WEEKS = 8;

/**
 * Days of daily history to pull. Ninety is the ceiling: a pg_cron job deletes
 * `activity_log` rows past 90 days, so asking for more would return real
 * workspace counts beside zeroed activity and every delta computed against
 * that stretch would be an invention.
 */
const DAILY_DAYS = 90;

/**
 * Window for the milestone funnel. It reads `workspaces.created_at` and the
 * durable `onboarding_*_at` columns rather than `activity_log`, so the 90 day
 * purge does not apply and a wide window really does mean all-time. That is
 * what this panel wants: the road to a first paying customer is a story about
 * everyone who has ever signed up, not about the last four weeks.
 */
const FUNNEL_DAYS = 400;

export async function KioskBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [daily, lifecycle, revenue, funnel, bands, gmail, providers, usage] = await Promise.all([
    fetchDailyMetrics(DAILY_DAYS),
    fetchLifecycleCounts(),
    fetchRevenueCounts(),
    fetchActivationFunnel(FUNNEL_DAYS),
    fetchEngagementBands(days),
    fetchGmailCapSummary(),
    fetchProviderMix(),
    fetchUsageVolume(days),
  ]);

  const rows = daily.ok ? daily.data : [];
  const current = rows.slice(-days);
  const previous = rows.slice(-days * 2, -days);
  // Only compare against a full prior period. A partial one makes every
  // percentage on the board an understatement dressed up as a decline.
  const comparable = previous.length === days;
  const latest = rows.at(-1);
  const priorSameDay = rows.at(-1 - days);

  const life = lifecycle.ok ? lifecycle.data : null;
  const money = revenue.ok ? revenue.data : null;
  const volume = usage.ok ? usage.data : null;

  const activeNow = life?.active_28d ?? latest?.active_28d ?? 0;
  const returning = returningWorkspaces(bands.ok ? bands.data : []);
  const oneAndDone = life?.one_and_done ?? null;

  const newThisWindow = sum(current, 'new_workspaces');
  const activationsThisWindow = sum(current, 'value_activations');

  const calls = sum(current, 'calls');
  const successes = sum(current, 'successes');
  const errors = sum(current, 'errors');

  return (
    <>
      {/* ---- Row 2: the four numbers the business turns on ---- */}

      <Tile label="Active workspaces" aside={`${days}d`} span={3}>
        {daily.ok ? (
          <BigNumber
            value={activeNow}
            trend={trend(activeNow, priorSameDay && comparable ? priorSameDay.active_28d : null, 'up')}
            caption={<><strong>{latest?.active_7d ?? 0}</strong> active in the last 7 days</>}
            spark={rows.slice(-30).map((row) => row.active_28d)}
          />
        ) : (
          <p className="kiosk-error"><strong>No data</strong><span>{daily.error}</span></p>
        )}
      </Tile>

      {/* Retention, stated as a count rather than a rate. "22% retained" over a
          denominator this small swings by ten points when one person opens
          their laptop; "12 came back" does not, and it is the number anyone
          actually wants when they glance at the wall. */}
      <Tile label="Came back" aside={`${days}d`} span={3} tone={returning > 0 ? 'good' : 'default'}>
        <BigNumber
          value={returning}
          trend={null}
          caption={
            oneAndDone === null
              ? <>Workspaces active on <strong>2 or more</strong> days</>
              : <>Active on <strong>2 or more</strong> days. {oneAndDone} tried once and left.</>
          }
        />
      </Tile>

      <Tile label="Value activations" aside={`${days}d`} span={3}>
        {daily.ok ? (
          <BigNumber
            value={activationsThisWindow}
            trend={trend(activationsThisWindow, comparable ? sum(previous, 'value_activations') : null, 'up')}
            caption={<><strong>{newThisWindow}</strong> signed up, {ratio(activationsThisWindow, newThisWindow)} reached a mailbox</>}
            spark={rows.slice(-30).map((row) => row.value_activations)}
            sparkColor="var(--kiosk-good)"
          />
        ) : (
          <p className="kiosk-error"><strong>No data</strong><span>{daily.error}</span></p>
        )}
      </Tile>

      {/* Paying, not "paid": a comp lands on the same `plan` column as a
          purchase, and so does our own 100%-off test subscription, so anything
          counting that column reports both as revenue. The tile is dashed while
          the number is zero, because a solid frame around a nought reads as a
          result rather than as the open goal it is.

          The excluded internal accounts are named in the caption, not in the
          aside. The board is a fixed 960x600 logical viewport, the aside is
          `white-space: nowrap`, and this tile is only three of twelve columns
          wide: a second clause up there squeezes the label into an ellipsis.
          The caption is the one line here that may wrap. */}
      <Tile
        label="Paying customers"
        aside={money ? `${money.comped_workspaces} comped` : undefined}
        span={3}
        tone={(money?.paying_workspaces ?? 0) > 0 ? 'good' : 'goal'}
      >
        <BigNumber
          value={money?.paying_workspaces ?? 0}
          caption={
            money && money.paying_workspaces === 0
              ? money.internal_paying_workspaces > 0
                ? <>Next milestone. <strong>{money.free_workspaces}</strong> free to convert, <strong>{money.internal_paying_workspaces}</strong> of ours not counted.</>
                : <>Next milestone. <strong>{money.free_workspaces}</strong> free workspaces to convert.</>
              : money
                ? <><strong>{money.paying_personal}</strong> {planDisplayName('personal')}, <strong>{money.paying_solo}</strong> {planDisplayName('solo')}, <strong>{money.paying_scale}</strong> {planDisplayName('pro')}</>
                : 'Revenue counts unavailable'
          }
        />
      </Tile>

      {/* ---- Row 3: the two panels worth standing still for ---- */}

      {daily.ok ? (
        <Tile label="Signups and activations" aside={`last ${CHART_WEEKS} weeks`} span={7}>
          <GroupedColumns
            buckets={weeklyBuckets(rows, CHART_WEEKS)}
            series={[
              { name: 'Signed up', color: 'var(--kiosk-accent)' },
              { name: 'Reached a mailbox', color: 'var(--kiosk-good)' },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Signups and activations" message={daily.error} span={7} />
      )}

      {funnel.ok ? (
        <Tile label="Road to a paying customer" aside="every signup, ever" span={5}>
          <FunnelSteps steps={milestoneSteps(funnel.data, returning, volume?.cap_hit_workspaces ?? 0, money?.paying_workspaces ?? 0)} />
        </Tile>
      ) : (
        <TileError label="Road to a paying customer" message={funnel.error} span={5} />
      )}

      {/* ---- Row 4: the supporting strip ---- */}

      {gmail.ok ? (
        <GmailTile summary={gmail.data} />
      ) : (
        <TileError label="Gmail OAuth headroom" message={gmail.error} span={3} className="kiosk-strip" />
      )}

      <Tile
        label="Reliability"
        aside={`${days}d`}
        span={3}
        className="kiosk-strip"
        tone={calls > 0 && successes / calls < 0.95 ? 'warn' : 'default'}
      >
        <BigNumber
          value={calls > 0 ? formatPercent(successes / calls, 1) : NO_DATA}
          caption={<>{formatCount(errors)} failed of {formatCount(calls)} calls</>}
        />
      </Tile>

      <Tile label="Work done for customers" aside={`${days}d`} span={3} className="kiosk-strip">
        <BigNumber
          value={volume?.billable_actions ?? (usage.ok ? 0 : NO_DATA)}
          caption={volume
            ? <>Billable actions across <strong>{volume.billable_workspaces}</strong> workspaces</>
            : 'Usage volume unavailable'}
        />
        {volume && (
          <FactRow
            facts={[
              { label: 'Estate', value: volume.total_workspaces },
              { label: 'At the cap', value: volume.cap_hit_workspaces },
            ]}
          />
        )}
      </Tile>

      {providers.ok ? (
        <Tile label="Connected inboxes" aside={`${sumBy(providers.data, (row) => row.inboxes)} live`} span={3} className="kiosk-strip">
          <BarList
            rows={providers.data
              .slice()
              .sort((a, b) => b.inboxes - a.inboxes)
              .slice(0, 5)
              .map((row) => ({ name: prettyProvider(row.provider), count: row.inboxes }))}
            emptyLabel="No inboxes connected"
          />
        </Tile>
      ) : (
        <TileError label="Connected inboxes" message={providers.error} span={3} className="kiosk-strip" />
      )}
    </>
  );
}

/**
 * The Gmail cap tile.
 *
 * Split out because its tone is driven by TIME rather than by the bar: Google
 * verification plus the CASA assessment take weeks, and the cap does not pause
 * while they run, so the level turns red when the runway gets shorter than the
 * process, not when the meter looks full. That is why this tile can be red at
 * a little over half. The aside says what to do about it, because a warning
 * nobody can act on is just a colour.
 */
function GmailTile({ summary }: { summary: GmailCapSummaryRow }) {
  const projection = gmailCapProjection(summary);
  const full = projection.projectedExhaustion
    ? MONTH_LABEL.format(new Date(`${projection.projectedExhaustion}-01T00:00:00Z`))
    : 'No growth';
  return (
    <Tile
      label="Gmail OAuth headroom"
      aside={projection.level === 'ok' ? `${projection.remaining} left` : `start verification`}
      span={3}
      className="kiosk-strip"
      tone={projection.level === 'ok' ? 'default' : projection.level === 'warn' ? 'warn' : 'bad'}
    >
      <Gauge value={projection.used} max={GMAIL_OAUTH_USER_CAP} unit="grants" />
      <FactRow
        facts={[
          { label: 'Slots left', value: projection.remaining },
          { label: 'Per month', value: projection.ratePerMonth.toFixed(1) },
          { label: 'Full by', value: full },
        ]}
      />
    </Tile>
  );
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ---------------------------------------------------------------- helpers */

function sum(rows: GrowthDailyRow[], key: keyof GrowthDailyRow): number {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/**
 * Percentage change, or nothing. A null previous period and a previous period
 * of zero both mean "no honest comparison exists": dividing by zero would
 * render every first-ever signup as an infinite improvement.
 */
function trend(current: number, previous: number | null | undefined, goodDirection: 'up' | 'down'): Trend {
  if (previous === null || previous === undefined || previous === 0) return null;
  return { percent: ((current - previous) / previous) * 100, goodDirection };
}

/**
 * Workspaces that came back at least once.
 *
 * The engagement RPC buckets by active days as '1', '2–3', '4–7', '8+', so
 * everything except the first band is a workspace that returned on a
 * different day. Matching on "not 1" rather than listing the other three keeps
 * this correct if a band is ever added.
 */
function returningWorkspaces(rows: { metric: string; band: string; workspaces: number }[]): number {
  return rows
    .filter((row) => row.metric === 'active_days' && row.band !== '1')
    .reduce((total, row) => total + row.workspaces, 0);
}

/**
 * Trailing 7-day buckets, oldest first, anchored on the most recent day.
 *
 * Deliberately not calendar weeks. The board is read on whatever day someone
 * walks past it, and a calendar-week chart spends most of its life ending in a
 * partial bar that looks like a collapse.
 */
function weeklyBuckets(rows: GrowthDailyRow[], weeks: number): { label: string; values: number[] }[] {
  const buckets: { label: string; values: number[] }[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const end = rows.length - index * 7;
    const slice = rows.slice(Math.max(0, end - 7), end);
    if (slice.length === 0) continue;
    buckets.push({
      label: index === 0 ? 'This week' : `${index}w ago`,
      values: [sum(slice, 'new_workspaces'), sum(slice, 'value_activations')],
    });
  }
  return buckets;
}

/**
 * The milestone ladder, ending at the step that is actually in play.
 *
 * The last two rungs come from outside the activation funnel on purpose: the
 * funnel stops at first value, and the interesting question now is what
 * happens after it. "Came back" is the step the product currently loses people
 * on, and "Hit a plan limit" is the step nobody has reached yet, which is
 * precisely why a checkout has never been started.
 */
function milestoneSteps(
  funnel: { stage: string; workspaces: number }[],
  returning: number,
  capHit: number,
  paying: number,
) {
  const stage = (name: string) => funnel.find((row) => row.stage === name)?.workspaces ?? 0;
  // The last three rungs are measured over the rolling window, not all time,
  // so each one says so. Mixing windows in a funnel is defensible; doing it
  // without labelling which rung changed measure is not.
  return [
    { label: 'Signed up', value: stage('signup') },
    { label: 'Connected an inbox', value: stage('inbox_connected') },
    { label: 'Used their mailbox', value: stage('value_activation') },
    {
      label: 'Came back',
      value: returning,
      note: returning === 0 ? 'nobody yet' : `2+ days, last ${KIOSK_WINDOW_DAYS}d`,
    },
    {
      label: 'Hit a plan limit',
      value: capHit,
      note: capHit === 0 ? 'nobody has met the paywall' : `last ${KIOSK_WINDOW_DAYS}d`,
    },
    {
      label: 'Paid',
      value: paying,
      note: paying === 0 ? 'the first one is still out there' : 'thank you',
    },
  ];
}

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

function prettyProvider(provider: string): string {
  const key = provider.toLowerCase();
  return PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
