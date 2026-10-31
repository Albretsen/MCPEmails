import { NextRequest, NextResponse } from 'next/server';
import { canDecide } from '@/lib/approvals/decide';
import { isUuid } from '@/lib/automations/rules';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { noApprovalWriteError } from '@/lib/approvals/no-approval';
import { noApprovalContext } from '../../shared';

/**
 * POST /api/no-approval-rules/[id]/confirm  { automation_id }
 *
 * A person says yes again to an automation as it stands now, after a change voided
 * its coverage. Owner or admin, signed in.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await noApprovalContext();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canDecide(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can change no-approval rules.', code: 'forbidden' }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const automationId = body?.automation_id;
  if (!isUuid(id) || typeof automationId !== 'string' || !isUuid(automationId)) {
    return NextResponse.json({ error: 'That rule could not be found.', code: 'not_found' }, { status: 404 });
  }
  const { data, error } = await c.auth.rpc('no_approval_rule_confirm', {
    p_workspace_id: c.workspaceId,
    p_rule_id: id,
    p_triage_rule_id: automationId,
  });
  if (error) {
    const refused = noApprovalWriteError(error);
    return NextResponse.json({ error: 'Could not confirm.', code: refused.code }, { status: refused.status });
  }
  if (!data) return NextResponse.json({ error: 'That rule could not be found.', code: 'not_found' }, { status: 404 });
  return NextResponse.json({ confirmed: true });
}
