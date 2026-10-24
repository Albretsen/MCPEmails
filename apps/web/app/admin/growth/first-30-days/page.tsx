/**
 * /admin/growth/first-30-days: payers whose assistant has not managed a single
 * successful call since they paid, and what the M2 stuck note did about each.
 *
 * The note is never sent to the customer automatically: the dispatcher saves a
 * draft in the founder's mailbox (or an internal notice when that fails). This
 * page is the list behind those drafts, so a missing draft is visible too.
 * Reads only. Same ADMIN_EMAILS gate as the rest of /admin/growth.
 *
 * Rules: src/lib/retention/first-30-days.ts. No client JavaScript.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { first30Mode, first30StartAt, listStuckPayers, type StuckRow } from '@/lib/retention/first-30-days';
import { SupabaseFirst30Store } from '@/lib/retention/first-30-days-store';
import { explainErrorCode } from '@/lib/retention/first-30-days-templates';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-experiments.css';

export const metadata = {
  title: 'First 30 days',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const STATUS_WORDS: Record<string, string> = {
  waiting: 'Under 72 hours since paying',
  due: 'Due: the next dispatcher run saves the draft',
  drafted: 'Draft saved',
  claimed: 'Claimed, outcome unknown (not retried)',
  failed: 'Failed (not retried)',
  window_missed: 'Past day 7 without a draft',
  not_subscribed: 'Subscription no longer active',
  owner_missing: 'Owner not found',
  unusable_email: 'Owner address unusable',
};

function when(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return (
    d.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

export default async function First30Page() {
  await requireAdmin();

  let rows: StuckRow[] = [];
  let loadError: string | null = null;
  try {
    rows = await listStuckPayers(new SupabaseFirst30Store(createServiceRoleClient()), new Date());
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  const mode = first30Mode();
  const startAt = first30StartAt();

  return (
    <main className="board">
      <header className="bd-head">
        <h1>First 30 days: stuck payers</h1>
        <p className="bd-head-sub">
          Paid in the last 14 days, zero successful tool calls since paying. Internal accounts and deleted workspaces
          are left out.
        </p>
      </header>

      <article className="ac-card xp-card">
        <div className="xp-head">
          <h2>State</h2>
          <span className={`xp-pill ${mode === 'send' ? 'xp-pill-running' : mode === 'dry_run' ? 'xp-pill-concluded' : 'xp-pill-draft'}`}>
            {`FIRST30 = ${mode}`}
          </span>
        </div>
        <p className="xp-desc">
          {mode === 'send'
            ? 'Live. Drafts are saved in the founder mailbox and day-8 summaries go out.'
            : mode === 'dry_run'
              ? 'Dry run. The dispatcher reports what it would do and writes nothing.'
              : 'Off. The dispatcher returns before reading anything.'}
          {` Only payments from ${when(startAt.toISOString())} onward are acted on; this list shows all of them.`}
        </p>
        {loadError ? <p className="xp-note xp-sum-bad">{`Could not read the list: ${loadError}`}</p> : null}
      </article>

      {loadError ? null : (
        <article className="ac-card xp-card" style={{ marginTop: 14 }}>
          {rows.length === 0 ? (
            <p className="xp-note">Nobody is stuck. Every recent payer has at least one successful call.</p>
          ) : (
            <table className="ac-table xp-table">
              <thead>
                <tr>
                  <th scope="col">Workspace</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Paid</th>
                  <th scope="col">Calls</th>
                  <th scope="col">Top errors</th>
                  <th scope="col">Draft</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.workspaceId}>
                    <th scope="row">
                      <code title={row.workspaceId}>{row.workspaceId.slice(0, 8)}</code>
                    </th>
                    <td>{row.ownerEmail ?? '-'}</td>
                    <td>{when(row.paidAt)}</td>
                    <td>{row.totalCalls}</td>
                    <td>
                      {row.topErrorCodes.length === 0
                        ? '-'
                        : row.topErrorCodes.map((e) => `${e.code} x${e.count} (${explainErrorCode(e.code).plain})`).join('; ')}
                    </td>
                    <td>
                      {STATUS_WORDS[row.status] ?? row.status}
                      {row.dueAt ? ` (due ${when(row.dueAt)})` : ''}
                      {row.detail ? ` [${row.detail}]` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      )}
    </main>
  );
}
