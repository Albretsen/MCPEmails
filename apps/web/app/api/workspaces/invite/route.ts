import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkMemberLimit } from '@/lib/plans/check-member-limit';
import { sendInviteEmail } from '@/lib/email/send-invite';

/**
 * POST /api/workspaces/invite
 *
 * Sends a workspace invite email and stores the pending invite.
 *
 * Body: { workspaceId: string, email: string, role: 'admin' | 'member' | 'viewer' }
 *
 * Caller must be the workspace owner or an admin.
 */

const VALID_INVITE_ROLES = new Set(['admin', 'member', 'viewer']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse body.
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { workspaceId, email, role } = body as Record<string, unknown>;

  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }
  if (typeof role !== 'string' || !VALID_INVITE_ROLES.has(role)) {
    return NextResponse.json(
      { error: `role must be one of: ${[...VALID_INVITE_ROLES].join(', ')}.` },
      { status: 400 },
    );
  }

  const normalizedEmail = email.trim().toLowerCase();

  // 3. Verify caller's membership and role (owner or admin may invite).
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
      { error: 'Only workspace owners and admins can send invites.' },
      { status: 403 },
    );
  }

  // 4. Check plan seat limit.
  const service = createServiceRoleClient();
  const memberLimit = await checkMemberLimit(service, workspaceId);
  if (memberLimit.atLimit) {
    return NextResponse.json(
      {
        error: `Your ${memberLimit.plan} plan allows a maximum of ${memberLimit.maxMembers} member${memberLimit.maxMembers === 1 ? '' : 's'}. Upgrade your plan to add more collaborators.`,
        error_code: 'member_limit_reached',
        current_count: memberLimit.currentCount,
        max_members: memberLimit.maxMembers,
        upgrade_url: '/pricing',
      },
      { status: 403 },
    );
  }

  // 5. Check for an already-pending invite to this email in this workspace.
  const { data: existingInvite } = await service
    .from('workspace_invites')
    .select('id')
    .eq('workspace_id', workspaceId)
    .ilike('email', normalizedEmail)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (existingInvite) {
    return NextResponse.json(
      { error: 'An invite for this email address is already pending.', error_code: 'invite_already_pending' },
      { status: 409 },
    );
  }

  // 6. Check the email isn't already a workspace member.
  const { data: matchedUser } = await service
    .from('users')
    .select('id')
    .ilike('email', normalizedEmail)
    .maybeSingle();

  if (matchedUser) {
    const { data: alreadyMember } = await service
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', matchedUser.id)
      .maybeSingle();

    if (alreadyMember) {
      return NextResponse.json(
        { error: 'This user is already a member of the workspace.', error_code: 'already_a_member' },
        { status: 409 },
      );
    }
  }

  // 7. Generate token. Store only the SHA-256 hash.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  // 8. Fetch inviter display_name for the email.
  const { data: inviter } = await service
    .from('users')
    .select('display_name, email')
    .eq('id', user.id)
    .single();

  const inviterName = inviter?.display_name || inviter?.email || 'A teammate';

  // 9. Fetch workspace display_name for the email.
  const { data: workspace } = await service
    .from('workspaces')
    .select('display_name')
    .eq('id', workspaceId)
    .single();

  const workspaceName = workspace?.display_name ?? 'the workspace';

  // 10. Insert the invite row.
  const { data: invite, error: insertError } = await service
    .from('workspace_invites')
    .insert({
      workspace_id: workspaceId,
      invited_by: user.id,
      email: normalizedEmail,
      role,
      token_hash: tokenHash,
    })
    .select('id, email, role, expires_at, created_at')
    .single();

  if (insertError || !invite) {
    console.error('[invite] Insert failed:', insertError?.message);
    return NextResponse.json({ error: 'Failed to create invite.' }, { status: 500 });
  }

  // 11. Send invite email. Fail gracefully — the invite row exists; the user
  //     can resend from the dashboard if the email bounces.
  try {
    await sendInviteEmail({
      to: normalizedEmail,
      inviterName,
      workspaceName,
      role,
      rawToken,
    });
  } catch (emailErr) {
    console.error('[invite] Email send failed:', emailErr);
    // Don't return 500 — the invite record is stored; admin can resend.
  }

  return NextResponse.json(
    {
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    },
    { status: 201 },
  );
}
