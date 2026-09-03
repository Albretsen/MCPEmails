/**
 * Acquisition: how many arrive, from where, and whether that channel's people
 * are any good.
 *
 * WHAT CHANGED. This section used to be three charts of the same series: bars
 * of signups against activations, lines of the two rolling active counts, and a
 * cumulative sum of the bars. The third one carried no information the first
 * did not, and none of the three could answer the question the section title
 * implies, which is where the signups came from.
 *
 * `workspaces.acquisition_source` has been populated since 2026-08-05 and was
 * never rendered anywhere. It is worth rendering: it already shows that the two
 * channels the founder has spent effort on convert worse than untouched
 * organic traffic, which is not a conclusion the signup count alone can reach.
 *
 * ATTRIBUTION COVERAGE IS SHOWN, NOT ASSUMED. Roughly a third of signups carry
 * no source at all: a direct hit with no referrer and no utm has nothing to
 * attribute. Those are reported as their own row rather than dropped, so the
 * shares are read against the real signup total. A channel table whose rows do
 * not sum to the signup count will eventually be read as if they did.
 */

import { fetchAcquisitionChannels, fetchDailyMetrics } from '@/lib/analytics/growth-queries';
import { BarSeries, LineChart, formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section } from './shared';

/** "2026-08-13" to "Aug 13". The charts want a short, dense axis label. */
const AXIS_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function axisLabel(day: string) {
  return AXIS_FORMAT.format(new Date(`${day}T00:00:00Z`));
}

/** Channel names as a person would write them. Anything unlisted renders as stored. */
const CHANNEL_LABELS: Record<string, string> = {
  unattributed: 'Unattributed',
  direct: 'Direct',
  organic_google: 'Google organic',
  reddit: 'Reddit',
  other: 'Other referrer',
};

/**
 * Trailing mean. Daily signups at this volume swing between 0 and 15, which
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
  const [dailyResult, channelResult] = await Promise.all([
    fetchDailyMetrics(days),
    fetchAcquisitionChannels(days),
  ]);
  if (!dailyResult.ok) return <SectionError title="Acquisition" message={dailyResult.error} />;

  const rows = dailyResult.data;
  const channels = channelResult.ok ? channelResult.data : [];
  const totalSignups = channels.reduce((total, row) => total + row.signups, 0);
  const attributed = channels
    .filter((row) => row.source !== 'unattributed')
    .reduce((total, row) => total + row.signups, 0);

  return (
    <Section
      id="acquisition"
      title="Acquisition"
      explain={
        <>
          New workspaces against the ones that reached a first mailbox operation, daily over the last{' '}
          {days} days. The gap between the two bars is the onboarding loss. The line is a 7 day trailing
          average, because a daily count that swings between 0 and 15 reads as noise otherwise.
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
        <div className="growth-panel">
          <div className="growth-mix-head">
            <h3>
              Where signups come from
              <InfoDot label="Acquisition channel">
                First-touch attribution, recorded once at signup and never overwritten. Only exists from
                2026-08-05, and lands empty on a direct hit with no referrer and no utm, so the
                unattributed row is real and is shown rather than hidden. Read the activation column,
                not the signup column: a channel that sends people who never use the product is worse
                than one that sends fewer who do.
              </InfoDot>
            </h3>
            <span>{ratio(attributed, totalSignups)} attributed</span>
          </div>
          {!channelResult.ok ? (
            <p className="growth-note">Channel breakdown could not load: {channelResult.error}</p>
          ) : channels.length === 0 ? (
            <p className="growth-note">No signups in this window.</p>
          ) : (
            <div className="growth-table-wrap growth-table-cards">
              <table className="growth-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Signups</th>
                    <th>Activated</th>
                    <th>Returned</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((row) => (
                    <tr key={row.source} className={row.source === 'unattributed' ? 'is-muted' : undefined}>
                      <td data-label="Source">
                        <span className="growth-account">{CHANNEL_LABELS[row.source] ?? row.source}</span>
                        {row.paying > 0 && (
                          <span className="growth-account-sub">
                            {formatCount(row.paying)} paying
                          </span>
                        )}
                      </td>
                      <td data-label="Signups">{formatCount(row.signups)}</td>
                      <td data-label="Activated">
                        {formatCount(row.activated)}
                        <span className="growth-account-sub">{ratio(row.activated, row.signups)}</span>
                      </td>
                      <td data-label="Returned">
                        {formatCount(row.returned)}
                        <span className="growth-account-sub">{ratio(row.returned, row.signups)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <LineChart
          title="Active workspaces"
          data={rows.map((row) => ({ label: axisLabel(row.day), values: [row.active_7d, row.active_28d] }))}
          series={[
            { key: 'active_7d', name: 'Active (7d)' },
            { key: 'active_28d', name: 'Active (28d)' },
          ]}
          footnote="Rolling counts of workspaces with at least one successful tool call in the trailing window."
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
