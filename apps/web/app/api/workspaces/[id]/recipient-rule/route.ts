import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { resolveEffectiveWorkspacePlan } from '@/lib/plans/effective-plan';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';
import { recordWorkspaceAuditEvent } from '@/lib/workspace/audit-events';
import { parseRecipientDomains, recipientRuleAuditDetails, storedRecipientDomains } from '@/lib/workspace/recipient-rule';

/**
 * The Business recipient rule (workspaces.allowed_recipient_domains,
 * migration 20261111130000). Settings > Advanced.
 *
 *   GET  any member: { domains, canEdit, available }
 *        domains    null = any recipient
 *        canEdit    owner or admin
 *        available  the workspace is on Business (effective plan 'pro')
 *   PUT  owner or admin, same origin, JSON: { domains: "a.com, b.com" | [...] | null }
 *        Empty clears the rule (always allowed, on any plan). Setting one
 *        needs Business. Written with the service role (workspaces has no user
 *        write privilege); every change lands in workspace_audit_events.
 *
 * GET and PUT are the only exported methods; any other is 405 from Next.js.
 */

type Params = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function caller(params: Params['params']) {
  const { id: workspaceId } = await params;
  if (!workspaceId || !UUID_RE.test(workspaceId)) {
    return { ok: false, response: NextResponse.json({ error: 'Workspace not found.' }, { status: 404 }) } as const;
  }
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized.' }, { status: 401 }) } as const;
  }
  const role = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!role) {
    return { ok: false, response: NextResponse.json({ error: 'Workspace not found.' }, { status: 404 }) } as const;
  }
  return { ok: true, supabase, user, role, workspaceId } as const;
}

async function isBusiness(supabase: Awaited<ReturnType<typeof createClient>>, workspaceId: string): Promise<boolean> {
  const plan = await resolveEffectiveWorkspacePlan(supabase, workspaceId);
  return plan.resolved && plan.plan === 'pro';
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const c = await caller(params);
  if (!c.ok) return c.response;

  const { data, error } = await createServiceRoleClient()
    .from('workspaces')
    .select('allowed_recipient_domains')
    .eq('id', c.workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    console.error('[recipient-rule] read failed:', error.message);
    return NextResponse.json({ error: 'Could not load the recipient rule.' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  return NextResponse.json({
    domains: storedRecipientDomains((data as { allowed_recipient_domains?: unknown }).allowed_recipient_domains),
    canEdit: canManageWorkspace(c.role),
    available: await isBusiness(c.supabase, c.workspaceId),
  });
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await caller(params);
  if (!c.ok) return c.response;
  if (!canManageWorkspace(c.role)) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can change the recipient rule.', error_code: 'insufficient_role' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('domains' in body)) {
    return NextResponse.json({ error: 'domains is required (empty clears the rule).' }, { status: 400 });
  }
  const parsed = parseRecipientDomains((body as Record<string, unknown>).domains);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, error_code: 'invalid_domains' }, { status: 400 });
  }

  // Setting a rule is a Business feature. Clearing one never is: a workspace
  // that left Business must still be able to lift a rule it set before.
  if (parsed.domains && !(await isBusiness(c.supabase, c.workspaceId))) {
    return NextResponse.json(
      { error: 'Recipient rules need the Business plan.', error_code: 'business_required', upgrade_url: '/pricing' },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();
  const { data: before } = await service
    .from('workspaces')
    .select('allowed_recipient_domains')
    .eq('id', c.workspaceId)
    .maybeSingle();
  const previous = storedRecipientDomains((before as { allowed_recipient_domains?: unknown } | null)?.allowed_recipient_domains);

  const { data: saved, error } = await service
    .from('workspaces')
    .update({ allowed_recipient_domains: parsed.domains })
    .eq('id', c.workspaceId)
    .is('deleted_at', null)
    .select('allowed_recipient_domains')
    .maybeSingle();
  if (error || !saved) {
    console.error('[recipient-rule] update failed:', error?.message ?? 'no row');
    return NextResponse.json({ error: 'Could not save the recipient rule.' }, { status: 500 });
  }
  const domains = storedRecipientDomains((saved as { allowed_recipient_domains?: unknown }).allowed_recipient_domains);

  if (JSON.stringify(previous) !== JSON.stringify(domains)) {
    // A diff, truncated with counts, so the row always fits its size cap.
    const logged = await recordWorkspaceAuditEvent(service, {
      workspaceId: c.workspaceId,
      actorUserId: c.user.id,
      kind: 'recipient_rule_changed',
      target: null,
      details: recipientRuleAuditDetails(previous, domains),
    });
    if (!logged) {
      // The rule is saved; the audit row is not. Loud, so it is noticed.
      console.error('[recipient-rule] AUDIT ROW LOST for a saved recipient rule change', {
        workspace_id: c.workspaceId,
        actor_user_id: c.user.id,
        to_count: domains?.length ?? 0,
      });
    }
  }

  return NextResponse.json({ domains });
}
