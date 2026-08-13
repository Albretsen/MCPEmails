/**
 * Acquisition and activation over time, plus the raw daily numbers.
 *
 * This replaces the old 28-row, 8-column daily table and the near-identical
 * weekly one. The tables are still here, collapsed behind a disclosure, for
 * when an exact figure is needed; they are just no longer the primary way to
 * see a trend, which is a job a chart does better than 224 small integers.
 */

import { fetchDailyMetrics } from '@/lib/analytics/growth-queries';
import { BarSeries, LineChart, formatCount } from '../charts';
import { SectionError, Section } from './shared';

/** "2026-08-13" to "Aug 13". The charts want a short, dense axis label. */
const AXIS_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function axisLabel(day: string) {
  return AXIS_FORMAT.format(new Date(`${day}T00:00:00Z`));
}

/**
 * Trailing mean. Daily signups at this volume swing between 0 and 8, which
 * reads as noise; the average is the only way the shape of the trend is
 * visible without hiding the actual counts behind it.
 */
function movingAverage(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - window + 1), index + 1);
    return Math.round((slice.reduce((total, value) => total + value, 0) / slice.length) * 10) / 10;
  });
}

export async function AcquisitionSection({ days }: { days: number }) {
  const result = await fetchDailyMetrics(days);
  if (!result.ok) return <SectionError title="Acquisition and activation" message={result.error} />;

  const rows = result.data;

  // Cumulative is a partial sum over the window, not the all-time total. The
  // title says so: a line starting at zero would otherwise read as "the
  // product had no users 90 days ago".
  const cumulative: number[] = [];
  rows.reduce((total, row) => {
    const next = total + row.new_workspaces;
    cumulative.push(next);
    return next;
  }, 0);

  return (
    <Section
      title="Acquisition and activation"
      explain={
        <>
          New workspaces against the ones that reached a first mailbox operation, daily over the last{' '}
          {days} days. The gap between the two bars is the onboarding loss. The line is a 7 day trailing
          average of signups, because a daily count that swings between 0 and 8 reads as noise otherwise.
          Cumulative is a partial sum over the selected window, not the all-time total.
        </>
      }
    >
      <BarSeries
          title="Signups and value activations"
          data={rows.map((row) => ({ label: axisLabel(row.day), values: [row.new_workspaces, row.value_activations] }))}
          series={[
            { key: 'new_workspaces', name: 'New workspaces' },
            { key: 'value_activations', name: 'Value activations' },
          ]}
          overlay={[{ key: 'trend', name: 'Signups, 7 day average', values: movingAverage(rows.map((row) => row.new_workspaces), 7) }]}
      />

      <div className="growth-split" style={{ marginTop: 18 }}>
          <LineChart
            title="Active workspaces"
            data={rows.map((row) => ({ label: axisLabel(row.day), values: [row.active_7d, row.active_28d] }))}
            series={[
              { key: 'active_7d', name: 'Active (7d)' },
              { key: 'active_28d', name: 'Active (28d)' },
            ]}
            footnote="Rolling counts of workspaces with at least one successful tool call in the trailing window."
          />
          <LineChart
            title={`Cumulative signups in the last ${days} days`}
            data={rows.map((row, index) => ({ label: axisLabel(row.day), values: [cumulative[index]] }))}
            series={[{ key: 'cumulative', name: 'Workspaces created' }]}
            footnote="Partial sum over the selected window, not the all-time workspace count."
          />
      </div>

      <details className="growth-raw">
        <summary>Show the raw daily numbers</summary>
        <div className="growth-table-wrap">
          <table className="growth-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>New</th>
                <th>Value activations</th>
                <th>Active (7d)</th>
                <th>Active (28d)</th>
                <th>Tool calls</th>
                <th>Success rate</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((row) => (
                <tr key={row.day}>
                  <td>{row.day}</td>
                  <td>{row.new_workspaces}</td>
                  <td>{row.value_activations}</td>
                  <td>{row.active_7d}</td>
                  <td>{row.active_28d}</td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{row.calls ? `${Math.round((row.successes / row.calls) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  );
}
