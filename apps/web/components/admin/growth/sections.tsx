/**
 * The data half of /admin/growth: one async Server Component per Suspense
 * boundary, each fetching and handing plain data to synchronous tiles.
 *
 * ONE BOUNDARY PER BAND, not one per tile and not one for the page. Per tile
 * would have the board assemble itself in thirty visible steps; one for the
 * page would hold everything behind the slowest Stripe call. Per band means
 * the shell paints at once and each band lands whole, which is also the only
 * granularity at which a half-arrived row can never show a ratio computed from
 * one loaded half and one missing one.
 *
 * A boundary renders SEVERAL grid children. React's Suspense emits no DOM
 * element of its own, so the cells below stay direct children of the grid and
 * keep their column spans; the fallbacks in page.tsx mirror the same spans so
 * the layout does not jump when a band resolves.
 *
 * NOTHING HERE THROWS, because nothing underneath it does: every fetcher
 * returns a GrowthResult, and a failure becomes a visibly dead tile rather
 * than a missing one. A hole in a grid reads as a zero.
 *
 * WHY THE TILES ARE THE KIOSK'S TILES. This page and the wall board answer the
 * same questions from the same RPCs, and until 2026-09-07 they did it in two
 * unrelated visual languages, one of which was described by the person who
 * reads both as "impossibly hard to use, boring, and ugly". They now share
 * `components/admin/kiosk/primitives` outright, and the two funnels share their
 * arithmetic through `kiosk/shared`, so a rung cannot mean one thing on the
 * wall and another on the laptop. What this page adds is what a wall display
 * has no room or no right to carry: the money panel, the computed to-do list,
 * the milestone track, the channel-quality bars, the cohort grid and the two
 * tables that name accounts.
 */

import {
  fetchAcquisitionChannels,
  fetchActivationFunnel,
  fetchActiveWorkspaces,
  fetchCohortRetention,
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchErrorBreakdown,
  fetchGmailCapSummary,
  fetchInboxDistribution,
  fetchLifecycleCounts,
  fetchPeopleCounts,
  fetchProviderFunnel,
  fetchProviderMix,
  fetchRetentionCurve,
  fetchUpgradePressure,
  fetchUserSignupDays,
  gmailCapProjection,
  type GrowthResult,
} from '@/lib/analytics/growth-queries';
import {
  fetchCashCollected,
  fetchCheckoutFunnel,
  fetchRecurringRevenue,
  valuationMultiple,
} from '@/lib/analytics/kiosk-revenue';
import { fetchRevenueDetail } from '@/lib/analytics/operator-revenue';
import { fetchRecentIncidents, fetchSystemHealth } from '@/lib/analytics/kiosk-health';
import { achievementReport } from '@/lib/analytics/growth-achievements';
import { agoLabel, formatDayKey, recordDay, streak } from '@/lib/analytics/growth-records';
import { valuationFromArr } from '@/lib/analytics/revenue-math';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import {
  BarSeries,
  CohortHeatmap,
  LineChart,
  NO_DATA,
  formatCount,
  formatMoney,
  formatPercent,
  ratio,
} from '../charts';
import {
  BarList,
  BigNumber,
  EventList,
  FunnelSteps,
  Gauge,
  GroupedColumns,
  Tile,
  TileError,
} from '../kiosk/primitives';
import {
  attemptRate,
  CHART_WEEKS,
  checkoutSteps,
  milestoneSteps,
  prettyChannel,
  prettyProvider,
  returningWorkspaces,
  signupWeeks,
  sum,
} from '../kiosk/shared';
import { CalendarHeat } from './CalendarHeat';
import { ChannelQuality, Rail, StatStrip, Verdict, type RailRow } from './board/panels';
import { Milestones } from './board/milestones';
import { Tables } from './Tables';

/** Ninety is a ceiling, not a taste: activity_log is purged past 90 days. */
const DAILY_DAYS = 90;
/** The durable columns (users.created_at, onboarding_*_at) survive that purge. */
const DURABLE_DAYS = 400;
const RETENTION_WEEKS = 16;
const COHORT_WEEKS = 10;
/**
 * A full year of daily cells. Fifty-two columns is also what makes the grid
 * fill a seven column cell: at twenty-six it drew at its intrinsic width and
 * left two thirds of the tile empty.
 */
const HEAT_WEEKS = 52;

/** Channels worth a row. Below this the tail is noise at these volumes. */
const CHANNEL_ROWS = 7;

function unwrap<T>(result: GrowthResult<T>): T | { error: string } {
  return result.ok ? result.data : { error: result.error };
}

function orNull<T>(result: GrowthResult<T>): T | null {
  return result.ok ? result.data : null;
}

/**
 * A grid cell.
 *
 * FOUR SPANS ONLY, all of which divide twelve. The version this replaces also
 * offered 3, 5, 7 and 9, and that is most of what made the board "messy": no
 * two rows shared a rhythm and every row ended ragged. See admin-growth.css
 * for why every tile needs a wrapper at all.
 */
function Cell({ span, tall, children }: { span: 4 | 6 | 8 | 12; tall?: 2 | 3; children: React.ReactNode }) {
  return <div className={`gb-cell gb-w${span}${tall ? ` gb-h${tall}` : ''}`}>{children}</div>;
}


/* ================================================== the overview and rail */

/**
 * The top of the board: one card carrying the six numbers the business turns
 * on and the chart that explains them, and one narrow card carrying the money
 * movements and the records.
 *
 * WHAT THIS REPLACED, 2026-09-07. A 76px MRR "hero" spanning twelve columns, a
 * row of four KPI tiles each with its own sparkline, a "Needs attention" panel
 * and a five-column Records tile. That was a full screen and a half before the
 * first band, it was the source of "everything looks far too large", and the
 * four KPI tiles implied their numbers had nothing to do with the chart three
 * rows below them. Plausible puts all of it in one card; so does this.
 *
 * THE STRIP IS SIX WIDE AND THAT IS THE BUDGET. A seventh metric means one of
 * these is not a headline, and the honest fix is to put it in a band below
 * rather than to squeeze the strip.
 */
export async function TopSection({ days }: { days: number }) {
  const [revenue, cash, checkout, lifecycle, health, incidents, people, signups, daily] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchCashCollected(),
    fetchCheckoutFunnel(),
    fetchLifecycleCounts(),
    fetchSystemHealth(),
    fetchRecentIncidents(6),
    fetchPeopleCounts(days),
    fetchUserSignupDays(DURABLE_DAYS),
    fetchDailyMetrics(DAILY_DAYS),
  ]);

  const mrr = orNull(revenue);
  const banked = orNull(cash);
  const life = orNull(lifecycle);
  const head = orNull(people);
  const signupRows = signups.ok ? signups.data : [];
  const dailyRows = daily.ok ? daily.data : [];
  const cumulative = signupRows[signupRows.length - 1]?.cumulative_users ?? 0;
  const weeks = signupWeeks(signupRows, CHART_WEEKS);

  const money = (minor: number) => formatMoney(minor, mrr?.currency ?? 'usd');
  const recentCalls = sum(dailyRows.slice(-days), 'calls');
  const priorCalls = sum(dailyRows.slice(-days * 2, -days), 'calls');
  const rate = attemptRate(sum(dailyRows, 'successes'), sum(dailyRows, 'calls'), sum(dailyRows, 'rate_limited'));

  const signupDays = signupRows.map((row) => ({ day: row.day, count: row.new_users }));
  const callDays = dailyRows.map((row) => ({ day: row.day, count: row.calls }));
  const signupStreak = streak(signupDays);
  const bestSignupDay = recordDay(signupDays);
  const busiestCallDay = recordDay(callDays);

  return (
    <>
      <Verdict level={health.level} headline={health.headline} reason={health.reason} />

      <Cell span={8} tall={3}>
        <Tile label="The business" aside={`last ${days} days · ${formatCount(incidents.filter((i) => i.status === 'open').length)} incidents open`}>
          <StatStrip
            stats={[
              {
                label: 'MRR',
                value: mrr ? money(mrr.mrrMinor) : NO_DATA,
                note: mrr ? `${money(mrr.arrMinor)} a year` : 'Stripe unavailable',
              },
              {
                label: 'Paying',
                value: mrr ? formatCount(mrr.payingCustomers) : NO_DATA,
                note: mrr && mrr.payingCustomers > 0 ? `${money(mrr.arpaMinor)} each` : 'nobody yet',
              },
              {
                label: 'Cash',
                value: banked ? money(banked.allTimeMinor) : NO_DATA,
                note: banked ? `${money(banked.last30Minor)} in 30d` : 'Stripe unavailable',
              },
              {
                label: 'Signed up',
                value: formatCount(cumulative),
                deltaPercent: head ? deltaPercent(head.new_users, head.prev_new_users) : null,
                note: head ? `${formatCount(head.new_users)} in ${days}d` : undefined,
              },
              {
                label: 'Active 7d',
                value: formatCount(life?.active_7d ?? 0),
                deltaPercent: head ? deltaPercent(head.active_users, head.prev_active_users) : null,
                note: life ? `${formatCount(life.active_28d)} in 28d` : undefined,
              },
              {
                label: 'Tool calls',
                value: formatCount(recentCalls),
                deltaPercent: deltaPercent(recentCalls, priorCalls),
                note: rate === null ? 'none attempted' : `${formatPercent(rate, 1)} succeeded`,
              },
            ]}
          />
          {weeks.length > 0 ? (
            <GroupedColumns
              buckets={weeks}
              series={[
                { name: 'Signed up', color: 'var(--cobalt-300)' },
                { name: 'Reached a mailbox', color: 'var(--mint-500)' },
              ]}
            />
          ) : (
            <p className="kiosk-empty">No signup week has any rows behind it.</p>
          )}
        </Tile>
      </Cell>

      {/* Baremetrics' rail. Movements are never netted into one figure: a net
          of zero cannot tell a quiet month from one sale cancelling one churn,
          and only one of those needs a reply. Zero rows still render, faded,
          because "nothing churned" and "we do not measure churn" must not look
          the same. */}
      <Cell span={4} tall={3}>
        <Tile label="Movements and records" aside={`${days}d`}>
          <Rail
            groups={[
              {
                title: 'Recurring revenue',
                rows: mrr
                  ? [
                      move('new', mrr.newCustomers, 'New', mrr.newMrrMinor, money, 'good'),
                      move('churn', mrr.churnedCustomers, 'Churned', -mrr.churnedMrrMinor, money, 'bad'),
                      move('risk', mrr.atRiskCustomers, 'Card failing', mrr.atRiskMinor, money, 'warn'),
                      move('leaving', mrr.leavingCustomers, 'Set to stop', mrr.leavingMinor, money, 'warn'),
                      {
                        key: 'valuation',
                        label: `Worth at ${valuationMultiple()}\u00d7 ARR`,
                        value: money(valuationFromArr(mrr.arrMinor, valuationMultiple()).valuationMinor),
                      },
                    ]
                  : [{ key: 'none', label: 'Stripe could not be read', value: NO_DATA }],
              },
              {
                title: 'Records',
                rows: [
                  {
                    key: 'best',
                    count: bestSignupDay ? formatCount(bestSignupDay.count) : NO_DATA,
                    label: 'Best signup day',
                    value: bestSignupDay ? (formatDayKey(bestSignupDay.day) ?? '') : '',
                  },
                  {
                    key: 'streak',
                    count: formatCount(signupStreak.current),
                    label: 'Signup streak, days',
                    value: `best ${formatCount(signupStreak.longest)}`,
                  },
                  {
                    key: 'busiest',
                    count: busiestCallDay ? formatCount(busiestCallDay.count) : NO_DATA,
                    label: 'Busiest call day',
                    value: busiestCallDay ? (formatDayKey(busiestCallDay.day) ?? '') : '',
                  },
                  {
                    key: 'sale',
                    label: 'Last sale',
                    value:
                      checkout.ok && checkout.data.lastCompletedAt
                        ? (agoLabel(checkout.data.lastCompletedAt) ?? NO_DATA)
                        : 'never',
                  },
                ],
              },
            ]}
          />
        </Tile>
      </Cell>
    </>
  );
}

/** One MRR movement row. Churn is passed negative so it reads as a loss. */
function move(
  key: string,
  count: number,
  label: string,
  minor: number,
  money: (minor: number) => string,
  tone: RailRow['tone'],
): RailRow {
  return {
    key,
    count: formatCount(count),
    label,
    value: money(minor),
    tone: minor === 0 ? undefined : tone,
    zero: minor === 0,
  };
}

/**
 * Percentage change, or null.
 *
 * A previous period of zero means no honest comparison exists: dividing by it
 * would render every first-ever signup as an infinite improvement.
 */
function deltaPercent(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/* ============================================================= money band */

export async function MoneySection({ days }: { days: number }) {
  const [revenue, checkout, pressure, bands] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchCheckoutFunnel(),
    fetchUpgradePressure(),
    fetchInboxDistribution(),
  ]);

  const mrr = orNull(revenue);
  const bandRows = bands.ok ? [...bands.data].sort((a, b) => a.band_index - b.band_index) : [];

  return (
    <>
      <Cell span={4}>
        {mrr && mrr.byPlan.length > 0 ? (
          <Tile label="Which tier pays" aside={`${formatMoney(mrr.arrMinor, mrr.currency)}/yr`}>
            <BarList
              rows={mrr.byPlan.map((plan) => ({ name: plan.label, count: Math.round(plan.mrrMinor / 100) }))}
              color="var(--mint-500)"
            />
          </Tile>
        ) : (
          <TileError
            label="Which tier pays"
            message={revenue.ok ? 'Stripe returned no live subscriptions.' : revenue.error}
          />
        )}
      </Cell>

      <Cell span={4}>
        {mrr ? (
          <Tile
            label="Money at risk"
            aside={mrr.atRiskCustomers > 0 ? `${formatCount(mrr.atRiskCustomers)} failing` : 'nothing failing'}
            tone={mrr.atRiskMinor > 0 ? 'bad' : mrr.leavingMinor > 0 ? 'warn' : 'good'}
          >
            <BigNumber
              value={formatMoney(mrr.atRiskMinor + mrr.leavingMinor, mrr.currency)}
              caption={
                // Never netted into the headline: a card Stripe cannot charge
                // and a subscription winding down at period end need different
                // replies, and only one of them is urgent.
                <>
                  <strong>{formatMoney(mrr.atRiskMinor, mrr.currency)}</strong> uncollectable,{' '}
                  <strong>{formatMoney(mrr.leavingMinor, mrr.currency)}</strong> set to stop
                </>
              }
            />
          </Tile>
        ) : (
          <TileError label="Money at risk" message={revenue.ok ? 'Stripe returned nothing.' : revenue.error} />
        )}
      </Cell>

      {/* "Still to convert" lived here and was cut: the free-workspace count
          is already the denominator of the checkout funnel one card to the
          right, and stating it twice is what a reader has to reconcile rather
          than read. */}
      <Cell span={4}>
        {pressure.ok ? (
          <Tile
            label="At the inbox ceiling"
            aside="the paywall"
            tone={pressure.data.at_ceiling > 0 ? 'goal' : 'default'}
          >
            <BigNumber
              value={pressure.data.at_ceiling}
              caption={
                <>
                  <strong>{formatCount(pressure.data.at_ceiling_activated)}</strong> have used a mailbox ·{' '}
                  {formatCount(pressure.data.grandfathered_workspaces)} grandfathered, never chargeable
                </>
              }
            />
          </Tile>
        ) : (
          <TileError label="At the inbox ceiling" message={pressure.error} />
        )}
      </Cell>

      <Cell span={6} tall={2}>
        {checkout.ok ? (
          <Tile
            label="Where the money is lost"
            aside={checkout.data.lastCompletedAt ? `last sale ${agoLabel(checkout.data.lastCompletedAt)}` : 'never sold'}
          >
            <FunnelSteps steps={checkoutSteps(checkout.data, mrr)} />
          </Tile>
        ) : (
          <TileError label="Where the money is lost" message={checkout.error} />
        )}
      </Cell>

      <Cell span={6} tall={2}>
        {bands.ok && pressure.ok ? (
          <BarSeries
            title="Workspaces by connected inboxes"
            subtitle="Connected inboxes are the value metric, so this is the paywall."
            labels={bandRows.map((band) => band.band)}
            series={[
              { key: 'capped', name: 'Cap applies', values: bandRows.map((band) => band.capped) },
              { key: 'exempt', name: 'Exempt forever', values: bandRows.map((band) => band.exempt) },
              { key: 'paid', name: 'Paid', values: bandRows.map((band) => band.paid) },
            ]}
            stacked
            height={170}
            footnote={`${formatCount(pressure.data.grandfathered_workspaces)} keep unlimited inboxes free forever; ${formatCount(pressure.data.grandfathered_over_free)} of those are already over the free allowance.`}
          />
        ) : (
          <FailedCard
            title="Workspaces by connected inboxes"
            error={bands.ok ? 'upgrade pressure unavailable' : bands.error}
          />
        )}
      </Cell>
    </>
  );
}

/* ======================================================== milestones band */

export async function MilestoneSection() {
  const [signups, daily, revenue, cash, checkout, lifecycle] = await Promise.all([
    fetchUserSignupDays(DURABLE_DAYS),
    fetchDailyMetrics(DAILY_DAYS),
    fetchRecurringRevenue(DAILY_DAYS),
    fetchCashCollected(),
    fetchCheckoutFunnel(),
    fetchLifecycleCounts(),
  ]);

  const report = achievementReport({
    signups: orNull(signups),
    daily: orNull(daily),
    revenue: orNull(revenue),
    cash: orNull(cash),
    checkout: orNull(checkout),
    lifecycle: orNull(lifecycle),
  });

  return (
    <Cell span={12} tall={3}>
      <Tile
        label="Milestones"
        aside={`${formatCount(report.unlockedCount)} of ${formatCount(report.totalCount)} reached`}
      >
        {/* No caption. Every caveat that used to be printed here is now where
            it belongs: the tool call rungs say "last 90 days" in their own
            detail line because the log is purged there, and the MRR rungs
            simply carry no date because Stripe is a snapshot and the month it
            first crossed a threshold is not available at any price. Repeating
            all three under the panel was four lines of prose explaining what
            the rungs already say. */}
        <Milestones report={report} />
      </Tile>
    </Cell>
  );
}

/* ============================================================ growth band */

export async function GrowthSection({ days }: { days: number }) {
  const [signups, funnel, checkout, channels, providers, providerFunnel, bands, revenue, lifecycle] =
    await Promise.all([
      fetchUserSignupDays(DURABLE_DAYS),
      fetchActivationFunnel(DURABLE_DAYS),
      fetchCheckoutFunnel(),
      fetchAcquisitionChannels(days),
      fetchProviderMix(),
      fetchProviderFunnel(days),
      fetchEngagementBands(days),
      fetchRecurringRevenue(days),
      fetchLifecycleCounts(),
    ]);

  const signupRows = signups.ok ? signups.data : [];
  const weeks = signupWeeks(signupRows, CHART_WEEKS);
  const life = orNull(lifecycle);

  const windowSignups = channels.ok ? channels.data.reduce((total, row) => total + row.signups, 0) : 0;
  const windowPaying = channels.ok ? channels.data.reduce((total, row) => total + row.paying, 0) : 0;

  return (
    <>
      <Cell span={6} tall={2}>
        {signups.ok && weeks.length > 0 ? (
          <Tile label="Signups and first mailboxes" aside={`${CHART_WEEKS} calendar weeks`}>
            <GroupedColumns
              buckets={weeks}
              series={[
                { name: 'Signed up', color: 'var(--cobalt-300)' },
                { name: 'Reached a mailbox', color: 'var(--mint-500)' },
              ]}
            />
          </Tile>
        ) : (
          <TileError
            label="Signups and first mailboxes"
            message={signups.ok ? 'No signup day has any rows behind it.' : signups.error}
          />
        )}
      </Cell>

      <Cell span={6} tall={2}>
        {channels.ok ? (
          <Tile
            label="Which channels produce customers"
            aside={`${days}d, first touch`}
          >
            <ChannelQuality
              rows={[...channels.data]
                .sort((a, b) => b.paying - a.paying || b.signups - a.signups)
                .slice(0, CHANNEL_ROWS)
                .map((row) => ({
                  name: prettyChannel(row.source),
                  signups: row.signups,
                  activated: row.activated,
                  paying: row.paying,
                }))}
            />
            {/* Unknown stays in the list: it is a gap in our own measurement,
                not a channel, and dropping it hands every named source a share
                it has not earned. Attribution only exists from August 2026 and
                lands null on roughly a third of signups. */}
            <p className="kiosk-big-caption">
              Green pays · blue reached a mailbox · grey neither.{' '}
              <strong>{ratio(windowPaying, windowSignups)}</strong> of these signups pay.
            </p>
          </Tile>
        ) : (
          <TileError label="Which channels produce customers" message={channels.error} />
        )}
      </Cell>

      <Cell span={8} tall={2}>
        <CalendarHeat
          title="Signups by day"
          subtitle={`Every UTC day of the last ${HEAT_WEEKS} weeks.`}
          days={signupRows.map((row) => ({ day: row.day, count: row.new_users }))}
          weeks={HEAT_WEEKS}
          unit="signups"
        />
      </Cell>

      <Cell span={4} tall={2}>
        {funnel.ok ? (
          <Tile label="Road to a paying customer" aside="workspaces, all accounts">
            <FunnelSteps
              steps={milestoneSteps(
                [...funnel.data].sort((a, b) => a.stage_index - b.stage_index),
                {
                  returning: returningWorkspaces(bands.ok ? bands.data : []),
                  oneAndDone: life?.one_and_done ?? null,
                },
                orNull(checkout),
                orNull(revenue),
                days,
              )}
            />
          </Tile>
        ) : (
          <TileError label="Road to a paying customer" message={funnel.error} />
        )}
      </Cell>

      <Cell span={6}>
        {providers.ok ? (
          <Tile label="Connected inboxes" aside="live, by provider">
            <BarList
              rows={providers.data.map((row) => ({ name: prettyProvider(row.provider), count: row.inboxes }))}
              emptyLabel="No inbox is connected."
            />
          </Tile>
        ) : (
          <TileError label="Connected inboxes" message={providers.error} />
        )}
      </Cell>

      <Cell span={6}>
        {providerFunnel.ok ? (
          <Tile label="Connection attempts" aside={`${days}d, by provider`}>
            <BarList
              rows={providerFunnel.data.map((row) => ({
                name: `${prettyProvider(row.provider)} · ${ratio(row.workspaces_connected, row.workspaces_attempted)}`,
                count: row.workspaces_attempted,
                color:
                  row.workspaces_connected === row.workspaces_attempted
                    ? 'var(--mint-500)'
                    : 'var(--amber-500)',
              }))}
              emptyLabel="Nobody tried to connect an inbox in this window."
            />
          </Tile>
        ) : (
          <TileError label="Connection attempts" message={providerFunnel.error} />
        )}
      </Cell>

      {/* The "Onboarding, step by step" ladder lived here and was cut: every
          rung of it is already the first three rungs of "Road to a paying
          customer" above, drawn from the same RPC. */}
    </>
  );
}

/* ======================================================= stickiness band */

export async function StickinessSection({ days }: { days: number }) {
  const [retention, cohorts, bands, lifecycle] = await Promise.all([
    fetchRetentionCurve(RETENTION_WEEKS),
    fetchCohortRetention(COHORT_WEEKS),
    fetchEngagementBands(days),
    fetchLifecycleCounts(),
  ]);

  const curve = retention.ok ? retention.data.filter((point) => point.eligible > 0) : [];
  const life = orNull(lifecycle);
  const activeDayBands = bands.ok
    ? bands.data.filter((row) => row.metric === 'active_days')
    : [];
  const returning = returningWorkspaces(bands.ok ? bands.data : []);

  return (
    <>
      <Cell span={6} tall={2}>
        {retention.ok ? (
          <LineChart
            title="Do they come back"
            subtitle="Share of each week's eligible workspaces still active, from their own first mailbox."
            labels={curve.map((point) => `W${point.week_index}`)}
            series={[
              {
                key: 'retained',
                name: 'Retained',
                values: curve.map((point) => (point.eligible > 0 ? (point.retained / point.eligible) * 100 : 0)),
              },
            ]}
            unit="percent"
            height={190}
            footnote="Our own accounts are excluded: the synthetic monitor calls every five minutes and used to lift this tail to 50%."
          />
        ) : (
          <FailedCard title="Do they come back" error={retention.error} />
        )}
      </Cell>

      <Cell span={6} tall={2}>
        {cohorts.ok ? (
          <CohortHeatmap
            title="Retention by signup week"
            subtitle="One row per signup cohort; each cell is how many were still active that week."
            rows={cohortRows(cohorts.data)}
            footnote="Cells under a cohort of ten print counts, not percentages: a percentage over seven people is a lie with a decimal point."
          />
        ) : (
          <FailedCard title="Retention by signup week" error={cohorts.error} />
        )}
      </Cell>

      <Cell span={4}>
        {bands.ok ? (
          <Tile label="Days people showed up" aside={`${days}d`}>
            <BarList
              rows={activeDayBands
                .sort((a, b) => a.band.localeCompare(b.band))
                .map((row) => ({
                  name: `${row.band} day${row.band === '1' ? '' : 's'}`,
                  count: row.workspaces,
                  color: row.band === '1' ? 'var(--fg-4)' : 'var(--cobalt-300)',
                }))}
              emptyLabel="Nobody was active in this window."
            />
          </Tile>
        ) : (
          <TileError label="Days people showed up" message={bands.error} />
        )}
      </Cell>

      <Cell span={4}>
        {life ? (
          <Tile label="Tried once and left" aside="ever" tone={life.one_and_done > 0 ? 'warn' : 'good'}>
            <BigNumber
              value={life.one_and_done}
              caption={
                <>against <strong>{formatCount(returning)}</strong> who came back on a second day in {days}d</>
              }
            />
          </Tile>
        ) : (
          <TileError label="Tried once and left" message={lifecycle.ok ? 'unavailable' : lifecycle.error} />
        )}
      </Cell>

      <Cell span={4}>
        {life ? (
          <Tile label="Going quiet" aside="14 days silent" tone={life.at_risk > 0 ? 'warn' : 'good'}>
            <BigNumber
              value={life.at_risk}
              caption={<>reached a mailbox, then stopped calling. The only population here that had value and lost it.</>}
            />
          </Tile>
        ) : (
          <TileError label="Going quiet" message={lifecycle.ok ? 'unavailable' : lifecycle.error} />
        )}
      </Cell>
    </>
  );
}

/* =========================================================== uptime band */

export async function UptimeSection({ days }: { days: number }) {
  const [daily, errors, incidents, gmail] = await Promise.all([
    fetchDailyMetrics(days),
    fetchErrorBreakdown(days),
    fetchRecentIncidents(8),
    fetchGmailCapSummary(),
  ]);

  const rows = daily.ok ? daily.data : [];
  const calls = sum(rows, 'calls');
  const successes = sum(rows, 'successes');
  const failures = sum(rows, 'errors');
  const throttled = sum(rows, 'rate_limited');
  const rate = attemptRate(successes, calls, throttled);
  const projection = gmail.ok ? gmailCapProjection(gmail.data) : null;

  return (
    <>
      <Cell span={4}>
        {daily.ok ? (
          <Tile
            label="Success rate"
            aside={`${days}d, attempted`}
            tone={rate === null ? 'default' : rate >= 0.99 ? 'good' : rate >= 0.95 ? 'warn' : 'bad'}
          >
            <BigNumber
              value={rate === null ? '—' : formatPercent(rate, 1)}
              // Attempted, not raw. A rate-limited call never reached a tool,
              // and counting it as one is what made this tile read 56.7% on an
              // hour where every real call succeeded (2026-09-03).
              caption={<><strong>{formatCount(throttled)}</strong> rate limited or capped, excluded from the denominator</>}
            />
          </Tile>
        ) : (
          <TileError label="Success rate" message={daily.error} />
        )}
      </Cell>

      <Cell span={4}>
        {daily.ok ? (
          <Tile label="Calls" aside={`${days}d`}>
            <BigNumber
              value={calls}
              caption={<><strong>{formatCount(successes)}</strong> succeeded, our own monitor included</>}
              spark={rows.map((row) => row.calls)}
            />
          </Tile>
        ) : (
          <TileError label="Calls" message={daily.error} />
        )}
      </Cell>

      <Cell span={4}>
        {daily.ok ? (
          <Tile label="Failures" aside={`${days}d`} tone={failures > 0 ? 'warn' : 'good'}>
            <BigNumber
              value={failures}
              caption={<>{ratio(failures, Math.max(1, calls - throttled))} of everything attempted</>}
              spark={rows.map((row) => row.errors)}
              sparkColor="var(--red-500)"
            />
          </Tile>
        ) : (
          <TileError label="Failures" message={daily.error} />
        )}
      </Cell>

      <Cell span={4} tall={2}>
        {gmail.ok && projection ? (
          <Tile
            label="Gmail OAuth headroom"
            aside="cumulative, never returned"
            tone={projection.used / GMAIL_OAUTH_USER_CAP >= 0.8 ? 'bad' : projection.used / GMAIL_OAUTH_USER_CAP >= 0.6 ? 'warn' : 'good'}
          >
            <Gauge value={projection.used} max={GMAIL_OAUTH_USER_CAP} unit="grants" />
            {/* Verification plus the CASA assessment take weeks and the cap
                does not pause for them, which is why the projected date is the
                figure worth printing rather than the headroom. */}
            <p className="kiosk-big-caption">
              {projection.projectedExhaustion
                ? `${projection.ratePerMonth} a month · full around ${projection.projectedExhaustion}`
                : 'Not filling. Revoking access does not return a slot.'}
            </p>
          </Tile>
        ) : (
          <TileError label="Gmail OAuth headroom" message={gmail.ok ? 'no projection' : gmail.error} />
        )}
      </Cell>

      <Cell span={8} tall={2}>
        {errors.ok ? (
          <Tile label="What is failing" aside={`${days}d, by tool and code`}>
            <BarList
              rows={errors.data.slice(0, 7).map((row) => ({
                name: `${row.tool_name} · ${row.error_code ?? 'no code'}`,
                count: row.failures,
                color: 'var(--red-500)',
              }))}
              emptyLabel="No call failed in this window."
            />
          </Tile>
        ) : (
          <TileError label="What is failing" message={errors.error} />
        )}
      </Cell>

      <Cell span={12} tall={2}>
        {daily.ok ? (
          <BarSeries
            title="Calls by outcome"
            subtitle={`Every workspace, our own synthetic monitor included.`}
            labels={rows.map((row) => row.day.slice(5))}
            series={[
              { key: 'ok', name: 'Succeeded', values: rows.map((row) => row.successes) },
              { key: 'err', name: 'Failed', values: rows.map((row) => row.errors) },
              { key: 'rl', name: 'Rate limited', values: rows.map((row) => row.rate_limited) },
            ]}
            stacked
            height={190}
            tickEvery={Math.max(1, Math.round(rows.length / 8))}
            footnote="Our own traffic is deliberately inside this: it is real load, and the one caller guaranteed to exercise the whole path."
          />
        ) : (
          <FailedCard title="Calls by outcome" error={daily.error} />
        )}
      </Cell>

      <Cell span={12} tall={2}>
        <Tile
          label="Outage log"
          aside={
            incidents.length === 0
              ? 'nothing recorded'
              : `${formatCount(incidents.filter((incident) => incident.status === 'open').length)} open`
          }
          tone={incidents.some((incident) => incident.status === 'open') ? 'bad' : 'default'}
        >
          <EventList
            rows={incidents.map((incident) => ({
              key: incident.fingerprint,
              title: `${incident.failureClass} at ${incident.failedStep}`,
              note:
                incident.status === 'open'
                  ? `still open after ${formatCount(incident.consecutiveFailures)} consecutive runs`
                  : 'resolved',
              when: formatDayKey(incident.lastFailureAt.slice(0, 10)) ?? incident.lastFailureAt.slice(0, 10),
              tone: incident.status === 'open' ? 'bad' : 'default',
            }))}
            emptyLabel="No incident has ever been recorded."
          />
        </Tile>
      </Cell>
    </>
  );
}

/* ================================================================= tables */

export async function TablesSection({ days }: { days: number }) {
  const [detail, roster] = await Promise.all([fetchRevenueDetail(), fetchActiveWorkspaces(days)]);
  return (
    <Cell span={12}>
      {/* No wrapper. The card scrolls its own tables through `.bd-scroll`, and
          a second scroll container around it gives the row two scrollbars and
          traps the inner one. */}
      <Tables detail={unwrap(detail)} roster={unwrap(roster)} windowDays={days} />
    </Cell>
  );
}

/* ================================================================ helpers */

/** A dead panel shaped like a chart card, for the charts that have no error state. */
function FailedCard({ title, error }: { title: string; error: string }) {
  return <TileError label={title} message={error} />;
}

/** Cohort cells, newest cohort first, as the heatmap wants them. */
function cohortRows(cells: { cohort_week: string; cohort_size: number; week_index: number; retained: number }[]) {
  const byWeek = new Map<string, { size: number; values: (number | null)[] }>();
  for (const cell of cells) {
    const row = byWeek.get(cell.cohort_week) ?? { size: cell.cohort_size, values: [] };
    row.size = cell.cohort_size;
    row.values[cell.week_index] = cell.retained;
    byWeek.set(cell.cohort_week, row);
  }
  return [...byWeek.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([week, row]) => ({
      label: formatDayKey(week) ?? week,
      size: row.size,
      // A missing cell is a week the cohort has not reached yet, which the
      // heatmap draws hatched. Filling the gaps with zero would report "nobody
      // came back" for a week that has not happened.
      values: Array.from({ length: row.values.length }, (_, index) => row.values[index] ?? null),
    }));
}
