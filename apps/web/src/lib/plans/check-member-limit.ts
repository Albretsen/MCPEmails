import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlanLimits } from '@/lib/stripe/plans';

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
  const [workspaceResult, memberCountResult] = await Promise.all([
    supabase
      .from('workspaces')
      .select('plan')
      .eq('id', workspaceId)
      .maybeSingle(),
    supabase
      .from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
  ]);

  const plan = (workspaceResult.data?.plan as string | undefined) ?? 'free';
  const limits = getPlanLimits(plan);
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
