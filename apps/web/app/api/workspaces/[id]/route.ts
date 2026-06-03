import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

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
