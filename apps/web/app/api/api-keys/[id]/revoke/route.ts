import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * PATCH /api/api-keys/[id]/revoke
 *
 * Soft-deletes an API key by setting deleted_at = now().
 * The row is never hard-deleted; it is retained for audit log integrity
 * (activity_log rows reference api_key_id and would lose their foreign key).
 *
 * Steps:
 *   1. Authenticate the requesting user.
 *   2. Resolve their workspace via workspace_members.
 *   3. Set deleted_at on the key row, only if it belongs to this workspace
 *      and is not already deleted (idempotent guard).
 *   4. Return 200 { revoked: true } on success.
 *
 * RLS on api_keys also enforces workspace isolation as a belt-and-suspenders
 * measure; the .eq('workspace_id', workspaceId) clause is still required for
 * the idempotency guard to work correctly.
 *
 * References:
 *   Documents/Architecture/api-key-management.md §4.4 (Revocation)
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: keyId } = await params;

  if (!keyId || typeof keyId !== 'string' || keyId.length > 100) {
    return NextResponse.json({ error: 'Invalid key ID.' }, { status: 400 });
  }

  const supabase = await createClient();

  // 1. Authenticate the requesting user.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Resolve the active workspace (cookie-aware, multi-workspace safe).
  //    The key being revoked belongs to the workspace currently in view, and
  //    the .eq('workspace_id', workspaceId) guard below keeps the write scoped.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);

  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // 3. Soft-delete the key row using the service role.
  //    Setting deleted_at moves the row out of the api_keys SELECT policy
  //    (deleted_at IS NULL), which Postgres rejects under the user's RLS context
  //    as "new row violates row-level security policy". Authorization is already
  //    established above (workspace membership), and the write is scoped to the
  //    key id AND workspace_id. The .is('deleted_at', null) guard keeps it
  //    idempotent: revoking an already-revoked key is a no-op (still 200).
  const service = createServiceRoleClient();
  const { error: updateError } = await service
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (updateError) {
    console.error('[revoke-api-key] Failed to revoke key:', updateError.message);
    return NextResponse.json({ error: 'Failed to revoke API key.' }, { status: 500 });
  }

  // 4. Kill the OAuth refresh-token chain bound to this key, if any. Without
  //    this, an OAuth client would silently mint a fresh access token within
  //    the hour and the "revoked" connection would resurrect itself. Scoped to
  //    both the key and the workspace.
  const { error: refreshRevokeError } = await service
    .from('oauth_refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('api_key_id', keyId)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null);

  if (refreshRevokeError) {
    console.error('[revoke-api-key] Failed to revoke refresh tokens:', refreshRevokeError.message);
    return NextResponse.json({ error: 'Failed to fully revoke connection.' }, { status: 500 });
  }

  return NextResponse.json({ revoked: true });
}
