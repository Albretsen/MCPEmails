import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePlanLimits, type PlanLimits } from '@/lib/stripe/plans';

/**
 * Resolve a workspace's effective plan, and say plainly when it could not be
 * resolved at all.
 *
 * WHY THE "COULD NOT RESOLVE" CASE IS A SEPARATE OUTCOME. The
 * `effective_workspace_plan(uuid)` RPC ends with
 *
 *     WHERE w.id = p_workspace_id AND w.id = ANY(public.my_workspace_ids())
 *
 * and `my_workspace_ids()` is built from `auth.uid()`. It is therefore RLS-
 * gated on the CALLING IDENTITY, and it returns ZERO ROWS whenever there is no
 * authenticated user, which is exactly what happens when it is handed a
 * service-role client. Every caller that coalesced the missing row to `'free'`
 * turned that into "this workspace is on the most restrictive plan", and the
 * consequence in production was that POST /api/workspaces/invite (the only
 * caller that had been given the service-role client) rejected EVERY invite on
 * EVERY plan with a 403 telling a paying Team customer to upgrade their free
 * plan. The Team feature was unusable for as long as that line existed.
 *
 * Collapsing "resolved as free" and "could not resolve" into one value is what
 * made that bug silent, so this function refuses to collapse them. The result
 * is a discriminated union: TypeScript will not let a caller read `plan` or
 * `limits` without first establishing that the lookup actually succeeded, so a
 * future service-role caller gets a compile error rather than a wrong answer.
 *
 * ALWAYS pass the request-scoped USER client.
 */
export type EffectivePlanResolution =
  | {
      resolved: true;
      /** Internal plan slug ("free" | "personal" | "solo" | "pro"). Never render it. */
      plan: string;
      limits: PlanLimits;
      compedScale: boolean;
      unlimitedInboxes: boolean;
    }
  | {
      resolved: false;
      /** The PostgREST error message when there was one, else null (no rows). */
      reason: string | null;
    };

export async function resolveEffectiveWorkspacePlan(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  workspaceId: string,
): Promise<EffectivePlanResolution> {
  const { data, error } = await supabase.rpc('effective_workspace_plan', {
    p_workspace_id: workspaceId,
  });

  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) {
    return { resolved: false, reason: error?.message ?? null };
  }

  const compedScale = row.comped_scale ?? false;
  const unlimitedInboxes = row.unlimited_inboxes ?? false;

  return {
    resolved: true,
    plan: row.plan,
    limits: resolvePlanLimits(row.plan, { compedScale, unlimitedInboxes }),
    compedScale,
    unlimitedInboxes,
  };
}
