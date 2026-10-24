import { NextRequest, NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkInboxLimit } from '@/lib/plans/check-inbox-limit';
import { parkAboveCap } from '@/lib/billing/parking';
import { readPlanChangeRow, sanitizeKeepOrder, writePlanChangeColumns } from '@/lib/billing/plan-change-sync';
import {
  SWAP_WINDOW_MS,
  claimSwapClock,
  keepOrderAfterSwap,
  nextSwapAllowedAt,
  planSwap,
  readSwapClock,
} from '@/lib/billing/inbox-swap';
import { canManageWorkspace, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';

/**
 * POST /api/inboxes/swap-parked { parkedInboxId, activeInboxId? }
 *
 * "Make active" on a parked inbox (src/lib/billing/parking.ts): the parked
 * inbox becomes active and the active inbox the customer picked is parked in
 * its place. `activeInboxId` may be left out only when the workspace has a
 * free slot under its plan's cap. The active count after the swap never
 * exceeds the cap (Free 1, Personal 3, Pro 10; none when unlimited).
 *
 * At most one swap per workspace per rolling 24 hours, so a workspace cannot
 * rotate many inboxes through one Free slot. The clock is
 * `workspaces.inbox_swapped_at`, claimed before the swap and put back if the
 * swap fails, so a failure does not cost the customer their day.
 *
 * Owner or admin only (it changes which mailboxes the workspace can reach).
 * The parked inbox is read through the RLS-scoped client, so a returned row
 * proves membership; every write goes through the service role scoped to that
 * workspace. The customer's choice is stored as the owner's keep order, so a
 * later plan change parks the same way.
 *
 *   200 { active, parked, next_swap_at }
 *   400 invalid_request          401 Unauthorized.       403 insufficient_role
 *   404 Inbox not found.         409 not_parked | active_not_found | pick_active | over_cap
 *   429 swap_limit { next_swap_at }                      500 swap_failed
 *   503 unavailable (migration 20261025020000 not applied)
 */

const ID = /^[0-9a-f-]{36}$/i;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let parkedInboxId: string;
  let activeInboxId: string | null;
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('shape');
    const record = body as Record<string, unknown>;
    if (typeof record.parkedInboxId !== 'string' || !ID.test(record.parkedInboxId)) throw new Error('parked');
    parkedInboxId = record.parkedInboxId;
    const active = record.activeInboxId;
    if (active === undefined || active === null) activeInboxId = null;
    else if (typeof active === 'string' && ID.test(active) && active !== parkedInboxId) activeInboxId = active;
    else throw new Error('active');
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized.' }, 401);

  const { data: visible, error: visibleError } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', parkedInboxId)
    .is('deleted_at', null)
    .maybeSingle();
  if (visibleError || !visible) return json({ error: 'Inbox not found.' }, 404);
  const workspaceId = visible.workspace_id;

  const role = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!canManageWorkspace(role)) {
    return json(insufficientRoleBody('Only workspace owners and admins can swap parked inboxes.'), 403);
  }

  const db = createServiceRoleClient();
  const clock = await readSwapClock(db, workspaceId);
  if (!clock.ok) {
    if (clock.reason === 'unavailable') return json({ error: 'unavailable' }, 503);
    if (clock.reason === 'not_found') return json({ error: 'Inbox not found.' }, 404);
    return json({ error: 'swap_failed' }, 500);
  }
  const now = new Date();
  const waitUntil = nextSwapAllowedAt(clock.lastSwapAt, now);
  if (waitUntil) return json({ error: 'swap_limit', next_swap_at: waitUntil.toISOString() }, 429);

  const { data: rows, error: rowsError } = await db
    .from('inboxes')
    .select('id, parked_at')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);
  if (rowsError) return json({ error: 'swap_failed' }, 500);
  const limit = await checkInboxLimit(supabase, workspaceId);
  const plan = planSwap(rows ?? [], parkedInboxId, activeInboxId, limit.maxInboxes);
  if (!plan.ok) return json({ error: plan.error }, 409);

  const stamp = now.toISOString();
  if (!(await claimSwapClock(db, workspaceId, clock.lastSwapAt, stamp))) {
    // Another click won the claim between the read and here.
    const again = await readSwapClock(db, workspaceId);
    const next = again.ok ? nextSwapAllowedAt(again.lastSwapAt, now) : null;
    return json({ error: 'swap_limit', next_swap_at: (next ?? new Date(now.getTime() + SWAP_WINDOW_MS)).toISOString() }, 429);
  }

  const result = await parkAboveCap(db, workspaceId, plan.cap, plan.preferredOrder, { now, label: 'swap' });
  if (result.failed || !result.active.includes(parkedInboxId)) {
    // Give the day back. parkAboveCap parks before it unparks, so a failure
    // leaves fewer active inboxes than the plan allows, never more, and a
    // retry repairs it.
    await claimSwapClock(db, workspaceId, stamp, clock.lastSwapAt);
    return json({ error: 'swap_failed' }, 500);
  }

  // Remember the choice for the next plan change. Best effort.
  const billing = await readPlanChangeRow(db, clock.ownerId);
  if (billing) {
    await writePlanChangeColumns(db, clock.ownerId, {
      inbox_keep_order: keepOrderAfterSwap(result.active, sanitizeKeepOrder(billing.inbox_keep_order), activeInboxId),
    });
  }

  return json({
    active: result.active,
    parked: result.parked,
    next_swap_at: new Date(now.getTime() + SWAP_WINDOW_MS).toISOString(),
  });
}
