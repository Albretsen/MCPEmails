/**
 * The five-second read: what changed this week.
 *
 * WHY A STRIP AT ALL. The page it replaces opened with five cards about
 * activity and one about paying customers, and everything that decides whether
 * this becomes a business was somewhere below the fold: what it earns, and how
 * many people are standing at the paywall. The operator's own summary of the
 * old page was that it was not useful often enough to open, which is what a
 * dashboard reads like when its first screen answers a question nobody is
 * asking that morning.
 *
 * These six answer, in order: is there money, is it growing, is anyone in a
 * position to give us more, are new people arriving, do they get anywhere, and
 * are they still here. Every one carries a delta against the previous
 * equivalent period, because at this size an absolute number is unreadable
 * without one.
 *
 * Everything here is repeated in full, with its definition and its history,
 * further down the page. This strip is a summary and is allowed to be terse;
 * nothing is stated here that is not explained below.
 */

import {
  fetchDailyMetrics,
  fetchUpgradePressure,
} from '@/lib/analytics/growth-queries';
import { fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import { MetricCard } from '../MetricCard';
import { formatMoney, NO_DATA } from '../charts';
import { StatBlock, StatCard } from './shared';

const SPARK_DAYS = 30;

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/** Percentage change, or null when there is nothing honest to compare against. */
function delta(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Packs a nullable delta into the shape StatBlock expects, dropping nulls. */
function tone(percent: number | null, goodDirection: 'up' | 'down') {
  return percent === null ? undefined : { percent, goodDirection };
}

export async function PulseSection({ days }: { days: number }) {
  // Two windows, so every number can be compared with the one before it.
  // Capped at 90 because `activity_log` is purged at 90: asking for more would
  // return real workspace counts beside zeroed activity, and a delta computed
  // against that is a fabrication.
  const requested = Math.min(days * 2, 90);
  const comparable = requested >= days * 2;

  const [dailyResult, revenueResult, pressureResult] = await Promise.all([
    fetchDailyMetrics(requested),
    fetchRecurringRevenue(days),
    fetchUpgradePressure(),
  ]);

  const rows = dailyResult.ok ? dailyResult.data : [];
  const current = rows.slice(-days);
  const previous = comparable ? rows.slice(-days * 2, -days) : null;
  const latest = rows.at(-1);
  const priorSameDay = comparable ? rows.at(-1 - days) : undefined;

  const money = revenueResult.ok ? revenueResult.data : null;
  const pressure = pressureResult.ok ? pressureResult.data : null;
  const windowLabel = `${days}d`;

  const newWorkspaces = sum(current.map((row) => row.new_workspaces));
  const activations = sum(current.map((row) => row.value_activations));

  return (
    <section className="growth-stat-grid is-six growth-pulse" aria-label="This week at a glance">
      {/* Money first, and stated as MRR rather than as what was billed. The
          first sale was a year up front: billed-this-month would have shown
          $48 in August and nothing for the eleven months after. */}
      <StatCard
        label="MRR"
        value={money ? formatMoney(money.mrrMinor, money.currency) : NO_DATA}
        detail={
          money
            ? money.payingCustomers === 0
              ? 'No paying subscriptions'
              : `${formatMoney(money.arrMinor, money.currency)} ARR from ${money.payingCustomers} customer${money.payingCustomers === 1 ? '' : 's'}`
            : 'Stripe unavailable'
        }
        explain={
          <>
            Monthly recurring revenue, priced from <strong>Stripe</strong> rather than from our own plan
            table: a yearly subscription contributes a twelfth of its net amount per month, and a
            100%-off comp contributes nothing. Nothing in the database can tell those apart, which is how
            this page once reported five paid workspaces while the real paying count was zero.
          </>
        }
        delta={money && money.netNewMrrMinor !== 0
          ? tone(delta(money.mrrMinor, money.mrrMinor - money.netNewMrrMinor), 'up')
          : undefined}
      />

      {/* The number the old page could not see at all. Since the 2026-08-19
          repricing the inbox count is the value metric, and this is the
          population the paywall is actually in front of. */}
      <StatCard
        label="At the inbox ceiling"
        value={pressure?.at_ceiling ?? 0}
        detail={pressure
          ? `${pressure.at_ceiling_activated} of them have used a mailbox`
          : 'Upgrade pressure unavailable'}
        explain={
          <>
            Free workspaces already holding every inbox their plan allows, so the next one they try to
            connect is refused. Excludes the workspaces the cap can never reach: everyone who signed up
            before the repricing was grandfathered into unlimited inboxes permanently. The activated
            subset is the number worth acting on, because a workspace that hit the ceiling without ever
            performing a mailbox operation is blocked by onboarding, not by price.
          </>
        }
      />

      <MetricCard metricKey="new_workspaces" label="New workspaces">
        <StatBlock
          label={`New workspaces (${windowLabel})`}
          value={newWorkspaces}
          detail="Signups in the window"
          explain="Workspaces created in the window and not since deleted. A signup count, not a surviving-account count: a workspace that never connected an inbox still counts."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.new_workspaces)}
          delta={previous ? tone(delta(newWorkspaces, sum(previous.map((row) => row.new_workspaces))), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="value_activations" label="Value activations">
        <StatBlock
          label={`Activated (${windowLabel})`}
          value={activations}
          detail={newWorkspaces > 0 ? `${Math.round((activations / newWorkspaces) * 100)}% of signups` : 'First mailbox operation'}
          explain="Workspaces that reached their first successful call touching a real mailbox: a success with an inbox attached that was not just inbox_list. Connecting an inbox and never using it does not count. The percentage compares two counts over the same window, not one cohort followed through, so it moves when either changes."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.value_activations)}
          delta={previous ? tone(delta(activations, sum(previous.map((row) => row.value_activations))), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="active_7d" label="Active workspaces, 7 day">
        <StatBlock
          label="Active (7d)"
          value={latest?.active_7d ?? 0}
          detail="Successful call in the last 7 days"
          explain="Distinct workspaces with at least one successful MCP tool call in the trailing 7 days. Any successful call counts, including a bare inbox_list, so it is a looser bar than value activation."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.active_7d)}
          delta={priorSameDay ? tone(delta(latest?.active_7d ?? 0, priorSameDay.active_7d), 'up') : undefined}
        />
      </MetricCard>

      <MetricCard metricKey="active_28d" label="Active workspaces, 28 day">
        <StatBlock
          label="Active (28d)"
          value={latest?.active_28d ?? 0}
          detail="Successful call in the last 28 days"
          explain="Distinct workspaces with a successful call in the trailing 28 days. It moves slowly and is the more trustworthy of the two active counts at this volume."
          spark={rows.slice(-SPARK_DAYS).map((row) => row.active_28d)}
          delta={priorSameDay ? tone(delta(latest?.active_28d ?? 0, priorSameDay.active_28d), 'up') : undefined}
        />
      </MetricCard>
    </section>
  );
}
