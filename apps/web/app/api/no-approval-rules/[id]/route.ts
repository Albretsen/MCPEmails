import { NextRequest, NextResponse } from 'next/server';
import { canDecide } from '@/lib/approvals/decide';
import { isUuid } from '@/lib/automations/rules';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { noApprovalWriteError, validateNoApprovalInput } from '@/lib/approvals/no-approval';
import { noApprovalContext } from '../shared';

/** PATCH saves the whole rule, DELETE removes it. Owner or admin, signed in. */

async function gate(request: NextRequest, params: Promise<{ id: string }>) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return { refused: NextResponse.json({ error: 'Bad request.' }, { status: 403 }) };
  }
  const c = await noApprovalContext();
  if (!c) return { refused: NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }) };
  if (!canDecide(c.role)) {
    return { refused: NextResponse.json({ error: 'Only workspace owners and admins can change no-approval rules.', code: 'forbidden' }, { status: 403 }) };
  }
  const { id } = await params;
  if (!isUuid(id)) return { refused: NextResponse.json({ error: 'That rule could not be found.', code: 'not_found' }, { status: 404 }) };
  return { c, id };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (g.refused) return g.refused;
  const input = validateNoApprovalInput(await request.json().catch(() => null));
  if (!input.ok) return NextResponse.json({ error: 'Check the rule and try again.', code: input.code }, { status: 400 });
  const { error } = await g.c.auth.rpc('no_approval_rule_save', {
    p_workspace_id: g.c.workspaceId,
    p_rule_id: g.id,
    p_name: input.value.name,
    p_recipients: input.value.recipients,
    p_scope: input.value.scope,
    p_automation_ids: input.value.automation_ids,
    p_inbox_ids: input.value.inbox_ids as unknown as string[],
    p_daily_limit: input.value.daily_limit,
    p_time_zone: input.value.time_zone,
    p_verified_senders_only: input.value.verified_senders_only,
    p_enabled: input.value.enabled,
  });
  if (error) {
    const refused = noApprovalWriteError(error);
    return NextResponse.json({ error: 'Could not save this rule.', code: refused.code }, { status: refused.status });
  }
  return NextResponse.json({ id: g.id });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(request, params);
  if (g.refused) return g.refused;
  const { data, error } = await g.c.auth.rpc('no_approval_rule_delete', { p_workspace_id: g.c.workspaceId, p_rule_id: g.id });
  if (error) {
    const refused = noApprovalWriteError(error);
    return NextResponse.json({ error: 'Could not delete this rule.', code: refused.code }, { status: refused.status });
  }
  if (!data) return NextResponse.json({ error: 'That rule could not be found.', code: 'not_found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
