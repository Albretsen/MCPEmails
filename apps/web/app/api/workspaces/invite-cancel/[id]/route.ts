import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * DELETE /api/workspaces/invite-cancel/[id]
 *
 * Cancels a pending invite by its UUID (used by the dashboard where the raw
 * token is not available, only the invite ID is stored client-side).
 *
 * Distinct from DELETE /api/workspaces/invite/[token] which accepts the raw
 * token for external/email-based cancellation flows.
 *
 * Body: { workspaceId: string }
 * Caller must be workspace owner or admin.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { id: inviteId } = await params;

  // Validate the id is a UUID before it reaches `.eq('id', ...)`. An invalid
  // value would otherwise trigger a Postgres uuid-cast error surfaced as a
  // misleading 500 ("Failed to cancel invite.").
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!inviteId || !UUID_RE.test(inviteId)) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }

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

  // Verify caller is owner or admin.
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

  // Delete the invite, scoped to the workspace to prevent cross-workspace deletion.
  const service = createServiceRoleClient();
  const { error: deleteError, count } = await service
    .from('workspace_invites')
    .delete({ count: 'exact' })
    .eq('id', inviteId)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null);

  if (deleteError) {
    console.error('[invite-cancel] Delete failed:', deleteError.message);
    return NextResponse.json({ error: 'Failed to cancel invite.' }, { status: 500 });
  }

  if (!count || count === 0) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }

  return NextResponse.json({ cancelled: true });
}
