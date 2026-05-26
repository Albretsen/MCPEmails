import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

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
  const { data: callerMember, error: callerError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single();

  if (callerError || !callerMember) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (callerMember.role !== 'owner' && callerMember.role !== 'admin') {
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
  if (callerMember.role === 'admin' && targetMember.role === 'admin') {
    return NextResponse.json(
      { error: 'Admins cannot remove other admins. Only the workspace owner can do this.' },
      { status: 403 },
    );
  }

  // 6. Prevent self-removal (use the dashboard "leave workspace" flow instead).
  if (targetUserId === user.id) {
    return NextResponse.json(
      { error: 'You cannot remove yourself. Use "Leave workspace" instead.' },
      { status: 400 },
    );
  }

  // 7. Soft-revoke all of the member's API keys in this workspace.
  await service
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('created_by', targetUserId)
    .is('deleted_at', null);

  // 8. Remove the membership row.
  const { error: deleteError } = await service
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', targetUserId);

  if (deleteError) {
    console.error('[members/remove] Delete failed:', deleteError.message);
    return NextResponse.json({ error: 'Failed to remove member.' }, { status: 500 });
  }

  return NextResponse.json({ removed: true, userId: targetUserId });
}

/**
 * PATCH /api/workspaces/members/[userId]
 *
 * Changes a member's role. Caller must be the workspace owner.
 * (Only the owner may promote/demote — admins cannot change roles.)
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
  const { data: callerMember, error: callerError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single();

  if (callerError || !callerMember) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (callerMember.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only the workspace owner can change member roles.' },
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

  return NextResponse.json({ userId: targetUserId, role: newRole });
}
