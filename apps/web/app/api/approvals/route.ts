import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide, decideApproval, parseRenderedRevision } from '@/lib/approvals/decide';
import { PENDING_APPROVAL_COLUMNS, selectTolerantly } from '@/lib/approvals/columns';
import { readSummary } from '@/lib/approvals/payload';
import { approvalAccess, embeddedInbox, holdReasonOf, redactApprovalRow } from '@/lib/approvals/access';

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  const db = createServiceRoleClient();
  const { data: membership } = await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, db } : null;
}

export async function GET() {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const { data, error } = await c.db.from('send_approvals')
    .select('id, inbox_id, operation, summary, send_at, status, created_at, expires_at, revision, hold_reason, inboxes(email_address, display_name, owner_user_id, visibility)')
    .eq('workspace_id', c.workspaceId).eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: 'Failed to load approvals.' }, { status: 500 });

  // No payload here: the queue lists summaries only, and nothing is
  // decrypted for it. The decision dialog loads one approval's Bcc addresses
  // when it opens (GET /api/approvals/[id]).
  // The summary is stored encrypted since 2026-10-30 (older rows in clear);
  // the panel gets the plain object either way.
  //
  // Privacy model (src/lib/approvals/access.ts): a held send from someone
  // else's private inbox is left out for a member and reduced to metadata for
  // an owner or admin. `can_decide` is per row, because the owner of a private
  // inbox decides their own sends whatever their role.
  const approvals = shapeRows(data ?? [], c.role, c.user.id);

  // Recently decided sends, so the panel can show WHERE each decision was made
  // (`decided_via`: the review card in Claude vs. this dashboard). A failure
  // here is not fatal — the pending queue is the load-bearing part of the view.
  const { data: decided } = await selectTolerantly<unknown[]>(
    ['id', 'inbox_id', 'operation', 'summary', 'status', 'created_at', 'decided_at', 'decided_via', 'inboxes(email_address, display_name, owner_user_id, visibility)'],
    PENDING_APPROVAL_COLUMNS,
    (columns) => c.db.from('send_approvals')
      .select(columns)
      .eq('workspace_id', c.workspaceId).neq('status', 'pending')
      .order('decided_at', { ascending: false, nullsFirst: false }).limit(20),
  );

  const decidedRows = shapeRows((decided ?? []) as Record<string, unknown>[], c.role, c.user.id);
  return NextResponse.json({ approvals, decided: decidedRows });
}

/** Drops hidden rows, redacts content the caller may not see, strips the embed's owner columns. */
function shapeRows(rows: Record<string, unknown>[], role: string, userId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const access = approvalAccess(role, userId, embeddedInbox(row), holdReasonOf(row));
    if (access.hidden) continue;
    if (access.redacted) {
      out.push({
        ...redactApprovalRow(row, access.showRecipients
          ? { recipients: true, summary: readSummary(row.summary) as Record<string, unknown> }
          : {}),
        can_decide: access.canDecide,
      });
      continue;
    }
    const inbox = row.inboxes as { email_address?: string; display_name?: string | null } | null;
    out.push({
      ...row,
      inboxes: inbox ? { email_address: inbox.email_address, display_name: inbox.display_name ?? null } : null,
      summary: readSummary(row.summary),
      can_decide: access.canDecide,
    });
  }
  return out;
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
  const body = await request.json().catch(() => null);
  const id = body?.id; const decision = body?.decision;
  // The version of the request the dialog showed; see decideApproval.
  const revision = parseRenderedRevision(body?.revision);
  if (typeof id !== 'string' || !['approve', 'reject'].includes(decision)) return NextResponse.json({ error: 'An approval id and decision are required.' }, { status: 400 });

  // Who may decide depends on the send's inbox as well as the role: the owner
  // of a private inbox decides their own sends (src/lib/approvals/access.ts).
  // A send the caller may not see is the same 404 as a missing id.
  if (!canDecide(c.role)) {
    const { data: held } = await c.db.from('send_approvals')
      .select('id, inbox_id, hold_reason, inboxes(owner_user_id, visibility)')
      .eq('id', id).eq('workspace_id', c.workspaceId).maybeSingle();
    if (!held) return NextResponse.json({ error: 'Not found.', code: 'not_found' }, { status: 404 });
    const access = approvalAccess(c.role, c.user.id, embeddedInbox(held as Record<string, unknown>), holdReasonOf(held as Record<string, unknown>));
    if (access.hidden) return NextResponse.json({ error: 'Not found.', code: 'not_found' }, { status: 404 });
    if (!access.canDecide) return NextResponse.json({ error: 'Only workspace owners and admins can decide sends.' }, { status: 403 });
  }

  const outcome = await decideApproval({
    db: c.db,
    approvalId: id,
    workspaceId: c.workspaceId,
    userId: c.user.id,
    decision,
    via: 'dashboard',
    revision,
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  return NextResponse.json({ success: true });
}
