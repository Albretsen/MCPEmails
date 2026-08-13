/**
 * Estate mix: what is connected, what clients are used, what plans are held,
 * and how close workspaces are to their action allowance.
 *
 * Current-state only, no time dimension. These replace four separate
 * two-column tables on the old page, which forced you to read counts without
 * any sense of relative size.
 */

import { fetchInventory } from '@/lib/analytics/growth-inventory';
import { formatCount } from '../charts';
import { MixBars, SectionError, Section, StatCard } from './shared';

export async function MixSection({ days }: { days: number }) {
  const result = await fetchInventory(days);
  if (!result.ok) return <SectionError title="Estate mix" message={result.error} />;
  const inventory = result.data;

  return (
    <>
      <Section
        title="Estate mix"
        blurb="Active inboxes by provider, and the MCP client recorded with each workspace's first successful tool call."
      >
        <div className="growth-split">
          <MixBars title="Mail provider" unit="active inboxes" rows={inventory.providerMix} />
          <MixBars title="MCP client" unit="workspaces" rows={inventory.clientMix} emptyLabel="No client recorded yet." />
        </div>
      </Section>

      <Section
        title="Plans and cap utilization"
        blurb={`Share of each workspace's monthly action allowance used in the last ${days} days, against the cap for the plan it is currently on. Caps come from the canonical plan table, so a pricing change moves this chart automatically.`}
      >
        <div className="growth-split">
          <MixBars title="Current plan" unit="workspaces" rows={inventory.planMix} />
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
            label="Paid workspaces"
            value={inventory.paidWorkspaces}
            detail="On the Agent or Scale plan"
          />
        </section>
        <p className="growth-note">
          Cap enforcement currently applies to a deterministic 5 percent cohort of newer workspaces, so a
          cap-hit count near zero reflects the rollout as much as it reflects usage.
        </p>
      </Section>
    </>
  );
}
