import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { fetchWorkspaceActionAllowance } from '@/lib/usage/allowance';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * GET /api/usage
 *
 * The authenticated workspace's action allowance for the current period, read
 * from `workspace_action_allowance()`, the same row the MCP edge function
 * enforces from. There is no second definition of the window, the cap or the
 * exemption on this side: the number this returns is the number that blocks.
 *
 * Response 200 (src/lib/usage/allowance.ts `ActionAllowance`):
 * {
 *   plan:          string,                 // effective plan id
 *   exempt:        boolean,                // never metered against Free
 *   exempt_reason: 'early_member' | 'comped' | 'exemption' | null,
 *   in_grace:      boolean,                // Free, inside its first 7 days
 *   grace_ends_at: string | null,          // ISO, Free only
 *   monthly: {
 *     used:         number,                // billable actions in the window
 *     cap:          number | null,         // 150 for a metered Free workspace,
 *                                          // null for exempt AND for every
 *                                          // paid plan (its ceiling is a silent
 *                                          // abuse guard, never a feature)
 *     remaining:    number | null,         // same rule as cap
 *     period_start: string,                // ISO, start of the counting window
 *     resets_at:    string,                // ISO, when the window ends
 *   },
 * }
 *
 * `daily_burst` is gone: it was never enforced and never shown.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // Cookie-aware resolution so users in 2+ workspaces target their active one
  // (a bare `.single()` on workspace_members throws for multi-workspace users).
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // Membership, under RLS, with the viewer's own client. The allowance function
  // is service-role only and would happily answer for any id, so the viewer's
  // right to see this workspace is established here first.
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id')
    .eq('id', workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const allowance = await fetchWorkspaceActionAllowance(createServiceRoleClient(), workspaceId);
  if (!allowance) {
    return NextResponse.json({ error: 'Usage is temporarily unavailable.' }, { status: 503 });
  }

  return NextResponse.json(allowance);
}
