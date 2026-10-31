import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide, decideApproval, parseRenderedRevision } from '@/lib/approvals/decide';
import { PENDING_APPROVAL_COLUMNS, selectTolerantly } from '@/lib/approvals/columns';
import { APPROVAL_RULE_LINK_COLUMNS, approvalDecider, withApprovalOrigin } from '@/lib/approvals/origin';
import { readSummary } from '@/lib/approvals/payload';
import { deliveryFromScheduledSend, loadScheduledSendsByApproval } from '@/lib/approvals/delivery';
import { forwardAgainWindowOpen } from '@/lib/approvals/forward-again';

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

/** When a row in the decided list was closed: its decision, or else its deadline. */
function closedAt(row: Record<string, unknown>): string {
  return String(row.decided_at ?? row.expires_at ?? row.created_at ?? '');
}

export async function GET() {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  // Read at one moment, so a row is on one side of its deadline or the other.
  const nowIso = new Date().toISOString();
  const { data, error } = await selectTolerantly<unknown[]>(
    ['id', 'inbox_id', 'operation', 'summary', 'send_at', 'status', 'created_at', 'expires_at', 'revision', 'no_approval_wait_reason', ...APPROVAL_RULE_LINK_COLUMNS, 'inboxes(email_address, display_name)'],
    ['no_approval_wait_reason', ...APPROVAL_RULE_LINK_COLUMNS],
    (columns) => c.db.from('send_approvals')
      .select(columns)
      .eq('workspace_id', c.workspaceId).eq('status', 'pending')
      // Past its deadline a row can not be approved, so it is not waiting any more.
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('created_at', { ascending: false }).limit(100),
  );
  if (error) return NextResponse.json({ error: 'Failed to load approvals.' }, { status: 500 });

  // No payload here: the queue lists summaries only, and nothing is
  // decrypted for it. The decision dialog loads one approval's Bcc addresses
  // when it opens (GET /api/approvals/[id]).
  // The summary is stored encrypted since 2026-10-30 (older rows in clear);
  // the panel gets the plain object either way.
  const pendingRows = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...withApprovalOrigin(row),
    summary: readSummary(row.summary),
  }));

  // Recently decided sends, so the panel can show WHERE each decision was made
  // (`decided_via`: the review card in Claude vs. this dashboard). A failure
  // here is not fatal — the pending queue is the load-bearing part of the view.
  const decidedColumns = ['id', 'inbox_id', 'operation', 'summary', 'status', 'created_at', 'expires_at', 'decided_at', 'decided_by', 'decided_via', 'no_approval_rule_name', ...APPROVAL_RULE_LINK_COLUMNS, 'inboxes(email_address, display_name)'];
  const { data: decided } = await selectTolerantly<unknown[]>(
    decidedColumns,
    [...PENDING_APPROVAL_COLUMNS, 'no_approval_rule_name', ...APPROVAL_RULE_LINK_COLUMNS],
    (columns) => c.db.from('send_approvals')
      .select(columns)
      .eq('workspace_id', c.workspaceId).neq('status', 'pending')
      .order('decided_at', { ascending: false, nullsFirst: false }).limit(20),
  );
  // Past their deadline but not retired yet (retention does that a day later).
  // Nobody decided these, and the list says so.
  const { data: lapsed } = await selectTolerantly<unknown[]>(
    decidedColumns,
    [...PENDING_APPROVAL_COLUMNS, 'no_approval_rule_name', ...APPROVAL_RULE_LINK_COLUMNS],
    (columns) => c.db.from('send_approvals')
      .select(columns)
      .eq('workspace_id', c.workspaceId).eq('status', 'pending')
      .lte('expires_at', nowIso)
      .order('expires_at', { ascending: false }).limit(20),
  );

  const closed: Record<string, unknown>[] = [
    ...((lapsed ?? []) as Record<string, unknown>[]).map((row) => ({ ...row, status: 'expired' })),
    ...((decided ?? []) as Record<string, unknown>[]),
  ]
    // Both lists are kept whole. Cutting the merge to 20 would let a busy day push
    // out a row that expired just now, and with it the Forward again button.
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)));

  const closedIds = closed.map((row) => String(row.id));
  const ruleIds = [
    ...new Set(
      [...closed, ...((data ?? []) as Record<string, unknown>[])]
        .map((row) => row.triage_rule_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const [markers, rules, successors] = await Promise.all([
    loadScheduledSendsByApproval(c.db, c.workspaceId, closedIds),
    ruleIds.length
      ? c.db.from('triage_rules').select('id, deleted_at').in('id', ruleIds)
      : Promise.resolve({ data: [] as { id: string; deleted_at: string | null }[] }),
    closedIds.length
      ? selectTolerantly<unknown[]>(['reforward_of'], ['reforward_of'], (columns) =>
          c.db.from('send_approvals').select(columns).in('reforward_of', closedIds))
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const deletedRules = new Set((rules.data ?? []).filter((rule) => rule.deleted_at).map((rule) => rule.id));
  const liveRules = new Set((rules.data ?? []).filter((rule) => !rule.deleted_at).map((rule) => rule.id));
  const reforwarded = new Set(
    ((successors.data ?? []) as { reforward_of?: unknown }[]).map((row) => row.reforward_of),
  );
  const ruleDeleted = (kind: string, ruleId: string | null) =>
    kind === 'rule_forward' && (!ruleId || deletedRules.has(ruleId));

  const approvals = pendingRows.map((row) => ({
    ...row,
    rule_deleted: ruleDeleted(row.kind, row.rule_id),
  }));

  const decidedRows = closed.map((row) => {
    const origin = withApprovalOrigin(row);
    const { decided_by: _decidedBy, ...rest } = origin as typeof origin & { decided_by?: unknown };
    const expired = row.status === 'expired';
    const isDeleted = ruleDeleted(origin.kind, origin.rule_id);
    return {
      ...rest,
      summary: readSummary(row.summary),
      decider: approvalDecider(row),
      // An expired row was decided by nobody, whatever older rows have recorded.
      decided_via: expired ? null : row.decided_via ?? null,
      decided_at: row.decided_at ?? null,
      delivery: row.status === 'approved'
        ? deliveryFromScheduledSend(markers.get(String(row.id)))
        : null,
      rule_deleted: isDeleted,
      can_forward_again: expired
        && origin.kind === 'rule_forward'
        && row.operation === 'email_forward'
        && !isDeleted
        && typeof origin.rule_id === 'string'
        && liveRules.has(origin.rule_id)
        && !reforwarded.has(row.id)
        && forwardAgainWindowOpen(row),
    };
  });
  return NextResponse.json({ approvals, decided: decidedRows });
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
  // The version of the request the dialog showed; see decideApproval.
  const revision = parseRenderedRevision(body?.revision);
  if (typeof id !== 'string' || !['approve', 'reject'].includes(decision)) return NextResponse.json({ error: 'An approval id and decision are required.' }, { status: 400 });

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
