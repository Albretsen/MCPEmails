import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { resolvePlanLimits } from '@/lib/stripe/plans';

/**
 * Result of an API key cap check.
 */
export interface ApiKeyLimitCheckResult {
  /** True when the workspace has reached the plan's API key cap. */
  atLimit: boolean;
  /** The workspace's current plan slug (e.g. "free", "solo", "pro"). */
  plan: string;
  /** Number of active (non-revoked) API keys currently in the workspace. */
  currentCount: number;
  /**
   * The plan's API key cap. `null` means unlimited (Enterprise).
   * Used in UI copy: "2 of 3 API keys used".
   */
  maxApiKeys: number | null;
}

/**
 * Check whether a workspace has reached its plan API key cap.
 *
 * Runs two parallel queries:
 *   1. Fetch the workspace's current plan.
 *   2. Count active (non-revoked, non-deleted) API keys for the workspace.
 *
 * Returns `{ atLimit: false, ... }` when the workspace can still create
 * more keys, or `{ atLimit: true, ... }` when the plan cap is reached.
 *
 * @param supabase     A request-scoped Supabase client (user or service role).
 * @param workspaceId  The workspace UUID to check.
 *
 * @example
 * const result = await checkApiKeyLimit(supabase, workspaceId);
 * if (result.atLimit) {
 *   return NextResponse.json(
 *     { error: 'API key limit reached.', error_code: 'api_key_limit_reached', upgrade_url: '/pricing' },
 *     { status: 403 },
 *   );
 * }
 */
export async function checkApiKeyLimit(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
): Promise<ApiKeyLimitCheckResult> {
  // Run both queries in parallel to minimise latency.
  const [workspaceResult, keyCountResult] = await Promise.all([
    supabase
      .from('workspaces')
      .select('plan, grandfathered')
      .eq('id', workspaceId)
      .maybeSingle(),
    supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  const plan = (workspaceResult.data?.plan as string | undefined) ?? 'free';
  const grandfathered = workspaceResult.data?.grandfathered ?? false;
  const limits = resolvePlanLimits(plan, { grandfathered });
  const currentCount = keyCountResult.count ?? 0;

  // Enterprise plan (Infinity) has no key cap.
  if (limits.maxApiKeys === Infinity) {
    return {
      atLimit: false,
      plan,
      currentCount,
      maxApiKeys: null,
    };
  }

  return {
    atLimit: currentCount >= limits.maxApiKeys,
    plan,
    currentCount,
    maxApiKeys: limits.maxApiKeys,
  };
}
