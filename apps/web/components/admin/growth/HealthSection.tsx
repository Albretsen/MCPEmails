/**
 * Health: is anything on fire, and what ceiling do we hit next.
 *
 * MERGES Reliability, Estate mix, Plans and cap utilization, and the Gmail
 * OAuth cap into one section, and drops most of what those four contained.
 *
 * WHAT WAS CUT AND WHY.
 *   - The action-cap utilization histogram, billable actions, cap-hit
 *     workspaces and total workspaces were four panels reporting a structural
 *     zero. The 2026-08-19 repricing made the action cap an abuse ceiling
 *     rather than a sold allowance, so a workspace at 60% of it is a possible
 *     runaway loop, not a customer about to convert. That is one line of text,
 *     not a chart with five bands where four are always empty.
 *   - The MCP client mix reported "unknown, 125 workspaces, 100%". A panel
 *     with one row that says nothing was drawn on every render. It is now
 *     rendered only when something other than unknown has been recorded, which
 *     is the point at which it starts being worth the space.
 *   - The error table was twenty rows deep. The top few are where every
 *     decision gets made; the rest is behind a disclosure.
 *
 * WHAT WAS KEPT AND PROMOTED. The Gmail OAuth cap was last on the page,
 * demoted in an earlier round for crowding out growth numbers. It is now
 * genuinely close: 67 of 100 grants spent and projected full around October
 * 2026, and verification plus the CASA assessment take weeks that do not pause
 * while it fills. That is the single hardest deadline the product has, so it
 * sits at the top of this section rather than the bottom of the page.
 */

import {
  fetchDailyMetrics,
  fetchErrorBreakdown,
  fetchGmailCapSummary,
  fetchProviderMix,
  fetchClientMix,
  fetchUsageVolume,
  gmailCapProjection,
} from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import { explainErrorCode } from '@/lib/analytics/error-codes';
import { BarSeries, ProgressMeter, formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { MetricLink } from '../MetricLink';
import { MixBars, SectionError, Section, StatCard } from './shared';

const AXIS_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const MONTH_FORMAT = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** How many failure rows are shown before the rest goes behind a disclosure. */
const TOP_FAILURES = 6;

function monthLabel(value: string | null) {
  if (!value) return null;
  return MONTH_FORMAT.format(new Date(`${value}-01T00:00:00Z`));
}

export async function HealthSection({ days }: { days: number }) {
  const [dailyResult, errorResult, capResult, providerResult, clientResult, volumeResult] = await Promise.all([
    fetchDailyMetrics(days),
    fetchErrorBreakdown(days),
    fetchGmailCapSummary(),
    fetchProviderMix(),
    fetchClientMix(),
    fetchUsageVolume(days),
  ]);

  if (!dailyResult.ok) return <SectionError title="Health" message={dailyResult.error} />;

  const rows = dailyResult.data;
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const successes = rows.reduce((total, row) => total + row.successes, 0);
  const errors = rows.reduce((total, row) => total + row.errors, 0);
  const rateLimited = rows.reduce((total, row) => total + row.rate_limited, 0);

  const cap = capResult.ok ? capResult.data : null;
  const projection = cap ? gmailCapProjection(cap) : null;
  const exhaustion = projection ? monthLabel(projection.projectedExhaustion) : null;

  const failures = errorResult.ok ? errorResult.data : [];
  const volume = volumeResult.ok ? volumeResult.data : null;

  // Only worth drawing once a client other than "unknown" has been recorded.
  // Until then it is a single row that says nothing on every render.
  const clientRows = clientResult.ok
    ? clientResult.data.filter((row) => row.client && row.client !== 'unknown')
    : [];

  return (
    <Section
      id="health"
      title="Health and ceilings"
      explain={
        <>
          Call quality over the last {days} days, and the operational limits that will bite next. A high
          aggregate success rate is compatible with one provider failing every single time, so read the
          failure table rather than the headline. Negative codes are JSON-RPC transport errors, which are
          almost always the client sending something the server rejected; named codes are the server, the
          mail provider, or a genuine not-found. Hover any code for what it means and who to look at
          first.
        </>
      }
      aside={projection && projection.level !== 'ok' ? (
        <span className={`growth-cap-flag is-${projection.level}`}>
          Gmail verification: {formatCount(projection.remaining)} slots left
          {exhaustion ? `, full around ${exhaustion}` : ''}
        </span>
      ) : undefined}
    >
      {/* The Gmail cap goes first. It is the one number on this page with a
          calendar deadline attached, and the remedy takes weeks. */}
      {capResult.ok && cap && projection ? (
        <div className="growth-panel growth-cap" style={{ marginBottom: 18 }}>
          <ProgressMeter
            value={projection.used}
            max={GMAIL_OAUTH_USER_CAP}
            label="Gmail OAuth grants used"
            note="Distinct Google accounts that have ever granted consent. Cumulative on Google's side: revoking access or deleting an inbox does not return a slot, which is why soft-deleted inboxes are counted. Our figure is a floor; the authoritative number is in the Cloud Console."
            unit="grants"
            thresholds={{ warn: 0.6, danger: 0.8 }}
          />
          <dl className="growth-cap-facts">
            <div><dt>New in 30 days</dt><dd>{formatCount(cap.grants_last_30d)}</dd></div>
            <div><dt>Rate</dt><dd>{projection.ratePerMonth.toFixed(1)} / month</dd></div>
            <div><dt>Slots left</dt><dd>{formatCount(projection.remaining)}</dd></div>
            <div><dt>Projected full</dt><dd>{exhaustion ?? 'No growth'}</dd></div>
            <div><dt>Connected now</dt><dd>{formatCount(cap.active)}</dd></div>
            <div style={{ alignSelf: 'end' }}>
              <MetricLink metricKey="gmail_grants">Grant history</MetricLink>
            </div>
          </dl>
          {cap.google_reported_users !== null && (
            <p className="growth-note">
              Cloud Console last reported {cap.google_reported_users} on {cap.google_reported_at?.slice(0, 10)}.
            </p>
          )}
        </div>
      ) : (
        <div className="growth-error" style={{ marginBottom: 18 }}>
          <strong>Gmail cap could not load.</strong>
          <code>{capResult.ok ? 'No data' : capResult.error}</code>
        </div>
      )}

      <section className="growth-stat-grid" aria-label="Reliability summary" style={{ marginBottom: 18 }}>
        <StatCard
          label={`Tool calls (${days}d)`}
          value={calls}
          detail={`${ratio(successes, calls)} succeeded`}
          explain="Every logged MCP tool call, successful or not. A volume number, not a user number: one looping client can dominate it, so read it beside the active-account counts."
        />
        <StatCard label="Errors" value={errors} detail="Calls that returned a failure" />
        <StatCard
          label="Rate limited"
          value={rateLimited}
          detail="Rejected by the rate limiter"
          explain="Calls refused before doing any work. A sustained count means one key is looping; the limiter counts every method, not just tool calls."
        />
        {/* Per-thousand rather than a percentage: at a 97 percent success rate
            the interesting movement all happens in the decimal places, where a
            rounded percentage shows nothing. */}
        <StatCard
          label="Errors per 1,000 calls"
          value={calls ? Math.round(((errors + rateLimited) / calls) * 1000) : 0}
          detail="Failures and rate limits together, over the same window"
        />
      </section>

      <div className="growth-split">
        <BarSeries
          title="Calls by outcome"
          data={rows.map((row) => ({
            label: AXIS_FORMAT.format(new Date(`${row.day}T00:00:00Z`)),
            values: [row.successes, row.errors, row.rate_limited],
          }))}
          series={[
            { key: 'successes', name: 'Success' },
            { key: 'errors', name: 'Error' },
            { key: 'rate_limited', name: 'Rate limited' },
          ]}
          stacked
        />

        <MixBars
          title="Mail provider"
          unit="active inboxes"
          rows={providerResult.ok
            ? providerResult.data.map((row) => ({ name: row.provider, count: row.inboxes }))
            : []}
          emptyLabel={providerResult.ok ? 'No active inboxes.' : 'Provider mix could not load.'}
        />
      </div>

      {clientRows.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <MixBars
            title="MCP client"
            unit="workspaces"
            rows={clientRows.map((row) => ({ name: row.client, count: row.workspaces }))}
          />
        </div>
      )}

      {errorResult.ok ? (
        <>
          <div className="growth-heading" style={{ margin: '24px 0 12px' }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>What is failing</h3>
            <InfoDot label="Error codes" align="end">
              Hover any code for what it means. Negative numbers are JSON-RPC transport errors defined by
              the MCP protocol; names are the server&rsquo;s own application codes.
            </InfoDot>
          </div>
          <FailureTable rows={failures.slice(0, TOP_FAILURES)} />
          {failures.length > TOP_FAILURES && (
            <details className="growth-raw">
              <summary>Show the other {failures.length - TOP_FAILURES} failure code(s)</summary>
              <div>
                <FailureTable rows={failures.slice(TOP_FAILURES)} />
              </div>
            </details>
          )}
        </>
      ) : (
        <div className="growth-error" style={{ marginTop: 18 }}>
          <strong>Error breakdown unavailable.</strong><code>{errorResult.error}</code>
        </div>
      )}

      {/* The action cap survives only as an abuse ceiling since the repricing,
          so it is one line rather than the four panels it used to be. */}
      {volume && (
        <p className="growth-note">
          {formatCount(volume.billable_actions)} billable action(s) from{' '}
          {formatCount(volume.billable_workspaces)} workspace(s) across {formatCount(volume.total_workspaces)}{' '}
          in total. {volume.cap_hit_workspaces === 0
            ? 'No workspace has been refused an action for exceeding its allowance.'
            : `${formatCount(volume.cap_hit_workspaces)} workspace(s) were refused ${formatCount(volume.cap_rejections)} call(s) for exceeding their allowance.`}
          <InfoDot label="The action cap">
            Since the 2026-08-19 repricing the action allowance is an <strong>abuse ceiling</strong>, not a
            sold quantity: what customers buy is connected inboxes. A workspace approaching it is worth
            looking at for a runaway loop, not for an upgrade prompt. Enforcement currently applies to a
            deterministic 5 percent cohort of newer workspaces, so a count near zero reflects the rollout
            as much as it reflects usage.
          </InfoDot>
        </p>
      )}
    </Section>
  );
}

function FailureTable({ rows }: { rows: { tool_name: string; error_code: string | null; failures: number; calls: number }[] }) {
  return (
    <div className="growth-table-wrap growth-table-cards">
      <table className="growth-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Error code</th>
            <th>Failures</th>
            <th>Failure rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td className="growth-empty" colSpan={4}>No failures recorded in this window.</td></tr>}
          {rows.map((row) => (
            <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
              <td data-label="Tool">{row.tool_name}</td>
              <td data-label="Error code" style={{ textAlign: 'right' }}><ErrorCode code={row.error_code} /></td>
              <td data-label="Failures">{formatCount(row.failures)}</td>
              <td data-label="Failure rate">
                {ratio(row.failures, row.calls)}
                <span className="growth-account-sub">of {formatCount(row.calls)} calls</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A failure code with its meaning behind a hover. Codes we cannot explain are
 * rendered plainly rather than with an empty tooltip, so an unexplained code is
 * visibly unexplained instead of looking like a documented one.
 */
function ErrorCode({ code }: { code: string | null }) {
  if (!code) return <>&mdash;</>;
  const explanation = explainErrorCode(code);
  if (!explanation) return <code className="growth-code">{code}</code>;
  return (
    <span className="growth-code-cell">
      <code className="growth-code">{code}</code>
      <InfoDot label={code} align="end">
        <strong>{explanation.title}</strong>
        <br />
        {explanation.detail}
        <br />
        <span className="growth-blame">Look at: {BLAME_LABELS[explanation.blame]}</span>
      </InfoDot>
    </span>
  );
}

const BLAME_LABELS: Record<string, string> = {
  client: 'the calling client or model',
  provider: 'the mail provider',
  server: 'our server',
  user: 'the user or their credentials',
};
