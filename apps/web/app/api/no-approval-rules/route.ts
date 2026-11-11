import { NextRequest, NextResponse } from 'next/server';
import { canDecide } from '@/lib/approvals/decide';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { noApprovalWriteError, validateNoApprovalInput } from '@/lib/approvals/no-approval';
import { visibleInboxIds } from '@/lib/inboxes/visibility';
import { noApprovalContext } from './shared';

/**
 * GET  /api/no-approval-rules  the rules, today's counts, which automations run without approval.
 * POST /api/no-approval-rules  create one (owner or admin, signed in).
 *
 * No API key reaches this route: it reads a session and nothing else, and the
 * write itself runs as that session (see ./shared.ts).
 */

export async function GET() {
  const c = await noApprovalContext();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const [{ data: overview, error: overviewError }, { data: coverage, error: coverageError }] = await Promise.all([
    c.db.rpc('no_approval_rules_overview', { p_workspace_id: c.workspaceId }),
    c.db.rpc('no_approval_workspace_coverage', { p_workspace_id: c.workspaceId }),
  ]);
  if (overviewError || coverageError) {
    return NextResponse.json({ error: 'Failed to load no-approval rules.' }, { status: 500 });
  }
  // An automation on someone else's private inbox is that person's (Business
  // privacy model, migration 20261111190000): its name and coverage are left out,
  // as GET /api/automations leaves the automation out.
  const visible = await visibleInboxIds(c.db, c.workspaceId, c.user.id);
  const { data: rules, error: rulesError } = await c.db
    .from('triage_rules')
    .select('id, inbox_id')
    .eq('workspace_id', c.workspaceId);
  if (rulesError) return NextResponse.json({ error: 'Failed to load no-approval rules.' }, { status: 500 });
  const visibleRules = new Set(
    ((rules ?? []) as Array<{ id: string; inbox_id: string | null }>)
      .filter((rule) => typeof rule.inbox_id === 'string' && visible.has(rule.inbox_id.toLowerCase()))
      .map((rule) => rule.id),
  );
  return NextResponse.json({
    overview: withVisibleAutomations(overview, visibleRules),
    coverage: ((coverage ?? []) as Array<{ triage_rule_id?: string | null }>)
      .filter((row) => typeof row.triage_rule_id === 'string' && visibleRules.has(row.triage_rule_id)),
  });
}

/** The overview with each rule's automations narrowed to the ones the caller may see. */
function withVisibleAutomations(overview: unknown, visibleRules: Set<string>): unknown {
  if (!overview || typeof overview !== 'object') return overview;
  const value = overview as { rules?: unknown };
  if (!Array.isArray(value.rules)) return overview;
  return {
    ...value,
    rules: value.rules.map((rule: Record<string, unknown>) => ({
      ...rule,
      automations: Array.isArray(rule.automations)
        ? rule.automations.filter((automation: { id?: unknown }) => typeof automation?.id === 'string' && visibleRules.has(automation.id))
        : rule.automations,
    })),
  };
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await noApprovalContext();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canDecide(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can change no-approval rules.', code: 'forbidden' }, { status: 403 });
  }
  const input = validateNoApprovalInput(await request.json().catch(() => null));
  if (!input.ok) return NextResponse.json({ error: 'Check the rule and try again.', code: input.code }, { status: 400 });
  const { data, error } = await c.auth.rpc('no_approval_rule_save', {
    p_workspace_id: c.workspaceId,
    p_rule_id: null as unknown as string,
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
  return NextResponse.json({ id: data }, { status: 201 });
}
