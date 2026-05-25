import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * PATCH /api/api-keys/[id]/revoke
 *
 * Soft-deletes an API key by setting deleted_at = now().
 * The row is never hard-deleted — it is retained for audit log integrity
 * (activity_log rows reference api_key_id and would lose their foreign key).
 *
 * Steps:
 *   1. Authenticate the requesting user.
 *   2. Resolve their workspace via workspace_members.
 *   3. Set deleted_at on the key row — only if it belongs to this workspace
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

  // 2. Resolve the user's workspace via workspace_members.
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const workspaceId = (member as { workspace_id: string }).workspace_id;

  // 3. Soft-delete the key row.
  //    The .is('deleted_at', null) guard makes this idempotent — revoking an
  //    already-revoked key is a no-op (0 rows updated, still returns 200).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase as any)
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (updateError) {
    console.error('[revoke-api-key] Failed to revoke key:', updateError.message);
    return NextResponse.json({ error: 'Failed to revoke API key.' }, { status: 500 });
  }

  return NextResponse.json({ revoked: true });
}
