/**
 * Revenue: what the product earns, who pays it, and what actually arrived.
 *
 * NEW IN THIS REDESIGN, AND THE REASON FOR IT. The page had no money on it at
 * all beyond a single count of "paying customers", derived from
 * `workspaces.plan`, which reads the same value for a purchase and for a comp.
 * That count was wrong twice in recorded history: five paid workspaces against
 * a true figure of zero, and one paying customer that was our own 100%-off
 * test subscription. Now that there IS a paying customer, a count with that
 * failure mode is the last thing this page should lead with.
 *
 * MRR AND CASH ARE BOTH SHOWN, AND THEY ARE DIFFERENT NUMBERS. The first sale
 * was Personal yearly. Roughly $48 of cash arrived in one August day and the
 * recurring revenue it created is roughly $4 a month. Showing only MRR hides
 * the only money that has ever landed; showing only cash would claim a
 * twelvefold collapse in September. Both, labelled, is the only honest layout.
 *
 * THE TABLE NAMES CUSTOMERS. That is deliberate and it is the one thing this
 * section has that the kiosk board must never have: the board hangs on a wall
 * behind a shared token, this page is behind an ADMIN_EMAILS session and
 * already names accounts in the roster. At one customer, a revenue panel that
 * cannot say which customer is barely a panel.
 *
 * The arithmetic lives in revenue-math.ts and the headline roll-up in
 * kiosk-revenue.ts, both shared with the kiosk, so the two surfaces can never
 * report different MRR. Only the per-account rows and the cash series are read
 * here (operator-revenue.ts).
 */

import { fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import { fetchRevenueDetail, hasEnded, type RevenueCustomerRow } from '@/lib/analytics/operator-revenue';
import { BarSeries, formatCount, formatMoney, NO_DATA } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section, StatCard } from './shared';

const DATE_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const MONTH_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit', timeZone: 'UTC' });

function day(iso: string | null): string {
  if (!iso) return NO_DATA;
  return DATE_FORMAT.format(new Date(iso));
}

export async function RevenueSection({ days }: { days: number }) {
  const [summaryResult, detailResult] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchRevenueDetail(),
  ]);

  // The headline roll-up is the section. Without it there is nothing to show,
  // and a revenue panel that renders zeroes because Stripe is unreachable is
  // the single most dangerous failure this page can have.
  if (!summaryResult.ok) return <SectionError title="Revenue" message={summaryResult.error} />;
  const money = summaryResult.data;
  const detail = detailResult.ok ? detailResult.data : null;

  const live = (detail?.customers ?? []).filter((row) => !hasEnded(row));
  const ended = (detail?.customers ?? []).filter(hasEnded);
  const cash = detail?.cash ?? [];

  return (
    <Section
      title="Revenue"
      explain={
        <>
          Read from <strong>Stripe</strong>, not from the database. The webhook stores a plan id, a status
          and a period end and drops the amount, the interval and the coupon, so anything derived from it
          is our own price list wearing a customer&rsquo;s name: a 100%-off comp on a paid price is
          indistinguishable from a purchase there, and this page has twice reported comps as revenue
          because of it.
          <br /><br />
          <strong>MRR normalises, cash does not.</strong> A yearly subscription contributes a twelfth of
          its net amount every month, so a year paid up front does not show as one enormous month
          followed by eleven empty ones. Cash is what actually arrived, net of refunds, and at this size
          it is the number that pays for anything. A trial contributes no MRR until it converts;{' '}
          <code>past_due</code> and <code>unpaid</code> keep theirs, because the product keeps their
          access while Stripe retries the card, and they are flagged rather than quietly written off.
        </>
      }
      aside={detail && detail.mode !== 'live' ? (
        <span className="growth-cap-flag is-warn">
          {detail.mode === 'test' ? 'Stripe TEST mode: these are not real numbers' : 'Stripe mode unknown'}
        </span>
      ) : undefined}
    >
      <section className="growth-stat-grid is-five" aria-label="Revenue summary" style={{ marginBottom: 18 }}>
        <StatCard
          label="MRR"
          value={formatMoney(money.mrrMinor, money.currency)}
          detail={money.netNewMrrMinor === 0
            ? `No change in the last ${days} days`
            : `${money.netNewMrrMinor > 0 ? '+' : ''}${formatMoney(money.netNewMrrMinor, money.currency)} in the last ${days} days`}
          explain={
            <>
              Net monthly recurring revenue across external, non-comped subscriptions. Net new is new
              minus churned over the window; expansion and contraction are deliberately not modelled,
              because doing that properly needs a stored MRR history to diff against and at single-digit
              customer counts an upgrade is visible in the table below anyway.
            </>
          }
        />
        <StatCard
          label="ARR"
          value={formatMoney(money.arrMinor, money.currency)}
          detail="MRR times twelve"
          explain="Not a forecast and not a booking. It is the same number as MRR said annually, which is the convention every SaaS benchmark is quoted in."
        />
        <StatCard
          label="Paying customers"
          value={money.payingCustomers}
          detail={[
            money.compedCustomers > 0 ? `${money.compedCustomers} comped` : null,
            money.internalCustomers > 0 ? `${money.internalCustomers} internal` : null,
          ].filter(Boolean).join(', ') || 'Live subscriptions paying something'}
          explain={
            <>
              Live subscriptions actually paying an amount above zero, excluding our own accounts.
              Comped means a real person on a subscription discounted to nothing: they are counted
              beside the paying figure, never inside it.
            </>
          }
        />
        <StatCard
          label="ARPA"
          value={money.payingCustomers > 0 ? formatMoney(money.arpaMinor, money.currency) : NO_DATA}
          detail={money.payingCustomers > 0
            ? `Across ${money.payingCustomers} paying customer${money.payingCustomers === 1 ? '' : 's'}`
            : 'No paying customers yet'}
          explain="MRR divided by paying customers. At one customer this is that customer's price and nothing more; it starts carrying information somewhere past ten."
        />
        <StatCard
          label="Cash collected"
          value={detail ? formatMoney(detail.cashAllTimeMinor, detail.currency) : NO_DATA}
          detail={detail
            ? `${formatMoney(detail.cashLast30Minor, detail.currency)} in the last 30 days`
            : 'Charge history unavailable'}
          explain={
            <>
              Money that actually arrived, all time, net of refunds, excluding charges on our own
              accounts. Read from charges rather than invoices because an invoice can be settled from a
              credit balance that moved no money at all. This is <strong>not</strong> MRR: a year paid up
              front lands here once and in MRR twelve times.
            </>
          }
        />
      </section>

      {/* Anything that needs attention this week gets a line of its own rather
          than a card, so the card row stays a constant six on every render. */}
      {(money.atRiskCustomers > 0 || money.leavingCustomers > 0 || money.otherCurrencies.length > 0
        || (detail?.truncated ?? false)) && (
        <ul className="growth-flags">
          {money.atRiskCustomers > 0 && (
            <li className="is-bad">
              <strong>{formatMoney(money.atRiskMinor, money.currency)}</strong> of MRR is on{' '}
              {money.atRiskCustomers} subscription{money.atRiskCustomers === 1 ? '' : 's'} Stripe cannot
              charge right now. Still counted, because the dunning grace period keeps their access.
            </li>
          )}
          {money.leavingCustomers > 0 && (
            <li className="is-warn">
              {money.leavingCustomers} paying subscription{money.leavingCustomers === 1 ? ' is' : 's are'}{' '}
              set to stop at the end of the period, worth{' '}
              <strong>{formatMoney(money.leavingMinor, money.currency)}</strong> of MRR.
            </li>
          )}
          {money.otherCurrencies.length > 0 && (
            <li className="is-warn">
              Live subscriptions also exist in {money.otherCurrencies.join(', ').toUpperCase()}. Those are
              not added to the figures above, so MRR understates the true total.
            </li>
          )}
          {detail?.truncated && (
            <li className="is-warn">
              Stripe returned more objects than this page reads in one pass, so the figures are floors.
            </li>
          )}
        </ul>
      )}

      <div className="growth-split">
        <div className="growth-panel">
          <div className="growth-mix-head">
            <h3>
              Subscriptions
              <InfoDot label="Subscriptions">
                Every subscription Stripe holds, newest first. Cancelled ones stay listed: at this volume
                the history is short enough to read, and a churn you cannot see is a churn you will
                rediscover as a surprise. Amounts are what the customer is charged per interval after any
                coupon; the MRR column is that normalised to a month.
              </InfoDot>
            </h3>
            <span>{live.length} live</span>
          </div>
          {!detail ? (
            <p className="growth-note">
              Subscription detail could not load: {detailResult.ok ? 'no data' : detailResult.error}
            </p>
          ) : detail.customers.length === 0 ? (
            <p className="growth-note">Stripe holds no subscriptions in this mode.</p>
          ) : (
            <div className="growth-table-wrap growth-table-cards">
              <table className="growth-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>MRR</th>
                    <th>Renews</th>
                  </tr>
                </thead>
                <tbody>
                  {[...live, ...ended].map((row) => (
                    <CustomerRow key={row.subscriptionId} row={row} currency={detail.currency} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {cash.length > 0 ? (
          <BarSeries
            title="Cash collected by month"
            subtitle="Net of refunds, excluding our own accounts."
            data={cash.map((month) => ({
              label: MONTH_FORMAT.format(new Date(`${month.month}T00:00:00Z`)),
              values: [month.netMinor / 100],
            }))}
            series={[{ key: 'cash', name: 'Cash' }]}
            footnote="Money that arrived, not revenue recognised. A yearly plan lands entirely in the month it was bought."
          />
        ) : (
          <div className="growth-panel">
            <div className="growth-mix-head"><h3>Cash collected by month</h3></div>
            <p className="growth-note">
              {detail ? 'No successful external charges yet.' : 'Charge history unavailable.'}
            </p>
          </div>
        )}
      </div>

      {money.byPlan.length > 0 && (
        <p className="growth-note">
          Where the MRR sits:{' '}
          {money.byPlan.map((plan, index) => (
            <span key={plan.label}>
              {index > 0 ? ' · ' : ''}
              <strong>{plan.label}</strong> {formatMoney(plan.mrrMinor, money.currency)}
              {' '}({formatCount(plan.customers)})
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}

/**
 * One subscription.
 *
 * Status is only printed when it is not a plain paying `active`: a column of
 * the word "active" repeated is noise, and the exceptions are the whole reason
 * to look at this table.
 */
function CustomerRow({ row, currency }: { row: RevenueCustomerRow; currency: string }) {
  const dead = hasEnded(row);
  const flags = [
    row.isInternal ? 'internal' : null,
    row.isComped ? 'comped' : null,
    row.cancelAtPeriodEnd && !dead ? 'cancelling' : null,
    dead ? row.status : row.status === 'active' ? null : row.status,
  ].filter(Boolean) as string[];

  return (
    <tr className={dead || row.isInternal ? 'is-muted' : undefined}>
      <td data-label="Customer">
        {/* Stripe holds no email on an API-created customer, so the
            subscription id is the fallback identity rather than a blank. */}
        <span className="growth-account">{row.email ?? row.subscriptionId}</span>
        <span className="growth-account-sub">
          {row.planLabel}
          {flags.map((flag) => (
            <span key={flag} className={`growth-tag${flag === 'comped' ? ' is-comped' : ''}${flag === 'internal' ? ' is-internal' : ''}`}>
              {flag}
            </span>
          ))}
        </span>
      </td>
      <td data-label="Amount">
        {formatMoney(row.netPerIntervalMinor, row.currency || currency)}
        <span className="growth-account-sub">
          / {row.interval}
          {row.discountPercentOff > 0 ? ` · ${Number(row.discountPercentOff.toFixed(2))}% off` : ''}
          {row.discountPercentOff === 0 && row.discountAmountMinor > 0
            ? ` · ${formatMoney(row.discountAmountMinor, row.currency || currency)} off`
            : ''}
        </span>
      </td>
      <td data-label="MRR">{dead ? NO_DATA : formatMoney(row.monthlyMinor, row.currency || currency)}</td>
      <td data-label={dead ? 'Ended' : 'Renews'}>{dead ? day(row.endedAt) : day(row.renewsAt)}</td>
    </tr>
  );
}
