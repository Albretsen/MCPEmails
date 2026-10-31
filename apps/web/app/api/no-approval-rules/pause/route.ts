import { NextRequest, NextResponse } from 'next/server';
import { canDecide } from '@/lib/approvals/decide';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { noApprovalWriteError } from '@/lib/approvals/no-approval';
import { noApprovalContext } from '../shared';

/**
 * POST /api/no-approval-rules/pause  { paused: boolean }
 *
 * Every forward in the workspace waits for approval while paused. Owner or admin.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await noApprovalContext();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canDecide(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can change no-approval rules.', code: 'forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.paused !== 'boolean') return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  const { data, error } = await c.auth.rpc('no_approval_pause_all', { p_workspace_id: c.workspaceId, p_paused: body.paused });
  if (error) {
    const refused = noApprovalWriteError(error);
    return NextResponse.json({ error: 'Could not change this.', code: refused.code }, { status: refused.status });
  }
  return NextResponse.json({ paused: data });
}
