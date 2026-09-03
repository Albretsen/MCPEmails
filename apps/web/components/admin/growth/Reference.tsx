/**
 * The two tables that name accounts, collapsed.
 *
 * THEY ARE COLLAPSED FOR TWO REASONS, and the second one is the real one.
 *
 * The first is editorial: everything above on this sheet is a brief, and a
 * brief is read top to bottom in a couple of minutes. These are lookup tools,
 * consulted when a number above has already prompted a question ("which
 * subscription is past due", "who is the workspace making all those calls"),
 * and a fifty row table in the middle of a brief is the thing that made two
 * previous versions of this page feel like a database viewer.
 *
 * The second is that these are THE ONLY TWO PLACES ON THE PAGE THAT CARRY
 * IDENTITY. Everything else is an aggregate. Both are behind the ADMIN_EMAILS
 * session, which is the actual access control, but a page that puts customer
 * email addresses on screen by default is one that puts them on screen every
 * time it is opened next to somebody, or shared, or screenshotted for a
 * changelog. Collapsed by default costs one click and removes that entirely.
 *
 * The kiosk board carries neither table and must not gain one: it hangs on a
 * wall behind a shared token, in a room, and its access control is a URL.
 *
 * Nothing else about an account appears here: no credential, no message
 * content, no subject, no recipient, no IP address.
 */

import type { GrowthActiveWorkspaceRow } from '@/lib/analytics/growth-types';
import type { RevenueDetail } from '@/lib/analytics/operator-revenue';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import { formatCount, formatMoney, ratio } from '../charts/format';
import { Dead, Note } from './sheet';

type Failed = { error: string };
const failed = <T,>(value: T | Failed): value is Failed =>
  typeof value === 'object' && value !== null && 'error' in (value as Failed);

export type ReferenceProps = {
  detail: RevenueDetail | Failed;
  roster: GrowthActiveWorkspaceRow[] | Failed;
  windowDays: number;
};

export function Reference({ detail, roster, windowDays }: ReferenceProps) {
  return (
    <div className="br-reference">
      <details className="br-drawer">
        <summary>
          Every Stripe subscription
          {!failed(detail) && <span> ({formatCount(detail.customers.length)})</span>}
        </summary>
        {failed(detail) ? (
          <Dead what="The subscription list" error={detail.error} />
        ) : (
          <Subscriptions detail={detail} />
        )}
      </details>

      <details className="br-drawer">
        <summary>
          Workspaces that used the product in the last {windowDays} days
          {!failed(roster) && <span> ({formatCount(roster.length)})</span>}
        </summary>
        {failed(roster) ? <Dead what="The active roster" error={roster.error} /> : <Roster rows={roster} />}
      </details>
    </div>
  );
}

function Subscriptions({ detail }: { detail: RevenueDetail }) {
  if (detail.customers.length === 0) return <p className="br-empty">Stripe holds no subscriptions</p>;
  return (
    <>
      <div className="br-scroll">
        <table className="br-table br-table-wide">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Plan</th>
              <th scope="col">Status</th>
              <th scope="col">Per interval</th>
              <th scope="col">MRR</th>
              <th scope="col">Renews</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {detail.customers.map((row) => (
              <tr key={row.subscriptionId} className={row.isInternal || row.isComped ? 'is-quiet' : undefined}>
                <th scope="row" className="br-cell-text">{row.email ?? 'no email on the Stripe customer'}</th>
                <td className="br-cell-text">{row.planLabel}</td>
                <td className="br-cell-text">{row.status}</td>
                <td>
                  {formatMoney(row.netPerIntervalMinor, row.currency)}
                  <span className="br-per">/{row.interval}</span>
                </td>
                <td>{formatMoney(row.monthlyMinor, row.currency)}</td>
                <td className="br-cell-text">{row.renewsAt ? formatDayKey(row.renewsAt.slice(0, 10)) : ''}</td>
                <td className="br-cell-text">
                  {[
                    row.isInternal ? 'ours' : null,
                    row.isComped ? 'comped' : null,
                    row.cancelAtPeriodEnd ? 'cancels at period end' : null,
                    row.discountPercentOff > 0 ? `${row.discountPercentOff}% off` : null,
                    row.discountAmountMinor > 0
                      ? `${formatMoney(row.discountAmountMinor, row.currency)} off`
                      : null,
                    row.endedAt ? `ended ${formatDayKey(row.endedAt.slice(0, 10))}` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        Priced from Stripe, in {detail.mode} mode. A comped row is a real person on a 100% off coupon and
        contributes nothing to MRR; rows marked ours are excluded from every figure on this page.
        {detail.truncated ? ' Stripe held more objects than the read ceiling, so this list is partial.' : ''}
      </Note>
    </>
  );
}

function Roster({ rows }: { rows: GrowthActiveWorkspaceRow[] }) {
  if (rows.length === 0) return <p className="br-empty">No workspace made a successful call in this window</p>;
  const ordered = [...rows].sort((a, b) => b.calls - a.calls);
  return (
    <>
      <div className="br-scroll">
        <table className="br-table br-table-wide">
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">Owner</th>
              <th scope="col">Plan</th>
              <th scope="col">Calls</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Days</th>
              <th scope="col">Inboxes</th>
              <th scope="col">Providers</th>
              <th scope="col">Last active</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr key={row.workspace_id}>
                <th scope="row" className="br-cell-text">{row.workspace_name}</th>
                <td className="br-cell-text">{row.owner_email ?? ''}</td>
                <td className="br-cell-text">
                  {row.plan}
                  {row.is_comped ? ' (comped)' : ''}
                </td>
                <td>{formatCount(row.calls)}</td>
                <td>{ratio(row.successes, row.calls)}</td>
                <td>{formatCount(row.active_days)}</td>
                <td>{formatCount(row.inboxes)}</td>
                <td className="br-cell-text">{row.providers}</td>
                <td className="br-cell-text">{agoLabel(row.last_active_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        A comped plan reads the same as a purchased one in the plan column, because both write it. The
        money on this page never comes from that column.
      </Note>
    </>
  );
}
