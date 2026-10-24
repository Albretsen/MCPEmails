/**
 * /admin/referrals: the referrals a person has to look at, and the rewards
 * export for bookkeeping.
 *
 * HELD AND VOIDED ONLY. A held referral is waiting on a decision (the
 * dispatcher stopped it on a fraud signal); a voided one is a record of why a
 * reward was not paid. Everything else runs unattended and needs no screen.
 *
 * PRIVACY. Short ids only, no emails: the reason and the dates answer every
 * question this page asks, and each id links to the user page, which is where
 * an address is shown if one is needed.
 *
 * NO CLIENT JAVASCRIPT. Server-rendered with the service role, like the other
 * admin pages.
 */

import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { fetchReviewRows, REVIEW_LIMIT, shortId, type ReviewRow } from './admin-referrals';
import '../../../styles/admin-board.css';
import '../../../styles/admin-experiments.css';

export const metadata = {
  title: 'Referrals',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export default async function ReferralsAdminPage() {
  await requireAdmin();

  let rows: ReviewRow[] = [];
  let truncated = false;
  let loadError: string | null = null;
  try {
    ({ rows, truncated } = await fetchReviewRows(createServiceRoleClient()));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  const held = rows.filter((r) => r.status === 'held');
  const voided = rows.filter((r) => r.status === 'voided');

  return (
    <main className="board">
      <header className="bd-head">
        <h1>Referrals</h1>
        <p className="bd-head-sub">
          Held referrals wait for a decision; voided ones say why no reward was paid.{' '}
          <a href="/admin/referrals/rewards.csv">Download every reward as CSV</a> for bookkeeping.
        </p>
      </header>

      {loadError ? (
        <article className="ac-card xp-card">
          <p className="xp-note xp-sum-bad">
            {`The referrals table could not be read: ${loadError}. If it says the table is missing, migration 20261025090000_referrals.sql has not been applied.`}
          </p>
        </article>
      ) : (
        <>
          {truncated ? (
            <p className="xp-note xp-sum-bad">{`Showing the ${REVIEW_LIMIT} most recently updated rows; there are more.`}</p>
          ) : null}
          <ReviewTable title="Held" rows={held} reasonOf={(r) => r.hold_reason} empty="Nothing is held." />
          <ReviewTable title="Voided" rows={voided} reasonOf={(r) => r.void_reason} empty="Nothing has been voided." />
        </>
      )}
    </main>
  );
}

function ReviewTable({
  title,
  rows,
  reasonOf,
  empty,
}: {
  title: string;
  rows: ReviewRow[];
  reasonOf: (r: ReviewRow) => string | null;
  empty: string;
}) {
  return (
    <article className="ac-card xp-card" style={{ marginTop: 14 }}>
      <div className="xp-head">
        <h2>{title}</h2>
        <span className="xp-pill xp-pill-draft">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="xp-note">{empty}</p>
      ) : (
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Referral</th>
              <th scope="col">Reason</th>
              <th scope="col">Via</th>
              <th scope="col">Attached</th>
              <th scope="col">First charge</th>
              <th scope="col">Qualifies</th>
              <th scope="col">Updated</th>
              <th scope="col">Referrer</th>
              <th scope="col">Friend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><code>{shortId(r.id)}</code></td>
                <td>{reasonOf(r) ?? ''}</td>
                <td>{r.attached_via}</td>
                <td>{day(r.attached_at)}</td>
                <td>{day(r.first_charge_at)}</td>
                <td>{day(r.qualifies_at)}</td>
                <td>{day(r.updated_at)}</td>
                <td><Link href={`/admin/growth/users/${r.referrer_user_id}`}><code>{shortId(r.referrer_user_id)}</code></Link></td>
                <td><Link href={`/admin/growth/users/${r.friend_user_id}`}><code>{shortId(r.friend_user_id)}</code></Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
