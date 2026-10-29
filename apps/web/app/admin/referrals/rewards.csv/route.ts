import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { fetchAllRewards, rewardsCsv } from '../admin-referrals';

/**
 * GET /admin/referrals/rewards.csv: every referral_rewards row, for Fiken.
 * Admin session only (404 otherwise, like every /admin page). Never cached.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  await requireAdmin();
  const csv = rewardsCsv(await fetchAllRewards(createServiceRoleClient()));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="referral-rewards-${day}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
