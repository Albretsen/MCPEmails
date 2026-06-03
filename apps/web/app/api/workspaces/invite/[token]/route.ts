import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * GET /api/workspaces/invite/[token]
 *
 * Resolves an invite token to workspace metadata for display on the accept page.
 * Does NOT require authentication: the token itself is the credential.
 * Does NOT consume the token.
 *
 * Returns 200 with { workspaceName, inviterName, role, expiresAt } on success.
 * Returns 404 if the token is not found, already accepted, or expired.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token: rawToken } = await params;
  if (!rawToken || typeof rawToken !== 'string') {
    return NextResponse.json({ error: 'Invalid token.' }, { status: 400 });
  }

  const tokenHash = hashToken(rawToken);
  const service = createServiceRoleClient();

  // Look up the invite: must be pending and not expired.
  const { data: invite, error } = await service
    .from('workspace_invites')
    .select('workspace_id, invited_by, email, role, expires_at')
    .eq('token_hash', tokenHash)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !invite) {
    return NextResponse.json({ error: 'Invite not found or expired.' }, { status: 404 });
  }

  // Fetch workspace name.
  const { data: workspace } = await service
    .from('workspaces')
    .select('display_name, slug')
    .eq('id', invite.workspace_id)
    .single();

  // Fetch inviter name.
  const { data: inviter } = await service
    .from('users')
    .select('display_name, email')
    .eq('id', invite.invited_by)
    .single();

  return NextResponse.json({
    workspaceName: workspace?.display_name ?? 'the workspace',
    workspaceSlug: workspace?.slug ?? '',
    inviterName: inviter?.display_name || inviter?.email || 'A teammate',
    role: invite.role,
    expiresAt: invite.expires_at,
  });
}

/**
 * DELETE /api/workspaces/invite/[token]
 *
 * Cancels a pending invite. Caller must be the workspace owner or admin.
 *
 * Body: { workspaceId: string }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { token: rawToken } = await params;

  // 2. Parse body for workspaceId.
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const { workspaceId } = body as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 });
  }

  // 3. Verify caller has owner or admin role in the workspace.
  const { data: callerMember, error: memberError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single();

  if (memberError || !callerMember) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (callerMember.role !== 'owner' && callerMember.role !== 'admin') {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can cancel invites.' },
      { status: 403 },
    );
  }

  // 4. Delete the invite, scoped to the workspace to prevent cross-workspace cancellation.
  const tokenHash = hashToken(rawToken);
  const service = createServiceRoleClient();

  const { error: deleteError, count } = await service
    .from('workspace_invites')
    .delete({ count: 'exact' })
    .eq('token_hash', tokenHash)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null);

  if (deleteError) {
    console.error('[invite/cancel] Delete failed:', deleteError.message);
    return NextResponse.json({ error: 'Failed to cancel invite.' }, { status: 500 });
  }

  if (!count || count === 0) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }

  return NextResponse.json({ cancelled: true });
}
