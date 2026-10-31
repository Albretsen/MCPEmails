import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide } from '@/lib/approvals/decide';
import { approveAllFromRule, parseApproveAllItems } from '@/lib/approvals/approve-all';

/**
 * POST /api/approvals/approve-rule: approve the waiting forwards a person saw,
 * from one rule, to the one address the confirmation named. See
 * src/lib/approvals/approve-all.ts.
 *
 * A dashboard session with an owner or admin role only. A request carrying any
 * Authorization header is refused before anything else, so a key can never reach
 * this. Answers one outcome per row.
 */
export async function POST(request: NextRequest) {
  if (request.headers.get('authorization')) {
    return NextResponse.json({ error: 'This needs a signed-in session.', code: 'session_required' }, { status: 403 });
  }
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }

  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const db = createServiceRoleClient();
  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canDecide(membership.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can do this.', code: 'role' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const items = parseApproveAllItems(body?.items);
  if (typeof body?.rule_id !== 'string' || typeof body?.address !== 'string' || !items) {
    return NextResponse.json({ error: 'A rule, an address and the requests you saw are required.' }, { status: 400 });
  }

  const result = await approveAllFromRule({
    db,
    workspaceId,
    userId: user.id,
    ruleId: body.rule_id,
    address: body.address,
    items,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ outcomes: result.outcomes });
}
