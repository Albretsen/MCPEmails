/**
 * Estate mix: what is connected, what clients are used, what plans are held,
 * and how close workspaces are to their action allowance.
 *
 * Current-state only, no time dimension. These replace four separate
 * two-column tables on the old page, which forced you to read counts without
 * any sense of relative size.
 *
 * Every number here comes from an RPC that returns a handful of aggregate rows.
 * The panels used to be built in Node from raw selects, which silently hit
 * PostgREST's 1,000-row response cap and reported every workspace in the bottom
 * utilization band while one sat at 188 percent of its cap. Nothing on this
 * page should fetch per-row data to count it.
 */

import {
  fetchClientMix,
  fetchProviderMix,
  fetchRevenueCounts,
  fetchUsageVolume,
  fetchUtilizationBands,
} from '@/lib/analytics/growth-queries';
import { planDisplayName } from '@/lib/stripe/plans';
import { formatCount } from '../charts';
import { MixBars, SectionError, Section, StatCard } from './shared';

export async function MixSection({ days }: { days: number }) {
  const [providerResult, clientResult, bandResult, volumeResult, revenueResult] = await Promise.all([
    fetchProviderMix(),
    fetchClientMix(),
    fetchUtilizationBands(),
    fetchUsageVolume(days),
    fetchRevenueCounts(),
  ]);

  // Never a plan mix built from the `plan` column: it reads 'pro' for a comp as
  // well as a purchase. Comped accounts get their own row so the paying row
  // cannot quietly absorb them, and so does an internal account on a paid plan:
  // the paying rows exclude it, and a row of its own is the difference between
  // excluded and disappeared. Internal accounts on the free plan stay inside
  // Free, which is a population count rather than a revenue one.
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const planRows = revenue
    ? [
        { name: 'Free', count: revenue.free_workspaces },
        { name: 'Comped', count: revenue.comped_workspaces },
        { name: 'Internal (paid plan)', count: revenue.internal_paying_workspaces },
        { name: `Paying (${planDisplayName('personal')})`, count: revenue.paying_personal },
        { name: `Paying (${planDisplayName('solo')})`, count: revenue.paying_solo },
        { name: `Paying (${planDisplayName('pro')})`, count: revenue.paying_scale },
      ].filter((row) => row.count > 0)
    : [];

  const volume = volumeResult.ok ? volumeResult.data : null;
  const utilizationBands = bandResult.ok
    ? bandResult.data.map((row) => ({ name: row.band, count: row.workspaces }))
    : [];

  return (
    <>
      {providerResult.ok && clientResult.ok ? (
        <Section
          title="Estate mix"
          explain="Active inboxes by provider, and the MCP client recorded with each workspace's first successful tool call. Every app-password connection is stored as a generic IMAP provider, so a named service is shown wherever one was recorded."
        >
          <div className="growth-split">
            <MixBars
              title="Mail provider"
              unit="active inboxes"
              rows={providerResult.data.map((row) => ({ name: row.provider, count: row.inboxes }))}
            />
            <MixBars
              title="MCP client"
              unit="workspaces"
              rows={clientResult.data.map((row) => ({ name: row.client, count: row.workspaces }))}
              emptyLabel="No client recorded yet."
            />
          </div>
        </Section>
      ) : (
        <SectionError
          title="Estate mix"
          message={[providerResult, clientResult].find((result) => !result.ok)?.error ?? 'Unknown error'}
        />
      )}

      {bandResult.ok ? (
        <Section
          title="Plans and cap utilization"
          explain={
            <>
              Share of each workspace&rsquo;s action allowance used <strong>in its own current billing
              period</strong>, against the cap for the plan it is on: the Stripe period for a paid plan,
              the calendar month for Free. Measured over the billing period rather than the page window
              because an allowance is only meaningful over the period it is granted for. Caps come from
              the canonical plan table, so a pricing change moves this automatically. Comped accounts and
              exempted workspaces cannot reach a cap and count in the bottom band. Cap enforcement
              currently applies to a deterministic 5 percent cohort of newer workspaces, so a cap-hit
              count near zero reflects the rollout as much as it reflects usage.
            </>
          }
        >
          <div className="growth-split">
            <MixBars title="Current plan" unit="workspaces" rows={planRows} />
            <MixBars title="Cap utilization" unit="workspaces" rows={utilizationBands} />
          </div>
          <section className="growth-stat-grid" aria-label="Usage volume" style={{ marginTop: 18, marginBottom: 0 }}>
            <StatCard
              label={`Billable actions (${days}d)`}
              value={volume?.billable_actions ?? 0}
              detail={
                volume
                  ? `${formatCount(volume.billable_workspaces)} workspace(s) with billable use`
                  : 'Usage volume unavailable'
              }
            />
            <StatCard
              label={`Cap-hit workspaces (${days}d)`}
              value={volume?.cap_hit_workspaces ?? 0}
              detail={
                volume
                  ? `${formatCount(volume.cap_rejections)} rejected billable call(s)`
                  : 'Usage volume unavailable'
              }
            />
            <StatCard
              label="Workspaces"
              value={volume?.total_workspaces ?? 0}
              detail={volume ? 'Non-deleted workspaces in total' : 'Usage volume unavailable'}
            />
            <StatCard
              label="Paying customers"
              value={revenue?.paying_workspaces ?? 0}
              detail={revenue
                ? revenue.internal_paying_workspaces > 0
                  ? `${revenue.comped_workspaces} comped and ${revenue.internal_paying_workspaces} internal, not revenue`
                  : `${revenue.comped_workspaces} comped, not revenue`
                : 'Revenue counts unavailable'}
              explain="A paid plan whose owner is external and holds no comped entitlement. Comps write the same plan column as a purchase, so counting that column alone reports them, and our own test accounts, as revenue. An external 100%-off Stripe discount is still counted: no amount or coupon is stored locally."
            />
          </section>
        </Section>
      ) : (
        <SectionError title="Plans and cap utilization" message={bandResult.error} />
      )}
    </>
  );
}
