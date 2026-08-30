import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';
import { fetchWorkspaceRole } from '@/lib/workspace/roles';
import { removeWorkspaceMember } from '@/lib/workspace/membership';

/**
 * POST /api/workspaces/[id]/leave
 *
 * The caller removes THEMSELVES from a workspace they were invited to.
 *
 * WHY THIS EXISTS. DELETE /api/workspaces/members/[userId] has always refused
 * self-removal with the sentence 'You cannot remove yourself. Use "Leave
 * workspace" instead.' There was no "Leave workspace": no route, no dashboard
 * control, no translation key anywhere in the app. A person who accepted an
 * invite could not get back out of the workspace by any means, and had to ask
 * an owner or admin to eject them. This is that flow.
 *
 * Rules:
 *  - The OWNER cannot leave. Ownership transfer is out of scope, and a
 *    workspace whose owner walked away has no one who can delete it, manage
 *    billing, or change roles. An owner who wants out deletes the workspace
 *    (DELETE /api/workspaces/[id]).
 *  - Anyone else may leave, with no approval from anybody.
 *  - Leaving soft-revokes the leaver's API keys in this workspace, using the
 *    same helper the admin-removal path uses. A leaver whose MCP credential
 *    kept working would be the same hole as a removed member's.
 *
 * The active-workspace cookie is cleared when it pointed at the workspace just
 * left. Verified against resolveActiveWorkspaceId rather than assumed: it only
 * honours the cookie after re-checking membership
 * (`.eq('workspace_id', preferred)` on workspace_members) and otherwise falls
 * back to the user's earliest-joined workspace, so a stale cookie already
 * resolves cleanly. Clearing it is belt and braces, and matches what the
 * workspace-delete route does with the same cookie.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { id: workspaceId } = await params;
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace id is required.' }, { status: 400 });
  }

  // 2. Resolve the caller's own role with the USER client, which is both the
  //    authorization check (RLS on workspace_members proves the membership is
  //    real) and the owner guard's input.
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!callerRole) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // 3. The owner cannot leave their own workspace.
  if (callerRole === 'owner') {
    return NextResponse.json(
      {
        // Do not offer ownership transfer here. There is no way to perform one:
        // `owner` is absent from VALID_INVITE_ROLES and VALID_ASSIGNABLE_ROLES,
        // and the PATCH handler refuses to touch the owner row at all. Pointing
        // the owner at a transfer they cannot carry out is the same defect this
        // route was written to remove, where the removal handler sent members to
        // a "Leave workspace" flow that did not exist.
        error: 'You own this workspace, so you cannot leave it. Delete the workspace instead, from Settings.',
        error_code: 'owner_cannot_leave',
      },
      { status: 403 },
    );
  }

  // 4. Revoke the leaver's keys in this workspace and drop the membership row.
  //    Service-role: setting api_keys.deleted_at moves the row out of its own
  //    RLS SELECT policy, which Postgres refuses under the user's context.
  //    Authorization was fully established in step 2 and every write below is
  //    scoped to this workspace and this user.
  const service = createServiceRoleClient();
  const { error: leaveError } = await removeWorkspaceMember(service, workspaceId, user.id);

  if (leaveError) {
    console.error('[workspaces/leave] Leave failed:', leaveError.message);
    return NextResponse.json({ error: 'Failed to leave the workspace.' }, { status: 500 });
  }

  const res = NextResponse.json({ left: true, workspaceId });
  if (request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value === workspaceId) {
    res.cookies.set(ACTIVE_WORKSPACE_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
  }
  return res;
}
