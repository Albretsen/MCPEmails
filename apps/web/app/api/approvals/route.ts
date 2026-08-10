import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide, decideApproval } from '@/lib/approvals/decide';
import { PENDING_APPROVAL_COLUMNS, selectTolerantly } from '@/lib/approvals/columns';

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  // The send_approvals migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const { data: membership } = await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, db } : null;
}

export async function GET() {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const { data, error } = await c.db.from('send_approvals')
    .select('id, inbox_id, operation, summary, send_at, status, created_at, inboxes(email_address, display_name)')
    .eq('workspace_id', c.workspaceId).eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: 'Failed to load approvals.' }, { status: 500 });

  // Recently decided sends, so the panel can show WHERE each decision was made
  // (`decided_via`: the review card in Claude vs. this dashboard). A failure
  // here is not fatal — the pending queue is the load-bearing part of the view.
  const { data: decided } = await selectTolerantly<unknown[]>(
    ['id', 'inbox_id', 'operation', 'summary', 'status', 'created_at', 'decided_at', 'decided_via', 'inboxes(email_address, display_name)'],
    PENDING_APPROVAL_COLUMNS,
    (columns) => c.db.from('send_approvals')
      .select(columns)
      .eq('workspace_id', c.workspaceId).neq('status', 'pending')
      .order('decided_at', { ascending: false, nullsFirst: false }).limit(20),
  );

  return NextResponse.json({ approvals: data ?? [], decided: decided ?? [] });
}

/**
 * Dashboard-panel decision endpoint.
 *
 * The approve path lives here and in `POST /api/approvals/[id]/decide` (the
 * authenticated review page). Both require a Supabase session and an
 * owner/admin role, and both delegate to `decideApproval` so the atomic claim
 * and the `scheduled_sends` dispatcher marker exist exactly once. Approving is
 * never reachable through the MCP channel — see `docs/mcp-apps/contract.md` §6.
 */
export async function PATCH(request: NextRequest) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canDecide(c.role)) return NextResponse.json({ error: 'Only workspace owners and admins can decide sends.' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const id = body?.id; const decision = body?.decision;
  if (typeof id !== 'string' || !['approve', 'reject'].includes(decision)) return NextResponse.json({ error: 'An approval id and decision are required.' }, { status: 400 });

  const outcome = await decideApproval({
    db: c.db,
    approvalId: id,
    workspaceId: c.workspaceId,
    userId: c.user.id,
    decision,
    via: 'dashboard',
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  return NextResponse.json({ success: true });
}
