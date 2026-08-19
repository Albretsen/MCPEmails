/**
 * Billing funnel: all-time, workspace-level.
 *
 * Reported all-time rather than windowed because the counts are small enough
 * that a 28-day window would usually show zeros and hide the real shape.
 *
 * WHAT IS AND IS NOT A FUNNEL HERE
 * Only pricing view -> checkout -> payment is a nested chain: every workspace
 * that reached Stripe had viewed pricing, and every completed payment started a
 * checkout (verified against the view, zero violations). The two cap numbers
 * are NOT ancestors of it. A user can open the pricing page without ever
 * hitting a paywall, and all ten who viewed pricing did exactly that, because
 * nobody has ever hit the cap at all.
 *
 * They used to be rendered as the top two rows of one funnel, which asserted a
 * nesting that does not exist: with the cap stage reading 2, the pricing row
 * printed "10 of 2" and its conversion-from-previous printed a dash. That stayed
 * invisible for as long as the cap bands were broken and the entry stage read
 * zero. The numbers are now stated as what they are, two facts about the
 * addressable population, above a funnel that really is one.
 *
 * The cap numbers stay first, and stay prominent, for the reason they were
 * added: a conversion rate measured against workspaces that were never asked
 * for money is not a conversion rate, and reading this page without them was
 * how the product spent months mistaking "nobody has ever hit a paywall" for
 * "nobody wants to pay".
 */

import { fetchBillingFunnel, fetchUtilizationBands } from '@/lib/analytics/growth-queries';
import { FunnelBars } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section, StatCard } from './shared';

export async function BillingFunnelSection() {
  const [funnelResult, bandResult] = await Promise.all([fetchBillingFunnel(), fetchUtilizationBands()]);
  if (!funnelResult.ok) return <SectionError title="Billing funnel" message={funnelResult.error} />;

  const rows = funnelResult.data;
  // Current state, not history: the top two bands over each workspace's own
  // current billing period. This read zero for as long as the bands did.
  const nearCap = bandResult.ok
    ? bandResult.data
        .filter((row) => row.band === '80-99%' || row.band === '100%+')
        .reduce((total, row) => total + row.workspaces, 0)
    : 0;

  const hitCap = rows.filter((row) => row.paywall_hits > 0).length;
  const steps = [
    { label: 'Viewed pricing while signed in', value: rows.filter((row) => row.pricing_views > 0).length },
    { label: 'Reached Stripe checkout', value: rows.filter((row) => row.checkouts_started > 0).length },
    { label: 'Completed payment', value: rows.filter((row) => row.checkouts_completed > 0).length },
  ];

  const failed = rows.filter((row) => row.checkouts_failed > 0).length;
  const abandoned = rows.filter((row) => row.abandoned_checkout).length;

  return (
    <Section
      title="Billing funnel"
      explain={
        <>
          All-time. Each stage counts workspaces that reached it at least once, so a stage showing zero
          means no user has ever got that far: a measurement fact, not a preference signal. The two cap
          numbers above the funnel are stated separately rather than as its first steps, because a pricing
          view does not require a paywall hit, and treating them as one chain reports conversion against a
          population the later stages were never drawn from.
        </>
      }
    >
      <section className="growth-stat-grid" aria-label="Addressable population" style={{ marginBottom: 18 }}>
        <StatCard
          label="Near or over the action cap"
          value={nearCap}
          detail={bandResult.ok ? 'Top two utilization bands, right now' : 'Cap utilization unavailable'}
          explain="The population that could plausibly be asked to pay: at least 80 percent of the plan's allowance used in its own current billing period. A snapshot of today rather than a history, which is why it is not a stage of the funnel below."
        />
        <StatCard
          label="Ever hit the action cap"
          value={hitCap}
          detail="Workspaces refused an action for exceeding their allowance"
          explain="Enforcement currently applies to a deterministic 5 percent cohort of newer workspaces, so this measures the rollout as much as it measures demand."
        />
      </section>

      <FunnelBars title="Workspaces reaching each billing stage, all time" steps={steps} />
      <p className="growth-note">
        {failed} checkout request(s) failed outright, {abandoned} reached Stripe and left without paying.
        <InfoDot label="Checkout failures">
          A failure carrying the <code>price_not_configured</code> reason is the one to act on immediately:
          it means an unset price environment variable made a plan unbuyable, which is indistinguishable
          from disinterest in aggregate.
        </InfoDot>
      </p>
    </Section>
  );
}
