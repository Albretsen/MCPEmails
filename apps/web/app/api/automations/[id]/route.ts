import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
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
 * PATCH  /api/automations/[id]  - edit, enable or disable one rule.
 * DELETE /api/automations/[id]  - soft delete (sets deleted_at).
 *
 * Both are owner/admin only. Deleting is a soft delete so the run history the
 * rule produced stays readable: a workspace needs to be able to answer "what
 * did that automation do to my mail" after switching it off.
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

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canManageAutomations(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can change automations.' }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'A request body is required.' }, { status: 400 });

  const { data: existing } = await c.db.from('triage_rules')
    .select('id, inbox_id, api_key_id, action, enabled, running_since')
    .eq('id', id)
    .eq('workspace_id', c.workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (body.name !== undefined) {
    const name = validateName(body.name);
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 });
    patch.name = name.value;
  }
  if (body.interval_minutes !== undefined) {
    const interval = validateInterval(body.interval_minutes);
    if (!interval.ok) return NextResponse.json({ error: interval.error }, { status: 400 });
    patch.interval_minutes = interval.value;
  }
  if (body.max_messages_per_run !== undefined) {
    const maxMessages = validateMaxMessages(body.max_messages_per_run);
    if (!maxMessages.ok) return NextResponse.json({ error: maxMessages.error }, { status: 400 });
    patch.max_messages_per_run = maxMessages.value;
  }
  if (body.filter !== undefined) {
    const filter = validateFilter(body.filter);
    if (!filter.ok) return NextResponse.json({ error: filter.error }, { status: 400 });
    patch.filter = filter.value;
  }
  if (body.action !== undefined) {
    const action = validateAction(body.action);
    if (!action.ok) return NextResponse.json({ error: action.error }, { status: 400 });
    patch.action = action.value;
  }

  const nextInboxId = body.inbox_id !== undefined ? body.inbox_id : existing.inbox_id;
  const nextApiKeyId = body.api_key_id !== undefined ? body.api_key_id : existing.api_key_id;
  if (body.inbox_id !== undefined || body.api_key_id !== undefined) {
    if (!isUuid(nextInboxId)) return NextResponse.json({ error: 'Choose the inbox this automation runs against.' }, { status: 400 });
    if (!isUuid(nextApiKeyId)) return NextResponse.json({ error: 'Choose the API key this automation acts with.' }, { status: 400 });
    const ownership = await assertWorkspaceResources(c.db, c.workspaceId, nextInboxId, nextApiKeyId);
    if (ownership) return NextResponse.json({ error: ownership.error }, { status: ownership.status });
    patch.inbox_id = nextInboxId;
    patch.api_key_id = nextApiKeyId;
  }

  // A label works on every provider, but not every NAME does: on IMAP a label
  // is a keyword, which is an atom. Either half of the pair can change in one
  // PATCH, so the check runs against the action and the inbox this rule will
  // have AFTER the edit, not the ones it had before.
  const nextAction = patch.action ?? existing.action;
  if (nextAction && typeof nextAction === 'object' && nextAction.type === 'label') {
    const provider = await readInboxProvider(c.db, c.workspaceId, nextInboxId);
    const forProvider = validateActionForProvider(nextAction, provider);
    if (!forProvider.ok) return NextResponse.json({ error: forProvider.error }, { status: 400 });
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'The enabled flag must be true or false.' }, { status: 400 });
    }
    patch.enabled = body.enabled;
    if (body.enabled) {
      // Turning a rule on schedules its first run and clears whatever auto-disabled
      // it, so a fixed rule does not stay one failure away from switching itself off.
      patch.next_run_at = new Date().toISOString();
      patch.consecutive_failures = 0;
      patch.disabled_reason = null;
    } else {
      patch.next_run_at = null;
    }
  }

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: 'There is nothing to update.' }, { status: 400 });
  }

  // An in-flight run holds a lease on the row. Editing what it is mid-run would
  // change the rule out from under the runner, so edits wait; only switching the
  // rule off is allowed, since that just stops the next run from being scheduled.
  const onlyDisabling = Object.keys(patch).every((key) => ['updated_at', 'enabled', 'next_run_at'].includes(key)) && patch.enabled === false;
  if (existing.running_since && !onlyDisabling) {
    return NextResponse.json({ error: 'This automation is running right now. Try again once the run finishes.' }, { status: 409 });
  }

  const { data, error } = await c.db.from('triage_rules')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', c.workspaceId)
    .is('deleted_at', null)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: 'Could not update this automation.' }, { status: 500 });
  return NextResponse.json({ automation: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!canManageAutomations(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can delete automations.' }, { status: 403 });
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });

  // Soft delete via the service-role client. The SELECT policy is evaluated
  // against the NEW row, so an RLS user client cannot write deleted_at.
  const { data, error } = await c.db.from('triage_rules')
    .update({ enabled: false, next_run_at: null, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', c.workspaceId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not delete this automation.' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });
  return NextResponse.json({ success: true });
}
