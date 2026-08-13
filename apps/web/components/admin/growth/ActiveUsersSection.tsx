/**
 * Who is actually using the product.
 *
 * Every other section describes the shape of the user base without ever saying
 * who is in it, which meant that answering "which accounts are real, and how
 * much do they use it" required leaving the page and writing SQL by hand. That
 * is how both the 2026-07-28 and 2026-08-13 audits were done. At roughly a
 * hundred accounts the roster fits on one screen and is the most directly
 * useful view here.
 *
 * This is the one place on the page that names accounts. It shows the
 * workspace name, the owner's email and usage counts, and nothing else: no
 * credentials, no message content, no subjects, no recipients, no IP address.
 *
 * Internal and comped accounts are flagged rather than hidden. Removing them
 * would misrepresent load, and leaving them unmarked is how "5 paid
 * workspaces" ended up on this page when the real number was zero.
 */

import { fetchActiveWorkspaces } from '@/lib/analytics/growth-queries';
import { formatCount, ratio } from '../charts';
import { InfoDot } from '../InfoDot';
import { SectionError, Section, StatCard } from './shared';

/** Accounts we run ourselves. Their traffic is real load but not a customer. */
const INTERNAL_DOMAINS = ['@mcpemails.com', '@mcpemails.dev'];

function isInternal(email: string | null) {
  return Boolean(email && INTERNAL_DOMAINS.some((domain) => email.toLowerCase().endsWith(domain)));
}

const DATE = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function shortDate(value: string | null) {
  return value ? DATE.format(new Date(value)) : '—';
}

/** Whole days between a timestamp and now, floored. */
function daysAgo(value: string) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

export async function ActiveUsersSection({ days }: { days: number }) {
  const result = await fetchActiveWorkspaces(days);
  if (!result.ok) return <SectionError title="Active accounts" message={result.error} />;

  const rows = result.data;
  const external = rows.filter((row) => !isInternal(row.owner_email) && !row.is_comped);
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const externalCalls = external.reduce((total, row) => total + row.calls, 0);
  // "Sticky" is the bar that matters for a product this young: used on four or
  // more separate days in the window, so not a one-off trial.
  const sticky = external.filter((row) => row.active_days >= 4).length;

  return (
    <Section
      title="Active accounts"
      explain={
        <>
          Every workspace with at least one <strong>successful</strong> tool call in the last {days} days,
          most recently active first. This is the only section that names accounts. Comped and internal
          accounts are marked rather than removed, because they are real load but not customers.
        </>
      }
    >
      <section className="growth-stat-grid" aria-label="Active account summary" style={{ marginBottom: 18 }}>
        <StatCard
          label="Active accounts"
          value={rows.length}
          detail={`${external.length} external, ${rows.length - external.length} internal or comped`}
          explain="A workspace counts as active on one successful tool call. It does not have to have touched a mailbox."
        />
        <StatCard
          label="Sticky accounts"
          value={sticky}
          detail={`${ratio(sticky, external.length)} of external accounts`}
          explain="External accounts active on four or more separate days in the window. A low bar deliberately: at this stage the question is whether anyone came back at all, not whether they use it daily."
        />
        <StatCard
          label="External share of calls"
          value={ratio(externalCalls, calls)}
          detail={`${formatCount(externalCalls)} of ${formatCount(calls)} calls`}
          explain="How much of the traffic comes from someone who is not us and is not comped. A low share means the headline volume is mostly our own accounts."
        />
        <StatCard
          label="Median active days"
          value={median(external.map((row) => row.active_days))}
          detail={`Across ${external.length} external account(s)`}
          explain="The middle external account's number of active days in the window. The mean is useless here because one automated client dominates it."
        />
      </section>

      <div className="growth-table-wrap">
        <table className="growth-table growth-table-roster">
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan</th>
              <th>Last active</th>
              <th>
                Active days <InfoDot label="Active days" align="end">Distinct UTC days with a successful call, inside the selected window.</InfoDot>
              </th>
              <th>
                Sessions <InfoDot label="Sessions" align="end">Runs of activity separated by a gap of 30 minutes or more. A long-running agent can log thousands of calls in a single session.</InfoDot>
              </th>
              <th>Calls</th>
              <th>
                Success <InfoDot label="Success rate" align="end">Share of this account&rsquo;s calls that succeeded. A low rate here with high volume usually means a broken provider or a client sending bad arguments.</InfoDot>
              </th>
              <th>Inboxes</th>
              <th>Signed up</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="growth-empty" colSpan={9}>No successful calls in this window.</td></tr>}
            {rows.map((row) => {
              const internal = isInternal(row.owner_email);
              return (
                <tr key={row.workspace_id} className={internal || row.is_comped ? 'is-muted' : undefined}>
                  <td>
                    <span className="growth-account">{row.owner_email ?? 'unknown owner'}</span>
                    <span className="growth-account-sub">
                      {row.workspace_name}
                      {row.providers && ` · ${row.providers}`}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {internal && <span className="growth-tag is-internal">internal</span>}
                    {row.is_comped
                      ? <span className="growth-tag is-comped">comped</span>
                      : <span className="growth-tag">{row.plan === 'pro' ? 'Scale' : row.plan === 'solo' ? 'Agent' : 'Free'}</span>}
                  </td>
                  <td>{daysAgo(row.last_active_at) === 0 ? 'today' : `${daysAgo(row.last_active_at)}d ago`}</td>
                  <td>{row.active_days}</td>
                  <td>{formatCount(row.sessions)}</td>
                  <td>{formatCount(row.calls)}</td>
                  <td>{ratio(row.successes, row.calls)}</td>
                  <td>{row.inboxes}</td>
                  <td>{shortDate(row.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Middle value, or 0 for an empty set. Even counts take the lower of the pair. */
function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
