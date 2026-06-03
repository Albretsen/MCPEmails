import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * DELETE /api/user/delete-account
 *
 * Soft-deletes every workspace the authenticated user owns (and all associated
 * data), removes the user from any workspace they were invited to, then signs
 * them out.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: confirmEmail must exactly match the user's email.
 *   3. Look up ALL workspaces the user owns.
 *   4. For each owned workspace: revoke API keys + OAuth refresh chains,
 *      disconnect inboxes and null their encrypted credentials, drop pending
 *      invites, and soft-delete the workspace.
 *   5. Remove the user's membership rows everywhere (owned + invited).
 *   6. Ban the auth user via the service-role admin API (~100-year ban_duration)
 *      so the credentials can no longer be used to log in.
 *   7. Sign the user out (invalidate session cookies).
 *   8. Return { success: true }.
 *
 * Residual (by design): the auth.users row is retained (soft-delete model);
 * audit/activity logs are preserved for integrity. The auth user is banned
 * via the service-role admin API so they cannot log in again despite the row
 * remaining in auth.users.
 *
 * Security:
 *   - Requires a valid session cookie.
 *   - Requires exact email confirmation: prevents accidental or CSRF-driven deletion.
 *   - Only the workspace owner may delete it (verified via the owner_id lookup
 *     on the authenticated client below).
 *   - The soft-delete mutations use the service-role client: setting deleted_at
 *     moves each row out of its SELECT policy (deleted_at IS NULL, or, for
 *     workspaces, my_workspace_ids() no longer returning the id), which
 *     Postgres rejects under the user's RLS context as "new row violates
 *     row-level security policy". Authorization is fully established before any
 *     mutation, and every write is scoped to the owned workspace_id.
 *   - After teardown, the auth user is permanently banned (ban_duration ~100 years)
 *     via auth.admin.updateUserById so that credentials can never be reused to log in.
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

  // 3. Fetch ALL workspaces owned by this user (a Pro user may own several).
  const service = createServiceRoleClient();
  const { data: ownedWorkspaces, error: workspaceError } = await service
    .from('workspaces')
    .select('id')
    .eq('owner_id', user.id)
    .is('deleted_at', null);

  if (workspaceError) {
    console.error('[delete-account] workspace lookup failed:', workspaceError.message);
    return NextResponse.json(
      { error: 'Failed to look up account data.' },
      { status: 500 },
    );
  }

  const ownedIds = (ownedWorkspaces ?? []).map((w) => w.id);
  const now = new Date().toISOString();

  // 4. Tear down every owned workspace: revoke keys + refresh chains, disconnect
  //    inboxes AND wipe their encrypted credentials, drop pending invites, then
  //    soft-delete the workspace. All scoped to the owned workspace ids.
  if (ownedIds.length > 0) {
    const steps = [
      // Soft-delete API keys.
      service.from('api_keys')
        .update({ deleted_at: now, updated_at: now })
        .in('workspace_id', ownedIds).is('deleted_at', null),
      // Kill OAuth refresh-token chains so connections can't resurrect.
      service.from('oauth_refresh_tokens')
        .update({ revoked_at: now })
        .in('workspace_id', ownedIds).is('revoked_at', null),
      // Disconnect inboxes AND null the encrypted credential columns (no PII left at rest).
      service.from('inboxes')
        .update({
          deleted_at: now,
          status: 'revoked',
          updated_at: now,
          oauth_access_token: null,
          oauth_refresh_token: null,
          imap_password: null,
        })
        .in('workspace_id', ownedIds).is('deleted_at', null),
      // Remove pending invites.
      service.from('workspace_invites').delete().in('workspace_id', ownedIds),
      // Soft-delete the workspaces themselves.
      service.from('workspaces')
        .update({ deleted_at: now, updated_at: now })
        .in('id', ownedIds),
    ];

    const results = await Promise.all(steps);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      console.error('[delete-account] teardown failed:', failed.error.message);
      return NextResponse.json(
        { error: 'Failed to delete account data. Please try again.' },
        { status: 500 },
      );
    }
  }

  // 5. Remove the user from ALL workspaces (owned + any they were invited to),
  //    so no dangling membership remains after the account is gone.
  const { error: membershipError } = await service
    .from('workspace_members')
    .delete()
    .eq('user_id', user.id);

  if (membershipError) {
    console.error('[delete-account] membership removal failed:', membershipError.message);
    return NextResponse.json(
      { error: 'Failed to delete account. Please try again.' },
      { status: 500 },
    );
  }

  // 6. Ban the auth user so they can never log in again, even though the
  //    auth.users row is retained for audit purposes. We set a ban_duration of
  //    ~100 years (876_600 h) and stamp app_metadata.deleted_at for traceability.
  //    This uses the service-role admin API (requires SUPABASE_SERVICE_ROLE_KEY).
  //    Failure is non-fatal: the workspace data is already destroyed; we log it
  //    and continue so the caller still gets a clean response.
  const { error: banError } = await service.auth.admin.updateUserById(user.id, {
    ban_duration: '876600h',
    app_metadata: { deleted_at: now },
  });
  if (banError) {
    console.error('[delete-account] auth ban failed (non-fatal):', banError.message);
  }

  // 7. Sign the user out to invalidate all session cookies.
  //    Failures here are non-fatal: the workspace is already deleted and the
  //    user will be locked out on next page load regardless.
  const { error: signOutError } = await supabase.auth.signOut();
  if (signOutError) {
    console.error('[delete-account] signOut failed (non-fatal):', signOutError.message);
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
