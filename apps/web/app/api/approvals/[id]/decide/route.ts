import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { validateCsrfToken } from '@/lib/oauth/csrf';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide, decideApproval } from '@/lib/approvals/decide';

/**
 * Decision endpoint for the authenticated review page (/approvals/[id]).
 *
 * This module deliberately exports ONLY `POST`. There is no GET handler: a
 * link that sends an email by being fetched would be a serious bug, and this
 * URL is reachable from inside an AI conversation where link-preview bots and
 * scanners routinely issue GETs. Any other method falls through to Next.js's
 * 405.
 *
 * It differs from `PATCH /api/approvals` in exactly one way: the workspace is
 * resolved from the approval row itself rather than from the active-workspace
 * cookie. A review link arrives from a Claude conversation and has no
 * relationship to whichever workspace the browser last had selected.
 *
 * The decision itself is delegated to `decideApproval` so the atomic claim and
 * the `scheduled_sends` dispatcher marker stay on one shared code path with
 * the dashboard panel. See `docs/mcp-apps/contract.md` §6.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const decision = body?.decision;
  const csrfToken = body?.csrf_token;

  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: 'A decision is required.' }, { status: 400 });
  }
  if (typeof csrfToken !== 'string' || !(await validateCsrfToken(csrfToken, user.id))) {
    return NextResponse.json(
      { error: 'This page expired. Reload it and try again.', code: 'csrf' },
      { status: 403 },
    );
  }

  // The send_approvals migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;

  const { data: approval } = await db
    .from('send_approvals')
    .select('id, workspace_id')
    .eq('id', id)
    .maybeSingle();

  const { data: membership } = approval
    ? await db
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', approval.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle()
    : { data: null };

  // A missing approval and an approval in someone else's workspace return the
  // same 404: this endpoint must not confirm that an id exists.
  if (!approval || !membership) {
    return NextResponse.json({ error: 'Not found.', code: 'not_found' }, { status: 404 });
  }

  if (!canDecide(membership.role)) {
    return NextResponse.json(
      {
        error: 'Only workspace owners and admins can decide sends.',
        code: 'role',
      },
      { status: 403 },
    );
  }

  const outcome = await decideApproval({
    db,
    approvalId: id,
    workspaceId: approval.workspace_id,
    userId: user.id,
    decision,
    via: 'review_page',
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  }

  return NextResponse.json({ success: true, decision });
}
