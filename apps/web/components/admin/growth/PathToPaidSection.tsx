/**
 * The path to paid: who could be charged, who looked, and who got stuck.
 *
 * THIS REPLACES THE BILLING FUNNEL SECTION, AND THE FOUR ACTION-CAP PANELS.
 * Until 2026-08-19 the metered resource was tool calls, so the page measured
 * the action cap in four places: a utilization histogram, billable actions,
 * cap-hit workspaces, and a "near or over the cap" card feeding the billing
 * funnel. The repricing moved the value metric to CONNECTED INBOXES and left
 * the action cap as a silent abuse ceiling. Nothing on the page moved with it,
 * so every one of those four panels now reports a structural zero: 259 of 260
 * workspaces sit in the bottom action band and nobody has ever hit that cap.
 * Four panels agreeing on zero reads like an absence of demand. It is an
 * absence of measurement.
 *
 * The gate that exists is the inbox cap, and 59 workspaces are standing at it.
 *
 * WHAT IS AND IS NOT A FUNNEL HERE, unchanged from the section this replaces.
 * Pricing view -> checkout -> payment is a real nested chain: every workspace
 * that reached Stripe had viewed pricing, and every completed payment started a
 * checkout. The ceiling numbers are NOT ancestors of it. A user can open the
 * pricing page without ever being refused an inbox, and most who have did
 * exactly that. Rendering them as the funnel's first rungs asserts a nesting
 * that does not exist, which is how the old section once printed "10 of 2".
 * They are stated above it, as facts about the addressable population.
 *
 * THE GRANDFATHER IS PART OF THE ANSWER. Every user who existed before the
 * repricing keeps unlimited inboxes permanently, so a conversion rate over the
 * whole estate is measured against a population most of which was never asked
 * for money. The two populations are separated everywhere on this page.
 */

import {
  fetchInboxDistribution,
  fetchUpgradePressure,
} from '@/lib/analytics/growth-queries';
import { fetchCheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import { PLANS } from '@/lib/stripe/plans';
import { BarSeries, FunnelBars, formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section, StatCard } from './shared';

export async function PathToPaidSection() {
  const [pressureResult, distributionResult, checkoutResult] = await Promise.all([
    fetchUpgradePressure(),
    fetchInboxDistribution(),
    fetchCheckoutFunnel(),
  ]);

  if (!pressureResult.ok) return <SectionError title="The path to paid" message={pressureResult.error} />;
  const pressure = pressureResult.data;
  const checkout = checkoutResult.ok ? checkoutResult.data : null;
  const freeCap = PLANS.free.limits.maxInboxes;

  const steps = checkout
    ? [
        { label: 'Viewed pricing while signed in', value: checkout.pricingViewed },
        { label: 'Reached Stripe checkout', value: checkout.checkoutStarted },
        { label: 'Completed payment', value: checkout.checkoutCompleted },
      ]
    : [];

  return (
    <Section
      title="The path to paid"
      explain={
        <>
          Since the 2026-08-19 repricing the thing customers buy is <strong>connected inboxes</strong>.
          Free allows {Number.isFinite(freeCap) ? freeCap : 'unlimited'}, and a workspace already holding
          that many is refused the next one. That refusal is the only paywall this product has, so it is
          the only population a conversion rate can honestly be measured against.
          <br /><br />
          Two things are stated separately from the funnel on purpose. The ceiling counts are a snapshot
          of today, not a stage anyone passed through, and viewing the pricing page does not require
          having been refused anything: treating them as one chain reports conversion against a
          population the later stages were never drawn from. The funnel itself counts distinct external
          workspaces, all time, with our own accounts excluded, so it does not read our own browsing back
          to us as intent.
        </>
      }
    >
      <section className="growth-stat-grid" aria-label="Addressable population" style={{ marginBottom: 18 }}>
        <StatCard
          label="At the inbox ceiling"
          value={pressure.at_ceiling}
          detail={`of ${formatCount(pressure.capped_workspaces)} workspaces the cap applies to`}
          explain="Free workspaces already holding every inbox their plan allows. Counts inboxes that exist, including ones whose connection is currently broken, exactly as the product counts them when it refuses a connect: a failing inbox still occupies the slot."
        />
        <StatCard
          label="Ceiling, and already using it"
          value={pressure.at_ceiling_activated}
          detail={`${ratio(pressure.at_ceiling_activated, pressure.at_ceiling)} of the ceiling group`}
          explain="Reached the ceiling AND performed a mailbox operation at some point. This is the population an upgrade prompt can be measured against: a workspace that hit the ceiling without ever using a mailbox is blocked by onboarding, not by price, and converting it is an activation problem."
        />
        <StatCard
          label="Cannot be charged"
          value={pressure.grandfathered_workspaces + pressure.comped_workspaces}
          detail={`${formatCount(pressure.grandfathered_over_free)} already hold more inboxes than Free allows`}
          explain={
            <>
              Free workspaces the inbox cap can never reach: everyone who existed before the repricing was
              grandfathered into unlimited inboxes <strong>permanently</strong> (migration 20260819170500),
              plus comped accounts. The second number is revenue deliberately forgone, not a bug. It is
              stated so no conversion rate on this page is ever divided by a population that cannot
              convert.
            </>
          }
        />
        <StatCard
          label="Left on Stripe's page"
          value={checkout?.abandoned ?? 0}
          detail={checkout
            ? `${formatCount(checkout.checkoutStarted)} started, ${formatCount(checkout.checkoutCompleted)} paid`
            : 'Checkout funnel unavailable'}
          explain={
            <>
              External workspaces handed a hosted Stripe checkout page that never completed. This is the
              largest single loss on the road to a payment and the cheapest to investigate, because every
              one of them had already decided to buy. A <code>price_not_configured</code> failure is the
              one to act on immediately: it means an unset price environment variable made a plan
              unbuyable, which is indistinguishable from disinterest in aggregate.
            </>
          }
        />
      </section>

      <div className="growth-split">
        {checkoutResult.ok && checkout ? (
          <div className="growth-bare">
            <FunnelBars title="External workspaces reaching each billing stage, all time" steps={steps} />
            <p className="growth-note">
              {checkout.checkoutFailed > 0
                ? `${formatCount(checkout.checkoutFailed)} checkout request(s) failed before reaching Stripe. `
                : ''}
              {formatCount(checkout.portalOpened)} existing subscriber(s) have opened the billing portal.
              {checkout.internalExcluded > 0
                ? ` ${formatCount(checkout.internalExcluded)} internal workspace(s) excluded.`
                : ''}
              <InfoDot label="Why these numbers are small">
                Every stage counts distinct workspaces, so a stage showing zero means nobody has ever got
                that far: a measurement fact, not a preference signal. These are read from
                `product_funnel_events` rather than from Stripe, because a pricing view and an abandoned
                checkout leave no trace in Stripe at all.
              </InfoDot>
            </p>
          </div>
        ) : (
          <div className="growth-error">
            <strong>Checkout funnel could not load.</strong>
            <code>{checkoutResult.ok ? 'No data' : checkoutResult.error}</code>
          </div>
        )}

        {distributionResult.ok ? (
          <BarSeries
            title="Workspaces by connected inboxes"
            subtitle="Split by whether the inbox cap can reach them."
            data={distributionResult.data.map((band) => ({
              label: band.band,
              values: [band.capped, band.exempt, band.paid],
            }))}
            series={[
              { key: 'capped', name: 'Cap applies' },
              { key: 'exempt', name: 'Grandfathered or comped' },
              { key: 'paid', name: 'Paying' },
            ]}
            stacked
            footnote="The 'cap applies' column has nothing above one inbox by construction: that is the cap working. Everything above it is either exempt or paying."
          />
        ) : (
          <div className="growth-error">
            <strong>Inbox distribution could not load.</strong>
            <code>{distributionResult.error}</code>
          </div>
        )}
      </div>
    </Section>
  );
}
