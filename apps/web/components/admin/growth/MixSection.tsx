/**
 * Estate mix: what is connected, what clients are used, what plans are held,
 * and how close workspaces are to their action allowance.
 *
 * Current-state only, no time dimension. These replace four separate
 * two-column tables on the old page, which forced you to read counts without
 * any sense of relative size.
 */

import { fetchRevenueCounts } from '@/lib/analytics/growth-queries';
import { fetchInventory } from '@/lib/analytics/growth-inventory';
import { formatCount } from '../charts';
import { MixBars, SectionError, Section, StatCard } from './shared';

export async function MixSection({ days }: { days: number }) {
  const [result, revenueResult] = await Promise.all([fetchInventory(days), fetchRevenueCounts()]);
  if (!result.ok) return <SectionError title="Estate mix" message={result.error} />;
  const inventory = result.data;

  // Never `inventory.planMix`: that reads the `plan` column, which says 'pro'
  // for a comp as well as a purchase. Comped accounts get their own row so the
  // paying row cannot quietly absorb them.
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const planRows = revenue
    ? [
        { name: 'Free', count: revenue.free_workspaces },
        { name: 'Comped', count: revenue.comped_workspaces },
        { name: 'Paying (Agent)', count: revenue.paying_solo },
        { name: 'Paying (Scale)', count: revenue.paying_scale },
      ].filter((row) => row.count > 0)
    : [];

  return (
    <>
      <Section
        title="Estate mix"
        explain="Active inboxes by provider, and the MCP client recorded with each workspace's first successful tool call. Every app-password connection is stored as a generic IMAP provider, so a named service is shown wherever one was recorded."
      >
        <div className="growth-split">
          <MixBars title="Mail provider" unit="active inboxes" rows={inventory.providerMix} />
          <MixBars title="MCP client" unit="workspaces" rows={inventory.clientMix} emptyLabel="No client recorded yet." />
        </div>
      </Section>

      <Section
        title="Plans and cap utilization"
        explain={
          <>
            Share of each workspace&rsquo;s monthly action allowance used in the last {days} days, against
            the cap for the plan it is currently on. Caps come from the canonical plan table, so a pricing
            change moves this automatically. Cap enforcement currently applies to a deterministic 5 percent
            cohort of newer workspaces, so a cap-hit count near zero reflects the rollout as much as it
            reflects usage.
          </>
        }
      >
        <div className="growth-split">
          <MixBars title="Current plan" unit="workspaces" rows={planRows} />
          <MixBars title="Cap utilization" unit="workspaces" rows={inventory.utilizationBands} />
        </div>
        <section className="growth-stat-grid" aria-label="Usage volume" style={{ marginTop: 18, marginBottom: 0 }}>
          <StatCard
            label={`Billable actions (${days}d)`}
            value={inventory.billableActions}
            detail={`${formatCount(inventory.billableWorkspaces)} workspace(s) with billable use`}
          />
          <StatCard
            label={`Cap-hit workspaces (${days}d)`}
            value={inventory.capHitWorkspaces}
            detail={`${formatCount(inventory.capRejections)} rejected billable call(s)`}
          />
          <StatCard
            label="Workspaces"
            value={inventory.workspaces}
            detail="Non-deleted workspaces in total"
          />
          <StatCard
            label="Paying customers"
            value={revenue?.paying_workspaces ?? 0}
            detail={revenue ? `${revenue.comped_workspaces} comped, not revenue` : 'Revenue counts unavailable'}
            explain="A paid plan whose owner holds no comped entitlement. Comps write the same plan column as a purchase, so counting that column alone reports them as revenue."
          />
        </section>
      </Section>
    </>
  );
}
