/**
 * The data half of /admin/growth: one async Server Component per Suspense
 * boundary, each of which fetches and hands plain data to a synchronous view.
 *
 * WHY THE SPLIT IS WORTH A FILE. Nothing in `Standing.tsx`, `Chain.tsx`,
 * `Ceilings.tsx`, `Records.tsx` or `Reference.tsx` awaits anything, which
 * means the entire presentation layer can be rendered to static HTML by a
 * plain Node script with fixture data. That is the only way this page's layout
 * can be checked at all: `/admin/growth` is behind an ADMIN_EMAILS session, so
 * a signed-out development server shows a 404 and nothing else, and the
 * alternative to a harness is deploying an unverified page to production and
 * looking at it there.
 *
 * ONE BOUNDARY PER REGION, not one per query and not one for the page. Per
 * query would have the sheet assemble itself in nineteen visible steps; one
 * for the page would hold the whole thing behind the slowest Stripe call. Per
 * region means the shell and the headings paint immediately and each region
 * lands whole, which is also the only granularity at which a half-arrived
 * region could never show a ratio computed from one loaded and one missing
 * half.
 *
 * NOTHING HERE THROWS, because nothing underneath it does: every fetcher
 * returns a `GrowthResult`, and `unwrap` turns a failure into a value the view
 * renders as a visibly dead panel. A missing panel would read as a zero, and a
 * zero beside revenue sends somebody off to investigate a query timeout as a
 * collapse in demand.
 */

import {
  fetchAcquisitionChannels,
  fetchActivationFunnel,
  fetchActiveWorkspaces,
  fetchDailyMetrics,
  fetchErrorBreakdown,
  fetchGmailCapSummary,
  fetchGmailGrantSeries,
  fetchInboxDistribution,
  fetchLifecycleCounts,
  fetchOAuthAbandonment,
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
import { Attention } from './Attention';
import { Ceilings } from './Ceilings';
import { Chain } from './Chain';
import { Records } from './Records';
import { Reference } from './Reference';
import { Standing } from './Standing';

/**
 * Days of daily history read from `activity_log`-derived series.
 *
 * Ninety is a ceiling rather than a choice: a pg_cron job deletes activity_log
 * rows past 90 days, so a wider window returns real workspace counts beside a
 * zeroed stretch of activity, and every rate computed across it is invented.
 */
const DAILY_DAYS = 90;

/**
 * Window for the activation ladder and the signup series. Both read
 * `workspaces.created_at`, `users.created_at` and the durable `onboarding_*_at`
 * columns, none of which the 90 day purge touches, so a wide window here
 * really does mean all-time.
 */
const DURABLE_DAYS = 400;

/** Weeks of the retention curve. Sixteen is four months of cohorts. */
const RETENTION_WEEKS = 16;

/** A failed read becomes a value the view renders as a dead panel. */
function unwrap<T>(result: GrowthResult<T>): T | { error: string } {
  return result.ok ? result.data : { error: result.error };
}

/** The same, for the places that want a nullable rather than a marker object. */
function orNull<T>(result: GrowthResult<T>): T | null {
  return result.ok ? result.data : null;
}

export async function StandingSection({ days }: { days: number }) {
  const [revenue, cash] = await Promise.all([fetchRecurringRevenue(days), fetchCashCollected()]);
  return <Standing revenue={unwrap(revenue)} cash={unwrap(cash)} windowDays={days} />;
}

/**
 * The to-do list.
 *
 * Reads eight sources and cares about which of them failed, which is why it
 * passes nulls rather than dead-panel markers: a rule with no data must be
 * counted as blocked, never as satisfied. `fetchSystemHealth` is the one
 * uncached read on the page, deliberately, because "is it up" has to be true
 * now rather than true within ten minutes.
 */
export async function AttentionSection({ days }: { days: number }) {
  const [revenue, checkout, cash, gmail, pressure, lifecycle, errors, health, incidents] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchCheckoutFunnel(),
    fetchCashCollected(),
    fetchGmailCapSummary(),
    fetchUpgradePressure(),
    fetchLifecycleCounts(),
    fetchErrorBreakdown(days),
    fetchSystemHealth(),
    fetchRecentIncidents(6),
  ]);

  const summary = orNull(gmail);
  const report = attentionReport({
    revenue: orNull(revenue),
    checkout: orNull(checkout),
    cash: orNull(cash),
    gmail: summary ? gmailCapProjection(summary) : null,
    pressure: orNull(pressure),
    lifecycle: orNull(lifecycle),
    health,
    incidents,
    errors: orNull(errors),
    windowDays: days,
  });

  return <Attention report={report} />;
}

export async function ChainSection({ days }: { days: number }) {
  const [
    signups,
    funnel,
    checkout,
    pressure,
    bands,
    lifecycle,
    retention,
    channels,
    providers,
    providerFunnel,
    oauth,
  ] = await Promise.all([
    fetchUserSignupDays(DURABLE_DAYS),
    fetchActivationFunnel(DURABLE_DAYS),
    fetchCheckoutFunnel(),
    fetchUpgradePressure(),
    fetchInboxDistribution(),
    fetchLifecycleCounts(),
    fetchRetentionCurve(RETENTION_WEEKS),
    fetchAcquisitionChannels(days),
    fetchProviderMix(),
    fetchProviderFunnel(days),
    fetchOAuthAbandonment(),
  ]);

  return (
    <Chain
      signups={unwrap(signups)}
      funnel={unwrap(funnel)}
      checkout={unwrap(checkout)}
      pressure={unwrap(pressure)}
      bands={unwrap(bands)}
      lifecycle={unwrap(lifecycle)}
      retention={unwrap(retention)}
      channels={unwrap(channels)}
      providers={unwrap(providers)}
      providerFunnel={unwrap(providerFunnel)}
      oauth={unwrap(oauth)}
      windowDays={days}
    />
  );
}

export async function CeilingsSection({ days }: { days: number }) {
  const [summary, grants, daily, errors, health, incidents] = await Promise.all([
    fetchGmailCapSummary(),
    fetchGmailGrantSeries(),
    fetchDailyMetrics(days),
    fetchErrorBreakdown(days),
    fetchSystemHealth(),
    fetchRecentIncidents(6),
  ]);

  return (
    <Ceilings
      gmail={summary.ok ? { summary: summary.data, projection: gmailCapProjection(summary.data) } : { error: summary.error }}
      grants={unwrap(grants)}
      daily={unwrap(daily)}
      errors={unwrap(errors)}
      health={health}
      incidents={incidents}
      windowDays={days}
    />
  );
}

export async function RecordsSection() {
  const [signups, daily, revenue, cash] = await Promise.all([
    fetchUserSignupDays(DURABLE_DAYS),
    fetchDailyMetrics(DAILY_DAYS),
    fetchRecurringRevenue(DAILY_DAYS),
    fetchCashCollected(),
  ]);

  return (
    <Records
      signups={unwrap(signups)}
      daily={unwrap(daily)}
      revenue={unwrap(revenue)}
      cash={unwrap(cash)}
      callWindowDays={DAILY_DAYS}
    />
  );
}

export async function ReferenceSection({ days }: { days: number }) {
  const [detail, roster] = await Promise.all([fetchRevenueDetail(), fetchActiveWorkspaces(days)]);
  return <Reference detail={unwrap(detail)} roster={unwrap(roster)} windowDays={days} />;
}
