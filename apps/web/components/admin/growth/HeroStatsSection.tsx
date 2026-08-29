/**
 * The hero row: the five numbers worth looking at before anything else.
 *
 * The old page opened with twelve stat cards across three stacked grids, which
 * is a wall of numbers with no hierarchy. Everything cut from here still
 * exists, but next to the section that explains it.
 *
 * Each card carries its own context: a 30-day sparkline, a delta against the
 * previous equivalent period, and a drill-down with the full history. That is
 * the answer to "31 active workspaces, is that good?", which the bare number
 * could never give.
 */

import { fetchDailyMetrics, fetchLifecycleCounts, fetchRevenueCounts } from '@/lib/analytics/growth-queries';
import { MetricCard } from '../MetricCard';
import { SectionError, StatBlock, StatCard } from './shared';

const SPARK_DAYS = 30;

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/** Percentage change, or null when there is nothing honest to compare against. */
function delta(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export async function HeroStatsSection({ days }: { days: number }) {
  // Ask for two windows so each number can be compared with the one before it.
  // Capped at 90 days because `activity_log` is purged at 90: requesting more
  // would return real workspace counts alongside zeroed activity counts, and a
  // delta computed against that would be a fabrication.
  const requested = Math.min(days * 2, 90);
  const comparable = requested >= days * 2;

  const [dailyResult, lifecycleResult, revenueResult] = await Promise.all([
    fetchDailyMetrics(requested),
    fetchLifecycleCounts(),
    fetchRevenueCounts(),
  ]);

  if (!dailyResult.ok) return <SectionError title="Summary" message={dailyResult.error} />;

  const rows = dailyResult.data;
  const current = rows.slice(-days);
  const previous = comparable ? rows.slice(-days * 2, -days) : null;
  const latest = rows.at(-1);
  const priorSameDay = comparable ? rows.at(-1 - days) : undefined;

  const lifecycle = lifecycleResult.ok ? lifecycleResult.data : null;
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const windowLabel = `${days}d`;

  return (
    <section className="growth-stat-grid is-five" aria-label="Growth summary">
      <MetricCard metricKey="active_7d" label="Active workspaces, 7 day">
        <StatBlock
          label="Active workspaces (7d)"
          value={latest?.active_7d ?? 0}
          detail="Successful call in the last 7 days"
          explain="Distinct workspaces with at least one successful MCP tool call in the trailing 7 days. Any successful call counts, including a bare inbox_list, so it is a looser bar than value activation."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.active_7d)}
          delta={priorSameDay ? tone(delta(latest?.active_7d ?? 0, priorSameDay.active_7d), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="active_28d" label="Active workspaces, 28 day">
        <StatBlock
          label="Active workspaces (28d)"
          value={latest?.active_28d ?? 0}
          detail={lifecycle ? `${lifecycle.one_and_done} activated and never came back` : 'Successful call in the last 28 days'}
          explain="Distinct workspaces with a successful call in the trailing 28 days. It moves slowly and is the more trustworthy of the two active counts at this volume."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.active_28d)}
          delta={priorSameDay ? tone(delta(latest?.active_28d ?? 0, priorSameDay.active_28d), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="new_workspaces" label="New workspaces">
        <StatBlock
          label={`New workspaces (${windowLabel})`}
          value={sum(current.map((row) => row.new_workspaces))}
          detail="Signups in the window"
          explain="Workspaces created in the window and not since deleted. A signup count, not a surviving-account count: a workspace that never connected an inbox still counts."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.new_workspaces)}
          delta={previous ? tone(delta(sum(current.map((row) => row.new_workspaces)), sum(previous.map((row) => row.new_workspaces))), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="value_activations" label="Value activations">
        <StatBlock
          label={`Value activations (${windowLabel})`}
          value={sum(current.map((row) => row.value_activations))}
          detail="First mailbox operation"
          explain="Workspaces that reached their first successful call touching a real mailbox: a success with an inbox attached that was not just inbox_list. Connecting an inbox and never using it does not count."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.value_activations)}
          delta={previous ? tone(delta(sum(current.map((row) => row.value_activations)), sum(previous.map((row) => row.value_activations))), 'up') : undefined}
        />
      </MetricCard>

      {/* Paying, not "paid". `workspaces.plan` reads 'pro' for a comp as well
          as a purchase, so counting the column made this card claim five paid
          workspaces while the true number of paying customers was zero, and
          later claim one paying customer when the row was our own test account
          on a 100%-off subscription. Comps and our own accounts are reported
          beside it, quietly, because neither is revenue. */}
      <StatCard
        label="Paying customers"
        value={revenue?.paying_workspaces ?? 0}
        detail={revenue
          ? [
              `${revenue.comped_workspaces} comped`,
              ...(revenue.internal_paying_workspaces > 0
                ? [`${revenue.internal_paying_workspaces} internal on a paid plan`]
                : []),
              `${revenue.free_workspaces} free`,
            ].join(', ')
          : 'Revenue counts unavailable'}
        explain={
          <>
            Workspaces on a paid plan whose owner is external and does <strong>not</strong> hold a
            comped entitlement. A comp lands on the same <code>plan</code> column as a purchase, so
            anything counting that column alone reports comps, and our own test accounts, as revenue.
            A 100%-off Stripe discount on an external account is still counted here: the webhook
            stores no amount or coupon, so nothing in the database can see it.
          </>
        }
      />
    </section>
  );
}

/** Packs a nullable delta into the shape StatBlock expects, dropping nulls. */
function tone(percent: number | null, goodDirection: 'up' | 'down') {
  return percent === null ? undefined : { percent, goodDirection };
}
