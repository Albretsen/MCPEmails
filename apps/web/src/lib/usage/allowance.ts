import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * The workspace action allowance, as the web side reads it.
 *
 * ONE DEFINITION. The SQL function `workspace_action_allowance(uuid)`
 * (supabase/migrations/20260912200000_free_action_cap_150.sql) is the only
 * place that knows the Free cap, the 7-day grace, the per-workspace exemption
 * and the billing window. The MCP edge function enforces off that row, and
 * /api/usage and the dashboard display off the same row through this module,
 * so the number a customer reads is the number that blocks them. Nothing here
 * re-derives a window or a cap; `shapeActionAllowance` only decides what may be
 * SHOWN.
 *
 * Service-role only: the function is SECURITY DEFINER with EXECUTE revoked
 * from anon and authenticated, so a browser session cannot read another
 * workspace's usage by id. Callers must have already established that the
 * viewer is a member of the workspace.
 */

/** One row of `workspace_action_allowance`, column for column. */
export type AllowanceRow = {
  plan: string;
  owner_id: string;
  exempt: boolean;
  exempt_reason: string | null;
  /** NULL when exempt, else the plan's allowance (the paid ones are silent). */
  cap: number | null;
  period_start: string;
  period_end: string;
  grace_ends_at: string | null;
  in_grace: boolean;
  used: number;
  remaining: number | null;
};

export type ExemptReason = 'early_member' | 'comped' | 'exemption';

/**
 * The shape /api/usage returns and the dashboard receives as `actionAllowance`.
 *
 * `monthly.cap` and `monthly.remaining` are non-null ONLY for a Free workspace
 * that is actually metered. A paid plan's ceiling is an abuse guard, not a
 * feature (see maxMonthlyToolCalls in src/lib/stripe/plans.ts), and an exempt
 * workspace has nothing to run out of; both arrive here as null so no surface
 * can draw a bar against a number the customer was never sold.
 */
export type ActionAllowance = {
  plan: string;
  exempt: boolean;
  exempt_reason: ExemptReason | null;
  in_grace: boolean;
  grace_ends_at: string | null;
  monthly: {
    used: number;
    cap: number | null;
    remaining: number | null;
    period_start: string;
    resets_at: string;
  };
};

const EXEMPT_REASONS: ReadonlySet<string> = new Set(['early_member', 'comped', 'exemption']);

/** True when this row's cap is one the customer was sold and may be shown. */
export function isPublicCap(row: Pick<AllowanceRow, 'plan' | 'exempt' | 'cap'>): boolean {
  return !row.exempt && row.plan === 'free' && row.cap != null;
}

/**
 * The customer-visible projection of an allowance row. Pure, so the API route
 * and the dashboard page cannot disagree about what is hidden.
 */
export function shapeActionAllowance(row: AllowanceRow): ActionAllowance {
  const showCap = isPublicCap(row);
  const used = Math.max(0, Number(row.used) || 0);
  const cap = showCap ? Number(row.cap) : null;
  return {
    plan: row.plan,
    exempt: Boolean(row.exempt),
    exempt_reason:
      row.exempt && row.exempt_reason && EXEMPT_REASONS.has(row.exempt_reason)
        ? (row.exempt_reason as ExemptReason)
        : null,
    in_grace: Boolean(row.in_grace),
    grace_ends_at: row.grace_ends_at ?? null,
    monthly: {
      used,
      cap,
      // Recomputed from the shown cap rather than copied, so a paid row's
      // remaining can never leak the silent ceiling by subtraction.
      remaining: cap == null ? null : Math.max(0, cap - used),
      period_start: row.period_start,
      resets_at: row.period_end,
    },
  };
}

/**
 * Reads and shapes the allowance for one workspace with a service-role client.
 * Returns null on any error or for an unknown workspace id (the function
 * returns no row), and logs, so a dashboard render never fails on this.
 */
export async function fetchWorkspaceActionAllowance(
  service: SupabaseClient<Database>,
  workspaceId: string,
): Promise<ActionAllowance | null> {
  // workspace_action_allowance is not in the generated Database types yet
  // (they are regenerated after the migration is applied), so it is called
  // through a narrowly typed view of rpc(). .rpc() dereferences `this`
  // internally, so the cast is bound back to the client or it throws a
  // TypeError at call time (app/api/workspaces/route.ts has the same note).
  const rpc = (service.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: AllowanceRow[] | null; error: { message: string } | null }>).bind(service);

  const { data, error } = await rpc('workspace_action_allowance', { p_workspace_id: workspaceId });
  if (error) {
    console.error('[workspace_action_allowance]', error.message);
    return null;
  }
  const row = data?.[0];
  return row ? shapeActionAllowance(row) : null;
}
