/**
 * /admin/growth/inbox-alerts: the read-out of the broken-inbox alert test
 * (experiment inbox_broken_alert, src/lib/retention/inbox-alert.ts).
 *
 * Per arm, over first alerts (sent, or recorded for the holdout at the moment
 * it would have been sent): breaks, workspaces, second alerts, and breaks that
 * ended with the inbox working again within 7 days. "Mature" breaks are at
 * least 7 days old, the fair denominator for the 7-day rate. Reads only. Same
 * ADMIN_EMAILS gate as the rest of /admin/growth. No client JavaScript.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { inboxAlertMode } from '@/lib/retention/inbox-alert';
import { loadInboxAlertReadout, type ReadoutRow } from '@/lib/retention/inbox-alert-store';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-experiments.css';

export const metadata = {
  title: 'Broken-inbox alert',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const pct = (num: number, den: number) => (den > 0 ? `${Math.round((num / den) * 100)}%` : '-');

export default async function InboxAlertsPage() {
  await requireAdmin();
  const mode = inboxAlertMode();

  let rows: ReadoutRow[] = [];
  let loadError: string | null = null;
  try {
    rows = await loadInboxAlertReadout(createServiceRoleClient());
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="board">
      <header className="bd-head">
        <h1>Broken-inbox alert</h1>
        <p className="bd-head-sub">
          Paid workspaces with an inbox whose sign-in the provider refused for 24 hours. Alert arm: email now, a
          second email after 5 days if still broken, and a dashboard banner. Holdout: nothing new.
        </p>
      </header>

      <article className="ac-card xp-card">
        <div className="xp-head">
          <h2>State</h2>
          <span className={`xp-pill ${mode === 'on' ? 'xp-pill-running' : mode === 'dry_run' ? 'xp-pill-concluded' : 'xp-pill-draft'}`}>
            {`INBOX_ALERT_ENABLED = ${mode}`}
          </span>
        </div>
        <p className="xp-desc">
          {mode === 'on'
            ? 'Live. The hourly dispatcher assigns, sends and records.'
            : mode === 'dry_run'
              ? 'Dry run. The dispatcher logs candidates and writes nothing, so the table stays empty.'
              : 'Off. The dispatcher returns before reading anything.'}
        </p>
        {loadError ? <p className="xp-note xp-sum-bad">{`Could not read the read-out: ${loadError}`}</p> : null}
      </article>

      {loadError ? null : (
        <article className="ac-card xp-card" style={{ marginTop: 14 }}>
          {rows.length === 0 ? (
            <p className="xp-note">No breaks recorded yet.</p>
          ) : (
            <table className="ac-table xp-table">
              <thead>
                <tr>
                  <th scope="col">Arm</th>
                  <th scope="col">Breaks</th>
                  <th scope="col">Workspaces</th>
                  <th scope="col">First email sent</th>
                  <th scope="col">Second (sent or would)</th>
                  <th scope="col">Reconnected in 7 days</th>
                  <th scope="col">Of mature (7+ days old)</th>
                  <th scope="col">Reconnected ever</th>
                  <th scope="col">Still broken</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.arm}>
                    <th scope="row">{r.arm}</th>
                    <td>{r.breaks}</td>
                    <td>{r.workspaces}</td>
                    <td>{r.arm === 'alert' ? `${r.firstSent}${r.firstFailed ? ` (${r.firstFailed} failed)` : ''}` : '-'}</td>
                    <td>{r.secondRows}</td>
                    <td>{`${r.reconnected7d} (${pct(r.reconnected7d, r.breaks)})`}</td>
                    <td>{`${r.reconnected7dMature} of ${r.mature} (${pct(r.reconnected7dMature, r.mature)})`}</td>
                    <td>{r.reconnectedAny}</td>
                    <td>{r.stillOpen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="xp-note">
            Funnel rows: inbox_alert_sent (alert_1, alert_2), inbox_alert_holdout (alert_1, alert_2), inbox_reconnected
            (category = arm). Ledger: public.inbox_alert_sends.
          </p>
        </article>
      )}
    </main>
  );
}
