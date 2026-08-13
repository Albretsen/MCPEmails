/**
 * Who is actually using the product.
 *
 * Every other section describes the shape of the user base without ever saying
 * who is in it, which meant that answering "which accounts are real, and how
 * much do they use it" required leaving the page and writing SQL by hand. That
 * is how both the 2026-07-28 and 2026-08-13 audits were done.
 *
 * This is the one place on the page that names accounts. It shows the
 * workspace name, the owner's email and usage counts, and nothing else: no
 * credentials, no message content, no subjects, no recipients, no IP address.
 *
 * Internal and comped accounts are flagged rather than hidden. Removing them
 * would misrepresent load, and leaving them unmarked is how "5 paid
 * workspaces" ended up on this page when the real number was zero.
 *
 * The table itself is a client component: filtering, sorting, search and
 * pagination all run over the array fetched here, because at this scale the
 * whole roster is a few kilobytes and a round trip per keystroke would be
 * slower than sorting it in place.
 */

import { fetchActiveWorkspaces } from '@/lib/analytics/growth-queries';
import { formatCount, ratio } from '../charts';
import { SectionError, Section, StatCard } from './shared';
import { ActiveAccountsTable } from './ActiveAccountsTable';
import { countReturned, type RosterRow } from './roster';

/** Accounts we run ourselves. Their traffic is real load but not a customer. */
const INTERNAL_DOMAINS = ['@mcpemails.com', '@mcpemails.dev'];

function isInternal(email: string | null) {
  return Boolean(email && INTERNAL_DOMAINS.some((domain) => email.toLowerCase().endsWith(domain)));
}

export async function ActiveUsersSection({ days }: { days: number }) {
  const result = await fetchActiveWorkspaces(days);
  if (!result.ok) return <SectionError title="Active accounts" message={result.error} />;

  // The internal-domain list is applied here so it stays server-side; the
  // table only ever sees the resulting flag.
  const rows: RosterRow[] = result.data.map((row) => ({ ...row, is_internal: isInternal(row.owner_email) }));
  const external = rows.filter((row) => !row.is_internal && !row.is_comped);
  const calls = rows.reduce((total, row) => total + row.calls, 0);
  const externalCalls = external.reduce((total, row) => total + row.calls, 0);
  // Counted over every row, matching the table's own filter button. The
  // external-only split goes in the detail line rather than in the headline,
  // so two things labelled "Returned" cannot show different numbers.
  const returned = countReturned(rows);
  const returnedExternal = countReturned(external);

  return (
    <Section
      title="Active accounts"
      explain={
        <>
          Every workspace with at least one <strong>successful</strong> tool call in the last {days} days.
          This is the only section that names accounts. Comped and internal accounts are marked rather
          than removed, because they are real load but not customers. The table opens filtered to accounts
          that came back on more than one day; use the All filter to see everyone.
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
          label="Returned"
          value={returned}
          detail={`${returnedExternal} external, ${ratio(returnedExternal, external.length)} of them`}
          explain="Accounts active on more than one day in the window. A deliberately low bar: at this stage the question is whether anyone came back at all, not whether they use it daily. This is exactly the population the table shows by default."
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

      <ActiveAccountsTable rows={rows} />
    </Section>
  );
}

/** Middle value, or 0 for an empty set. Even counts take the lower of the pair. */
function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
