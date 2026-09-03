/**
 * The live health verdict and the incidents behind it.
 *
 * TWO TIMESCALES, DELIBERATELY SEPARATE. The verdict at the top is uncached
 * and answers "is it working right now"; the incident list is the durable
 * record and answers the question somebody actually walks over to ask, which
 * is whether this morning's blip was the fourth this week or the first since
 * June. A single blended figure answers neither, and this page is read weekly,
 * which is exactly the interval at which an outage that started an hour ago
 * disappears into a monthly average.
 *
 * An incident row is also the only durable reliability record we have:
 * `activity_log` is purged at 90 days and the raw monitor run history is
 * noise, but an incident is a deduplicated, human-sized fact about a time the
 * product stopped working.
 */

import type { HealthLevel } from '@/lib/analytics/health-math';
import type { MonitorIncident } from '@/lib/analytics/kiosk-health';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import { formatCount } from '../charts';

export type IncidentsCardProps = {
  health: { level: HealthLevel; headline: string; reason: string; checkedAt: string };
  incidents: MonitorIncident[];
};

export function IncidentsCard({ health, incidents }: IncidentsCardProps) {
  const open = incidents.filter((incident) => incident.status === 'open').length;
  return (
    <figure className="ac-card">
      <figcaption className="ac-head">
        <h3 className="ac-title">Right now</h3>
        <p className="ac-sub">
          Checked {agoLabel(health.checkedAt) ?? 'just now'}, uncached.{' '}
          {open > 0 ? `${formatCount(open)} incident still open.` : 'No open incident.'}
        </p>
      </figcaption>

      <p className={`bd-verdict is-${health.level}`}>
        <i aria-hidden="true" />
        <b>{health.headline}</b>
      </p>
      <p className="bd-note">{health.reason}</p>

      {incidents.length === 0 ? (
        <p className="bd-empty">No incident has ever been recorded</p>
      ) : (
        // A list rather than a table: this card is a third of a row wide, and
        // three nowrap columns at that width truncate the one string worth
        // reading. An open incident keeps its own marker so it can never be
        // mistaken for a closed one just because closed rows sit above it.
        <ul className="bd-incidents">
          {incidents.map((incident) => (
            <li key={incident.fingerprint} className={incident.status === 'open' ? 'is-open' : undefined}>
              <span className="bd-incident-what">
                {incident.failureClass} at {incident.failedStep}
              </span>
              <span className="bd-incident-when">
                {formatDayKey(incident.lastFailureAt.slice(0, 10))}
                {incident.status === 'open'
                  ? `, still open after ${formatCount(incident.consecutiveFailures)} runs`
                  : ', resolved'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
