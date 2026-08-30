import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveWorkspacePlan } from '@/lib/plans/effective-plan';

/** The seat picture for a workspace whose plan was actually resolved. */
export interface ResolvedMemberLimit {
  resolved: true;
  /** True when the workspace has reached the plan's member cap. */
  atLimit: boolean;
  /** The workspace's current plan slug (e.g. "free", "solo", "pro"). */
  plan: string;
  /** Number of current workspace members (including the owner). */
  currentCount: number;
  /**
   * The plan's member cap. `null` means unlimited (Team).
   * Used in UI copy: "2 of 10 seats used".
   */
  maxMembers: number | null;
  /**
   * Whether this plan includes the Admin and Viewer roles. False means the
   * only assignable role is `member`. Carried here so the invite and
   * role-change routes can enforce it without a second plan lookup.
   */
  teamRolesEnabled: boolean;
}

/** The plan lookup failed. Nothing about the seat cap is known. */
export interface UnresolvedMemberLimit {
  resolved: false;
  /** PostgREST error message when there was one, else null (zero rows). */
  reason: string | null;
}

export type MemberLimitCheckResult = ResolvedMemberLimit | UnresolvedMemberLimit;

/**
 * Check whether a workspace has reached its plan member seat cap.
 *
 * Since the 2026-08-19 repricing, seats are a Team (`pro`) feature only: Free,
 * Personal and Pro (`solo`) are all single-user. Verified safe against
 * production at the time of the change: no workspace on any plan had more than
 * one member, so nobody was retroactively over their seat cap.
 *
 * PASS THE REQUEST-SCOPED USER CLIENT, NEVER THE SERVICE-ROLE ONE. The plan
 * comes from the `effective_workspace_plan(uuid)` RPC, which is RLS-gated on
 * `auth.uid()` through `my_workspace_ids()`. A service-role client has no
 * `auth.uid()`, so the RPC returns zero rows and the plan cannot be
 * determined. That is why this function returns a discriminated union: an
 * unresolvable plan is an ERROR for the caller to surface, not a `free` plan
 * to enforce. Treating it as `free` is what made every invite on every plan
 * fail with a bogus "upgrade your plan" 403 in production, silently, for as
 * long as the wrong client was passed.
 *
 * Runs two queries in parallel:
 *   1. Resolve the workspace's effective plan.
 *   2. Count workspace_members rows for the workspace.
 *
 * @param supabase     A request-scoped Supabase USER client.
 * @param workspaceId  The workspace UUID to check.
 */
export async function checkMemberLimit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  workspaceId: string,
): Promise<MemberLimitCheckResult> {
  const [planResolution, memberCountResult] = await Promise.all([
    resolveEffectiveWorkspacePlan(supabase, workspaceId),
    supabase
      .from('workspace_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
  ]);

  if (!planResolution.resolved) {
    return { resolved: false, reason: planResolution.reason };
  }

  const { plan, limits } = planResolution;
  const currentCount = memberCountResult.count ?? 0;

  if (limits.maxMembers === Infinity) {
    return {
      resolved: true,
      atLimit: false,
      plan,
      currentCount,
      maxMembers: null,
      teamRolesEnabled: limits.teamRolesEnabled,
    };
  }

  return {
    resolved: true,
    atLimit: currentCount >= limits.maxMembers,
    plan,
    currentCount,
    maxMembers: limits.maxMembers,
    teamRolesEnabled: limits.teamRolesEnabled,
  };
}
