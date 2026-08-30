import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { sendInviteEmail } from '@/lib/email/send-invite';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';

/**
 * POST /api/workspaces/invite-resend/[id]
 *
 * Re-sends a pending invite by its UUID, on a freshly minted token.
 *
 * WHY THIS EXISTS. POST /api/workspaces/invite deliberately swallows a failed
 * email send because the invite row is already stored and (the comment said)
 * "the user can resend from the dashboard if the email bounces". There was no
 * resend, anywhere in the app. Meanwhile the stored row makes the natural retry
 * (invite the same address again) return 409 `invite_already_pending`, and the
 * raw token is unrecoverable because only its SHA-256 hash is persisted. So one
 * Resend outage produced an invite that was never delivered, could not be
 * re-created, and blocked that address for the full 7-day expiry. This is the
 * missing half.
 *
 * Body: { workspaceId: string }
 * Caller must be the workspace owner or an admin, exactly like the cancel route
 * this is modelled on (app/api/workspaces/invite-cancel/[id]/route.ts).
 *
 * WHY THE OLD TOKEN IS INVALIDATED. `token_hash` is replaced rather than
 * duplicated, so any link from an earlier attempt stops working. That is the
 * correct behaviour and not merely convenient: an invite link is a bearer
 * credential that grants membership of a workspace to whoever presents it, and
 * an undelivered one has an unknown fate (a bounce log, a misrouted mailbox, a
 * mail gateway's link scanner). Resending should not multiply the number of
 * live credentials pointing at one seat. One pending invite, one live token.
 * `expires_at` is pushed out to a fresh 7-day window for the same reason the
 * token is new: the recipient is only now receiving their first usable link.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function POST(
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
  // misleading 500. Same guard as the cancel route.
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

  // Verify caller is owner or admin of the workspace they claim to act on.
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!callerRole) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (!canManageWorkspace(callerRole)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can resend invites.' },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();

  // Load the invite, scoped to the workspace so an id from another workspace
  // cannot be resent (and so it cannot be probed for existence either: both
  // cases answer 404).
  const { data: invite, error: lookupError } = await service
    .from('workspace_invites')
    .select('id, email, role')
    .eq('id', inviteId)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .maybeSingle();

  if (lookupError) {
    console.error('[invite-resend] Lookup failed:', lookupError.message);
    return NextResponse.json({ error: 'Failed to resend invite.' }, { status: 500 });
  }
  if (!invite) {
    return NextResponse.json({ error: 'Invite not found.' }, { status: 404 });
  }

  // An already-expired invite is deliberately still resendable: the window is
  // extended below, and the alternative (cancel, then re-invite) is the same
  // outcome with two clicks and a chance to mistype the address.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { error: rotateError } = await service
    .from('workspace_invites')
    .update({ token_hash: hashToken(rawToken), expires_at: expiresAt })
    .eq('id', inviteId)
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null);

  if (rotateError) {
    console.error('[invite-resend] Token rotation failed:', rotateError.message);
    return NextResponse.json({ error: 'Failed to resend invite.' }, { status: 500 });
  }

  // Inviter and workspace names for the email body, same lookups the original
  // send does. Service-role: the users table is not readable by an ordinary
  // member's client.
  const { data: inviter } = await service
    .from('users')
    .select('display_name, email')
    .eq('id', user.id)
    .single();

  const { data: workspace } = await service
    .from('workspaces')
    .select('display_name')
    .eq('id', workspaceId)
    .single();

  try {
    await sendInviteEmail({
      to: invite.email,
      inviterName: inviter?.display_name || inviter?.email || 'A teammate',
      workspaceName: workspace?.display_name ?? 'the workspace',
      role: invite.role,
      rawToken,
    });
  } catch (emailErr) {
    // Unlike the original send, a failure here IS reported as a failure: the
    // caller pressed Resend precisely to find out whether the mail goes out, so
    // answering 201 would be answering the wrong question. The rotated token is
    // left in place; the row is still pending and still resendable.
    console.error('[invite-resend] Email send failed:', emailErr);
    return NextResponse.json(
      {
        error: 'The invite could not be emailed. The invite is still pending, so you can try again.',
        error_code: 'invite_email_failed',
        emailDelivered: false,
        inviteId: invite.id,
        email: invite.email,
        expiresAt,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    inviteId: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt,
    emailDelivered: true,
  });
}
