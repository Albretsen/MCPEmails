/**
 * Reliability: call volume by outcome, and what is actually failing.
 *
 * The old page's only quality signal was an aggregate success rate per day,
 * which stays reassuringly near 98 percent while one provider is completely
 * broken for every user who tries it. The breakdown is the part that names the
 * problem.
 */

import { fetchDailyMetrics, fetchErrorBreakdown } from '@/lib/analytics/growth-queries';
import { BarSeries, formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { explainErrorCode } from '@/lib/analytics/error-codes';
import { SectionError, Section, StatCard } from './shared';

const AXIS_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function ReliabilitySection({ days }: { days: number }) {
  const [dailyResult, errorResult] = await Promise.all([fetchDailyMetrics(days), fetchErrorBreakdown(days)]);
  if (!dailyResult.ok) return <SectionError title="Reliability" message={dailyResult.error} />;

  const rows = dailyResult.data;
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const successes = rows.reduce((total, row) => total + row.successes, 0);
  const errors = rows.reduce((total, row) => total + row.errors, 0);
  const rateLimited = rows.reduce((total, row) => total + row.rate_limited, 0);

  return (
    <Section
      title="Reliability"
      explain={
        <>
          Every MCP tool call in the last {days} days by outcome. A high aggregate success rate is
          compatible with one provider failing every single time, so read the breakdown rather than the
          headline. Hover a code in the table for what it means and who to look at first. Negative codes
          are JSON-RPC transport errors, which are almost always the client sending something the server
          rejected; named codes are the server, the mail provider, or a genuine not-found.
        </>
      }
    >
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
        {/* Per-thousand rather than a percentage: at a 99 percent success rate
            the interesting movement all happens in the decimal places, where a
            rounded percentage shows nothing. */}
        <StatCard
          label="Errors per 1,000 calls"
          value={calls ? Math.round(((errors + rateLimited) / calls) * 1000) : 0}
          detail="Failures and rate limits together, over the same window"
        />
      </section>

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

      {errorResult.ok ? (
        <div className="growth-table-wrap" style={{ marginTop: 18 }}>
          <table className="growth-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>
                  Error code <InfoDot label="Error codes" align="end">Hover any code for what it means. Negative numbers are JSON-RPC transport errors defined by the MCP protocol; names are the server&rsquo;s own application codes.</InfoDot>
                </th>
                <th>Failures</th>
                <th>Calls</th>
                <th>Failure rate</th>
              </tr>
            </thead>
            <tbody>
              {errorResult.data.length === 0 && <tr><td className="growth-empty" colSpan={5}>No failures recorded in this window.</td></tr>}
              {errorResult.data.map((row) => (
                <tr key={`${row.tool_name}:${row.error_code ?? 'none'}`}>
                  <td>{row.tool_name}</td>
                  <td style={{ textAlign: 'right' }}>
                    <ErrorCode code={row.error_code} />
                  </td>
                  <td>{formatCount(row.failures)}</td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{ratio(row.failures, row.calls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="growth-error" style={{ marginTop: 18 }}>
          <strong>Error breakdown unavailable.</strong><code>{errorResult.error}</code>
        </div>
      )}
    </Section>
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
