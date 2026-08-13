/**
 * Billing funnel: all-time, workspace-level.
 *
 * Reported all-time rather than windowed because the counts are small enough
 * that a 28-day window would usually show zeros and hide the real shape.
 *
 * The entry stage is deliberately "could have been asked to pay", taken from
 * cap utilization rather than from a billing event. A conversion rate measured
 * against workspaces that were never asked for money is not a conversion rate,
 * and reading the funnel without that stage was how the product spent months
 * mistaking "nobody has ever hit a paywall" for "nobody wants to pay".
 */

import { fetchBillingFunnel } from '@/lib/analytics/growth-queries';
import { fetchInventory } from '@/lib/analytics/growth-inventory';
import { FunnelBars } from '../charts';
import { SectionError, Section } from './shared';

export async function BillingFunnelSection() {
  const [funnelResult, inventoryResult] = await Promise.all([fetchBillingFunnel(), fetchInventory(28)]);
  if (!funnelResult.ok) return <SectionError title="Billing funnel" message={funnelResult.error} />;

  const rows = funnelResult.data;
  const nearCap = inventoryResult.ok
    ? inventoryResult.data.utilizationBands
        .filter((band) => band.name === '80-99%' || band.name === '100%+')
        .reduce((total, band) => total + band.count, 0)
    : 0;

  const steps = [
    { label: 'Near or over the action cap (28d)', value: nearCap, note: 'The population that could plausibly be asked to pay' },
    { label: 'Hit the action cap', value: rows.filter((row) => row.paywall_hits > 0).length },
    { label: 'Viewed pricing while signed in', value: rows.filter((row) => row.pricing_views > 0).length },
    { label: 'Reached Stripe checkout', value: rows.filter((row) => row.checkouts_started > 0).length },
    { label: 'Completed payment', value: rows.filter((row) => row.checkouts_completed > 0).length },
  ];

  const failed = rows.filter((row) => row.checkouts_failed > 0).length;
  const abandoned = rows.filter((row) => row.abandoned_checkout).length;

  return (
    <Section
      title="Billing funnel"
      blurb="All-time. Each stage counts workspaces that reached it at least once. A stage showing zero means no user has ever got that far, which is a measurement fact, not a preference signal."
    >
      <div className="growth-panel">
        <FunnelBars title="Workspaces reaching each billing stage, all time" steps={steps} />
      </div>
      <p className="growth-note">
        Off to the side of the funnel: <strong>{failed}</strong> workspace(s) had a checkout request fail outright,
        and <strong>{abandoned}</strong> reached Stripe and left without paying. A failure carrying the
        <code> price_not_configured </code> reason is the one to act on immediately: it means an unset price
        environment variable made a plan unbuyable, which is indistinguishable from disinterest in aggregate.
      </p>
    </Section>
  );
}
