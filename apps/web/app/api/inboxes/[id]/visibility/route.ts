import { NextRequest, NextResponse, after } from 'next/server';
import { syncMailboxAddonForWorkspace } from '@/lib/stripe/mailbox-addon';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { isInboxVisibility, ownsInbox, privateInboxLimitErrorBody } from '@/lib/inboxes/visibility';
import { checkPrivateInboxLimit } from '@/lib/plans/check-private-inbox-limit';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';
import { recordWorkspaceAuditEvent } from '@/lib/workspace/audit-events';

/**
 * PATCH /api/inboxes/[id]/visibility  { visibility: 'private' | 'company' }
 *
 * Who in the workspace may use this mailbox (migration
 * 20261111190000_inbox_owner_visibility):
 *   private  only the person who connected it (inboxes.owner_user_id)
 *   company  every member of the workspace
 *
 * Only that person may change it. A workspace owner or admin who did not
 * connect the mailbox gets 403 on a company inbox they can see and 404 on a
 * private one they cannot (the RLS read hides it, so there is no oracle). The
 * row is read through the RLS-scoped client and written with the service role
 * pinned to the id, the workspace AND the owner, so the decision cannot be
 * raced by the row changing hands in between.
 *
 * PATCH is the only exported method; any other answers 405 from Next.js.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }

  const { id: inboxId } = await params;
  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) {
    return NextResponse.json({ error: 'Invalid inbox ID.' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const visibility = body && typeof body === 'object' ? (body as Record<string, unknown>).visibility : undefined;
  if (!isInboxVisibility(visibility)) {
    return NextResponse.json({ error: "visibility must be 'private' or 'company'." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { data: inbox, error: fetchError } = await supabase
    .from('inboxes')
    .select('id, workspace_id, owner_user_id, visibility, email_address')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();
  if (fetchError || !inbox) return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });

  const role = await fetchWorkspaceRole(supabase, inbox.workspace_id, user.id);
  if (!canManageInboxes(role)) {
    return NextResponse.json(insufficientRoleBody('Workspace viewers cannot change inbox settings.'), { status: 403 });
  }
  if (!ownsInbox(inbox, user.id)) {
    return NextResponse.json(
      {
        error: 'Only the person who connected this mailbox can change who can use it.',
        error_code: 'not_inbox_owner',
      },
      { status: 403 },
    );
  }

  if (inbox.visibility === visibility) return NextResponse.json({ visibility });

  const service = createServiceRoleClient();
  // Making a mailbox private adds one to this person's private count, so the
  // per-person cap of Business seat pricing applies exactly as on connect
  // (402 private_inbox_limit_reached; no cap when the switch is off or the
  // subscription is not seat-priced). Company-wide never adds a private one.
  if (visibility === 'private') {
    const privateLimit = await checkPrivateInboxLimit({ db: service, workspaceId: inbox.workspace_id, userId: user.id });
    if (privateLimit.atLimit) {
      return NextResponse.json(privateInboxLimitErrorBody(privateLimit), { status: 402 });
    }
  }
  const { data: saved, error: updateError } = await service
    .from('inboxes')
    .update({ visibility, updated_at: new Date().toISOString() })
    .eq('id', inboxId)
    .eq('workspace_id', inbox.workspace_id)
    .eq('owner_user_id', user.id)
    .is('deleted_at', null)
    .select('visibility')
    .maybeSingle();
  if (updateError || !saved) {
    console.error('[inbox-visibility] update failed:', updateError?.message ?? 'no row');
    return NextResponse.json({ error: 'Could not change who can use this mailbox.' }, { status: 500 });
  }
  // Security audit view (never throws).
  await recordWorkspaceAuditEvent(service, {
    workspaceId: inbox.workspace_id,
    actorUserId: user.id,
    kind: 'inbox_visibility_changed',
    target: inboxId,
    details: {
      from: inbox.visibility,
      to: saved.visibility,
      ...(typeof (inbox as { email_address?: unknown }).email_address === 'string'
        ? { inbox: (inbox as { email_address: string }).email_address }
        : {}),
    },
  });
  // Company-wide mailboxes past the included ten are billed by the mailbox
  // add-on (and, on seat pricing, the sync also brings the seats in step), so
  // a switch either way re-syncs. After the response; a failure is logged and
  // never fails the change, which is already saved.
  const workspaceId = inbox.workspace_id;
  after(() =>
    syncMailboxAddonForWorkspace(workspaceId)
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error('[inbox-visibility] mailbox add-on sync failed:', err instanceof Error ? err.message : String(err));
      }),
  );
  return NextResponse.json({ visibility: saved.visibility });
}
