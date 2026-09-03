/**
 * The money card: the one panel a reader should land on first.
 *
 * IT IS ONE CARD, NOT FIVE. An earlier version of this page opened with a
 * strip of equally sized stat cards carrying MRR, ARR, ARPA, cash and the
 * customer count, and six boxes of the same size is a list rather than a
 * hierarchy. Here MRR is the number, ARR and ARPA are a line under it, cash is
 * a second figure at half the size because it answers a different question,
 * and the customer counts are a caption. One card, five weights.
 *
 * MOVEMENTS ARE CHIPS AND ARE NEVER NETTED. New, churned, at risk and leaving
 * each get their own pill with its own colour. A single "net new MRR" cannot
 * tell a quiet month from one sale cancelling one churn, and only one of those
 * needs a reply. Zero-valued chips still render, faded, because "nothing
 * churned" and "we do not measure churn" must not look the same.
 *
 * EVERY FIGURE HERE IS PRICED FROM STRIPE, including the paying and comped
 * counts. Postgres stores a plan id and a period end but no amount, no
 * interval and no coupon, so a database-derived MRR is our own price list
 * wearing a customer's name. This page has twice reported 100%-off comps as
 * revenue; taking the counts from the same Stripe roll-up as the money means
 * the caption cannot disagree with the headline above it.
 */

import type { CashCollected } from '@/lib/analytics/kiosk-revenue';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import { agoLabel } from '@/lib/analytics/growth-records';
import { Sparkline, formatCount, formatMoney } from '../charts';
import { Dead } from './Dead';

export type MoneyCardProps = {
  revenue: RevenueSummary | { error: string };
  cash: CashCollected | { error: string };
  windowDays: number;
};

export function MoneyCard({ revenue, cash, windowDays }: MoneyCardProps) {
  if ('error' in revenue) {
    return (
      <figure className="ac-card">
        <figcaption className="ac-head">
          <h3 className="ac-title">Recurring revenue</h3>
        </figcaption>
        <Dead what="Stripe subscriptions" error={revenue.error} />
      </figure>
    );
  }

  const money = (minor: number) => formatMoney(minor, revenue.currency);
  const cashOk = !('error' in cash);

  return (
    <figure className="ac-card">
      <figcaption className="ac-head">
        <h3 className="ac-title">Recurring revenue</h3>
        <p className="ac-sub">
          Priced from Stripe. {formatCount(revenue.payingCustomers)} paying,{' '}
          {formatCount(revenue.compedCustomers)} comped, {formatCount(revenue.internalCustomers)} ours.
        </p>
      </figcaption>

      <div className="bd-money-top">
        <div className="bd-money-mrr">
          <span className="bd-money-value">{money(revenue.mrrMinor)}</span>
          <span className="bd-money-unit">
            /mo · {money(revenue.arrMinor)} a year
            {revenue.payingCustomers > 0 ? ` · ${money(revenue.arpaMinor)} each` : ''}
          </span>
        </div>
        {cashOk && (
          <div className="bd-money-cash">
            <b>{money(cash.allTimeMinor)}</b>
            <span>cash, all time</span>
          </div>
        )}
      </div>

      <ul className="bd-moves">
        <Move label={`new, ${windowDays}d`} amount={revenue.newMrrMinor} count={revenue.newCustomers} money={money} kind="new" />
        <Move label={`churned, ${windowDays}d`} amount={revenue.churnedMrrMinor} count={revenue.churnedCustomers} money={money} kind="churn" />
        <Move label="at risk" amount={revenue.atRiskMinor} count={revenue.atRiskCustomers} money={money} kind="risk" />
        <Move label="leaving" amount={revenue.leavingMinor} count={revenue.leavingCustomers} money={money} kind="leaving" />
      </ul>

      {revenue.byPlan.length > 0 && (
        <p className="bd-money-plans">
          {revenue.byPlan.map((plan) => (
            <span key={plan.label}>
              {plan.label} <b>{money(plan.mrrMinor)}</b> ({formatCount(plan.customers)})
            </span>
          ))}
        </p>
      )}

      {/* Four months before a trend line is drawn at all. Two points is a
          straight line between two facts, and at this card's width it reads as
          a trajectory the data does not support. */}
      {cashOk && cash.months.length >= 4 && (
        <Sparkline
          values={cash.months.map((month) => month.netMinor)}
          label="Cash collected by month"
          height={34}
          color="var(--mint-500)"
        />
      )}

      {cashOk && (
        <p className="bd-note">
          {money(cash.last30Minor)} banked in the last 30 days across {formatCount(cash.charges)} charges
          {cash.since ? `, first dollar ${agoLabel(cash.since)}` : ''}. Cash and MRR are meant to
          disagree: a year paid up front lands whole and recurs at a twelfth of that.
        </p>
      )}
      {cashOk && cash.mode !== 'live' && (
        <p className="bd-flag">Stripe is in {cash.mode} mode here, so these are not real dollars.</p>
      )}
      {'error' in cash && <Dead what="Cash collected" error={cash.error} />}
    </figure>
  );
}

function Move({
  label,
  amount,
  count,
  money,
  kind,
}: {
  label: string;
  amount: number;
  count: number;
  money: (minor: number) => string;
  kind: 'new' | 'churn' | 'risk' | 'leaving';
}) {
  const live = amount > 0;
  return (
    <li className={`is-${kind}${live ? '' : ' is-zero'}`}>
      <i />
      <b>{money(amount)}</b>
      {label}
      {live ? ` (${formatCount(count)})` : ''}
    </li>
  );
}
