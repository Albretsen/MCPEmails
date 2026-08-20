import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolvePlanLimits } from '@/lib/stripe/plans';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * GET /api/usage
 *
 * Returns the authenticated workspace's billable action usage for the current
 * billing-cycle window. The action ledger is also the source used by edge
 * enforcement, so the customer-visible value cannot drift from the cap check.
 *
 * Response 200:
 * {
 *   plan: string,
 *   monthly: {
 *     used:       number,          // calls made this billing cycle
 *     cap:        number | null,   // null = a comped entitlement
 *     resets_at:  string,          // ISO timestamp of next UTC month start
 *   },
 *   daily_burst: { ... },
 * }
 *
 * The daily burst row remains a request-rate diagnostic; the monthly row is
 * the abuse ceiling, NOT a pricing lever. Since the 2026-08-19 repricing the
 * value metric is connected inboxes; the action ceiling exists so a runaway
 * agent cannot burn unbounded provider quota, and it must never be presented as
 * something a customer can buy more of.
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
  // Cookie-aware resolution so users in 2+ workspaces target their active one
  // (a bare `.single()` on workspace_members throws for multi-workspace users).
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);

  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // ── Plan ──────────────────────────────────────────────────────────────────
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('plan, owner_id')
    .eq('id', workspaceId)
    .maybeSingle();

  if (workspaceError || !workspace) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const service = createServiceRoleClient();
  const [{ data: entitlement }, { data: billing }] = await Promise.all([
    service.from('user_usage_entitlements').select('kind, expires_at, unlimited_inboxes').eq('user_id', workspace.owner_id).maybeSingle(),
    service.from('user_billing').select('current_period_start, current_period_end').eq('user_id', workspace.owner_id).maybeSingle(),
  ]);
  const compedScale = entitlement?.kind === 'comped_scale' &&
    (!entitlement.expires_at || new Date(entitlement.expires_at) > new Date());
  const plan = compedScale ? 'pro' : ((workspace.plan as string) ?? 'free');
  const limits = resolvePlanLimits(plan, {
    compedScale,
    unlimitedInboxes: entitlement?.unlimited_inboxes ?? false,
  });

  // ── Window boundaries ─────────────────────────────────────────────────────
  // Paid workspaces follow Stripe's exact billing cycle. Free workspaces use
  // the documented calendar-month cycle. This matches edge enforcement.
  const now = new Date();

  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();

  const calendarMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();

  // Reset timestamps
  const nextMidnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();

  const nextCalendarMonthUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();

  const billingStart = plan !== 'free' && billing?.current_period_start && billing?.current_period_end &&
    new Date(billing.current_period_start) <= now && now < new Date(billing.current_period_end)
    ? billing.current_period_start
    : calendarMonthStart;
  const billingEnd = plan !== 'free' && billing?.current_period_start && billing?.current_period_end &&
    new Date(billing.current_period_start) <= now && now < new Date(billing.current_period_end)
    ? billing.current_period_end
    : nextCalendarMonthUTC;

  // ── Count queries (parallel) ──────────────────────────────────────────────
  const [dailyResult, monthlyResult] = await Promise.all([
    supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart),
    supabase
      .from('action_usage')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('billable', true)
      .eq('meter_version', 1)
      .gte('occurred_at', billingStart)
      .lt('occurred_at', billingEnd),
  ]);

  const usedToday = dailyResult.count ?? 0;
  const usedThisMonth = monthlyResult.count ?? 0;

  return NextResponse.json({
    plan,
    monthly: {
      used: usedThisMonth,
      cap: limits.maxMonthlyToolCalls === Infinity ? null : limits.maxMonthlyToolCalls,
      resets_at: billingEnd,
    },
    daily_burst: {
      used: usedToday,
      cap: limits.maxDailyBurstCalls === Infinity ? null : limits.maxDailyBurstCalls,
      resets_at: nextMidnightUTC,
    },
  });
}
