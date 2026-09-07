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
  fetchRevenueCounts,
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
import { attentionReport } from '@/lib/analytics/growth-attention';
import { achievementReport } from '@/lib/analytics/growth-achievements';
import { agoLabel, formatDayKey, recordDay, streak } from '@/lib/analytics/growth-records';
import { valuationFromArr } from '@/lib/analytics/revenue-math';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import {
  BarSeries,
  CohortHeatmap,
  LineChart,
  formatCount,
  formatMoney,
  formatPercent,
  ratio,
} from '../charts';
import {
  BarList,
  BigNumber,
  EventList,
  FactRow,
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
  trend,
} from '../kiosk/shared';
import { CalendarHeat } from './CalendarHeat';
import { Attention, ChannelQuality, Hero, Verdict } from './board/panels';
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

/** A grid cell. See admin-growth.css for why every tile gets one. */
function Cell({ span, tall, children }: { span: number; tall?: 2 | 3; children: React.ReactNode }) {
  return <div className={`gb-cell gb-w${span}${tall ? ` gb-h${tall}` : ''}`}>{children}</div>;
}

/** Stage ids as a person would say them. */
const STAGE_LABELS: Record<string, string> = {
  signup: 'Signed up',
  client_selected: 'Picked a client',
  inbox_connected: 'Connected an inbox',
  connection_verified: 'Verified',
  credential_issued: 'Key issued',
  technical_activation: 'First call',
  value_activation: 'Reached a mailbox',
};

/* ============================================ the verdict, money and to-do */

export async function TopSection({ days }: { days: number }) {
  const [revenue, cash, checkout, pressure, lifecycle, errors, health, incidents, signups, daily] =
    await Promise.all([
      fetchRecurringRevenue(days),
      fetchCashCollected(),
      fetchCheckoutFunnel(),
      fetchUpgradePressure(),
      fetchLifecycleCounts(),
      fetchErrorBreakdown(days),
      fetchSystemHealth(),
      fetchRecentIncidents(6),
      fetchUserSignupDays(DURABLE_DAYS),
      fetchDailyMetrics(DAILY_DAYS),
    ]);

  const mrr = orNull(revenue);
  // Nulls rather than dead-panel markers: a rule whose data failed has to be
  // counted as blocked, never as satisfied, or a Stripe outage quietly turns
  // "money at risk" into "nothing to do".
  const report = attentionReport({
    revenue: mrr,
    checkout: orNull(checkout),
    cash: orNull(cash),
    lifecycle: orNull(lifecycle),
    health,
    incidents,
    errors: orNull(errors),
    windowDays: days,
  });

  const signupRows = signups.ok ? signups.data : [];
  const dailyRows = daily.ok ? daily.data : [];
  const signupDays = signupRows.map((row) => ({ day: row.day, count: row.new_users }));
  const callDays = dailyRows.map((row) => ({ day: row.day, count: row.calls }));
  const signupStreak = streak(signupDays);
  const bestSignupDay = recordDay(signupDays);
  const busiestCallDay = recordDay(callDays);

  return (
    <>
      <Verdict
        level={health.level}
        headline={health.headline}
        reason={health.reason}
        checkedAt={health.checkedAt}
        openIncidents={incidents.filter((incident) => incident.status === 'open').length}
      />

      <Hero
        revenue={mrr}
        revenueError={revenue.ok ? null : revenue.error}
        cash={orNull(cash)}
        valuationMinor={mrr ? valuationFromArr(mrr.arrMinor, valuationMultiple()).valuationMinor : null}
        valuationMultiple={valuationMultiple()}
        lastSaleAt={checkout.ok ? checkout.data.lastCompletedAt : null}
        windowDays={days}
      />

      <Cell span={7} tall={2}>
        <Tile
          label="Needs attention"
          aside={report.items.length === 0 ? 'nothing crossed' : `${formatCount(report.items.length)} open`}
          tone={report.items.some((item) => item.severity === 'act') ? 'bad' : 'good'}
        >
          <Attention report={report} />
        </Tile>
      </Cell>

      {/* Records exist for one reason: everything else on this page is a level
          or a rate, and neither can tell you that last Tuesday was the best day
          this product has ever had. A best-ever is the only figure here that is
          allowed to be simply pleasant to look at, and it is still a counted
          fact with a date on it. */}
      <Cell span={5} tall={2}>
        <Tile label="Records" aside="all time, from the series read">
          {/* Five facts and no sentence. The signup records read the durable
              user table and really are all time; the call record is bounded at
              the 90 day purge, which the tile's own aside covers. */}
          <FactRow
            facts={[
              {
                label: 'Best signup day',
                value: bestSignupDay ? `${formatCount(bestSignupDay.count)} · ${formatDayKey(bestSignupDay.day) ?? ''}` : '—',
              },
              {
                label: 'Signup streak',
                value: signupStreak.current > 0 ? `${formatCount(signupStreak.current)} days` : 'broken',
              },
              { label: 'Longest ever', value: `${formatCount(signupStreak.longest)} days` },
              {
                label: 'Busiest call day',
                value: busiestCallDay ? `${formatCount(busiestCallDay.count)} · ${formatDayKey(busiestCallDay.day) ?? ''}` : '—',
              },
              {
                label: 'Last sale',
                value:
                  checkout.ok && checkout.data.lastCompletedAt
                    ? (agoLabel(checkout.data.lastCompletedAt) ?? '—')
                    : 'never',
              },
            ]}
          />
        </Tile>
      </Cell>
    </>
  );
}

/* ====================================================== the four headlines */

export async function PulseSection({ days }: { days: number }) {
  const [people, signups, daily, lifecycle] = await Promise.all([
    fetchPeopleCounts(days),
    fetchUserSignupDays(DURABLE_DAYS),
    fetchDailyMetrics(DAILY_DAYS),
    fetchLifecycleCounts(),
  ]);

  const signupRows = signups.ok ? signups.data : [];
  const dailyRows = daily.ok ? daily.data : [];
  const life = orNull(lifecycle);
  const head = orNull(people);
  const cumulative = signupRows[signupRows.length - 1]?.cumulative_users ?? 0;

  const calls = sum(dailyRows, 'calls');
  const successes = sum(dailyRows, 'successes');
  const throttled = sum(dailyRows, 'rate_limited');
  const rate = attemptRate(successes, calls, throttled);

  // Two equal halves of the window, so a delta needs no second query. The
  // recent half is the one on screen.
  const recentCalls = sum(dailyRows.slice(-days), 'calls');
  const priorCalls = sum(dailyRows.slice(-days * 2, -days), 'calls');

  return (
    <>
      <Cell span={3}>
        <Tile label="Signed up" aside="people, all time" tone="good">
          <BigNumber
            value={cumulative}
            trend={head ? trend(head.new_users, head.prev_new_users, 'up') : null}
            caption={
              head
                ? <><strong>{formatCount(head.new_users)}</strong> in {days}d · {formatCount(head.internal_users)} of ours excluded</>
                : 'People counts unavailable.'
            }
            spark={signupRows.slice(-60).map((row) => row.new_users)}
          />
        </Tile>
      </Cell>

      <Cell span={3}>
        <Tile label="Reached a mailbox" aside="ever" tone="good">
          <BigNumber
            value={life?.value_activated ?? 0}
            caption={
              life
                ? <><strong>{ratio(life.value_activated, cumulative)}</strong> of everyone who signed up</>
                : 'Lifecycle counts unavailable.'
            }
            spark={signupRows.slice(-60).map((row) => row.activated_users)}
            sparkColor="var(--mint-500)"
          />
        </Tile>
      </Cell>

      <Cell span={3}>
        <Tile label="Active this week" aside="7 days" tone={(life?.active_7d ?? 0) > 0 ? 'good' : 'warn'}>
          <BigNumber
            value={life?.active_7d ?? 0}
            trend={head ? trend(head.active_users, head.prev_active_users, 'up') : null}
            caption={
              life
                ? <><strong>{formatCount(life.active_28d)}</strong> active in 28d</>
                : 'Lifecycle counts unavailable.'
            }
            spark={dailyRows.map((row) => row.active_7d)}
          />
        </Tile>
      </Cell>

      <Cell span={3}>
        <Tile label={`Tool calls, ${days}d`} aside={rate === null ? 'no attempts' : formatPercent(rate, 1)}>
          <BigNumber
            value={recentCalls}
            trend={trend(recentCalls, priorCalls, 'up')}
            caption={
              // Attempted, not raw: a rate-limited call never reached a tool.
              // Dividing by raw calls is what made a board tile read 56.7% on
              // an hour where every real call succeeded.
              rate === null
                ? 'Nothing was attempted.'
                : <><strong>{formatPercent(rate, 1)}</strong> succeeded, our own monitor included</>
            }
            spark={dailyRows.map((row) => row.calls)}
            sparkColor="var(--amber-500)"
          />
        </Tile>
      </Cell>
    </>
  );
}

/* ============================================================= money band */

export async function MoneySection({ days }: { days: number }) {
  const [revenue, counts, checkout, pressure, bands] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchRevenueCounts(),
    fetchCheckoutFunnel(),
    fetchUpgradePressure(),
    fetchInboxDistribution(),
  ]);

  const mrr = orNull(revenue);
  const money = orNull(counts);
  const bandRows = bands.ok ? [...bands.data].sort((a, b) => a.band_index - b.band_index) : [];

  return (
    <>
      <Cell span={3}>
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

      <Cell span={3}>
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

      <Cell span={3}>
        {money ? (
          <Tile label="Still to convert" aside="free workspaces">
            <BigNumber
              value={money.free_workspaces}
              caption={
                <>
                  <strong>{formatCount(money.paying_workspaces)}</strong> pay ·{' '}
                  {formatCount(money.comped_workspaces)} comped · {formatCount(money.internal_workspaces)} ours
                </>
              }
            />
          </Tile>
        ) : (
          <TileError label="Still to convert" message={counts.ok ? 'unavailable' : counts.error} />
        )}
      </Cell>

      <Cell span={3}>
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
      <Cell span={7} tall={2}>
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

      <Cell span={5} tall={2}>
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

      <Cell span={7} tall={2}>
        <CalendarHeat
          title="Signups by day"
          subtitle={`Every UTC day of the last ${HEAT_WEEKS} weeks.`}
          days={signupRows.map((row) => ({ day: row.day, count: row.new_users }))}
          weeks={HEAT_WEEKS}
          unit="signups"
        />
      </Cell>

      <Cell span={5} tall={2}>
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

      <Cell span={4}>
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

      <Cell span={4}>
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

      <Cell span={4}>
        {funnel.ok ? (
          <Tile label="Onboarding, step by step" aside="workspaces, all time">
            <FunnelSteps
              steps={[...funnel.data]
                .sort((a, b) => a.stage_index - b.stage_index)
                .map((stage) => ({ label: STAGE_LABELS[stage.stage] ?? stage.stage, value: stage.workspaces }))}
            />
          </Tile>
        ) : (
          <TileError label="Onboarding, step by step" message={funnel.error} />
        )}
      </Cell>
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
      <Cell span={3}>
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

      <Cell span={3}>
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

      <Cell span={3}>
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

      <Cell span={3}>
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

      <Cell span={5} tall={2}>
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

      <Cell span={7} tall={2}>
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
