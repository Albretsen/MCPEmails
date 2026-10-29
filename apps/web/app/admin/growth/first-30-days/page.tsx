/**
 * /admin/growth/first-30-days: payers whose assistant has not managed a single
 * successful call since they paid, and what the M2 stuck note did about each.
 *
 * The note is never sent to the customer automatically: the dispatcher saves a
 * draft in the founder's mailbox (or an internal notice when that fails). This
 * page is the list behind those drafts, so a missing draft is visible too.
 * Reads only. Same ADMIN_EMAILS gate as the rest of /admin/growth.
 *
 * The "Go-live switch" card shows the dry-run-to-live switch
 * (src/lib/retention/first-30-days-go-live.ts): the mode and where it comes
 * from, the automatic decision, the last mailbox probe and a live tally of the
 * go-live criteria, plus the SQL that re-arms a decided switch.
 *
 * Rules: src/lib/retention/first-30-days.ts. No client JavaScript.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { first30StartAt, listStuckPayers, type StuckRow } from '@/lib/retention/first-30-days';
import { SupabaseFirst30Store } from '@/lib/retention/first-30-days-store';
import {
  CRITERIA_TEXT,
  defaultRetryAt,
  evaluateGoLive,
  evidenceFromLog,
  resolveFirst30Mode,
  retrySql,
  type GoLiveResult,
  type ResolvedMode,
} from '@/lib/retention/first-30-days-go-live';
import { SupabaseGoLiveStore } from '@/lib/retention/first-30-days-go-live-store';
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
  const startAt = first30StartAt();
  const now = new Date();
  const goLiveStore = new SupabaseGoLiveStore(createServiceRoleClient());
  const resolved: ResolvedMode = await resolveFirst30Mode(process.env, () => goLiveStore.readSwitch());
  const mode = resolved.mode;
  let tally: GoLiveResult | null = null;
  let lastProbe: { at: string; ok: boolean; error: string | null } | null = null;
  let tallyError: string | null = null;
  try {
    const evidenceRows = await goLiveStore.readEvidence(startAt);
    tally = evaluateGoLive(evidenceFromLog(evidenceRows, now, startAt));
    const probes = evidenceRows.filter((r) => r.decision === 'mailbox_probe');
    const last = probes[probes.length - 1];
    if (last) lastProbe = { at: last.runAt, ok: !last.error, error: last.error };
  } catch (err) {
    tallyError = err instanceof Error ? err.message : String(err);
  }
  const sw = resolved.switchRow;
  const failedIds = Array.isArray((sw?.decisionDetail as { failed?: unknown } | null)?.failed)
    ? ((sw!.decisionDetail as { failed: string[] }).failed)
    : [];
  const sourceWords: Record<string, string> = {
    off: 'FIRST30_ENABLED is not on',
    env_override: 'FIRST30_DRY_RUN env override',
    db: 'retention_switches row',
    db_unreadable: 'row unreadable, failing safe to dry run',
  };

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
            {`FIRST30 = ${mode} (${sourceWords[resolved.source]})`}
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


      <article className="ac-card xp-card" style={{ marginTop: 14 }}>
        <div className="xp-head">
          <h2>Go-live switch</h2>
          <span className={`xp-pill ${sw?.decision === 'went_live' ? 'xp-pill-running' : sw?.decision === 'held' ? 'xp-pill-draft' : 'xp-pill-concluded'}`}>
            {sw ? `${sw.mode}${sw.decision ? `, ${sw.decision}` : ', undecided'}` : 'no switch row'}
          </span>
        </div>
        <p className="xp-desc">
          {`Row mode: ${sw?.mode ?? '-'}. Effective: ${mode} from ${sourceWords[resolved.source]}. Automatic decision at ${when(sw?.autoGoLiveAt ?? null)}`}
          {sw?.decision ? `; decided ${when(sw.decidedAt)}: ${sw.decision}${failedIds.length ? ` (failed: ${failedIds.join(', ')})` : ''}.` : '; not decided yet.'}
          {resolved.source === 'env_override' ? ' The env override is set, so the automatic decision is skipped until it is removed.' : ''}
        </p>
        <p className="xp-note">
          {lastProbe
            ? `Last mailbox probe ${when(lastProbe.at)}: ${lastProbe.ok ? 'ok' : `failed (${lastProbe.error ?? 'unknown'})`}.`
            : 'No mailbox probe logged yet.'}
        </p>
        {tallyError ? <p className="xp-note xp-sum-bad">{`Could not read the dry-run log: ${tallyError}`}</p> : null}
        {tally ? (
          <table className="ac-table xp-table">
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Now</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {tally.criteria.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{CRITERIA_TEXT[c.id]}</th>
                  <td>{c.pass ? 'pass' : 'not yet'}</td>
                  <td>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="xp-note">
          Decided once, never again automatically. To re-arm it (for example after a hold), run this one statement with
          a new time:
        </p>
        <pre className="xp-note" style={{ whiteSpace: 'pre-wrap' }}>{retrySql(defaultRetryAt(now))}</pre>
        <p className="xp-note">
          Emergency overrides: FIRST30_DRY_RUN=true forces dry run, FIRST30_DRY_RUN=false forces live, unset hands the
          mode back to the row.
        </p>
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
