/**
 * Below the fold on the kiosk.
 *
 * The board above is one screen and answers "how are we doing". This answers
 * the follow-up questions someone asks once they have walked over to the
 * panel and put a finger on it: which week does retention actually fall off,
 * what is breaking, which client are people connecting from.
 *
 * It exists because the display is a touchscreen. Everything here is also on
 * /admin/growth in more detail, so nothing is lost if it is never scrolled to,
 * and nothing here is allowed to be the only place a number appears.
 *
 * Like the board, aggregates only. No workspace names, no owner addresses.
 */

import Link from 'next/link';
import {
  fetchClientMix,
  fetchErrorBreakdown,
  fetchEngagementBands,
  fetchRetentionCurve,
} from '@/lib/analytics/growth-queries';
import { fetchCheckoutFunnel, fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import type { CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import { fetchRecentIncidents } from '@/lib/analytics/kiosk-health';
import type { MonitorIncident } from '@/lib/analytics/kiosk-health';
import { NO_DATA, formatCount, formatMoney, ratio } from '../charts';
import { BarList, FactRow, Tile, TileError } from './primitives';
import { KIOSK_WINDOW_DAYS } from './shared';

/** Weeks of the retention curve to show. Twelve is one quarter. */
const RETENTION_WEEKS = 12;

export async function KioskDetail() {
  const [retention, bands, clients, errors, checkout, recurring, incidents] = await Promise.all([
    fetchRetentionCurve(RETENTION_WEEKS),
    fetchEngagementBands(KIOSK_WINDOW_DAYS),
    fetchClientMix(),
    fetchErrorBreakdown(KIOSK_WINDOW_DAYS),
    fetchCheckoutFunnel(),
    fetchRecurringRevenue(KIOSK_WINDOW_DAYS),
    fetchRecentIncidents(),
  ]);

  return (
    <section className="kiosk-more" aria-label="Supporting detail">
      <header className="kiosk-more-head">
        <div>
          <h2>Supporting detail</h2>
          <p>External accounts only where the metric supports it. All dates UTC.</p>
        </div>
        <Link href="/admin/growth">Open the full growth page</Link>
      </header>

      {/* Retention as a table rather than a curve. Below the fold it is being
          read from arm's length, where the exact number per week is more use
          than the shape, and the shape is on /admin/growth already. */}
      {retention.ok ? (
        <Tile label="Retention after first value" aside="external accounts">
          {retention.data.length === 0 ? (
            <p className="kiosk-empty">No cohort has aged into a full week yet.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="is-num">Eligible</th>
                  <th className="is-num">Came back</th>
                  <th className="is-num">Rate</th>
                </tr>
              </thead>
              <tbody>
                {retention.data.slice(0, 8).map((point) => (
                  <tr key={point.week_index}>
                    <td>W{point.week_index}</td>
                    <td className="is-num">{formatCount(point.eligible)}</td>
                    <td className="is-num">{formatCount(point.retained)}</td>
                    <td className="is-num">{ratio(point.retained, point.eligible)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Retention after first value" message={retention.error} />
      )}

      {/* The checkout funnel in full, because the board above only has room
          for the two rungs of it that matter most. Counted in distinct
          workspaces and all-time: a handful of checkouts a year would show as
          zeros in any window short enough to be interesting.

          "Abandoned" is the row to read first. It is the only stage where
          someone had already decided to pay us and did not, which makes it the
          one number here with a fix attached rather than a strategy. */}
      {checkout.ok ? (
        <Tile
          label="Checkout funnel"
          aside={checkout.data.lastCompletedAt ? `last sale ${daysAgo(checkout.data.lastCompletedAt)}` : 'no sale yet'}
        >
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
          <FactRow
            facts={[
              { label: 'Portal opened', value: checkout.data.portalOpened },
              { label: 'Create failed', value: checkout.data.checkoutFailed },
              { label: 'Ours, excluded', value: checkout.data.internalExcluded },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Checkout funnel" message={checkout.error} />
      )}

      {/* Which tier the money is actually in. The board above shows one total;
          this says whether that total is one Team seat or twenty Personal
          ones, which is the question the 2026-08-19 repricing was a bet on.
          Comped subscriptions are real accounts with no money in them, so they
          are a fact underneath rather than a row in the table. */}
      {recurring.ok ? (
        <Tile
          label="Where the money is"
          aside={`${formatMoney(recurring.data.arrMinor, recurring.data.currency)} a year`}
        >
          {recurring.data.byPlan.length === 0 ? (
            <p className="kiosk-empty">No paid subscription is live.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="is-num">Customers</th>
                  <th className="is-num">Per month</th>
                </tr>
              </thead>
              <tbody>
                {recurring.data.byPlan.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="is-num">{formatCount(row.customers)}</td>
                    <td className="is-num">{formatMoney(row.mrrMinor, recurring.data.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <FactRow
            facts={[
              { label: 'Comped', value: recurring.data.compedCustomers },
              { label: 'Payment failing', value: recurring.data.atRiskCustomers },
              { label: 'Leaving', value: recurring.data.leavingCustomers },
              { label: 'Ours, excluded', value: recurring.data.internalCustomers },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Where the money is" message={recurring.error} />
      )}

      {bands.ok ? (
        <Tile label="How many days people showed up" aside={`${KIOSK_WINDOW_DAYS}d`}>
          <BarList
            rows={bands.data
              .filter((row) => row.metric === 'active_days')
              .map((row) => ({
                name: `${row.band} ${row.band === '1' ? 'day' : 'days'}`,
                count: row.workspaces,
                // The one-day band is the churn band. Painting it the same
                // colour as the rest would hide the shape of the problem.
                color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-good)',
              }))}
            emptyLabel="No activity in the window"
          />
        </Tile>
      ) : (
        <TileError label="How many days people showed up" message={bands.error} />
      )}

      {clients.ok ? (
        <Tile label="MCP client on first success" aside="all time">
          <BarList
            rows={clients.data
              .slice()
              .sort((a, b) => b.workspaces - a.workspaces)
              .slice(0, 6)
              .map((row) => ({ name: row.client || 'Unknown', count: row.workspaces }))}
            emptyLabel="No client recorded yet"
          />
        </Tile>
      ) : (
        <TileError label="MCP client on first success" message={clients.error} />
      )}

      {/* THE OUTAGE LOG. The board above answers "is it up right now", which is
          the only question worth asking while it is down and a useless one the
          rest of the time. This answers the one somebody actually walks over to
          ask: whether this morning's blip was the fourth this week or the first
          since June.

          It is also the only durable record on either half of this page.
          `activity_log` is purged at 90 days and the raw run history is noise,
          but an incident row is a deduplicated, human-sized fact about a time
          the product stopped working, kept for as long as the table is.

          "Runs" is the strike count, and it is the column that says whether an
          entry was worth waking up for: one strike on a retryable class is
          somebody else's network, and the row is here for completeness rather
          than for blame. */}
      <Tile
        label="Outage log"
        aside={incidentAside(incidents)}
        tone={incidents.some((row) => row.status === 'open') ? 'bad' : 'default'}
      >
        {incidents.length === 0 ? (
          <p className="kiosk-empty">The synthetic monitor has never opened an incident.</p>
        ) : (
          <table className="kiosk-table">
            <thead>
              <tr>
                <th>What failed</th>
                <th>Cause</th>
                <th className="is-num">Runs</th>
                <th className="is-num">When</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident) => (
                <tr key={incident.fingerprint}>
                  <td>{incident.failedStep}</td>
                  <td>{incident.failureClass.replace(/_/g, ' ')}</td>
                  <td className="is-num">{formatCount(incident.consecutiveFailures)}</td>
                  <td className="is-num">{incidentWhen(incident)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tile>

      {errors.ok ? (
        <Tile label="What is failing" aside={`${KIOSK_WINDOW_DAYS}d`}>
          {errors.data.length === 0 ? (
            <p className="kiosk-empty">No failures recorded in the window.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Code</th>
                  <th className="is-num">Failed</th>
                  <th className="is-num">Of calls</th>
                </tr>
              </thead>
              <tbody>
                {errors.data.slice(0, 8).map((row) => (
                  <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
                    <td>{row.tool_name}</td>
                    <td>{row.error_code ?? NO_DATA}</td>
                    <td className="is-num">{formatCount(row.failures)}</td>
                    <td className="is-num">{ratio(row.failures, row.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="What is failing" message={errors.error} />
      )}
    </section>
  );
}

/**
 * The checkout stages as table rows.
 *
 * "Started a checkout" and everything after it is shown as a share of the
 * people who looked at the plans, not of every signup: the question this table
 * answers is what happens to intent once it exists, and dividing by the whole
 * estate would bury a 60% abandonment rate under a small percentage.
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
 * The outage log's aside.
 *
 * "0 open" is not the same sentence as "all resolved" even though it is the
 * same fact: a number beside a red word reads as a count of something bad, and
 * this tile's happy state should not be the one that looks like a tally.
 */
function incidentAside(incidents: MonitorIncident[]): string {
  if (incidents.length === 0) return 'never';
  const open = incidents.filter((row) => row.status === 'open').length;
  return open === 0 ? 'all resolved' : `${open} open`;
}

/**
 * When an incident happened, or the fact that it has not finished.
 *
 * An open incident deliberately does not get a date. It gets the word "OPEN",
 * because the one thing a reader must not do with this table is scan a column
 * of dates and conclude that everything in it is over.
 */
function incidentWhen(incident: MonitorIncident): string {
  if (incident.status === 'open') return 'OPEN';
  return daysAgo(incident.resolvedAt ?? incident.lastFailureAt);
}

/** Whole days since an ISO timestamp, phrased for a wall. */
function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
