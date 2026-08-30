import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkMemberLimit } from '@/lib/plans/check-member-limit';
import { sendInviteEmail } from '@/lib/email/send-invite';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';

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

/**
 * Escape a caller-supplied string so `ilike` matches it literally.
 *
 * `ilike` is a PATTERN match, so an address is not just a value: `_` and `%`
 * are LIKE wildcards, and PostgREST additionally rewrites `*` to `%` on the
 * way in. Without escaping, `foo_bar@x.com` also matches `fooXbar@x.com`, so
 * the duplicate-invite and already-a-member checks below could match a
 * stranger's row, or match several rows at once (which makes `.maybeSingle()`
 * return PGRST116 and, since we ignore the error, skips the check entirely).
 *
 * Backslash is LIKE's default escape character, so it must be escaped first.
 * A literal `*` is not expressible through PostgREST's like/ilike at all; it is
 * escaped here too, so the worst case for such an address is a missed dedupe,
 * never a match against somebody else's.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_*]/g, (char) => `\\${char}`);
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
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
  // Stored rows are not guaranteed lower-case (the invite index is on
  // LOWER(email)), so lookups stay case-insensitive via `ilike`, but always on
  // the escaped form, never on the raw address.
  const emailPattern = escapeLikePattern(normalizedEmail);

  // 3. Verify caller's membership and role (owner or admin may invite).
  const callerRole = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!callerRole) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  if (!canManageWorkspace(callerRole)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can send invites.' },
      { status: 403 },
    );
  }

  // 4. Check the plan seat limit.
  //
  //    THE LIMIT CHECK MUST USE THE REQUEST-SCOPED USER CLIENT. checkMemberLimit
  //    reads the plan from the `effective_workspace_plan(uuid)` RPC, whose WHERE
  //    clause ends `AND w.id = ANY(public.my_workspace_ids())`, and
  //    my_workspace_ids() is derived from auth.uid(). A service-role client has
  //    no auth.uid(), so the RPC returned zero rows, the plan silently fell back
  //    to 'free', maxMembers became 1, and every workspace (which always has an
  //    owner) read as already at its cap. Live effect before this fix: a paying
  //    Team workspace got a 403 telling it to upgrade its free plan, on every
  //    invite. Every other caller of a check*Limit helper already passes the
  //    user client (see api-keys/route.ts and inboxes/imap/route.ts); this was
  //    the one that did not.
  //
  //    The service-role client below is still correct for the steps that
  //    genuinely have to bypass RLS: the invite dedupe lookup (rows the caller
  //    cannot SELECT), the users lookup by email, and the insert.
  const memberLimit = await checkMemberLimit(supabase, workspaceId);

  // An unresolvable plan is an error, not a free plan. Answering 403 "upgrade
  // your plan" when the truth is "we could not read your plan" is what made the
  // service-role bug above invisible for as long as it lived: the message was
  // plausible, so it read as a billing state rather than a defect.
  if (!memberLimit.resolved) {
    console.error('[invite] Could not resolve the workspace plan:', memberLimit.reason);
    return NextResponse.json(
      {
        error: 'Could not read this workspace\u2019s plan, so the invite was not sent. Please try again.',
        error_code: 'plan_unresolved',
      },
      { status: 500 },
    );
  }

  const service = createServiceRoleClient();

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

  // 4b. Admin and Viewer are a Team-plan capability. The dashboard already
  //     hides the role selector when the plan does not include them
  //     (MembersPage's `teamRolesEnabled` gate), but hiding a control is not
  //     enforcement: a workspace that downgrades off Team, or any caller
  //     posting JSON directly, could still hand out roles the plan does not
  //     include. On such a plan the only assignable role is `member`.
  if (!memberLimit.teamRolesEnabled && role !== 'member') {
    return NextResponse.json(
      {
        error: 'Assigning the Admin and Viewer roles needs the Team plan. On this plan collaborators join as Member.',
        error_code: 'team_roles_not_available',
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
    .ilike('email', emailPattern)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
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
    .ilike('email', emailPattern)
    .limit(1)
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

  // 11. Send the invite email.
  //
  //     A failed send does NOT roll the invite row back, and does not fail the
  //     request. Both alternatives were weighed:
  //
  //       Roll the row back. A retry would then be a clean re-invite, needing
  //       no new endpoint. It also throws away a real invite the admin created,
  //       loses the audit trail of it, and (because the raw token exists only
  //       in this function's scope) means a send that actually SUCCEEDED but
  //       reported a transport error would leave a live accept link pointing at
  //       a row that no longer exists.
  //
  //       Keep the row and make resending real. Chosen. The row is the record
  //       of intent; the email is a delivery attempt against it. What was
  //       broken was not the row, it was that "the admin can resend" was
  //       written in this comment and implemented nowhere: the natural retry
  //       (invite the same address again) hits the pending-invite check in step
  //       5 and gets a 409, so a single Resend outage locked that address out
  //       for the full 7-day expiry with an undeliverable token.
  //
  //     So: the row stays, POST /api/workspaces/invite-resend/[id] mints a
  //     fresh token and tries again, and this response reports honestly whether
  //     the email left the building so the dashboard can flag the invite and
  //     put the Resend action in front of the admin immediately.
  let emailDelivered = true;
  try {
    await sendInviteEmail({
      to: normalizedEmail,
      inviterName,
      workspaceName,
      role,
      rawToken,
    });
  } catch (emailErr) {
    emailDelivered = false;
    console.error('[invite] Email send failed:', emailErr);
  }

  return NextResponse.json(
    {
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
      emailDelivered,
    },
    { status: 201 },
  );
}
