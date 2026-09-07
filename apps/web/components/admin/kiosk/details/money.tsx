/**
 * The six panels behind the Money view's tiles.
 *
 * The pattern is audience.tsx's, written out there once: one `Promise.all` per
 * panel so the thing paints in a single frame, a `TileError` rather than a zero
 * whenever a read did not answer, and aggregates only, because this display
 * hangs on a wall in a room with other people in it.
 *
 * WHAT IS DIFFERENT ABOUT THE MONEY PANELS: THE WINDOW MOSTLY DOES NOT APPLY.
 * A Stripe subscription is either live right now or it is not, and cash that
 * arrived last March is still in the bank. Printing "last 7 days" over either
 * of those would be a lie that the window switch above it makes look
 * authoritative, which is why the registry marks all six `window: 'fixed'`.
 * The one figure the window genuinely owns is MOVEMENT: `fetchRecurringRevenue`
 * takes a window and uses it to decide what counts as new and what counts as
 * churned. So `days` is passed through, the movement tiles say which window
 * they are reporting, and every other tile says "live" or "all time" instead.
 *
 * THE THREE MONEY NUMBERS ARE MEANT TO DISAGREE, and the panels lean on that
 * rather than reconciling it. MRR is forward looking and normalised, so a year
 * bought up front is a twelfth per month. Cash is what actually reached the
 * bank, which for that same customer was the whole year in one afternoon. The
 * valuation is MRR run through one arithmetic convention and nothing more. A
 * reader who notices the three do not match has understood the business rather
 * than found a bug, so each panel says so in its own note.
 */

import {
  fetchBillingFunnel,
  fetchRevenueCounts,
  fetchUpgradePressure,
} from '@/lib/analytics/growth-queries';
import type { BillingFunnelRow } from '@/lib/analytics/growth-queries';
import {
  fetchCashCollected,
  fetchCheckoutFunnel,
  fetchRecurringRevenue,
  valuationMultiple,
} from '@/lib/analytics/kiosk-revenue';
import type { CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import { planSplit, valuationFromArr } from '@/lib/analytics/revenue-math';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import { NO_DATA, formatCount, formatMoney, ratio } from '../../charts';
import {
  BarList,
  BigNumber,
  FactRow,
  FunnelSteps,
  GroupedColumns,
  SplitList,
  Tile,
  TileError,
} from '../primitives';
import { CHART_WEEKS, checkoutSteps } from '../shared';
import { windowShort } from '../windows';
import type { KioskDetailProps } from './registry';

/** Same format as the board's cash tile, so the two never label a month differently. */
const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Months of cash history a panel table shows. Six fits without scrolling the tile. */
const CASH_TABLE_MONTHS = 6;

/* ------------------------------------------------------------------ revenue */

/**
 * Behind "Recurring revenue": what is actually recurring.
 *
 * The tile shows one number per month. Standing at the glass the question is
 * always which subscriptions that number is made of, whether it moved, and why
 * it is not the same as the money in the bank. So: the mix by plan with each
 * plan's share, the movement inside the window, and MRR set beside cash so the
 * gap between them is stated rather than left to be discovered.
 */
export async function RevenueDetail({ days }: KioskDetailProps) {
  const [recurring, counts, cash] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchRevenueCounts(),
    fetchCashCollected(),
  ]);

  return (
    <>
      {recurring.ok ? (
        <Tile
          label="Monthly recurring revenue"
          aside="live subscriptions"
          span={4}
          tone={recurring.data.mrrMinor > 0 ? 'good' : 'goal'}
        >
          <BigNumber
            value={formatMoney(recurring.data.mrrMinor, recurring.data.currency)}
            suffix="/mo"
            caption={
              <>
                <strong>{formatMoney(recurring.data.arrMinor, recurring.data.currency)}</strong> a year at
                today&rsquo;s rate
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Subscribers', value: recurring.data.payingCustomers },
              { label: 'Each, per month', value: formatMoney(recurring.data.arpaMinor, recurring.data.currency) },
              // Comped accounts are live subscriptions on a paid price carrying
              // a 100% off coupon: real people, no money. They are named here
              // rather than folded into the subscriber count, which is the one
              // number on this panel that has to stay uninflatable.
              { label: 'Comped', value: recurring.data.compedCustomers },
              { label: 'Ours, excluded', value: recurring.data.internalCustomers },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Monthly recurring revenue" message={recurring.error} span={4} />
      )}

      {/* The share column is against MRR, not against subscriber count. With
          four tiers sold monthly and yearly, one Team seat and six Personal
          ones are the same row count and a very different business, and the
          share is the only column that says which of those we are. */}
      {recurring.ok ? (
        <Tile
          label="Which tier the money is in"
          aside={
            recurring.data.otherCurrencies.length > 0
              ? `plus ${recurring.data.otherCurrencies.map((code) => code.toUpperCase()).join('/')}`
              : recurring.data.currency.toUpperCase()
          }
          span={8}
        >
          {recurring.data.byPlan.length === 0 ? (
            <p className="kiosk-empty">No paid subscription is live.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="is-num">Subscribers</th>
                  <th className="is-num">Per month</th>
                  <th className="is-num">Share of MRR</th>
                </tr>
              </thead>
              <tbody>
                {recurring.data.byPlan.map((plan) => (
                  <tr key={plan.label}>
                    <td>{plan.label}</td>
                    <td className="is-num">{formatCount(plan.customers)}</td>
                    <td className="is-num">{formatMoney(plan.mrrMinor, recurring.data.currency)}</td>
                    <td className="is-num">{ratio(plan.mrrMinor, recurring.data.mrrMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Which tier the money is in" message={recurring.error} span={8} />
      )}

      {/* The one tile on this panel the window switch genuinely owns. New and
          churned are decided by `windowDays` inside summarizeSubscriptions, so
          the aside says which window produced them; everything else here is
          live state and says so. */}
      {recurring.ok ? (
        <Tile
          label="What moved"
          aside={windowShort(days)}
          span={6}
          tone={recurring.data.netNewMrrMinor < 0 ? 'bad' : recurring.data.netNewMrrMinor > 0 ? 'good' : 'default'}
        >
          <BigNumber
            value={formatMoney(recurring.data.netNewMrrMinor, recurring.data.currency)}
            suffix="/mo"
            caption={movementCaption(recurring.data, days)}
          />
          <FactRow
            facts={[
              { label: 'Won', value: formatMoney(recurring.data.newMrrMinor, recurring.data.currency) },
              { label: 'New subscriptions', value: recurring.data.newCustomers },
              { label: 'Lost', value: formatMoney(recurring.data.churnedMrrMinor, recurring.data.currency) },
              { label: 'Ended', value: recurring.data.churnedCustomers },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="What moved" message={recurring.error} span={6} />
      )}

      {/* Both reads or neither. A cash figure beside a missing MRR, or the
          reverse, is the exact comparison this tile exists to make, and half of
          it is worse than none: the reader would take the surviving number as
          the answer to a question it does not answer. */}
      {recurring.ok && cash.ok ? (
        <Tile
          label="Recurring against arrived"
          aside={cash.data.mode === 'test' ? 'TEST MODE' : 'all time'}
          span={6}
          tone={cash.data.mode === 'test' ? 'warn' : 'default'}
        >
          <FactRow
            facts={[
              { label: 'Recurring, per month', value: formatMoney(recurring.data.mrrMinor, recurring.data.currency) },
              { label: 'Recurring, per year', value: formatMoney(recurring.data.arrMinor, recurring.data.currency) },
              { label: 'Cash in, all time', value: formatMoney(cash.data.allTimeMinor, cash.data.currency) },
              { label: 'Cash in, last 30d', value: formatMoney(cash.data.last30Minor, cash.data.currency) },
            ]}
          />
          {/* `kiosk-empty` for a sentence that is not an empty state: it is the
              board's only muted in-tile prose style, and inventing a class for
              one paragraph is how a stylesheet grows a second way to say the
              same thing. */}
          <p className="kiosk-empty">
            A year bought up front lands once and is recognised twelve times, so these two are supposed to
            differ. {formatCount(cash.data.charges)} charges have succeeded
            {counts.ok ? `, against ${formatCount(counts.data.free_workspaces)} free workspaces still to convert` : ''}.
          </p>
        </Tile>
      ) : (
        <TileError
          label="Recurring against arrived"
          message={!recurring.ok ? recurring.error : !cash.ok ? cash.error : 'unavailable'}
          span={6}
        />
      )}

      <p className="kiosk-detail-note">
        Priced from Stripe, never from our own price table: a comped account is a live subscription carrying a
        100% off coupon, and against the price table it would read as full revenue. This is NOT cash, NOT
        bookings and NOT a forecast. Yearly plans are shown at a twelfth a month, a card that is failing is
        still counted because dunning has not given up on it, and expansion or contraction from a plan change
        is not modelled at all. Only the movement tile uses the {windowShort(days)} window; everything else is
        live state and does not move when the window does. Our own accounts are excluded throughout.
      </p>
    </>
  );
}

/** One line under the net-new figure, naming the window it was measured over. */
function movementCaption(mrr: RevenueSummary, days: number) {
  if (mrr.newCustomers === 0 && mrr.churnedCustomers === 0) {
    return <>Nothing started or ended in the last {days} days.</>;
  }
  return (
    <>
      <strong>{formatMoney(mrr.newMrrMinor, mrr.currency)}</strong> won and{' '}
      <strong>{formatMoney(mrr.churnedMrrMinor, mrr.currency)}</strong> lost in the last {days} days
    </>
  );
}

/* ---------------------------------------------------------------- valuation */

/**
 * Behind "Company valuation": the arithmetic, and what it is not.
 *
 * This is the one figure on any board that was arrived at by multiplication,
 * and a large currency number on a wall is the single easiest thing in this
 * building to mistake for a fact. So the panel's main job is to SHOW ITS
 * WORKING: three rows of arithmetic anyone can check, the multiple named, and
 * the cash that has genuinely arrived sitting beside it for scale.
 */
export async function ValuationDetail({ days }: KioskDetailProps) {
  const [recurring, cash] = await Promise.all([fetchRecurringRevenue(days), fetchCashCollected()]);
  const valuation = recurring.ok ? valuationFromArr(recurring.data.arrMinor, valuationMultiple()) : null;

  return (
    <>
      {recurring.ok && valuation ? (
        // `goal` is the board's existing frame for a constructed number rather
        // than an achieved one, and this is the only figure here that was
        // arrived at rather than measured.
        <Tile label="On this convention" aside={`${valuation.multiple}x ARR`} span={4} tone="goal">
          <BigNumber
            value={formatMoney(valuation.valuationMinor, recurring.data.currency)}
            caption={
              <>
                <strong>{formatMoney(valuation.arrMinor, recurring.data.currency)}</strong> ARR at{' '}
                {valuation.multiple}x. An arithmetic convention, not an offer.
              </>
            }
          />
        </Tile>
      ) : (
        <TileError
          label="On this convention"
          message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error}
          span={4}
        />
      )}

      {/* The working, in full. Every row is one operation on the row above it,
          so a reader who disagrees with the answer can see exactly which step
          they disagree with rather than having to trust the total. */}
      {recurring.ok && valuation ? (
        <Tile label="How it is arrived at" aside="three steps" span={8}>
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>Step</th>
                <th className="is-num">Figure</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Recurring revenue, priced from Stripe</td>
                <td className="is-num">{formatMoney(recurring.data.mrrMinor, recurring.data.currency)} /mo</td>
              </tr>
              <tr>
                <td>Times twelve months</td>
                <td className="is-num">{formatMoney(valuation.arrMinor, recurring.data.currency)} ARR</td>
              </tr>
              <tr>
                <td>Times the {valuation.multiple}x ARR multiple</td>
                <td className="is-num">{formatMoney(valuation.valuationMinor, recurring.data.currency)}</td>
              </tr>
            </tbody>
          </table>
        </Tile>
      ) : (
        <TileError
          label="How it is arrived at"
          message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error}
          span={8}
        />
      )}

      {/* What one subscriber is worth on the same convention. This is the
          number that makes the multiple concrete, and it is also the honest
          way to read the headline: at this size the whole figure is a handful
          of people, any one of whom can cancel on a Tuesday. */}
      {recurring.ok && valuation ? (
        <Tile label="What one subscriber carries" aside="same convention" span={6}>
          <BigNumber
            value={formatMoney(Math.round(recurring.data.arpaMinor * 12 * valuation.multiple), recurring.data.currency)}
            caption={
              recurring.data.payingCustomers === 0
                ? <>Nobody is paying, so the convention values the business at nothing.</>
                : <>Each of <strong>{formatCount(recurring.data.payingCustomers)}</strong> subscribers, valued the same way</>
            }
          />
          <FactRow
            facts={[
              { label: 'Per subscriber, per month', value: formatMoney(recurring.data.arpaMinor, recurring.data.currency) },
              { label: 'Subscribers', value: recurring.data.payingCustomers },
              // Comps are in this tile because they are the clearest proof the
              // figure is priced rather than counted: they are live
              // subscriptions that add nothing to it.
              { label: 'Comped, worth nothing here', value: recurring.data.compedCustomers },
            ]}
          />
        </Tile>
      ) : (
        <TileError
          label="What one subscriber carries"
          message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error}
          span={6}
        />
      )}

      {cash.ok ? (
        <Tile
          label="Money that actually exists"
          aside={cash.data.mode === 'test' ? 'TEST MODE' : cash.data.truncated ? 'at least' : 'all time'}
          span={6}
          tone={cash.data.mode === 'test' ? 'warn' : 'default'}
        >
          <BigNumber
            value={formatMoney(cash.data.allTimeMinor, cash.data.currency)}
            caption={
              cash.data.charges === 0
                ? <>No charge has ever succeeded.</>
                : <><strong>{formatCount(cash.data.charges)}</strong> successful charges, net of refunds</>
            }
          />
          <FactRow
            facts={[
              { label: 'Last 30 days', value: formatMoney(cash.data.last30Minor, cash.data.currency) },
              { label: 'Since', value: cash.data.since ? MONTH_LABEL.format(new Date(cash.data.since)) : NO_DATA },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Money that actually exists" message={cash.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        This is NOT a valuation, NOT an offer, NOT an appraisal and NOT anything anyone has bid. It is one
        month of recurring revenue multiplied by twelve and then by a round number that lives in an
        environment variable, and it moves the instant MRR moves. It inherits every one of MRR&rsquo;s
        caveats: comped subscriptions contribute nothing, yearly plans count at a twelfth a month, and a
        failing card is still counted until dunning gives up. Zero ARR gives zero rather than a floor. The
        window switch does not apply to any figure on this panel.
      </p>
    </>
  );
}

/* -------------------------------------------------------------- subscribers */

/**
 * Behind "Paying subscribers": who is on what.
 *
 * The count cannot be derived from the money beside it, which is the whole
 * reason it gets wall space: one Team seat and sixteen Personal ones are the
 * same MRR and completely different businesses. This panel is the mix in full,
 * plus the two populations the count is drawn from: the free workspaces that
 * could still convert, and the ones already standing at the inbox ceiling.
 */
export async function SubscribersDetail({ days }: KioskDetailProps) {
  const [recurring, counts, pressure] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchRevenueCounts(),
    fetchUpgradePressure(),
  ]);

  return (
    <>
      {recurring.ok ? (
        <Tile
          label="Paying right now"
          aside={recurring.data.compedCustomers > 0 ? `${recurring.data.compedCustomers} comped` : 'paid plans'}
          span={4}
          tone={recurring.data.payingCustomers > 0 ? 'good' : 'goal'}
        >
          <BigNumber
            value={recurring.data.payingCustomers}
            caption={
              recurring.data.payingCustomers === 0
                ? <>Nobody is on a paid plan yet.</>
                : <><strong>{formatMoney(recurring.data.mrrMinor, recurring.data.currency)}</strong> a month between them</>
            }
          />
          {/* planSplit rather than a slice: with four tiers sold two ways there
              are up to eight groups, and dropping the tail is how the board
              once showed a mix of three under a headline of ten. The tail
              collapses into one counted row so the list always sums to the
              number above it. */}
          <SplitList
            rows={planSplit(recurring.data.byPlan, 4).map((plan) => ({ label: plan.label, count: plan.customers }))}
          />
        </Tile>
      ) : (
        <TileError label="Paying right now" message={recurring.error} span={4} />
      )}

      {recurring.ok ? (
        <Tile label="Who is on what" aside="live subscriptions" span={8}>
          {recurring.data.byPlan.length === 0 ? (
            <p className="kiosk-empty">No paid subscription is live.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="is-num">Subscribers</th>
                  <th className="is-num">Per month</th>
                  <th className="is-num">Each</th>
                </tr>
              </thead>
              <tbody>
                {recurring.data.byPlan.map((plan) => (
                  <tr key={plan.label}>
                    <td>{plan.label}</td>
                    <td className="is-num">{formatCount(plan.customers)}</td>
                    <td className="is-num">{formatMoney(plan.mrrMinor, recurring.data.currency)}</td>
                    <td className="is-num">
                      {plan.customers > 0
                        ? formatMoney(Math.round(plan.mrrMinor / plan.customers), recurring.data.currency)
                        : NO_DATA}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Who is on what" message={recurring.error} span={8} />
      )}

      {/* The estate the subscriber count is a fraction of. Counted in
          WORKSPACES from Postgres, not in subscriptions from Stripe, so it
          will not add up to the tile above and is labelled to say so. */}
      {counts.ok ? (
        <Tile label="The estate it is drawn from" aside="workspaces" span={6}>
          <BarList
            rows={[
              { name: 'Free', count: counts.data.free_workspaces, color: 'var(--fg-4)' },
              { name: 'Paying', count: counts.data.paying_workspaces, color: 'var(--kiosk-good)' },
              { name: 'Comped', count: counts.data.comped_workspaces, color: 'var(--kiosk-accent)' },
              { name: 'Ours', count: counts.data.internal_workspaces, color: 'var(--kiosk-warn)' },
            ]}
            emptyLabel="No workspace exists yet"
          />
          <FactRow
            facts={[
              { label: 'Paying owners', value: counts.data.paying_owners },
              { label: 'Paid, ours', value: counts.data.internal_paying_workspaces },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="The estate it is drawn from" message={counts.error} span={6} />
      )}

      {/* Where the next subscriber most plausibly comes from. Since the
          2026-08-19 repricing the paywall is the inbox count, so the activated
          subset is the number worth acting on: a workspace that hit the ceiling
          without ever performing a mailbox operation is blocked by onboarding
          rather than by price. */}
      {pressure.ok ? (
        <Tile
          label="Standing at the inbox ceiling"
          aside={`${pressure.data.grandfathered_workspaces} exempt`}
          span={6}
          tone={pressure.data.at_ceiling_activated > 0 ? 'goal' : 'default'}
        >
          <BigNumber
            value={pressure.data.at_ceiling}
            caption={
              <>
                <strong>{formatCount(pressure.data.at_ceiling_activated)}</strong> of them have already used a
                mailbox
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Capped at all', value: pressure.data.capped_workspaces },
              { label: 'Capped and active', value: pressure.data.capped_activated },
              { label: 'Grandfathered over the cap', value: pressure.data.grandfathered_over_free },
              { label: 'Already paid', value: pressure.data.paid_workspaces },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Standing at the inbox ceiling" message={pressure.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        The headline counts live Stripe SUBSCRIPTIONS that pay something; the two lower tiles count
        WORKSPACES in our own database. They are not the same unit and are not expected to add up: one
        subscription can own several workspaces, and a workspace that never opened a checkout has no
        subscription at all. Comped accounts are excluded from the headline because they pay nothing, and
        counted below because they are real people using the product. This is NOT seats, NOT signups and NOT
        active users. The window switch does not apply: every figure here is live state.
      </p>
    </>
  );
}

/* --------------------------------------------------------------------- cash */

/**
 * Behind "Cash collected": what actually arrived.
 *
 * The only money figure on the board that is a fact about the past. Charges
 * rather than invoices, because an invoice can be settled from a credit
 * balance that moved no money at all, and refunds are netted against the month
 * the charge landed in rather than the month somebody asked for them back.
 */
export async function CashDetail({ days }: KioskDetailProps) {
  const [cash, recurring] = await Promise.all([fetchCashCollected(), fetchRecurringRevenue(days)]);

  return (
    <>
      {cash.ok ? (
        <Tile
          label="Collected, net of refunds"
          // TEST MODE is shouted rather than footnoted: .env.local holds a test
          // key and only Vercel production holds the live one, so a locally
          // rendered board would otherwise print test dollars in the same
          // typeface as real ones.
          aside={cash.data.mode === 'test' ? 'TEST MODE' : cash.data.truncated ? 'at least' : 'all time'}
          span={4}
          tone={cash.data.mode === 'test' ? 'warn' : cash.data.allTimeMinor > 0 ? 'good' : 'goal'}
        >
          <BigNumber
            value={formatMoney(cash.data.allTimeMinor, cash.data.currency)}
            caption={
              cash.data.charges === 0
                ? <>No charge has ever succeeded.</>
                : <><strong>{formatMoney(cash.data.last30Minor, cash.data.currency)}</strong> of it in the last 30 days</>
            }
          />
          <FactRow
            facts={[
              { label: 'Charges', value: cash.data.charges },
              { label: 'Since', value: cash.data.since ? MONTH_LABEL.format(new Date(cash.data.since)) : NO_DATA },
              { label: 'Currency', value: cash.data.currency.toUpperCase() },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Collected, net of refunds" message={cash.error} span={4} />
      )}

      {/* By month, not by week. A handful of customers pay on a handful of
          different days, so a weekly cash chart is a few spikes and a lot of
          nothing; a month is the smallest bucket in which this business has a
          shape at all. Whole units, because minor units on a chart axis is a
          number nobody reads. */}
      {cash.ok ? (
        <Tile label="Cash by month" aside={`${CHART_WEEKS} months`} span={8}>
          {cash.data.months.length === 0 ? (
            <p className="kiosk-empty">No charge has ever succeeded.</p>
          ) : (
            <GroupedColumns
              buckets={cash.data.months.slice(-CHART_WEEKS).map((month) => ({
                label: MONTH_LABEL.format(new Date(`${month.month}T00:00:00Z`)),
                values: [Math.round(month.netMinor / 100)],
              }))}
              series={[{ name: `Net cash (${cash.data.currency.toUpperCase()})`, color: 'var(--kiosk-good)' }]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Cash by month" message={cash.error} span={8} />
      )}

      {/* Gross and refunded as their own columns, newest first. The chart above
          draws the net only, and a month where a large charge was refunded and
          a replacement one landed looks identical there to a quiet month. */}
      {cash.ok ? (
        <Tile label="Month by month" aside="newest first" span={6}>
          {cash.data.months.length === 0 ? (
            <p className="kiosk-empty">No charge has ever succeeded.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="is-num">Gross</th>
                  <th className="is-num">Refunded</th>
                  <th className="is-num">Net</th>
                </tr>
              </thead>
              <tbody>
                {cash.data.months
                  .slice(-CASH_TABLE_MONTHS)
                  .reverse()
                  .map((month) => (
                    <tr key={month.month}>
                      <td>{MONTH_LABEL.format(new Date(`${month.month}T00:00:00Z`))}</td>
                      <td className="is-num">{formatMoney(month.grossMinor, cash.data.currency)}</td>
                      <td className="is-num">
                        {month.refundedMinor > 0 ? formatMoney(month.refundedMinor, cash.data.currency) : NO_DATA}
                      </td>
                      <td className="is-num">{formatMoney(month.netMinor, cash.data.currency)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Month by month" message={cash.error} span={6} />
      )}

      {recurring.ok && cash.ok ? (
        <Tile label="Why this is not MRR" aside="the same money, twice" span={6}>
          <FactRow
            facts={[
              { label: 'Cash in, all time', value: formatMoney(cash.data.allTimeMinor, cash.data.currency) },
              { label: 'Cash in, last 30d', value: formatMoney(cash.data.last30Minor, cash.data.currency) },
              { label: 'Recurring, per month', value: formatMoney(recurring.data.mrrMinor, recurring.data.currency) },
              { label: 'Recurring, per year', value: formatMoney(recurring.data.arrMinor, recurring.data.currency) },
            ]}
          />
          {/* Muted in-tile prose, same reuse of `kiosk-empty` as the revenue panel. */}
          <p className="kiosk-empty">
            A year bought up front arrives once and is recognised twelve times. The two figures are supposed
            to disagree, and by roughly that much.
          </p>
        </Tile>
      ) : (
        <TileError
          label="Why this is not MRR"
          message={!cash.ok ? cash.error : !recurring.ok ? recurring.error : 'unavailable'}
          span={6}
        />
      )}

      <p className="kiosk-detail-note">
        Successful CHARGES, not invoices: an invoice can be settled from a credit balance that moved no
        money. Refunds are netted against the month the charge landed in, not the month the refund happened,
        so an old month can move. This is NOT revenue recognition, NOT profit and NOT net of Stripe&rsquo;s
        fees or of any cost we pay. Our own purchases are excluded, which is why the live 100% off test
        buys do not appear as cash that never arrived. &ldquo;All time&rdquo; reaches back two years and
        pages to a ceiling; if it ever hits that ceiling the tile says &ldquo;at least&rdquo; rather than
        quietly understating. The window switch does not apply to anything on this panel.
      </p>
    </>
  );
}

/* ----------------------------------------------------------------- checkout */

/**
 * Behind "Where the money is lost": which rung people fall off.
 *
 * ALL TIME, ON PURPOSE. At a handful of checkouts a year, any window short
 * enough to be interesting shows zeros and hides the shape entirely.
 *
 * The rung to read first is abandonment. It is the only step where somebody had
 * already decided to pay us and did not, which makes it the one number on this
 * panel with a fix attached rather than a strategy.
 */
export async function CheckoutDetail({ days }: KioskDetailProps) {
  const [checkout, recurring, billing] = await Promise.all([
    fetchCheckoutFunnel(),
    fetchRecurringRevenue(days),
    fetchBillingFunnel(),
  ]);
  const mrr = recurring.ok ? recurring.data : null;
  // Built once rather than per branch below: it walks every workspace row, and
  // the empty case has to test the same ladder the tile renders.
  const paywall = billing.ok ? paywallSteps(billing.data) : null;

  return (
    <>
      {checkout.ok ? (
        <Tile
          label="The road to paying us"
          aside={checkout.data.lastCompletedAt ? `last sale ${daysAgo(checkout.data.lastCompletedAt)}` : 'no sale yet'}
          span={7}
        >
          <FunnelSteps steps={checkoutSteps(checkout.data, mrr)} />
        </Tile>
      ) : (
        <TileError label="The road to paying us" message={checkout.error} span={7} />
      )}

      {checkout.ok ? (
        <Tile
          label="Left on Stripe's page"
          aside="had decided to pay"
          span={5}
          tone={checkout.data.abandoned > 0 ? 'bad' : 'good'}
        >
          <BigNumber
            value={checkout.data.abandoned}
            caption={
              checkout.data.abandoned === 0
                ? <>Everyone who started a checkout finished it.</>
                : <>of <strong>{formatCount(checkout.data.checkoutStarted)}</strong> workspaces that started one</>
            }
          />
          <FactRow
            facts={[
              { label: 'Paid', value: checkout.data.checkoutCompleted },
              // A checkout that could not be created is our bug, not a change
              // of mind, and it is the one row here nobody can fix by writing
              // better pricing copy.
              { label: 'Could not start', value: checkout.data.checkoutFailed },
              { label: 'Opened the portal', value: checkout.data.portalOpened },
              { label: 'Ours, excluded', value: checkout.data.internalExcluded },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Left on Stripe's page" message={checkout.error} span={5} />
      )}

      {/* Every rung as a share of the people who LOOKED AT THE PLANS, not of
          every signup. This panel asks what happens to intent once it exists,
          and dividing by the whole estate would bury a high abandonment rate
          under a small percentage. */}
      {checkout.ok ? (
        <Tile label="Rung by rung" aside="of those who looked" span={6}>
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="is-num">Workspaces</th>
                <th className="is-num">Of viewers</th>
              </tr>
            </thead>
            <tbody>
              {checkoutStages(checkout.data).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="is-num">{formatCount(row.value)}</td>
                  <td className="is-num">{row.share ? ratio(row.value, checkout.data.pricingViewed) : NO_DATA}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tile>
      ) : (
        <TileError label="Rung by rung" message={checkout.error} span={6} />
      )}

      {/* THE PAYWALL IS THE ONE THING THE FUNNEL ABOVE CANNOT SEE. A refusal to
          connect another inbox is not a billing event, so it exists only in
          this view, which is also the reason the numbers here will not match
          the tiles above: `billing_funnel_by_workspace` aggregates before
          anything knows who owns a workspace, so it cannot drop ours. Read it
          as a shape, not as a count, and the note below says so. */}
      {paywall ? (
        <Tile label="After the paywall said no" aside="includes ours" span={6}>
          {paywall[0].value === 0 ? (
            <p className="kiosk-empty">No workspace has been refused by the inbox paywall.</p>
          ) : (
            <FunnelSteps steps={paywall} />
          )}
        </Tile>
      ) : (
        <TileError
          label="After the paywall said no"
          message={billing.ok ? 'The billing funnel view returned no rows.' : billing.error}
          span={6}
        />
      )}

      <p className="kiosk-detail-note">
        Counted in distinct WORKSPACES, all time, and not in people or in money: a workspace that started
        three checkouts is one row on every rung it reached. This is NOT a conversion rate for a period, NOT
        revenue and NOT a measure of traffic, since only signed-in views are recorded at all. The top three
        tiles exclude our own accounts, which matters here more than anywhere else on the board because the
        owner&rsquo;s own pricing visits and live test purchases are a large share of every billing event
        ever recorded. The paywall tile cannot exclude them and says so in its corner. The window switch
        does not apply: all of it is all-time.
      </p>
    </>
  );
}

/**
 * The checkout stages as table rows.
 *
 * Not shared with `checkoutSteps` in shared.ts even though they overlap: that
 * one is a ladder with notes for a funnel drawn on a wall, this one is a table
 * with a share column read at arm's length, and folding them together would
 * mean one of the two carrying fields the other ignores.
 */
function checkoutStages(funnel: CheckoutFunnel) {
  return [
    { label: 'Looked at the plans', value: funnel.pricingViewed, share: false },
    { label: 'Started a checkout', value: funnel.checkoutStarted, share: true },
    { label: 'Abandoned on Stripe', value: funnel.abandoned, share: true },
    { label: 'Paid', value: funnel.checkoutCompleted, share: true },
  ];
}

/**
 * What a workspace refused by the inbox paywall did next.
 *
 * Each rung is "of the workspaces that hit the paywall, how many then reached
 * this step", so the ladder narrows for one reason only. Counted per workspace
 * rather than per hit: somebody looping a connect attempt six times is one
 * person being told no, not six.
 */
function paywallSteps(rows: BillingFunnelRow[]) {
  const blocked = rows.filter((row) => row.paywall_hits > 0);
  return [
    { label: 'Refused by the paywall', value: blocked.length, note: 'inbox cap reached' },
    { label: 'Then looked at the plans', value: blocked.filter((row) => row.pricing_views > 0).length },
    { label: 'Then started a checkout', value: blocked.filter((row) => row.checkouts_started > 0).length },
    { label: 'Then paid', value: blocked.filter((row) => row.checkouts_completed > 0).length },
  ];
}

/** Whole days since an ISO timestamp, phrased for a wall. */
function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/* ------------------------------------------------------------------ at risk */

/**
 * Behind "Money at risk": what is about to stop paying.
 *
 * MONEY AT RISK IS STILL COUNTED IN MRR, and this panel exists because that is
 * the only honest arrangement. The app entitles a failing card through the
 * dunning grace period, so dropping it from revenue on the first bounce would
 * paint a collapse that has not happened; leaving it in silently would hide the
 * only money on the board with a deadline attached. It is in the total and
 * named here.
 */
export async function AtRiskDetail({ days }: KioskDetailProps) {
  const [recurring, counts] = await Promise.all([fetchRecurringRevenue(days), fetchRevenueCounts()]);

  return (
    <>
      {recurring.ok ? (
        <Tile
          label="Exposed right now"
          aside={recurring.data.atRiskCustomers + recurring.data.leavingCustomers === 0 ? 'nothing' : 'walk over'}
          span={4}
          tone={
            recurring.data.atRiskMinor > 0 ? 'bad' : recurring.data.leavingMinor > 0 ? 'warn' : 'good'
          }
        >
          <BigNumber
            value={formatMoney(recurring.data.atRiskMinor + recurring.data.leavingMinor, recurring.data.currency)}
            suffix="/mo"
            caption={riskCaption(recurring.data)}
          />
          <FactRow
            facts={[
              { label: 'Card failing', value: recurring.data.atRiskCustomers },
              { label: 'Winding down', value: recurring.data.leavingCustomers },
              { label: 'Of MRR', value: ratio(recurring.data.atRiskMinor + recurring.data.leavingMinor, recurring.data.mrrMinor) },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Exposed right now" message={recurring.error} span={4} />
      )}

      {recurring.ok ? (
        <Tile label="The state of every subscription" aside="live subscriptions" span={8}>
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>State</th>
                <th className="is-num">Subscriptions</th>
                <th className="is-num">Per month</th>
                <th className="is-num">Of MRR</th>
              </tr>
            </thead>
            <tbody>
              {riskRows(recurring.data).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="is-num">{formatCount(row.customers)}</td>
                  <td className="is-num">{formatMoney(row.minor, recurring.data.currency)}</td>
                  <td className="is-num">{ratio(row.minor, recurring.data.mrrMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tile>
      ) : (
        <TileError label="The state of every subscription" message={recurring.error} span={8} />
      )}

      {/* What has already gone, over the window, so the exposure above can be
          read against the rate it has historically been realised at. This is
          the one tile on the panel the window switch owns. */}
      {recurring.ok ? (
        <Tile
          label="What has already gone"
          aside={windowShort(days)}
          span={6}
          tone={recurring.data.churnedMrrMinor > 0 ? 'warn' : 'default'}
        >
          <BigNumber
            value={formatMoney(recurring.data.churnedMrrMinor, recurring.data.currency)}
            suffix="/mo"
            caption={
              recurring.data.churnedCustomers === 0
                ? <>No subscription stopped billing in the last {days} days.</>
                : <><strong>{formatCount(recurring.data.churnedCustomers)}</strong> subscriptions stopped billing in the last {days} days</>
            }
          />
          <FactRow
            facts={[
              { label: 'Won back', value: formatMoney(recurring.data.newMrrMinor, recurring.data.currency) },
              { label: 'Net', value: formatMoney(recurring.data.netNewMrrMinor, recurring.data.currency) },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="What has already gone" message={recurring.error} span={6} />
      )}

      {/* CONCENTRATION IS THE REAL RISK AT THIS SIZE, and it is not on the tile
          this panel sits behind. With a subscriber count in single digits the
          average subscriber is a large share of the whole, so one cancellation
          on a Tuesday is a double digit move in every money figure on the
          board. */}
      {recurring.ok ? (
        <Tile label="What one cancellation costs" aside="concentration" span={6} tone="goal">
          <BigNumber
            value={formatMoney(recurring.data.arpaMinor, recurring.data.currency)}
            suffix="/mo"
            caption={
              recurring.data.payingCustomers === 0
                ? <>Nobody is paying, so there is nothing to lose.</>
                : <>The average subscriber is <strong>{ratio(recurring.data.arpaMinor, recurring.data.mrrMinor)}</strong> of all recurring revenue</>
            }
          />
          <FactRow
            facts={[
              { label: 'Subscribers', value: recurring.data.payingCustomers },
              {
                label: 'Largest tier',
                value: recurring.data.byPlan[0]
                  ? `${recurring.data.byPlan[0].label}, ${ratio(recurring.data.byPlan[0].mrrMinor, recurring.data.mrrMinor)}`
                  : NO_DATA,
              },
              // Comps carry no money, so they cannot be at risk; they are here
              // because losing one is still losing a user, which is the thing
              // this tile is otherwise silent about.
              { label: 'Comped, nothing to lose', value: recurring.data.compedCustomers },
              { label: 'Free workspaces', value: counts.ok ? counts.data.free_workspaces : NO_DATA },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="What one cancellation costs" message={recurring.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        Every figure here is money we are still counting as revenue. A card that is failing keeps its
        entitlement through dunning and stays in MRR, and a subscription set to stop at the end of the period
        is still being billed until it does. This is NOT churn that has happened, NOT a forecast, and NOT a
        collection estimate: nothing here knows whether a retry will succeed. A subscription can be both
        failing and winding down, so the two rows can overlap and the exposed total is a ceiling rather than
        a sum. Comped accounts carry no money and therefore cannot appear as money at risk. Only the
        &ldquo;already gone&rdquo; tile uses the {windowShort(days)} window.
      </p>
    </>
  );
}

/** One line under the exposure, in the order somebody should act on it. */
function riskCaption(mrr: RevenueSummary) {
  if (mrr.atRiskMinor > 0) {
    return <><strong>{formatMoney(mrr.atRiskMinor, mrr.currency)}</strong> on cards Stripe cannot charge right now</>;
  }
  if (mrr.leavingMinor > 0) {
    return <><strong>{formatMoney(mrr.leavingMinor, mrr.currency)}</strong> set to stop at the end of the period</>;
  }
  return <>Every live subscription is paying and none is winding down.</>;
}

/**
 * Every live subscription in one of four states.
 *
 * "Healthy" is floored at zero rather than allowed to go negative. A
 * subscription that is both failing and already cancelled is counted in both of
 * the two rows above it, so on a small base the subtraction can undershoot, and
 * a negative currency figure in a table of positives reads as a bug in the
 * board rather than as the double count it is. The note under the panel states
 * the overlap; a negative number would state something false.
 */
function riskRows(mrr: RevenueSummary) {
  const spokenFor = mrr.atRiskMinor + mrr.leavingMinor;
  const spokenForCustomers = mrr.atRiskCustomers + mrr.leavingCustomers;
  return [
    { label: 'Card failing, in dunning', customers: mrr.atRiskCustomers, minor: mrr.atRiskMinor },
    { label: 'Set to stop at period end', customers: mrr.leavingCustomers, minor: mrr.leavingMinor },
    {
      label: 'Paying and staying',
      customers: Math.max(0, mrr.payingCustomers - spokenForCustomers),
      minor: Math.max(0, mrr.mrrMinor - spokenFor),
    },
    // Zero, always, and on the table anyway: a comped account is a live
    // subscription that a reader will otherwise go looking for in the rows
    // above and not find.
    { label: 'Comped, paying nothing', customers: mrr.compedCustomers, minor: 0 },
  ];
}
