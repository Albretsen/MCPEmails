/**
 * Connection funnel by provider, plus OAuth consent abandonment.
 *
 * This is the view that would have caught Yandex months earlier: 2 workspaces,
 * 21 consecutive `auth_failed` attempts, 0 successes, invisible in every
 * aggregate on the old page.
 *
 * The abandonment table beside it measures a leak that leaves no
 * `product_funnel_events` row at all. `oauth_states` rows are deleted on a
 * successful callback and never cleaned up otherwise, so a surviving row is a
 * user who left for the provider's consent screen and never came back. For
 * Gmail that number is large and the cause is known: the app is published but
 * unverified, so users meet Google's unverified-app interstitial.
 */

import { fetchOAuthAbandonment, fetchProviderFunnel } from '@/lib/analytics/growth-queries';
import { formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section } from './shared';

/**
 * Only the OAuth flows that still exist. `oauth_states` also holds stale
 * nonces from the Fastmail OAuth flow that was removed in June 2026, and
 * Fastmail inboxes are stored as `provider = 'imap'`, so that row would render
 * as a 100 percent abandonment rate for a flow nobody can even reach.
 */
const LIVE_OAUTH_PROVIDERS = new Set(['gmail', 'outlook']);

export async function ProviderFunnelSection({ days }: { days: number }) {
  const [funnelResult, abandonmentResult] = await Promise.all([
    fetchProviderFunnel(days),
    fetchOAuthAbandonment(),
  ]);

  if (!funnelResult.ok) return <SectionError title="Connection funnel by provider" message={funnelResult.error} />;

  const rows = [...funnelResult.data].sort((a, b) => b.workspaces_attempted - a.workspaces_attempted);

  return (
    <Section
      title="Connection funnel by provider"
      explain={
        <>
          Inbox connection attempts in the last {days} days. Read the workspace columns, not the attempt
          columns: one user retrying a broken provider twenty times is one lost user, not twenty. This is
          the view that would have caught Yandex months earlier (2 workspaces, 21 consecutive auth
          failures, 0 successes).
        </>
      }
    >
      <div className="growth-table-wrap">
        <table className="growth-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Workspaces tried</th>
              <th>Workspaces connected</th>
              <th>Connect rate</th>
              <th>Attempts</th>
              <th>Failures</th>
              <th>Top failure reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="growth-empty" colSpan={7}>No connection attempts in this window.</td></tr>}
            {rows.map((row) => (
              <tr key={row.provider}>
                <td>{row.provider}</td>
                <td>{formatCount(row.workspaces_attempted)}</td>
                <td>{formatCount(row.workspaces_connected)}</td>
                <td>{ratio(row.workspaces_connected, row.workspaces_attempted)}</td>
                <td>{formatCount(row.attempts)}</td>
                <td>{formatCount(row.failures)}</td>
                <td style={{ textAlign: 'right' }}>{row.top_error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
        <div className="growth-table-wrap">
          <table className="growth-table">
            <thead><tr><th>Provider</th><th>Abandoned</th><th>Connected</th><th>Abandonment rate</th></tr></thead>
            <tbody>
              {abandonmentResult.data.filter((row) => LIVE_OAUTH_PROVIDERS.has(row.provider)).length === 0 && (
                <tr><td className="growth-empty" colSpan={4}>No OAuth attempts recorded.</td></tr>
              )}
              {abandonmentResult.data.filter((row) => LIVE_OAUTH_PROVIDERS.has(row.provider)).map((row) => (
                <tr key={row.provider}>
                  <td>{row.provider}</td>
                  <td>{formatCount(row.abandoned)}</td>
                  <td>{formatCount(row.connected)}</td>
                  <td>{ratio(row.abandoned, row.abandoned + row.connected)}</td>
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
