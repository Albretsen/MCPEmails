/**
 * The data half of /admin/growth: one async Server Component per Suspense
 * boundary, each fetching and handing plain data to synchronous cards.
 *
 * ONE BOUNDARY PER BAND, not one per card and not one for the page. Per card
 * would have the board assemble itself in twenty visible steps; one for the
 * page would hold everything behind the slowest Stripe call. Per band means
 * the shell paints at once and each band lands whole, which is also the only
 * granularity at which a half-arrived row can never show a ratio computed from
 * one loaded half and one missing one.
 *
 * A boundary renders SEVERAL grid children. React's Suspense emits no DOM
 * element of its own, so the cards below stay direct children of the grid and
 * keep their column spans; the fallbacks mirror the same spans so the layout
 * does not jump when a band resolves.
 *
 * NOTHING HERE THROWS, because nothing underneath it does: every fetcher
 * returns a GrowthResult, and `unwrap` turns a failure into a value the card
 * renders as a visibly dead panel rather than as a missing card. A hole in a
 * grid reads as a zero.
 */

import {
  fetchAcquisitionChannels,
  fetchActivationFunnel,
  fetchActiveWorkspaces,
  fetchCohortRetention,
  fetchDailyMetrics,
  fetchErrorBreakdown,
  fetchGmailCapSummary,
  fetchGmailGrantSeries,
  fetchInboxDistribution,
  fetchLifecycleCounts,
  fetchProviderFunnel,
  fetchProviderMix,
  fetchRetentionCurve,
  fetchUpgradePressure,
  fetchUserSignupDays,
  gmailCapProjection,
  type GrowthResult,
} from '@/lib/analytics/growth-queries';
import { fetchCashCollected, fetchCheckoutFunnel, fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import { fetchRevenueDetail } from '@/lib/analytics/operator-revenue';
import { fetchRecentIncidents, fetchSystemHealth } from '@/lib/analytics/kiosk-health';
import { attentionReport } from '@/lib/analytics/growth-attention';
import { achievementReport, type Achievement } from '@/lib/analytics/growth-achievements';
import { summariseSeries } from '@/lib/analytics/growth-metrics';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import {
  BarSeries,
  CohortHeatmap,
  FunnelBars,
  LineChart,
  ProgressMeter,
  formatCount,
  formatPercent,
  ratio,
} from '../charts';
import { prettyChannel, prettyProvider } from '../kiosk/shared';
import { AttentionCard } from './AttentionCard';
import { BadgeGrid, type Badge } from './BadgeGrid';
import { CalendarHeat } from './CalendarHeat';
import { Dead } from './Dead';
import { Donut } from './Donut';
import { IncidentsCard } from './IncidentsCard';
import { KpiTile } from './KpiTile';
import { MixBars } from './MixBars';
import { MoneyCard } from './MoneyCard';
import { Tables } from './Tables';

/** Ninety is a ceiling, not a taste: activity_log is purged past 90 days. */
const DAILY_DAYS = 90;
/** The durable columns (users.created_at, onboarding_*_at) survive that purge. */
const DURABLE_DAYS = 400;
const RETENTION_WEEKS = 16;
const COHORT_WEEKS = 10;
/**
 * A full year of daily cells. Fifty-two columns is also what makes the grid
 * fill a six column card: at twenty-six it drew at its intrinsic width and
 * left two thirds of the card empty.
 */
const HEAT_WEEKS = 52;

function unwrap<T>(result: GrowthResult<T>): T | { error: string } {
  return result.ok ? result.data : { error: result.error };
}

function orNull<T>(result: GrowthResult<T>): T | null {
  return result.ok ? result.data : null;
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

/* ============================================================ money + to-do */

export async function MoneySection({ days }: { days: number }) {
  const [revenue, cash, checkout, gmail, pressure, lifecycle, errors, health, incidents] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchCashCollected(),
    fetchCheckoutFunnel(),
    fetchGmailCapSummary(),
    fetchUpgradePressure(),
    fetchLifecycleCounts(),
    fetchErrorBreakdown(days),
    fetchSystemHealth(),
    fetchRecentIncidents(6),
  ]);

  const capSummary = orNull(gmail);
  // Nulls rather than dead-panel markers: a rule whose data failed has to be
  // counted as blocked, never as satisfied, or a Stripe outage quietly turns
  // "money at risk" into "nothing to do".
  const report = attentionReport({
    revenue: orNull(revenue),
    checkout: orNull(checkout),
    cash: orNull(cash),
    gmail: capSummary ? gmailCapProjection(capSummary) : null,
    pressure: orNull(pressure),
    lifecycle: orNull(lifecycle),
    health,
    incidents,
    errors: orNull(errors),
    windowDays: days,
  });

  return (
    <>
      <div className="bd-w5">
        <MoneyCard revenue={unwrap(revenue)} cash={unwrap(cash)} windowDays={days} />
      </div>
      <div className="bd-w7">
        <AttentionCard report={report} />
      </div>
    </>
  );
}

/* ====================================================== the four KPI tiles */

export async function PulseSection({ days }: { days: number }) {
  const [signups, daily, lifecycle] = await Promise.all([
    fetchUserSignupDays(DURABLE_DAYS),
    fetchDailyMetrics(DAILY_DAYS),
    fetchLifecycleCounts(),
  ]);

  const signupRows = signups.ok ? signups.data : [];
  const dailyRows = daily.ok ? daily.data : [];
  const life = lifecycle.ok ? lifecycle.data : null;

  // The window and the window before it, so a delta needs no second query.
  // summariseSeries splits a series in half and reduces each half the way the
  // metric demands: a sum for per-period counts, the last value for a rolling
  // window that would be double counted by adding it up.
  const newUsers = summariseSeries(signupRows.slice(-days * 2).map((row) => row.new_users), 'sum');
  const firstMailboxes = summariseSeries(signupRows.slice(-days * 2).map((row) => row.activated_users), 'sum');
  const active = summariseSeries(dailyRows.map((row) => row.active_7d), 'last');
  const calls = summariseSeries(dailyRows.map((row) => row.calls), 'sum');

  const totalCalls = dailyRows.reduce((sum, row) => sum + row.calls, 0);
  const totalSuccess = dailyRows.reduce((sum, row) => sum + row.successes, 0);
  const cumulative = signupRows[signupRows.length - 1]?.cumulative_users ?? 0;

  return (
    <>
      <div className="bd-w3">
        <KpiTile
          label="People, all time"
          value={formatCount(cumulative)}
          delta={{ percent: newUsers.deltaPercent, goodDirection: 'up' }}
          caption={`${formatCount(newUsers.current)} signed up in the last ${days} days`}
          spark={signupRows.slice(-60).map((row) => row.new_users)}
        />
      </div>
      <div className="bd-w3">
        <KpiTile
          label="Reached a mailbox"
          value={formatCount(life?.value_activated ?? 0)}
          delta={{ percent: firstMailboxes.deltaPercent, goodDirection: 'up' }}
          caption={
            life
              ? `${ratio(life.value_activated, cumulative)} of everyone who ever signed up`
              : 'lifecycle counts unavailable'
          }
          spark={signupRows.slice(-60).map((row) => row.activated_users)}
          sparkColor="var(--mint-500)"
        />
      </div>
      <div className="bd-w3">
        <KpiTile
          label="Active this week"
          value={formatCount(life?.active_7d ?? 0)}
          delta={{ percent: active.deltaPercent, goodDirection: 'up' }}
          caption={life ? `${formatCount(life.active_28d)} active in the last 28 days` : 'lifecycle counts unavailable'}
          spark={dailyRows.map((row) => row.active_7d)}
        />
      </div>
      <div className="bd-w3">
        <KpiTile
          label={`Tool calls, ${DAILY_DAYS} days`}
          value={formatCount(totalCalls)}
          delta={{ percent: calls.deltaPercent, goodDirection: 'up' }}
          caption={
            totalCalls > 0
              ? `${formatPercent(totalSuccess / totalCalls, 1)} succeeded, our own traffic included`
              : 'no calls recorded'
          }
          spark={dailyRows.map((row) => row.calls)}
          sparkColor="var(--amber-500)"
        />
      </div>
    </>
  );
}

/* ============================================================== milestones */

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
    <div className="bd-w12">
      <BadgeGrid
        title="Milestones"
        subtitle={`${formatCount(report.unlockedCount)} of ${formatCount(report.totalCount)} reached. Every one is a counted fact, dated where a series can prove the day.`}
        unlocked={report.unlocked.map(toBadge)}
        next={report.next.map(toBadge)}
        footnote="Tool call rungs are counted inside the 90 day activity window, not all time, because the log is purged there. Signup and cash rungs read durable columns and really are all time."
      />
    </div>
  );
}

/** An achievement as the badge grid wants it, with the dates already worded. */
function toBadge(achievement: Achievement): Badge {
  return {
    id: achievement.id,
    title: achievement.title,
    detail: achievement.detail,
    unlocked: achievement.unlocked,
    achievedLabel: achievement.unlockedOn ? formatDayKey(achievement.unlockedOn) : null,
    progress: achievement.progress,
    remainingLabel: achievement.unlocked
      ? null
      : `${formatCount(Math.max(0, achievement.target - achievement.current))} to go${
          achievement.daysToGo === null ? '' : `, about ${formatCount(achievement.daysToGo)} days`
        }`,
    tone: achievement.category,
  };
}

/* ================================================== acquisition and funnel */

export async function GrowthSection({ days }: { days: number }) {
  const [signups, funnel, checkout, channels, providers, providerFunnel, retention, cohorts, bands, pressure] =
    await Promise.all([
      fetchUserSignupDays(DURABLE_DAYS),
      fetchActivationFunnel(DURABLE_DAYS),
      fetchCheckoutFunnel(),
      fetchAcquisitionChannels(days),
      fetchProviderMix(),
      fetchProviderFunnel(days),
      fetchRetentionCurve(RETENTION_WEEKS),
      fetchCohortRetention(COHORT_WEEKS),
      fetchInboxDistribution(),
      fetchUpgradePressure(),
    ]);

  const signupRows = signups.ok ? signups.data : [];
  const weeks = weeklyBuckets(signupRows, 14);
  const curve = retention.ok ? retention.data.filter((point) => point.eligible > 0) : [];
  const bandRows = bands.ok ? [...bands.data].sort((a, b) => a.band_index - b.band_index) : [];

  return (
    <>
      <div className="bd-w7">
        <BarSeries
          title="Signups and first mailboxes, by week"
          subtitle="Calendar weeks, Monday to Sunday. The current week is still being lived and is always short."
          labels={weeks.labels}
          series={[
            { key: 'new', name: 'Signed up', values: weeks.newUsers },
            { key: 'act', name: 'Reached a mailbox', values: weeks.activated },
          ]}
          height={230}
          footnote="From users.created_at and the durable activation column, so this is not affected by the 90 day log purge."
        />
      </div>

      <div className="bd-w5">
        {channels.ok ? (
          <Donut
            title={`Where they came from, last ${days} days`}
            subtitle="First-touch attribution. Unknown is our own measurement gap and stays in."
            slices={channels.data.map((row) => ({ name: prettyChannel(row.source), value: row.signups }))}
            centerLabel="signups"
            footnote="Attribution only exists from August 2026 and lands null on roughly a third of signups. Dropping the unknown slice would silently hand every named channel a share it has not earned."
          />
        ) : (
          <FailedCard title="Acquisition channels" error={channels.error} />
        )}
      </div>

      <div className="bd-w5">
        <CalendarHeat
          title="Signups by day"
          subtitle={`Every UTC day of the last ${HEAT_WEEKS} weeks.`}
          days={signupRows.map((row) => ({ day: row.day, count: row.new_users }))}
          weeks={HEAT_WEEKS}
          unit="signups"
        />
      </div>

      <div className="bd-w3">
        {providers.ok ? (
          <MixBars
            title="Inboxes by provider"
            subtitle="Live inboxes, app-password connections named by service."
            rows={providers.data.map((row) => ({ name: prettyProvider(row.provider), value: row.inboxes }))}
            unit="inboxes"
          />
        ) : (
          <FailedCard title="Provider mix" error={providers.error} />
        )}
      </div>

      <div className="bd-w4">
        {providerFunnel.ok ? (
          <MixBars
            title="Connection attempts"
            subtitle={`Workspaces that tried each provider, last ${days} days.`}
            rows={providerFunnel.data.map((row) => ({
              name: prettyProvider(row.provider),
              value: row.workspaces_attempted,
              note: `${ratio(row.workspaces_connected, row.workspaces_attempted)} connected`,
            }))}
            unit="workspaces"
          />
        ) : (
          <FailedCard title="Connection attempts" error={providerFunnel.error} />
        )}
      </div>

      <div className="bd-w4">
        {funnel.ok ? (
          <FunnelBars
            title="Signup to mailbox"
            subtitle="Workspaces, all time, from the durable onboarding timestamps. Ours included."
            steps={[...funnel.data]
              .sort((a, b) => a.stage_index - b.stage_index)
              .map((stage) => ({ label: STAGE_LABELS[stage.stage] ?? stage.stage, value: stage.workspaces }))}
          />
        ) : (
          <FailedCard title="The activation funnel" error={funnel.error} />
        )}
      </div>

      <div className="bd-w4">
        {checkout.ok ? (
          <FunnelBars
            title="Plans to paid"
            subtitle="Distinct external workspaces, all time, from the billing event stream. Ours removed."
            steps={[
              { label: 'Looked at the plans', value: checkout.data.pricingViewed },
              { label: 'Started a checkout', value: checkout.data.checkoutStarted },
              { label: 'Paid', value: checkout.data.checkoutCompleted },
            ]}
            footnote={
              checkout.data.lastCompletedAt
                ? `Last completed sale ${agoLabel(checkout.data.lastCompletedAt)}. ${formatCount(checkout.data.abandoned)} started and never finished.`
                : `No checkout has ever completed. ${formatCount(checkout.data.abandoned)} were started.`
            }
          />
        ) : (
          <FailedCard title="The checkout funnel" error={checkout.error} />
        )}
      </div>

      <div className="bd-w4">
        {retention.ok ? (
          <LineChart
            title="Do they come back"
            subtitle="Share of each week's eligible workspaces still active, counted from their own activation."
            labels={curve.map((point) => `W${point.week_index}`)}
            series={[
              {
                key: 'retained',
                name: 'Retained',
                values: curve.map((point) => (point.eligible > 0 ? (point.retained / point.eligible) * 100 : 0)),
              },
            ]}
            unit="percent"
            height={200}
            footnote="Our own accounts are excluded: the synthetic monitor calls the product every five minutes and used to lift this tail to 50% when no external workspace had ever returned that late."
          />
        ) : (
          <FailedCard title="The retention curve" error={retention.error} />
        )}
      </div>

      <div className="bd-w6">
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
            height={200}
            footnote={`${formatCount(pressure.data.at_ceiling)} sit at the ceiling, ${formatCount(pressure.data.at_ceiling_activated)} of those have actually used a mailbox. ${formatCount(pressure.data.grandfathered_workspaces)} are grandfathered and can never be charged.`}
          />
        ) : (
          <FailedCard title="Inbox distribution" error={bands.ok ? 'upgrade pressure unavailable' : bands.error} />
        )}
      </div>

      <div className="bd-w6">
        {cohorts.ok ? (
          <CohortHeatmap
            title="Retention by signup week"
            subtitle="Each row is a signup cohort; each cell is how many were still active that week."
            rows={cohortRows(cohorts.data)}
            footnote="Cells print counts rather than percentages wherever the cohort is under ten, because a percentage over seven people is a lie with a decimal point."
          />
        ) : (
          <FailedCard title="Cohort retention" error={cohorts.error} />
        )}
      </div>
    </>
  );
}

/* ================================================ reliability and ceilings */

export async function HealthSection({ days }: { days: number }) {
  const [summary, grants, daily, errors, health, incidents] = await Promise.all([
    fetchGmailCapSummary(),
    fetchGmailGrantSeries(),
    fetchDailyMetrics(days),
    fetchErrorBreakdown(days),
    fetchSystemHealth(),
    fetchRecentIncidents(6),
  ]);

  const dailyRows = daily.ok ? daily.data : [];
  const projection = summary.ok ? gmailCapProjection(summary.data) : null;
  const grantRows = grants.ok ? grants.data : [];

  return (
    <>
      {/* Three short cards, then the two tall ones. An earlier arrangement put
          the cap meter (about 150px of content) beside the 90 day call chart,
          and the grid stretched it into a card that was two thirds empty. */}
      <div className="bd-w4">
        <IncidentsCard health={health} incidents={incidents} />
      </div>

      <div className="bd-w4">
        {summary.ok && projection ? (
          <ProgressMeter
            value={projection.used}
            max={GMAIL_OAUTH_USER_CAP}
            label="Gmail OAuth cap"
            unit="grants"
            thresholds={{ warn: 0.6, danger: 0.8 }}
            note={
              projection.projectedExhaustion
                ? `Filling at ${projection.ratePerMonth} a month, full around ${projection.projectedExhaustion}. Verification plus the CASA assessment take weeks and the cap does not pause for them.`
                : 'Not currently filling. The count is cumulative: revoking access does not return a slot.'
            }
          />
        ) : (
          <FailedCard title="The Gmail OAuth cap" error={summary.ok ? 'no projection' : summary.error} />
        )}
      </div>

      <div className="bd-w4">
        {grants.ok ? (
          <BarSeries
            title="Gmail grants by month"
            subtitle="New consents against a cap that is cumulative and never gives a slot back."
            labels={grantRows.map((row) => row.month.slice(0, 7))}
            series={[{ key: 'new', name: 'New grants', values: grantRows.map((row) => row.new_grants) }]}
            overlay={[{ key: 'cum', name: 'Total ever', values: grantRows.map((row) => row.cumulative_grants) }]}
            height={170}
            footnote="The total line is what Google counts against the hundred. Deleted inboxes are still in it."
          />
        ) : (
          <FailedCard title="The Gmail grant series" error={grants.error} />
        )}
      </div>

      <div className="bd-w4">
        {errors.ok ? (
          <MixBars
            title="What fails"
            subtitle={`Failed calls by tool and error code, last ${days} days.`}
            rows={errors.data.map((row) => ({
              name: `${row.tool_name} · ${row.error_code ?? 'no code'}`,
              value: row.failures,
              note: ratio(row.failures, row.calls),
            }))}
            unit="failures"
            limit={7}
          />
        ) : (
          <FailedCard title="The error breakdown" error={errors.error} />
        )}
      </div>
      <div className="bd-w8">
        {daily.ok ? (
          <BarSeries
            title="Calls by outcome"
            subtitle={`Every workspace including our own synthetic monitor, last ${days} days.`}
            labels={dailyRows.map((row) => row.day.slice(5))}
            series={[
              { key: 'ok', name: 'Succeeded', values: dailyRows.map((row) => row.successes) },
              { key: 'err', name: 'Failed', values: dailyRows.map((row) => row.errors) },
              { key: 'rl', name: 'Rate limited', values: dailyRows.map((row) => row.rate_limited) },
            ]}
            stacked
            height={230}
            tickEvery={Math.max(1, Math.round(dailyRows.length / 8))}
            footnote="Our own traffic is deliberately inside this: it is real load on the real server, and it is the one caller guaranteed to exercise the whole path."
          />
        ) : (
          <FailedCard title="Call volume" error={daily.error} />
        )}
      </div>

    </>
  );
}

/* ================================================================= tables */

export async function TablesSection({ days }: { days: number }) {
  const [detail, roster] = await Promise.all([fetchRevenueDetail(), fetchActiveWorkspaces(days)]);
  return (
    <div className="bd-w12">
      <Tables detail={unwrap(detail)} roster={unwrap(roster)} windowDays={days} />
    </div>
  );
}

/* ================================================================ helpers */

/** A card-shaped dead panel, for the chart primitives that have no error state. */
function FailedCard({ title, error }: { title: string; error: string }) {
  return (
    <figure className="ac-card">
      <figcaption className="ac-head">
        <h3 className="ac-title">{title}</h3>
      </figcaption>
      <Dead what={title} error={error} />
    </figure>
  );
}

/**
 * Trailing calendar weeks, Monday to Sunday, oldest first.
 *
 * Calendar rather than rolling seven-day buckets, at the operator's request:
 * rolling buckets never end in a short bar, which is tidy, and cost the reader
 * the ability to check the chart against anything, because "last week" on the
 * page and "last week" in somebody's head become different stretches of time.
 * The current week is short and is labelled so.
 */
function weeklyBuckets(
  rows: { day: string; new_users: number; activated_users: number }[],
  weeks: number,
): { labels: string[]; newUsers: number[]; activated: number[] } {
  const byWeek = new Map<string, { newUsers: number; activated: number }>();
  for (const row of rows) {
    const key = mondayOf(row.day.slice(0, 10));
    const bucket = byWeek.get(key) ?? { newUsers: 0, activated: 0 };
    bucket.newUsers += row.new_users;
    bucket.activated += row.activated_users;
    byWeek.set(key, bucket);
  }
  const keys = [...byWeek.keys()].sort().slice(-weeks);
  return {
    labels: keys.map((key, index) => (index === keys.length - 1 ? 'This week' : WEEK_LABEL.format(new Date(`${key}T00:00:00Z`)))),
    newUsers: keys.map((key) => byWeek.get(key)?.newUsers ?? 0),
    activated: keys.map((key) => byWeek.get(key)?.activated ?? 0),
  };
}

const WEEK_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The UTC Monday on or before a day key. getUTCDay is 0 on Sunday, so the
 * shift below is what separates an ISO week from a US one, and is the single
 * most common way this function is written wrong.
 */
function mondayOf(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
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
