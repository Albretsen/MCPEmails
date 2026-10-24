import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import {
  DISMISSED_METADATA_KEY,
  FIRST_WEEK_WINDOW_DAYS,
  INBOX_TROUBLE_CODES,
  RECENT_CALL_WINDOW,
  countSuccessDays,
  dismissedWorkspaceIds,
  withDismissed,
  type FirstWeekCounts,
} from '@/lib/onboarding/first-week-checklist';

/**
 * GET  /api/onboarding/first-week  the counts behind the dashboard's first week
 *                                  checklist, for the owner of the active
 *                                  workspace.
 * POST /api/onboarding/first-week  dismiss the checklist for that workspace.
 *
 * OWNER ONLY. The workspace row is read with the service role filtered on
 * `owner_id = user.id`, the same owner rule first-tool-reported uses. Nothing
 * below runs until that row comes back, and every later query is filtered on
 * that workspace id. A member or viewer gets `{ eligible: false }`.
 *
 * CHEAP BY CONSTRUCTION. The first payment is one indexed lookup. Outside the
 * 14 day window, or once dismissed, the route stops there, so most owners cost
 * two small queries. Inside it: at most 3 "first success at or after" lookups
 * (activity_log is partitioned on created_at and indexed on
 * (workspace_id, created_at)), one 10-row read and one head count.
 *
 * DISMISSAL lives in the owner's auth user_metadata, a list of workspace ids.
 * It is server-side and survives devices and browsers, and it needs no schema
 * change for a card that only exists for two weeks per workspace.
 */

const NOT_ELIGIBLE = { eligible: false } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Unauthorized.' }, 401);
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return json(NOT_ELIGIBLE);

  const db = createServiceRoleClient();
  const { data: workspace } = await db
    .from('workspaces')
    .select('id, plan')
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!workspace) return json(NOT_ELIGIBLE);

  const dismissed = dismissedWorkspaceIds(user.user_metadata).includes(workspaceId);
  const paid = Boolean(workspace.plan) && workspace.plan !== 'free';
  if (dismissed || !paid) return json(NOT_ELIGIBLE);

  const { data: firstCheckout } = await db
    .from('product_funnel_events')
    .select('occurred_at')
    .eq('workspace_id', workspaceId)
    .eq('stage', 'checkout_completed')
    .order('occurred_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const paidAt = firstCheckout?.occurred_at ?? null;
  if (!paidAt) return json(NOT_ELIGIBLE);
  const windowStart = Date.now() - FIRST_WEEK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (Date.parse(paidAt) < windowStart) return json(NOT_ELIGIBLE);

  const firstSuccessAtOrAfter = async (fromIso: string) => {
    const { data } = await db
      .from('activity_log')
      .select('created_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'success')
      .gte('created_at', fromIso)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data?.created_at ?? null;
  };

  const [successDays, recent, automations] = await Promise.all([
    countSuccessDays(paidAt, firstSuccessAtOrAfter),
    db
      .from('activity_log')
      .select('error_code, inbox_id, status')
      .eq('workspace_id', workspaceId)
      .gte('created_at', paidAt)
      .order('created_at', { ascending: false })
      .limit(RECENT_CALL_WINDOW),
    db
      .from('triage_rules')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  const recentRows = recent.data ?? [];
  const recentErrorCodes = recentRows.map((r) => (r.status === 'success' ? null : r.error_code ?? null));
  const troubleRow = recentRows.find(
    (r) => r.status !== 'success' && r.inbox_id && INBOX_TROUBLE_CODES.includes(r.error_code ?? ''),
  );

  const counts: FirstWeekCounts = {
    paidAt,
    paid,
    dismissed: false,
    successDays,
    recentErrorCodes,
    troubleInboxId: troubleRow?.inbox_id ?? null,
    automationCount: automations.count ?? 0,
  };
  return json({ eligible: true, counts });
}

export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Unauthorized.' }, 401);
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return json({ error: 'Workspace not found.' }, 404);

  const { error } = await supabase.auth.updateUser({
    data: { [DISMISSED_METADATA_KEY]: withDismissed(user.user_metadata, workspaceId) },
  });
  if (error) return json({ error: 'Could not save.' }, 500);
  return json({ ok: true });
}
