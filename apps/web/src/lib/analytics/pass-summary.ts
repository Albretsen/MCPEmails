/**
 * The operator board's pass line: "Passes: N active, N sold this month,
 * N renewed" (plan section 6). Not on the kiosk headline.
 *
 * KEPT APART FROM MRR. A pass is a one-time payment and creates no Stripe
 * subscription, so revenue-math.ts never sees it and MRR is untouched; its
 * money is already in the cash tiles through charges. A pass running out is
 * not subscription churn and is not counted in any cancel ratio: this line
 * only counts passes. Subscribers and pass holders are reported side by side,
 * never summed.
 *
 *   active     passes covering now (starts_at <= now < ends_at), not refunded
 *   sold       passes bought this UTC month, refunded ones excluded
 *   renewed    `pass_renewed` rows since the pass launched (all time, because
 *              renewals arrive about three months after the sale, so a monthly
 *              count would read zero most months)
 *
 * Our own accounts are excluded, as everywhere on the board.
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { GROWTH_TAGS, cachedSection, type GrowthResult } from '@/lib/analytics/growth-queries';

export interface PassSummary {
  active: number;
  soldThisMonth: number;
  renewed: number;
}

export interface PassSummaryRow {
  user_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
}

/** Pure: the three counts from the rows. Exported for the test. */
export function summarisePasses(
  rows: readonly PassSummaryRow[],
  renewedRows: number,
  now: Date,
  internalUsers: ReadonlySet<string> = new Set(),
): PassSummary {
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const t = now.getTime();
  const real = rows.filter((row) => !internalUsers.has(row.user_id));
  return {
    active: real.filter(
      (row) =>
        row.status !== 'refunded' && Date.parse(row.starts_at) <= t && t < Date.parse(row.ends_at),
    ).length,
    soldThisMonth: real.filter((row) => row.status !== 'refunded' && Date.parse(row.created_at) >= monthStart)
      .length,
    renewed: renewedRows,
  };
}

/** One sentence, the board's wording. */
export function passSummaryLine(summary: PassSummary): string {
  return `Passes: ${summary.active} active, ${summary.soldThisMonth} sold this month, ${summary.renewed} renewed`;
}

type PassesClient = {
  from(table: 'user_passes'): {
    select(columns: string): PromiseLike<{ data: PassSummaryRow[] | null; error: { message: string } | null }>;
  };
};

export async function fetchPassSummary(): Promise<GrowthResult<PassSummary>> {
  return cachedSection<PassSummary>(['pass_summary'], GROWTH_TAGS.revenue, async () => {
    const db = createServiceRoleClient();
    // user_passes is not in the generated types until its migration is applied
    // and the types are regenerated; the table is small (one row per sale).
    const { data: rows, error } = await (db as unknown as PassesClient)
      .from('user_passes')
      .select('user_id, starts_at, ends_at, status, created_at');
    if (error) throw new Error(error.message);
    const passRows = rows ?? [];

    const userIds = [...new Set(passRows.map((row) => row.user_id))];
    const internal = new Set<string>();
    if (userIds.length > 0) {
      const { data: users } = await db.from('users').select('id, email').in('id', userIds);
      for (const user of users ?? []) if (isInternalAccount(user.email)) internal.add(user.id);
    }

    const { data: renewed, error: renewedError } = await db
      .from('product_funnel_events')
      .select('workspace_id')
      .eq('stage', 'pass_renewed');
    if (renewedError) throw new Error(renewedError.message);
    // Internal accounts' renewals: resolved through their workspaces.
    let renewedCount = (renewed ?? []).length;
    if (internal.size > 0 && renewedCount > 0) {
      const { data: internalWorkspaces } = await db
        .from('workspaces')
        .select('id')
        .in('owner_id', [...internal]);
      const skip = new Set((internalWorkspaces ?? []).map((w) => w.id));
      renewedCount = (renewed ?? []).filter((row) => !skip.has(row.workspace_id)).length;
    }

    return summarisePasses(passRows, renewedCount, new Date(), internal);
  });
}
