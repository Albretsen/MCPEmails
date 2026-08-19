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

import {
  fetchClientMix,
  fetchErrorBreakdown,
  fetchEngagementBands,
  fetchRetentionCurve,
} from '@/lib/analytics/growth-queries';
import { NO_DATA, formatCount, ratio } from '../charts';
import { BarList, Tile, TileError } from './primitives';
import { KIOSK_WINDOW_DAYS } from './board';

/** Weeks of the retention curve to show. Twelve is one quarter. */
const RETENTION_WEEKS = 12;

export async function KioskDetail() {
  const [retention, bands, clients, errors] = await Promise.all([
    fetchRetentionCurve(RETENTION_WEEKS),
    fetchEngagementBands(KIOSK_WINDOW_DAYS),
    fetchClientMix(),
    fetchErrorBreakdown(KIOSK_WINDOW_DAYS),
  ]);

  return (
    <section className="kiosk-more" aria-label="Supporting detail">
      <header className="kiosk-more-head">
        <div>
          <h2>Supporting detail</h2>
          <p>External accounts only where the metric supports it. All dates UTC.</p>
        </div>
        <a href="/admin/growth">Open the full growth page</a>
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
