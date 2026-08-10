import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { resolvePlanLimits } from '@/lib/stripe/plans';

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
  const [effectivePlanResult, inboxCountResult] = await Promise.all([
    supabase
      .rpc('effective_workspace_plan', { p_workspace_id: workspaceId }),
    supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  const effectivePlan = effectivePlanResult.data?.[0];
  const plan = effectivePlan?.plan ?? 'free';
  const limits = resolvePlanLimits(plan, { compedScale: effectivePlan?.comped_scale ?? false });
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

/**
 * Whether the workspace already has a (non-deleted) inbox for this email.
 *
 * Used to distinguish a reconnect (same address, where the upsert reuses the
 * existing row and does not increase the inbox count) from a brand-new
 * connection. Reconnects must never be blocked by the plan inbox cap.
 */
export async function inboxExistsForEmail(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('inboxes')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email_address', email)
    .is('deleted_at', null)
    .maybeSingle();

  return !!data;
}
