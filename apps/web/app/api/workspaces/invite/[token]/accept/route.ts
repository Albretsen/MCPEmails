import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * POST /api/workspaces/invite/[token]/accept
 *
 * Accepts a workspace invite for the currently authenticated user.
 * Calls the accept_workspace_invite() PL/pgSQL RPC which performs both
 * the workspace_members INSERT and the accepted_at stamp atomically.
 *
 * Requires the user to be logged in. If the invite email doesn't match
 * the signed-in user's email, returns 403.
 *
 * Error SQLSTATE codes from the RPC are mapped to HTTP status codes:
 *   P0001  invite_not_found        → 404
 *   P0002  invite_already_accepted → 409
 *   P0003  invite_expired          → 410
 *   P0004  invite_email_mismatch   → 403
 *   P0005  already_a_member        → 409
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Require authentication.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.', error_code: 'unauthenticated' }, { status: 401 });
  }

  const { token: rawToken } = await params;
  if (!rawToken || typeof rawToken !== 'string') {
    return NextResponse.json({ error: 'Invalid token.' }, { status: 400 });
  }

  const tokenHash = hashToken(rawToken);
  const service = createServiceRoleClient();

  // 2. Call the atomic RPC.
  const { data, error } = await service.rpc('accept_workspace_invite', {
    p_token_hash: tokenHash,
    p_user_id:    user.id,
    p_user_email: user.email ?? '',
  });

  if (error) {
    // Map PL/pgSQL exception messages to HTTP status codes.
    const msg: string = error.message ?? '';

    if (msg.includes('invite_not_found')) {
      return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
    }
    if (msg.includes('invite_already_accepted')) {
      return NextResponse.json({ error: 'This invite has already been accepted.' }, { status: 409 });
    }
    if (msg.includes('invite_expired')) {
      return NextResponse.json({ error: 'This invite has expired.' }, { status: 410 });
    }
    if (msg.includes('invite_email_mismatch')) {
      return NextResponse.json(
        {
          error: 'This invite was sent to a different email address. Sign in with the correct account to accept it.',
          error_code: 'invite_email_mismatch',
        },
        { status: 403 },
      );
    }
    if (msg.includes('already_a_member')) {
      return NextResponse.json(
        { error: 'You are already a member of this workspace.' },
        { status: 409 },
      );
    }

    console.error('[invite/accept] RPC error:', error.message);
    return NextResponse.json({ error: 'Failed to accept invite.' }, { status: 500 });
  }

  // RPC returns a single row with workspace_id, workspace_slug, role.
  const result = Array.isArray(data) ? data[0] : data;
  if (!result) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }

  return NextResponse.json({
    workspaceId:   result.workspace_id,
    workspaceSlug: result.workspace_slug,
    role:          result.role,
  });
}
