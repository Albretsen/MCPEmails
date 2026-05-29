import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolvePlanLimits } from '@/lib/stripe/plans';

/**
 * GET /api/usage
 *
 * Returns the authenticated workspace's MCP call usage for the current
 * UTC calendar month and the current UTC calendar day (burst window).
 *
 * Response 200:
 * {
 *   plan: string,
 *   monthly: {
 *     used:       number,          // calls made this UTC calendar month
 *     cap:        number | null,   // null = unlimited (Enterprise)
 *     resets_at:  string,          // ISO timestamp of next UTC month start
 *   },
 *   daily_burst: {
 *     used:       number,          // calls made today (UTC calendar day)
 *     cap:        number | null,   // null = unlimited (Enterprise)
 *     resets_at:  string,          // ISO timestamp of next UTC midnight
 *   },
 * }
 *
 * Counts are fetched in parallel from activity_log using the same window
 * boundaries as the edge function quota check (checkPlanQuota).
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  // ── Auth ──────────────────────────────────────────────────────────────────
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const workspaceId = member.workspace_id;

  // ── Plan ──────────────────────────────────────────────────────────────────
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('plan, grandfathered')
    .eq('id', workspaceId)
    .maybeSingle();

  if (workspaceError || !workspace) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const plan = (workspace.plan as string) ?? 'free';
  const grandfathered = workspace.grandfathered ?? false;
  const limits = resolvePlanLimits(plan, { grandfathered });

  // ── Window boundaries (UTC) ───────────────────────────────────────────────
  const now = new Date();

  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();

  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  // Reset timestamps
  const nextMidnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();

  const nextMonthUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();

  // ── Count queries (parallel) ──────────────────────────────────────────────
  const [dailyResult, monthlyResult] = await Promise.all([
    supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart),
    supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', monthStart),
  ]);

  const usedToday = dailyResult.count ?? 0;
  const usedThisMonth = monthlyResult.count ?? 0;

  return NextResponse.json({
    plan,
    monthly: {
      used: usedThisMonth,
      cap: limits.maxMonthlyToolCalls === Infinity ? null : limits.maxMonthlyToolCalls,
      resets_at: nextMonthUTC,
    },
    daily_burst: {
      used: usedToday,
      cap: limits.maxDailyBurstCalls === Infinity ? null : limits.maxDailyBurstCalls,
      resets_at: nextMidnightUTC,
    },
  });
}
