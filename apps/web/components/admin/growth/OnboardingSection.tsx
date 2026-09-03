/**
 * Onboarding: how far new workspaces get, and exactly where they stop.
 *
 * MERGES two sections that were always read together and never apart: the
 * signup-to-value funnel, and the per-provider connection funnel with its
 * OAuth abandonment table. The funnel says a stage loses people; the provider
 * tables say which provider and with what error. Split across two headings
 * with a retention section between them, answering "why" meant scrolling back.
 *
 * The funnel reads the durable `workspaces.onboarding_*_at` columns rather than
 * re-deriving stages from activity, so it stays correct after `activity_log` is
 * purged at 90 days, and it is cohorted on signup date: every workspace counted
 * at stage 1 is the same population measured at stage 7, which is the only way
 * a drop-off percentage means anything.
 *
 * The provider table is the view that would have caught Yandex months earlier:
 * 2 workspaces, 21 consecutive `auth_failed` attempts, 0 successes, invisible
 * in every aggregate the old page had.
 *
 * The abandonment table measures a leak that leaves no `product_funnel_events`
 * row at all. `oauth_states` rows are deleted on a successful callback and
 * never cleaned up otherwise, so a surviving row is a user who left for the
 * provider's consent screen and never came back. For Gmail that number is large
 * and the cause is known: the app is published but unverified, so users meet
 * Google's unverified-app interstitial.
 */

import {
  fetchActivationFunnel,
  fetchOAuthAbandonment,
  fetchProviderFunnel,
} from '@/lib/analytics/growth-queries';
import { FunnelBars, formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section } from './shared';

const STAGE_LABELS: Record<string, string> = {
  signup: 'Signed up',
  client_selected: 'Picked an MCP client',
  inbox_connected: 'Connected an inbox',
  connection_verified: 'Connection verified',
  credential_issued: 'Got an API key',
  technical_activation: 'First successful tool call',
  value_activation: 'First mailbox operation',
};

/**
 * Only the OAuth flows that still exist. `oauth_states` also holds stale
 * nonces from the Fastmail OAuth flow removed in June 2026, and Fastmail
 * inboxes are stored as `provider = 'imap'`, so that row would render as a 100
 * percent abandonment rate for a flow nobody can reach.
 */
const LIVE_OAUTH_PROVIDERS = new Set(['gmail', 'outlook']);

export async function OnboardingSection({ days }: { days: number }) {
  const [funnelResult, providerResult, abandonmentResult] = await Promise.all([
    fetchActivationFunnel(days),
    fetchProviderFunnel(days),
    fetchOAuthAbandonment(),
  ]);

  if (!funnelResult.ok) return <SectionError title="Onboarding" message={funnelResult.error} />;

  const steps = [...funnelResult.data]
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((row) => ({ label: STAGE_LABELS[row.stage] ?? row.stage, value: row.workspaces }));

  const providers = providerResult.ok
    ? [...providerResult.data].sort((a, b) => b.workspaces_attempted - a.workspaces_attempted)
    : [];

  const abandonment = abandonmentResult.ok
    ? abandonmentResult.data.filter((row) => LIVE_OAUTH_PROVIDERS.has(row.provider))
    : [];

  return (
    <Section
      id="onboarding"
      title="Onboarding"
      explain={
        <>
          Workspaces created in the last {days} days, measured against how far they got. Stages are
          cumulative, so a workspace that reached a later stage counts at every earlier one and the funnel
          can only narrow. Value activation is the stage that matters: everything before it proves only
          that the plumbing works.
          <br /><br />
          <strong>Read the middle stages with care.</strong> Client selection and connection verification
          were only instrumented on 2026-08-05, and the backfill set late timestamps without earlier ones,
          so for older workspaces those two are inferred from the stage that follows and carry no
          independent signal.
          <br /><br />
          The two tables below say <em>why</em> the connect stage loses people. Read the workspace
          columns, not the attempt columns: one user retrying a broken provider twenty times is one lost
          user, not twenty.
        </>
      }
    >
      <FunnelBars title={`Workspaces created in the last ${days} days`} steps={steps} />

      <div className="growth-heading" style={{ margin: '24px 0 12px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Connection attempts by provider</h3>
        <InfoDot label="Connection funnel">
          &ldquo;Resolved attempts&rdquo; counts attempts that ended in a success or a failure, so it
          always equals the two columns beside it. A consent screen opened and never returned from
          resolves as neither, and is counted in the abandonment table below.
        </InfoDot>
      </div>
      {providerResult.ok ? (
        <div className="growth-table-wrap growth-table-cards">
          <table className="growth-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Tried</th>
                <th>Connected</th>
                <th>Connect rate</th>
                <th>Failures</th>
                <th>Top failure</th>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 && (
                <tr><td className="growth-empty" colSpan={6}>No connection attempts in this window.</td></tr>
              )}
              {providers.map((row) => (
                <tr key={row.provider}>
                  <td data-label="Provider">{row.provider}</td>
                  <td data-label="Tried">{formatCount(row.workspaces_attempted)}</td>
                  <td data-label="Connected">{formatCount(row.workspaces_connected)}</td>
                  <td data-label="Connect rate">{ratio(row.workspaces_connected, row.workspaces_attempted)}</td>
                  <td data-label="Failures">{formatCount(row.failures)}</td>
                  <td data-label="Top failure" style={{ textAlign: 'right' }}>{row.top_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="growth-error"><strong>Provider funnel could not load.</strong><code>{providerResult.error}</code></div>
      )}

      <div className="growth-heading" style={{ margin: '24px 0 12px' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>OAuth consent abandonment</h3>
        <InfoDot label="OAuth consent abandonment">
          All-time. Users who left for the provider&rsquo;s consent screen and never came back. This leak
          records no funnel event of any kind, so it is counted from the leftover OAuth state rows, which
          are deleted on a successful callback and never cleaned up otherwise. For Gmail the cause is
          known: the app is published but unverified, so users meet Google&rsquo;s unverified-app
          interstitial. Only providers whose OAuth flow still exists are listed.
        </InfoDot>
      </div>
      {abandonmentResult.ok ? (
        <div className="growth-table-wrap growth-table-cards">
          <table className="growth-table">
            <thead><tr><th>Provider</th><th>Abandoned</th><th>Connected</th><th>Abandonment rate</th></tr></thead>
            <tbody>
              {abandonment.length === 0 && (
                <tr><td className="growth-empty" colSpan={4}>No OAuth attempts recorded.</td></tr>
              )}
              {abandonment.map((row) => (
                <tr key={row.provider}>
                  <td data-label="Provider">{row.provider}</td>
                  <td data-label="Abandoned">{formatCount(row.abandoned)}</td>
                  <td data-label="Connected">{formatCount(row.connected)}</td>
                  <td data-label="Abandonment rate">{ratio(row.abandoned, row.abandoned + row.connected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="growth-error"><strong>Abandonment could not load.</strong><code>{abandonmentResult.error}</code></div>
      )}
    </Section>
  );
}
