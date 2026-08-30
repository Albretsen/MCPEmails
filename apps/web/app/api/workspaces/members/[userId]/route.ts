import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkMemberLimit } from '@/lib/plans/check-member-limit';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';
import {
  demotionRevocationNotice,
  removeWorkspaceMember,
  revokeApiKeysBeyondViewerScopes,
} from '@/lib/workspace/membership';

const VALID_ASSIGNABLE_ROLES = new Set(['admin', 'member', 'viewer']);

/**
 * DELETE /api/workspaces/members/[userId]
 *
 * Removes a member from a workspace. Caller must be owner or admin.
 * Soft-revokes all of the removed member's API keys in the workspace.
 *
 * Query params: workspaceId
 *
 * Guards:
 *  - Cannot remove the workspace owner.
 *  - Admins cannot remove other admins (only the owner can).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { userId: targetUserId } = await params;
  const workspaceId = request.nextUrl.searchParams.get('workspaceId');

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId query parameter is required.' }, { status: 400 });
  }

  // 2. Verify caller's role in the workspace.
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!callerRole) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (!canManageWorkspace(callerRole)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can remove members.' },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();

  // 3. Fetch the target member row.
  const { data: targetMember, error: targetError } = await service
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId)
    .single();

  if (targetError || !targetMember) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
  }

  // 4. Cannot remove the workspace owner.
  if (targetMember.role === 'owner') {
    return NextResponse.json(
      { error: 'The workspace owner cannot be removed.' },
      { status: 403 },
    );
  }

  // 5. Admins can remove members and viewers but not other admins.
  if (callerRole === 'admin' && targetMember.role === 'admin') {
    return NextResponse.json(
      { error: 'Admins cannot remove other admins. Only the workspace owner can do this.' },
      { status: 403 },
    );
  }

  // 6. Prevent self-removal. The self-service route is
  //    POST /api/workspaces/[id]/leave, which applies the owner guard this
  //    handler cannot (an owner removing themselves would orphan the
  //    workspace) and reuses the same teardown below.
  if (targetUserId === user.id) {
    return NextResponse.json(
      {
        error: 'You cannot remove yourself. Use "Leave workspace" instead.',
        error_code: 'use_leave_workspace',
      },
      { status: 400 },
    );
  }

  // 7-8. Revoke the member's API keys in this workspace, then drop the
  //      membership row. Shared with the leave flow so the two cannot drift:
  //      an ex-member holding a live MCP credential is the same hole whichever
  //      side ended the membership.
  const { error: removeError } = await removeWorkspaceMember(service, workspaceId, targetUserId);

  if (removeError) {
    console.error('[members/remove] Delete failed:', removeError.message);
    return NextResponse.json({ error: 'Failed to remove member.' }, { status: 500 });
  }

  return NextResponse.json({ removed: true, userId: targetUserId });
}

/**
 * PATCH /api/workspaces/members/[userId]
 *
 * Changes a member's role. Caller must be the workspace owner.
 * (Only the owner may promote/demote; admins cannot change roles.)
 *
 * Body: { workspaceId: string, role: 'admin' | 'member' | 'viewer' }
 *
 * Guards:
 *  - Cannot change the owner's role.
 *  - Cannot promote anyone to 'owner' (ownership transfer is out of scope).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { userId: targetUserId } = await params;

  // 2. Parse body.
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { workspaceId, role: newRole } = body as Record<string, unknown>;

  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 });
  }
  if (typeof newRole !== 'string' || !VALID_ASSIGNABLE_ROLES.has(newRole)) {
    return NextResponse.json(
      { error: `role must be one of: ${[...VALID_ASSIGNABLE_ROLES].join(', ')}.` },
      { status: 400 },
    );
  }

  // 3. Verify caller is the workspace owner.
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!callerRole) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (callerRole !== 'owner') {
    return NextResponse.json(
      { error: 'Only the workspace owner can change member roles.' },
      { status: 403 },
    );
  }

  // 3b. Admin and Viewer are a Team-plan capability (PlanLimits.teamRolesEnabled).
  //     The dashboard hides the role selector when the plan lacks them, but a
  //     hidden control is not enforcement: a workspace that downgrades off Team
  //     keeps its members, and until now its owner could still PATCH anyone to
  //     `admin` or `viewer`. On such a plan the only assignable role is
  //     `member`. Existing role rows are deliberately left alone; this gate is
  //     about handing out new ones, and silently demoting a team on a failed
  //     card charge would be a worse failure than refusing a role change.
  //
  //     Reads the plan with the USER client for the reason spelled out in
  //     lib/plans/check-member-limit.ts: effective_workspace_plan is RLS-gated
  //     on auth.uid() and returns nothing under a service-role client.
  const memberLimit = await checkMemberLimit(supabase, workspaceId);
  if (!memberLimit.resolved) {
    console.error('[members/patch] Could not resolve the workspace plan:', memberLimit.reason);
    return NextResponse.json(
      {
        error: 'Could not read this workspace\u2019s plan, so the role was not changed. Please try again.',
        error_code: 'plan_unresolved',
      },
      { status: 500 },
    );
  }
  if (!memberLimit.teamRolesEnabled && newRole !== 'member') {
    return NextResponse.json(
      {
        error: 'The Admin and Viewer roles need the Team plan. On this plan everyone is a Member.',
        error_code: 'team_roles_not_available',
        upgrade_url: '/pricing',
      },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();

  // 4. Fetch the target member to guard against changing the owner row.
  const { data: targetMember, error: targetError } = await service
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId)
    .single();

  if (targetError || !targetMember) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
  }
  if (targetMember.role === 'owner') {
    return NextResponse.json(
      { error: "The workspace owner's role cannot be changed." },
      { status: 403 },
    );
  }

  // 5. Apply the role change.
  const { error: updateError } = await service
    .from('workspace_members')
    .update({ role: newRole })
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId);

  if (updateError) {
    console.error('[members/patch] Update failed:', updateError.message);
    return NextResponse.json({ error: 'Failed to update member role.' }, { status: 500 });
  }

  // 6. A role change has to reach the credentials the member is already
  //    holding, or it is only a label. Demoting someone to `viewer` used to
  //    change this one row and nothing else, so every API key that person had
  //    already minted kept its `send:email` and other write scopes and kept
  //    working through the MCP server: the demoted admin could still send mail
  //    from the workspace's mailboxes the moment after being demoted. The
  //    sibling DELETE handler above has always revoked a removed member's keys;
  //    this is the same obligation one step short of removal.
  //
  //    Only keys holding a scope outside the viewer allow-list are revoked, and
  //    they are revoked rather than narrowed. See the reasoning on
  //    revokeApiKeysBeyondViewerScopes: quietly rewriting a live key's scopes
  //    leaves the user holding a credential that no longer does what they were
  //    told it does, failing inside their agent instead of in the dashboard.
  let revokedKeyCount = 0;
  if (newRole === 'viewer') {
    const { revokedKeyIds, error: revokeError } = await revokeApiKeysBeyondViewerScopes(
      service,
      workspaceId,
      targetUserId,
    );
    if (revokeError) {
      // The role write already landed. Report the failure rather than claim a
      // clean demotion: the caller has to know that write-scoped keys may still
      // be live so they can revoke them by hand.
      console.error('[members/patch] Key reconciliation failed:', revokeError.message);
      return NextResponse.json(
        {
          error: 'The role was changed, but this member\u2019s existing API keys could not be revoked. Revoke them manually from the API keys page.',
          error_code: 'key_revocation_failed',
          userId: targetUserId,
          role: newRole,
        },
        { status: 500 },
      );
    }
    revokedKeyCount = revokedKeyIds.length;
  }

  return NextResponse.json({
    userId: targetUserId,
    role: newRole,
    revokedKeyCount,
    ...(revokedKeyCount > 0 ? { notice: demotionRevocationNotice(revokedKeyCount) } : {}),
  });
}
