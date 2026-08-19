import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePlanLimits } from '@/lib/stripe/plans';

export interface MemberLimitCheckResult {
  /** True when the workspace has reached the plan's member cap. */
  atLimit: boolean;
  /** The workspace's current plan slug (e.g. "free", "solo", "pro"). */
  plan: string;
  /** Number of current workspace members (including the owner). */
  currentCount: number;
  /**
   * The plan's member cap. `null` means unlimited (Enterprise).
   * Used in UI copy: "2 of 10 seats used".
   */
  maxMembers: number | null;
}

/**
 * Check whether a workspace has reached its plan member seat cap.
 *
 * Since the 2026-08-19 repricing, seats are a Team (`pro`) feature only: Free
 * and Pro (`solo`) are both single-user. Verified safe against production at
 * the time of the change: no workspace on any plan had more than one member, so
 * nobody was retroactively over their seat cap.
 *
 * Runs two parallel queries:
 *   1. Fetch the workspace's current plan.
 *   2. Count workspace_members rows for the workspace.
 *
 * @param supabase     A request-scoped Supabase client (user or service role).
 * @param workspaceId  The workspace UUID to check.
 */
export async function checkMemberLimit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  workspaceId: string,
): Promise<MemberLimitCheckResult> {
  const [effectivePlanResult, memberCountResult] = await Promise.all([
    supabase
      .rpc('effective_workspace_plan', { p_workspace_id: workspaceId }),
    supabase
      .from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
  ]);

  const effectivePlan = effectivePlanResult.data?.[0];
  const plan = effectivePlan?.plan ?? 'free';
  // The inbox grandfather is threaded through for consistency with the other
  // two checkers even though it cannot change a seat count: resolvePlanLimits
  // only widens maxInboxes from it. Passing it here means one call shape.
  const limits = resolvePlanLimits(plan, {
    compedScale: effectivePlan?.comped_scale ?? false,
    unlimitedInboxes: effectivePlan?.unlimited_inboxes ?? false,
  });
  const currentCount = memberCountResult.count ?? 0;

  if (limits.maxMembers === Infinity) {
    return { atLimit: false, plan, currentCount, maxMembers: null };
  }

  return {
    atLimit: currentCount >= limits.maxMembers,
    plan,
    currentCount,
    maxMembers: limits.maxMembers,
  };
}
