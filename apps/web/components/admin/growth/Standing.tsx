/**
 * "How much are we paid, and what changed": the top of the sheet.
 *
 * THE OPENING IS ONE COMPOSITE OBJECT, NOT A ROW OF CARDS. The two designs
 * this replaces both opened with a strip of equally sized stat cards, and the
 * verdict on both was the same: a list of six numbers at one weight is not a
 * hierarchy, it is a pile. Here the region is three things of three different
 * kinds, at three different sizes, and the difference in kind is the point:
 *
 *   MRR is a LEVEL: what the business is, right now. One display-size number,
 *   the only one on the page.
 *
 *   The ledger is MOVEMENTS: what changed inside the window, as signed rows
 *   that are never netted. A single "net new MRR" cannot tell a quiet month
 *   from one sale cancelling one churn, and only one of those needs a reply.
 *   Rows that are zero still render, greyed, so an empty month is visibly
 *   empty rather than absent.
 *
 *   Cash is a DIFFERENT QUESTION and is sized as a third thing. The first sale
 *   was a year up front: $48 arrived in an afternoon and the MRR it created is
 *   $4. A page showing only MRR hides every dollar that has ever reached the
 *   bank; one showing only cash claims the business earns twelve times what it
 *   recurringly does. Both are here, labelled, and a reader who notices they
 *   disagree has understood the business rather than found a bug.
 *
 * EVERY FIGURE IN THIS REGION COMES FROM STRIPE. Nothing in Postgres stores an
 * amount, an interval or a coupon, so a DB-derived MRR is our price list
 * wearing a customer's name; this page has twice reported 100%-off comps as
 * revenue. The paying, comped and internal counts are therefore taken from the
 * Stripe roll-up too, not from `growth_revenue_counts`, so the caption under
 * the headline cannot disagree with the headline.
 */

import type { CashCollected } from '@/lib/analytics/kiosk-revenue';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import { agoLabel, daysBetween, nextMilestone } from '@/lib/analytics/growth-records';
import { formatCount, formatMoney } from '../charts/format';
import { Dead, Display, Label, Lead, MonthBars, Note } from './sheet';

export type StandingProps = {
  revenue: RevenueSummary | { error: string };
  cash: CashCollected | { error: string };
  windowDays: number;
};

export function Standing({ revenue, cash, windowDays }: StandingProps) {
  return (
    <div className="br-standing">
      <div className="br-standing-col">
        {'error' in revenue ? <Dead what="Recurring revenue" error={revenue.error} /> : <Recurring revenue={revenue} />}
      </div>
      <div className="br-standing-col">
        {'error' in revenue ? (
          <Dead what="MRR movements" error={revenue.error} />
        ) : (
          <Ledger revenue={revenue} windowDays={windowDays} />
        )}
      </div>
      <div className="br-standing-col">
        {'error' in cash ? <Dead what="Cash collected" error={cash.error} /> : <Cash cash={cash} />}
      </div>
    </div>
  );
}

function Recurring({ revenue }: { revenue: RevenueSummary }) {
  const milestone = nextMilestone(revenue.mrrMinor / 100);
  return (
    <>
      <Label>Monthly recurring revenue</Label>
      <Display value={formatMoney(revenue.mrrMinor, revenue.currency)} unit="/mo" />
      <ul className="br-counts">
        <li>
          <b>{formatCount(revenue.payingCustomers)}</b> paying
        </li>
        <li>
          <b>{formatCount(revenue.compedCustomers)}</b> comped
        </li>
        <li>
          <b>{formatCount(revenue.internalCustomers)}</b> ours
        </li>
      </ul>
      <Note>
        {formatMoney(revenue.arrMinor, revenue.currency)} a year at this rate.{' '}
        {revenue.payingCustomers > 0
          ? `${formatMoney(revenue.arpaMinor, revenue.currency)} each.`
          : 'No average per customer while nobody pays.'}
        {milestone && (
          <>
            {' '}
            {formatMoney(milestone.remaining * 100, revenue.currency)} short of{' '}
            {formatMoney(milestone.target * 100, revenue.currency)}.
          </>
        )}{' '}
        A comped account is a real person on a 100% off coupon, so it is counted and is not revenue.
      </Note>
    </>
  );
}

/**
 * The movement ledger.
 *
 * ChartMogul splits MRR movements into new business, expansion, reactivation,
 * contraction and churn, and never nets them. This product has no expansion or
 * contraction to split out (there is no stored MRR history to diff against, so
 * an upgrade is invisible to the arithmetic), and saying that out loud in the
 * footnote is better than presenting four of the five categories as if they
 * were all of them.
 *
 * At risk and leaving are not movements that happened; they are money that is
 * about to move. They sit in the same table because the reader's question is
 * the same one, and are separated by a rule rather than by a second heading.
 */
function Ledger({ revenue, windowDays }: { revenue: RevenueSummary; windowDays: number }) {
  const money = (minor: number) => formatMoney(minor, revenue.currency);
  return (
    <>
      <Label>What moved, last {windowDays} days</Label>
      <table className="br-ledger">
        <tbody>
          <LedgerRow label="New business" amount={revenue.newMrrMinor} count={revenue.newCustomers} sign="+" money={money} tone="mint" />
          <LedgerRow label="Churned" amount={revenue.churnedMrrMinor} count={revenue.churnedCustomers} sign="-" money={money} tone="red" />
        </tbody>
        <tbody className="br-ledger-ahead">
          <LedgerRow label="At risk now" amount={revenue.atRiskMinor} count={revenue.atRiskCustomers} money={money} tone="amber" />
          <LedgerRow label="Leaving at period end" amount={revenue.leavingMinor} count={revenue.leavingCustomers} money={money} tone="amber" />
        </tbody>
      </table>
      <Note>
        New and churned are dated from when billing actually started and stopped, not from when somebody
        pressed cancel. At risk and leaving are still being paid today and are still inside the MRR
        beside them. Expansion and contraction are not modelled at all: that needs a stored MRR history
        to diff against, and there is none, so an upgrade shows up here as nothing.
      </Note>
      {revenue.byPlan.length > 0 && (
        <p className="br-byplan">
          {revenue.byPlan.map((plan) => (
            <span key={plan.label}>
              {plan.label} <b>{money(plan.mrrMinor)}</b> ({formatCount(plan.customers)})
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function LedgerRow({
  label,
  amount,
  count,
  sign,
  money,
  tone,
}: {
  label: string;
  amount: number;
  count: number;
  sign?: string;
  money: (minor: number) => string;
  tone: 'mint' | 'red' | 'amber';
}) {
  // A zero row is rendered and greyed rather than dropped. "Nothing churned"
  // and "we do not measure churn" must never look the same.
  const live = amount > 0;
  return (
    <tr className={live ? `is-${tone}` : 'is-quiet'}>
      <th scope="row">{label}</th>
      <td className="br-ledger-amount">
        {live && sign}
        {money(amount)}
      </td>
      <td className="br-ledger-count">{count === 1 ? '1 account' : `${formatCount(count)} accounts`}</td>
    </tr>
  );
}

function Cash({ cash }: { cash: CashCollected }) {
  const firstDollarDays = cash.since ? daysBetween(cash.since) : null;
  return (
    <>
      <Label>Cash collected, net of refunds</Label>
      <Lead value={formatMoney(cash.allTimeMinor, cash.currency)} unit="all time" />
      <MonthBars
        months={cash.months.map((month) => ({ month: month.month, value: month.netMinor }))}
        format={(value) => formatMoney(value, cash.currency)}
      />
      <Note>
        {formatMoney(cash.last30Minor, cash.currency)} in the last 30 days, across{' '}
        {formatCount(cash.charges)} charges.{' '}
        {firstDollarDays !== null && cash.since
          ? `First dollar ${agoLabel(cash.since)}, ${formatCount(firstDollarDays)} days of trading.`
          : 'No charge has landed yet.'}
      </Note>
      {cash.mode !== 'live' && (
        <p className="br-flag">
          Stripe is in {cash.mode} mode here: these are not real dollars.
        </p>
      )}
      {cash.truncated && <Note>Stripe held more charges than the read ceiling, so this is a floor.</Note>}
    </>
  );
}
