import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';
import { recordWorkspaceAuditEvent } from '@/lib/workspace/audit-events';
import { isApprovalWindowHours, storedApprovalWindowHours } from '@/lib/approvals/window';

/**
 * The active workspace's approval window (workspaces.approval_window_hours,
 * migration 20261114110000): how long a held send stays decidable.
 *
 *   GET  any member: { windowHours, canEdit }
 *   PUT  owner or admin, same origin, JSON: { windowHours: 24 | 72 | 168 | 336 }
 *        Applies to sends held after the change; pending ones keep their
 *        deadline. Written with the service role (workspaces has no user write
 *        privilege); every change lands in workspace_audit_events.
 */

async function caller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return null;
  const role = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  return role ? { user, workspaceId, role } : null;
}

async function readWindow(workspaceId: string) {
  return createServiceRoleClient()
    .from('workspaces')
    .select('approval_window_hours')
    .eq('id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
}

export async function GET(): Promise<NextResponse> {
  const c = await caller();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const { data, error } = await readWindow(c.workspaceId);
  if (error) {
    console.error('[approvals/settings] read failed:', error.message);
    return NextResponse.json({ error: 'Could not load the approval window.' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  return NextResponse.json({
    windowHours: storedApprovalWindowHours((data as { approval_window_hours?: unknown }).approval_window_hours),
    canEdit: canManageWorkspace(c.role),
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await caller();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canManageWorkspace(c.role)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can change the approval window.', error_code: 'insufficient_role' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  const windowHours = body && typeof body === 'object' ? (body as Record<string, unknown>).windowHours : undefined;
  if (!isApprovalWindowHours(windowHours)) {
    return NextResponse.json(
      { error: 'windowHours must be 24, 72, 168 or 336.', error_code: 'invalid_window' },
      { status: 400 },
    );
  }

  const service = createServiceRoleClient();
  const { data: before } = await readWindow(c.workspaceId);
  const previous = storedApprovalWindowHours((before as { approval_window_hours?: unknown } | null)?.approval_window_hours);

  const { data: saved, error } = await service
    .from('workspaces')
    .update({ approval_window_hours: windowHours })
    .eq('id', c.workspaceId)
    .is('deleted_at', null)
    .select('approval_window_hours')
    .maybeSingle();
  if (error || !saved) {
    console.error('[approvals/settings] update failed:', error?.message ?? 'no row');
    return NextResponse.json({ error: 'Could not save the approval window.' }, { status: 500 });
  }

  if (previous !== windowHours) {
    const logged = await recordWorkspaceAuditEvent(service, {
      workspaceId: c.workspaceId,
      actorUserId: c.user.id,
      kind: 'approval_window_changed',
      target: null,
      details: { from_hours: previous, to_hours: windowHours },
    });
    if (!logged) {
      console.error('[approvals/settings] AUDIT ROW LOST for a saved approval window change', {
        workspace_id: c.workspaceId,
        actor_user_id: c.user.id,
      });
    }
  }

  return NextResponse.json({
    windowHours: storedApprovalWindowHours((saved as { approval_window_hours?: unknown }).approval_window_hours),
  });
}
