import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide } from '@/lib/approvals/decide';
import { forwardAgain } from '@/lib/approvals/forward-again';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/approvals/[id]/forward-again: a new pending request from an expired
 * rule forward, with the same message and address and a new deadline.
 *
 * A dashboard session with an owner or admin role only. A key can never reach
 * this: a request carrying any Authorization header is refused before anything
 * else. The body must be empty, so there is no field that could name another
 * address or message; see src/lib/approvals/forward-again.ts.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (request.headers.get('authorization')) {
    return NextResponse.json({ error: 'This needs a signed-in session.', code: 'session_required' }, { status: 403 });
  }
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  if (!UUID_RE.test(id ?? '')) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (body && typeof body === 'object' && Object.keys(body).length > 0) {
    return NextResponse.json({ error: 'This takes no options.', code: 'no_options' }, { status: 400 });
  }

  const db = createServiceRoleClient();
  const { data: approval } = await db.from('send_approvals').select('id, workspace_id').eq('id', id).maybeSingle();
  const { data: membership } = approval
    ? await db
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', approval.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle()
    : { data: null };
  if (!approval || !membership) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (!canDecide(membership.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can do this.', code: 'role' }, { status: 403 });
  }

  const outcome = await forwardAgain({ db, approvalId: id, workspaceId: approval.workspace_id });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  return NextResponse.json({ success: true, id: outcome.id, expires_at: outcome.expires_at }, { status: 201 });
}
