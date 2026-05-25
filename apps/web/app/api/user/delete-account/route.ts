import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * DELETE /api/user/delete-account
 *
 * Soft-deletes the authenticated user's workspace and all associated data,
 * then signs the user out.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: confirmEmail must exactly match the user's email.
 *   3. Look up the user's workspace (they must be the owner).
 *   4. Soft-delete all active API keys in the workspace (set deleted_at).
 *   5. Soft-delete all connected inboxes in the workspace (set deleted_at).
 *   6. Soft-delete the workspace itself (set deleted_at).
 *      my_workspace_ids() now excludes this workspace, making all tenant data
 *      invisible to the authenticated role immediately.
 *   7. Sign the user out (invalidate session cookies).
 *   8. Return { success: true }.
 *
 * Security:
 *   - Requires a valid session cookie.
 *   - Requires exact email confirmation — prevents accidental or CSRF-driven deletion.
 *   - Only the workspace owner may delete it (enforced by workspaces_update_owner RLS).
 *   - All mutations use the authenticated Supabase client so RLS is always active.
 *   - No credentials, tokens, or secrets are logged.
 *   - Data is soft-deleted, not hard-deleted, to preserve the audit trail.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse and validate request body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { confirmEmail } = body as { confirmEmail?: unknown };

  if (typeof confirmEmail !== 'string' || confirmEmail.trim().length === 0) {
    return NextResponse.json(
      { error: 'Email confirmation is required.' },
      { status: 400 },
    );
  }

  // Compare case-insensitively to be tolerant of capitalisation differences.
  if (confirmEmail.trim().toLowerCase() !== (user.email ?? '').toLowerCase()) {
    return NextResponse.json(
      { error: 'Email address does not match. Please type your exact email address.' },
      { status: 400 },
    );
  }

  // 3. Fetch the workspace owned by this user.
  //    Uses the authenticated client — the RLS workspaces_select_members policy
  //    ensures this returns only workspaces the user belongs to.
  const { data: workspace, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id, owner_id')
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (workspaceError) {
    console.error('[delete-account] workspace lookup failed:', workspaceError.message);
    return NextResponse.json(
      { error: 'Failed to look up account data.' },
      { status: 500 },
    );
  }

  if (!workspace) {
    // No workspace found — nothing to delete. Sign out anyway and report success.
    await supabase.auth.signOut();
    return NextResponse.json({ success: true }, { status: 200 });
  }

  const workspaceId = workspace.id;
  const now = new Date().toISOString();

  // 4. Soft-delete all active API keys in the workspace.
  //    The api_keys_update_members RLS policy allows this for workspace members
  //    when deleted_at IS NULL, which matches exactly the keys we want to revoke.
  const { error: keysError } = await supabase
    .from('api_keys')
    .update({ deleted_at: now, updated_at: now })
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (keysError) {
    console.error('[delete-account] api_keys soft-delete failed:', keysError.message);
    return NextResponse.json(
      { error: 'Failed to revoke API keys. Please try again.' },
      { status: 500 },
    );
  }

  // 5. Soft-delete all connected inboxes in the workspace.
  //    The inboxes_update_members RLS policy allows this for workspace members
  //    when deleted_at IS NULL.
  const { error: inboxesError } = await supabase
    .from('inboxes')
    .update({ deleted_at: now, status: 'revoked', updated_at: now })
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (inboxesError) {
    console.error('[delete-account] inboxes soft-delete failed:', inboxesError.message);
    return NextResponse.json(
      { error: 'Failed to disconnect inboxes. Please try again.' },
      { status: 500 },
    );
  }

  // 6. Soft-delete the workspace itself.
  //    The workspaces_update_owner RLS policy allows this since owner_id = auth.uid().
  //    After this update, my_workspace_ids() returns an empty array for this user,
  //    making all tenant data invisible to the authenticated role immediately.
  const { error: workspaceUpdateError } = await supabase
    .from('workspaces')
    .update({ deleted_at: now, updated_at: now })
    .eq('id', workspaceId)
    .eq('owner_id', user.id);

  if (workspaceUpdateError) {
    console.error('[delete-account] workspace soft-delete failed:', workspaceUpdateError.message);
    return NextResponse.json(
      { error: 'Failed to delete account. Please try again.' },
      { status: 500 },
    );
  }

  // 7. Sign the user out to invalidate all session cookies.
  //    Failures here are non-fatal — the workspace is already deleted and the
  //    user will be locked out on next page load regardless.
  const { error: signOutError } = await supabase.auth.signOut();
  if (signOutError) {
    console.error('[delete-account] signOut failed (non-fatal):', signOutError.message);
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
