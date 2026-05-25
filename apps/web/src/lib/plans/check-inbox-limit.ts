import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { getPlanLimits } from '@/lib/stripe/plans';

/**
 * Result of an inbox cap check.
 */
export interface InboxLimitCheckResult {
  /** True when the workspace has reached the plan's inbox cap. */
  atLimit: boolean;
  /** The workspace's current plan slug (e.g. "free", "pro"). */
  plan: string;
  /** Number of active (non-deleted) inboxes currently connected. */
  currentCount: number;
  /**
   * The plan's inbox cap. `null` means unlimited (Enterprise).
   * Used in UI copy: "1 of 5 inboxes".
   */
  maxInboxes: number | null;
}

/**
 * Check whether a workspace has reached its plan inbox cap.
 *
 * Runs two parallel queries:
 *   1. Fetch the workspace's current plan.
 *   2. Count active (non-deleted) inboxes for the workspace.
 *
 * Returns `{ atLimit: false, ... }` when the workspace can still connect
 * more inboxes, or `{ atLimit: true, ... }` when the plan cap is reached.
 *
 * @param supabase  A request-scoped Supabase client (user or service role).
 * @param workspaceId  The workspace UUID to check.
 *
 * @example
 * const result = await checkInboxLimit(supabase, workspaceId);
 * if (result.atLimit) {
 *   return NextResponse.redirect(`...?error=inbox_limit_reached`);
 * }
 */
export async function checkInboxLimit(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
): Promise<InboxLimitCheckResult> {
  // Run both queries in parallel to minimise latency.
  const [workspaceResult, inboxCountResult] = await Promise.all([
    supabase
      .from('workspaces')
      .select('plan')
      .eq('id', workspaceId)
      .maybeSingle(),
    supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  const plan = (workspaceResult.data?.plan as string | undefined) ?? 'free';
  const limits = getPlanLimits(plan);
  const currentCount = inboxCountResult.count ?? 0;

  // Enterprise plan (Infinity) has no inbox cap.
  if (limits.maxInboxes === Infinity) {
    return {
      atLimit: false,
      plan,
      currentCount,
      maxInboxes: null,
    };
  }

  return {
    atLimit: currentCount >= limits.maxInboxes,
    plan,
    currentCount,
    maxInboxes: limits.maxInboxes,
  };
}
