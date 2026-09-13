/**
 * /admin/growth/usage-cap: the Free workspaces near or at their action
 * allowance, and the one thing an operator can do about it from here.
 *
 * THE SAME PATTERN AS /admin/growth/experiments. Server-rendered HTML, plain
 * forms posting to a route handler that answers 303 back to this URL, no
 * client JavaScript, `force-dynamic` because an exemption granted a second
 * ago must be on the next render. Server Actions are not used anywhere under
 * /admin/growth because their action-ID lookup failed in production on this
 * app (verified 2026-08-30).
 *
 * WHAT IT SHOWS. Every externally owned Free workspace at 50% or more of its
 * allowance this period, most used first, with the owner's address. This is
 * the one page in the feature that names the person, on purpose: the board
 * band prints the domain and the wall kiosk prints nothing, and an operator
 * about to grant an exemption or answer a support mail needs the address.
 * It sits behind the same ADMIN_EMAILS session as the account tables.
 *
 * WHAT IT DOES. A "grant exemption until" form, posting to ./exempt, which
 * writes a workspace_usage_exemptions row with the same validation as
 * /api/admin/usage-exemptions. workspace_action_allowance() reads that table
 * live, so the edge function honours the exemption on the next call.
 *
 * The numbers are read through the same cached fetcher the board band uses,
 * so this page cannot disagree with the tile that linked to it. The Refresh
 * button drops the cache for both.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { fetchUsageCapWorkspaces } from '@/lib/analytics/growth-queries';
import type { GrowthUsageCapWorkspaceRow } from '@/lib/analytics/growth-types';
import { capShare, describeUsageCapState } from '@/lib/analytics/usage-cap';
import { NO_DATA, formatCount } from '../../../../components/admin/charts/format';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-experiments.css';

export const metadata = { title: 'Usage cap · MCP Emails', robots: { index: false, follow: false } };

/** An exemption granted a second ago must be on the next render. */
export const dynamic = 'force-dynamic';

const PAGE_PATH = '/admin/growth/usage-cap';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Day precision: these are facts about rows, not a series. */
function day(value: string | null): string {
  if (!value) return NO_DATA;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NO_DATA;
  return parsed.toISOString().slice(0, 10);
}

/** Minute precision, UTC, for "when did they last do something". */
function when(value: string | null): string {
  if (!value) return 'never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NO_DATA;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The first of next month, as the form's default "until". */
function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

function Roster({ rows }: { rows: GrowthUsageCapWorkspaceRow[] }) {
  if (rows.length === 0) {
    return <p className="xp-empty">No Free workspace is past half its allowance this period.</p>;
  }
  return (
    <div className="ac-scroll">
      <table className="ac-table xp-table">
        <thead>
          <tr>
            <th scope="col">Owner</th>
            <th scope="col">Workspace</th>
            <th scope="col">State</th>
            <th scope="col">Used</th>
            <th scope="col">Share</th>
            <th scope="col">Left</th>
            <th scope="col">Resets</th>
            <th scope="col">Last action</th>
            <th scope="col">Refused</th>
            <th scope="col">Emails</th>
            <th scope="col">Paused rules</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const share = capShare(row.used, row.cap);
            return (
              <tr key={row.workspace_id}>
                <th scope="row">
                  <a href={`/admin/growth/users/${row.owner_id}`}>{row.owner_email ?? row.owner_domain ?? 'unknown'}</a>
                </th>
                <td className="bd-cell-text">
                  {row.workspace_name ?? ''}
                  <br />
                  <code className="xp-key">{row.workspace_id.slice(0, 8)}</code>
                </td>
                <td className={row.state === 'capped' ? 'xp-sum-bad' : undefined}>{describeUsageCapState(row.state)}</td>
                <td>{`${formatCount(row.used)} of ${row.cap === null ? NO_DATA : formatCount(row.cap)}`}</td>
                <td>{share === null ? NO_DATA : `${share}%`}</td>
                <td>{row.remaining === null ? NO_DATA : formatCount(row.remaining)}</td>
                <td>{day(row.period_end)}</td>
                <td>{when(row.last_action_at)}</td>
                <td>{formatCount(row.refusals)}</td>
                <td className="bd-cell-text">
                  {row.emails_sent ? `sent: ${row.emails_sent}` : ''}
                  {row.emails_sent && row.emails_queued ? <br /> : null}
                  {row.emails_queued ? `queued: ${row.emails_queued}` : ''}
                  {!row.emails_sent && !row.emails_queued ? 'none' : ''}
                </td>
                <td className={row.paused_rules > 0 ? 'xp-sum-bad' : undefined}>{formatCount(row.paused_rules)}</td>
                <td>
                  <a href={`${PAGE_PATH}?workspace_id=${row.workspace_id}#exempt`}>Exempt</a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The exemption form. Posts to ./exempt, which validates exactly as
 * /api/admin/usage-exemptions does and 303s back here. A blank "until" is
 * an open-ended exemption, which the form says in words next to the field
 * because it is the more consequential of the two.
 */
function ExemptForm({ workspaceId }: { workspaceId: string }) {
  return (
    <article className="ac-card xp-card" id="exempt">
      <div className="xp-head">
        <h2>Grant an exemption</h2>
      </div>
      <p className="xp-desc">
        Lifts the Free allowance for one workspace until the date given. It changes nothing in Stripe and nothing
        else about the plan; the edge function reads it on the next call. Revoke it from the API
        (DELETE /api/admin/usage-exemptions).
      </p>
      <form method="post" action={`${PAGE_PATH}/exempt`} className="xp-row">
        <label className="xp-field xp-field-wide">
          <span>Workspace id</span>
          <input
            type="text"
            name="workspace_id"
            defaultValue={workspaceId}
            required
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            placeholder="a uuid from the table above"
            title="A workspace uuid."
          />
        </label>
        <label className="xp-field xp-field-wide">
          <span>Reason</span>
          <input type="text" name="reason" required maxLength={500} placeholder="What they told us, and why we agree" />
        </label>
        <label className="xp-field">
          <span>Ticket</span>
          <input type="text" name="ticket_id" required maxLength={200} placeholder="support thread or issue id" />
        </label>
        <label className="xp-field">
          <span>Until (UTC, blank = no end)</span>
          <input type="date" name="expires_at" defaultValue={firstOfNextMonth()} />
        </label>
        <button type="submit" className="xp-btn xp-btn-primary">Grant exemption</button>
      </form>
      <p className="xp-hint">
        The exemption starts now and ends at 00:00 UTC on the date given. The default is the 1st, which is when
        the allowance resets anyway; a longer one is a decision worth a line in the reason.
      </p>
    </article>
  );
}

export default async function UsageCapPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; workspace_id?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const prefill = params.workspace_id && UUID.test(params.workspace_id) ? params.workspace_id : '';
  const roster = await fetchUsageCapWorkspaces();

  return (
    <main className="board">
      <header className="bd-head">
        <div>
          <h1>Usage cap</h1>
          <p className="bd-head-sub">
            Free workspaces at half their 150 email actions or more this UTC month. The first 7 days after signup are
            not counted, and every workspace from before 2026-09-12 is exempt for good, so none of those appear here.
          </p>
        </div>
        <div className="bd-tools">
          <a href="/admin/growth#usage-cap">Growth</a>
          <a href="/admin/growth/users">People</a>
          <form action="/admin/growth/refresh" method="POST">
            <button type="submit">Refresh</button>
          </form>
        </div>
      </header>

      {params.error ? (
        <p className="xp-banner xp-banner-error" role="alert">{params.error}</p>
      ) : null}
      {params.ok ? (
        <p className="xp-banner xp-banner-ok">{`Saved: ${params.ok}.`}</p>
      ) : null}

      <div className="xp-list">
        <article className="ac-card xp-card">
          <div className="xp-head">
            <h2>Near or at the wall</h2>
            <span className="xp-pill xp-pill-draft">
              {roster.ok ? `${formatCount(roster.data.length)} workspaces` : 'unavailable'}
            </span>
          </div>
          {roster.ok ? (
            <Roster rows={roster.data} />
          ) : (
            <p className="xp-note xp-sum-bad">
              {`The roster could not be read: ${roster.error}. If this names a missing function, migration 20260912210000 has not been applied.`}
            </p>
          )}
          <p className="xp-hint">
            Most used first. Emails are this period&apos;s usage notices (80% warning, limit reached, automation
            paused), one of each per workspace per month. Refused counts every call the allowance turned away since
            the period opened. Cached ten minutes with the board; Refresh drops it.
          </p>
        </article>

        <ExemptForm workspaceId={prefill} />
      </div>

      <p className="bd-foot">
        Our own accounts are excluded. UTC throughout. The state here is bucketed by the same rules the edge function
        enforces from, so a workspace this page calls capped is one whose next call is refused.
      </p>
    </main>
  );
}
