import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
// Automations use the same owner/admin gate as send approvals, so the
// predicate is imported rather than duplicated. If the two ever diverge,
// split them: silently sharing a role set is how one of them ends up wrong.
import { canDecide as canManageAutomations } from '@/lib/approvals/decide';
import {
  RULE_COLUMNS,
  assertWorkspaceResources,
  isUuid,
  readInboxProvider,
  validateAction,
  validateActionForProvider,
  validateFilter,
  validateInterval,
  validateMaxMessages,
  validateName,
} from '@/lib/automations/rules';

/**
 * GET  /api/automations  - rules for the active workspace, with a last-run summary.
 * POST /api/automations  - create a rule (owner/admin, always created disabled).
 *
 * A new rule is written with `enabled: false` no matter what the client asked
 * for. Enabling is a separate, explicit PATCH, so nothing can start touching a
 * mailbox as a side effect of the create form.
 */

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  // The triage_automations migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const { data: membership } = await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, db } : null;
}

/** Rules a workspace can hold. Well above any real use, low enough to bound the page. */
const MAX_RULES = 200;

type RunSummary = {
  rule_id: string;
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  matched: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error_code: string | null;
};

export async function GET() {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { data: rules, error } = await c.db.from('triage_rules')
    .select(`${RULE_COLUMNS}, inboxes(email_address, display_name)`)
    .eq('workspace_id', c.workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(MAX_RULES);
  if (error) return NextResponse.json({ error: 'Failed to load automations.' }, { status: 500 });

  const rows = (rules ?? []) as Array<Record<string, unknown>>;

  // Last run per rule. Fetched as one flat, workspace-scoped page and reduced
  // in memory rather than as a PostgREST embed: an embedded resource cannot be
  // limited to one row per parent, and every row-returning select silently
  // truncates at 1000 rows, so a per-rule embed would quietly lose runs.
  const lastRunByRule = new Map<string, RunSummary>();
  if (rows.length > 0) {
    const ruleIds = rows.map((row) => row.id as string);
    const { data: runs } = await c.db.from('triage_runs')
      .select('id, rule_id, status, started_at, completed_at, matched, processed, succeeded, failed, skipped, error_code')
      .eq('workspace_id', c.workspaceId)
      .in('rule_id', ruleIds)
      .order('started_at', { ascending: false })
      .limit(600);
    for (const run of (runs ?? []) as RunSummary[]) {
      if (!lastRunByRule.has(run.rule_id)) lastRunByRule.set(run.rule_id, run);
    }
  }

  return NextResponse.json({
    role: c.role,
    automations: rows.map((row) => ({
      ...row,
      last_run: lastRunByRule.get(row.id as string) ?? null,
    })),
  });
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canManageAutomations(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can create automations.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'A request body is required.' }, { status: 400 });

  const name = validateName(body.name);
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
  const interval = validateInterval(body.interval_minutes);
  if (!interval.ok) return NextResponse.json({ error: interval.error }, { status: 400 });
  const maxMessages = validateMaxMessages(body.max_messages_per_run ?? 25);
  if (!maxMessages.ok) return NextResponse.json({ error: maxMessages.error }, { status: 400 });
  const filter = validateFilter(body.filter);
  if (!filter.ok) return NextResponse.json({ error: filter.error }, { status: 400 });
  const action = validateAction(body.action);
  if (!action.ok) return NextResponse.json({ error: action.error }, { status: 400 });

  if (!isUuid(body.inbox_id)) return NextResponse.json({ error: 'Choose the inbox this automation runs against.' }, { status: 400 });
  if (!isUuid(body.api_key_id)) return NextResponse.json({ error: 'Choose the API key this automation acts with.' }, { status: 400 });

  const ownership = await assertWorkspaceResources(c.db, c.workspaceId, body.inbox_id, body.api_key_id);
  if (ownership) return NextResponse.json({ error: ownership.error }, { status: ownership.status });

  // A label works on every provider, but not every NAME does: on IMAP a label
  // is a keyword, which is an atom. Refuse it here rather than store a rule
  // whose every run can only fail.
  const provider = await readInboxProvider(c.db, c.workspaceId, body.inbox_id);
  const forProvider = validateActionForProvider(action.value, provider);
  if (!forProvider.ok) return NextResponse.json({ error: forProvider.error }, { status: 400 });

  const count = await c.db.from('triage_rules')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', c.workspaceId)
    .is('deleted_at', null);
  if (typeof count?.count === 'number' && count.count >= MAX_RULES) {
    return NextResponse.json({ error: 'This workspace has reached its automation limit.' }, { status: 409 });
  }

  const { data, error } = await c.db.from('triage_rules').insert({
    workspace_id: c.workspaceId,
    inbox_id: body.inbox_id,
    api_key_id: body.api_key_id,
    created_by: c.user.id,
    name: name.value,
    // Always created off. Enabling is a separate, deliberate action.
    enabled: false,
    filter: filter.value,
    action: action.value,
    interval_minutes: interval.value,
    max_messages_per_run: maxMessages.value,
  }).select(RULE_COLUMNS).maybeSingle();

  if (error || !data) return NextResponse.json({ error: 'Could not create this automation.' }, { status: 500 });
  return NextResponse.json({ automation: { ...data, last_run: null } }, { status: 201 });
}
