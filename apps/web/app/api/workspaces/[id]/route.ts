import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';

const MAX_NAME_LEN = 60;

/**
 * PATCH /api/workspaces/[id]
 *
 * Renames a workspace (updates display_name). The slug is intentionally NOT
 * changed: slugs are used in MCP endpoint URLs so renaming them would break
 * existing client configs. Only display_name is updated — this is what the
 * UI label says ("Workspace name") and what appears in the sidebar/breadcrumb.
 *
 * Body: { displayName: string }
 *
 * Authorization: caller must be the workspace owner or an admin.
 * The write itself uses the service-role client (RLS blocks user-client
 * writes to the workspaces table per the codebase soft-delete pattern).
 */
export async function PATCH(
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

  // 2. Parse body.
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { displayName } = body as Record<string, unknown>;
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    return NextResponse.json({ error: 'A workspace name is required.' }, { status: 400 });
  }
  if (displayName.trim().length > MAX_NAME_LEN) {
    return NextResponse.json(
      { error: `Workspace name must be ${MAX_NAME_LEN} characters or fewer.` },
      { status: 400 },
    );
  }
  const trimmed = displayName.trim();

  // 3. Verify caller is an owner or admin of this workspace (user-role client
  //    enforces RLS on workspace_members, which is the correct auth check).
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
      { error: 'Only workspace owners and admins can rename the workspace.' },
      { status: 403 },
    );
  }

  // 4. Perform the write using the service-role client.
  //    The user-role client cannot UPDATE the workspaces table (RLS blocks it),
  //    so we use the service-role client — same pattern as soft-deletes.
  const service = createServiceRoleClient();

  const { error: updateError } = await service
    .from('workspaces')
    .update({ display_name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', workspaceId)
    .is('deleted_at', null);

  if (updateError) {
    console.error('[workspaces/patch] Update failed:', updateError.message);
    return NextResponse.json({ error: 'Failed to update workspace name.' }, { status: 500 });
  }

  return NextResponse.json({ id: workspaceId, displayName: trimmed });
}

/**
 * DELETE /api/workspaces/[id]
 *
 * Soft-deletes a SINGLE workspace and tears down all of its data, while
 * leaving the caller's account and any OTHER workspaces fully intact. This is
 * the workspace-scoped counterpart to DELETE /api/user/delete-account (which
 * removes the whole account and every workspace the user owns).
 *
 * Body: { confirmName: string } — must match the workspace's display name.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Verify the caller is the OWNER of this workspace (admins/members cannot
 *      delete a workspace — only the owner can).
 *   3. Validate confirmName matches the workspace display_name (case-insensitive),
 *      mirroring the type-to-confirm guard on account deletion.
 *   4. Refuse to delete the caller's LAST remaining workspace: a user must
 *      always have at least one workspace to land in. They should delete their
 *      account instead.
 *   5. Tear down the workspace (scoped to this id): revoke API keys + OAuth
 *      refresh chains, disconnect inboxes and null their encrypted credentials,
 *      drop pending invites, remove ALL member rows, then soft-delete the
 *      workspace row.
 *   6. If this workspace was the active one (cookie), clear the cookie so the
 *      next dashboard load resolves a valid workspace.
 *
 * Security mirrors delete-account: authorization is fully established before
 * any mutation; every write is scoped to this workspace_id; soft-delete writes
 * use the service-role client (setting deleted_at moves rows out of their RLS
 * SELECT policy, which Postgres rejects under the user's RLS context). Data is
 * soft-deleted, not hard-deleted, to preserve the audit trail.
 */
export async function DELETE(
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

  // 2. Parse body.
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const { confirmName } = body as { confirmName?: unknown };
  if (typeof confirmName !== 'string' || confirmName.trim().length === 0) {
    return NextResponse.json(
      { error: 'Workspace name confirmation is required.' },
      { status: 400 },
    );
  }

  // 3. Verify the caller is the OWNER of this workspace (user-role client
  //    enforces RLS on workspace_members — the correct authorization check).
  //    Only owners may delete a workspace; admins/members cannot.
  const { data: callerMember, error: memberError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .single();

  if (memberError || !callerMember) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (callerMember.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only the workspace owner can delete the workspace.' },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();

  // 4. Fetch the workspace and validate the typed name matches.
  const { data: workspaceRow, error: wsLookupError } = await service
    .from('workspaces')
    .select('display_name')
    .eq('id', workspaceId)
    .is('deleted_at', null)
    .single();

  if (wsLookupError || !workspaceRow) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  }
  if (
    confirmName.trim().toLowerCase() !==
    (workspaceRow.display_name ?? '').trim().toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'Workspace name does not match. Please type the exact workspace name.' },
      { status: 400 },
    );
  }

  // 5. Refuse to delete the caller's LAST remaining workspace. A user must
  //    always have at least one workspace to land in; to leave entirely they
  //    should delete their account. Count the user's OTHER non-deleted
  //    workspaces (owned or invited).
  const { data: memberships } = await service
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id);

  const otherIds = (memberships ?? [])
    .map((m) => m.workspace_id)
    .filter((id) => id !== workspaceId);

  let remaining = 0;
  if (otherIds.length > 0) {
    const { count } = await service
      .from('workspaces')
      .select('id', { count: 'exact', head: true })
      .in('id', otherIds)
      .is('deleted_at', null);
    remaining = count ?? 0;
  }

  if (remaining === 0) {
    return NextResponse.json(
      {
        error:
          'This is your only workspace. Delete your account instead to close it.',
        code: 'last_workspace',
      },
      { status: 409 },
    );
  }

  // 6. Tear down the workspace, scoped to this id. Order mirrors delete-account.
  const now = new Date().toISOString();
  const steps = [
    // Soft-delete API keys.
    service.from('api_keys')
      .update({ deleted_at: now, updated_at: now })
      .eq('workspace_id', workspaceId).is('deleted_at', null),
    // Kill OAuth refresh-token chains so connections can't resurrect.
    service.from('oauth_refresh_tokens')
      .update({ revoked_at: now })
      .eq('workspace_id', workspaceId).is('revoked_at', null),
    // Disconnect inboxes AND null the encrypted credential columns (no PII at rest).
    service.from('inboxes')
      .update({
        deleted_at: now,
        status: 'revoked',
        updated_at: now,
        oauth_access_token: null,
        oauth_refresh_token: null,
        imap_password: null,
      })
      .eq('workspace_id', workspaceId).is('deleted_at', null),
    // Remove pending invites.
    service.from('workspace_invites').delete().eq('workspace_id', workspaceId),
    // Remove ALL membership rows for this workspace (the workspace is gone).
    service.from('workspace_members').delete().eq('workspace_id', workspaceId),
    // Soft-delete the workspace itself.
    service.from('workspaces')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', workspaceId),
  ];

  const results = await Promise.all(steps);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    console.error('[workspaces/delete] teardown failed:', failed.error.message);
    return NextResponse.json(
      { error: 'Failed to delete workspace. Please try again.' },
      { status: 500 },
    );
  }

  // 7. If the deleted workspace was the active one, clear the cookie so the
  //    next dashboard load resolves to a still-valid workspace.
  const res = NextResponse.json({ success: true }, { status: 200 });
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
