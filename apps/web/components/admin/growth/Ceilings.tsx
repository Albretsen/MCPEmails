/**
 * "What is running out, or broken": the two things on this page with a clock
 * attached to them.
 *
 * They share a region because they share a shape. Everything else on the sheet
 * is a level or a movement that can be looked at next week instead; these two
 * are the only places where not looking has a cost that accrues. Google's cap
 * is the harder of the two and is on the left, because it is the single hard
 * calendar deadline in the business: a published-but-unverified OAuth client
 * is cut off at a hundred users, the count is cumulative, revoking access does
 * not give a slot back, and the verification that lifts it takes weeks that do
 * not start until somebody notices.
 *
 * The reliability half deliberately reports the LIVE verdict and the WINDOW
 * separately. The live one is uncached and is the answer to "is it working
 * right now"; the window is 90 days of `activity_log` and is the answer to "is
 * it usually working". A single blended figure answers neither, and this page
 * is read weekly, which is exactly the interval at which an outage that
 * started an hour ago is invisible in a monthly average.
 *
 * OUR OWN TRAFFIC IS INSIDE THESE NUMBERS, on purpose, unlike the customer
 * counts elsewhere on the sheet. The synthetic monitor's calls are real load
 * on the real server: excluding them from a reliability denominator would be
 * removing the only traffic guaranteed to be exercising the whole path.
 */

import type { GmailCapProjection } from '@/lib/analytics/growth-metrics';
import type { GmailCapSummaryRow, GmailGrantMonthRow, GrowthDailyRow, GrowthErrorRow } from '@/lib/analytics/growth-types';
import type { HealthLevel } from '@/lib/analytics/health-math';
import type { MonitorIncident } from '@/lib/analytics/kiosk-health';
import { agoLabel, formatDayKey } from '@/lib/analytics/growth-records';
import { formatCount, formatPercent, ratio } from '../charts/format';
import { Dead, Facts, Label, Lead, Meter, MonthBars, Note } from './sheet';

type Failed = { error: string };
const failed = <T,>(value: T | Failed): value is Failed =>
  typeof value === 'object' && value !== null && 'error' in (value as Failed);

export type CeilingsProps = {
  gmail: { summary: GmailCapSummaryRow; projection: GmailCapProjection } | Failed;
  grants: GmailGrantMonthRow[] | Failed;
  daily: GrowthDailyRow[] | Failed;
  errors: GrowthErrorRow[] | Failed;
  health: { level: HealthLevel; headline: string; reason: string; since: string | null; checkedAt: string };
  incidents: MonitorIncident[];
  windowDays: number;
};

export function Ceilings(props: CeilingsProps) {
  return (
    <div className="br-split">
      <div className="br-split-col">
        <GmailCap gmail={props.gmail} grants={props.grants} />
      </div>
      <div className="br-split-col">
        <Faults
          daily={props.daily}
          errors={props.errors}
          health={props.health}
          incidents={props.incidents}
          windowDays={props.windowDays}
        />
      </div>
    </div>
  );
}

function GmailCap({
  gmail,
  grants,
}: {
  gmail: CeilingsProps['gmail'];
  grants: GmailGrantMonthRow[] | Failed;
}) {
  if (failed(gmail)) return <Dead what="The Gmail OAuth cap" error={gmail.error} />;
  const { summary, projection } = gmail;

  return (
    <>
      <Label>Gmail OAuth grants against Google&apos;s cap</Label>
      <Lead value={formatCount(projection.used)} unit={`of ${formatCount(projection.cap)}`} />
      <Meter value={projection.used} max={projection.cap} level={projection.level} />
      <Facts
        rows={[
          { label: 'Slots left', value: formatCount(projection.remaining) },
          { label: 'Filling at', value: `${projection.ratePerMonth}/month` },
          { label: 'Full around', value: projection.projectedExhaustion ?? 'not filling' },
          {
            label: 'Still live',
            value: formatCount(summary.live),
            note: `${formatCount(summary.active)} active`,
          },
        ]}
      />
      {failed(grants) ? (
        <Dead what="The grant series" error={grants.error} />
      ) : (
        <MonthBars
          months={grants.map((row) => ({ month: row.month, value: row.new_grants }))}
          format={(value) => formatCount(value)}
        />
      )}
      <Note>
        The used figure is a floor: Google counts a grant the moment consent is given, so a consent that
        failed before the inbox row was written burns a slot we cannot see. Deleted inboxes are counted
        too, because revoking access does not return a slot.
        {summary.google_reported_users !== null
          ? ` The Cloud Console last reported ${formatCount(summary.google_reported_users)} by hand${
              summary.google_reported_at ? `, ${agoLabel(summary.google_reported_at)}` : ''
            }, and the higher of the two is used here.`
          : ' No hand-entered Cloud Console figure has been recorded, so only our own count is available.'}
      </Note>
    </>
  );
}

function Faults({
  daily,
  errors,
  health,
  incidents,
  windowDays,
}: {
  daily: GrowthDailyRow[] | Failed;
  errors: GrowthErrorRow[] | Failed;
  health: CeilingsProps['health'];
  incidents: MonitorIncident[];
  windowDays: number;
}) {
  const rows = failed(daily) ? [] : daily;
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const successes = rows.reduce((total, row) => total + row.successes, 0);
  const failures = rows.reduce((total, row) => total + row.errors, 0);
  const limited = rows.reduce((total, row) => total + row.rate_limited, 0);
  const totalFailures = failed(errors) ? 0 : errors.reduce((total, row) => total + row.failures, 0);

  return (
    <>
      <Label>Is it working</Label>
      <p className={`br-verdict is-${health.level}`}>
        <b>{health.headline}</b>
        <span>{health.reason}</span>
        <em>
          checked {agoLabel(health.checkedAt) ?? 'just now'}
          {health.since ? `, since ${health.since.slice(11, 16)} UTC` : ''}
        </em>
      </p>

      {failed(daily) ? (
        <Dead what="Call volume" error={daily.error} />
      ) : (
        <>
          <Lead value={calls > 0 ? formatPercent(successes / calls, 1) : 'no calls'} unit={`over ${windowDays} days`} />
          <Facts
            rows={[
              { label: 'Calls', value: formatCount(calls) },
              { label: 'Failed', value: formatCount(failures) },
              { label: 'Rate limited', value: formatCount(limited) },
              { label: 'Busiest day', value: formatCount(Math.max(0, ...rows.map((row) => row.calls))) },
            ]}
          />
        </>
      )}

      {failed(errors) ? (
        <Dead what="The error breakdown" error={errors.error} />
      ) : errors.length === 0 ? (
        <p className="br-empty">No failures recorded in this window</p>
      ) : (
        <table className="br-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Code</th>
              <th scope="col">Failures</th>
              <th scope="col">Of that tool</th>
            </tr>
          </thead>
          <tbody>
            {errors.slice(0, 6).map((row) => (
              <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
                <th scope="row">{row.tool_name}</th>
                <td className="br-cell-text">{row.error_code ?? 'none'}</td>
                <td>{formatCount(row.failures)}</td>
                <td>{ratio(row.failures, row.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!failed(errors) && errors.length > 6 && (
        <details className="br-details">
          <summary>
            {errors.length - 6} more failing {errors.length - 6 === 1 ? 'tool and code pair' : 'tool and code pairs'}
          </summary>
          <table className="br-table">
            <tbody>
              {errors.slice(6).map((row) => (
                <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
                  <th scope="row">{row.tool_name}</th>
                  <td className="br-cell-text">{row.error_code ?? 'none'}</td>
                  <td>{formatCount(row.failures)}</td>
                  <td>{ratio(row.failures, row.calls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {!failed(errors) && totalFailures > 0 && (
        <Note>
          {formatCount(totalFailures)} failed calls in the window, our own synthetic traffic included: it
          is real load on the real server, and a reliability figure that excluded it would be measuring
          the product with the one caller guaranteed to exercise the whole path removed.
        </Note>
      )}

      <Label>Incidents the monitor opened</Label>
      {incidents.length === 0 ? (
        <p className="br-empty">No incident has ever been recorded</p>
      ) : (
        <ul className="br-incidents">
          {incidents.map((incident) => (
            <li key={incident.fingerprint} className={`is-${incident.status}`}>
              <span className="br-incident-what">
                {incident.failureClass} at {incident.failedStep}
              </span>
              <span className="br-incident-when">
                {formatDayKey(incident.lastFailureAt.slice(0, 10))}
                {incident.status === 'open'
                  ? `, still open after ${formatCount(incident.consecutiveFailures)} runs`
                  : ', resolved'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
