import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { loadProFeatureAccess } from '@/lib/plans/pro-features';
import { INBOX_INSTRUCTIONS_MAX_CHARS, normalizeInboxInstructionsInput } from '@/lib/inboxes/inbox-instructions';
import { canManageInboxes, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';

/**
 * /api/inboxes/[id]/instructions: the owner's standing instructions for AI
 * clients on one inbox (Pro feature `inbox_instructions`).
 *
 *   GET                              { instructions, updated_at, allowed, max_chars }
 *   PUT { instructions: string|null } save (trimmed; empty or null clears)
 *
 * Gate (lib/plans/pro-features.ts): 404 unless the feature is VISIBLE for the
 * inbox's workspace, so before launch this route does not exist for a
 * customer; PUT is 403 `pro_feature_required` unless ALLOWED (Pro or
 * Business). GET answers a visible workspace on a lower plan too, with
 * `allowed: false`, so the dashboard can show the field disabled.
 *
 * Authorization mirrors /folders: the inbox is read through the RLS-scoped
 * client (a returned row proves membership), viewers may read but not write,
 * and the column is read and written through the service-role client scoped to
 * the inbox id AND that workspace (there is no user write grant on inboxes).
 * `ai_instructions` is read in its own query: before the migration lands it
 * answers 503 'unavailable' here and nowhere else breaks.
 */

type Params = { params: Promise<{ id: string }> };

interface Scope {
  inboxId: string;
  workspaceId: string;
  allowed: boolean;
  canManage: boolean;
}

type Authorized = { ok: true; scope: Scope } | { ok: false; response: NextResponse };

function fail(error: string, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

async function authorize(params: Params['params']): Promise<Authorized> {
  const { id: inboxId } = await params;
  if (!inboxId || typeof inboxId !== 'string' || inboxId.length > 100) return fail('Invalid inbox ID.', 400);

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return fail('Unauthorized.', 401);

  const { data: visible, error } = await supabase
    .from('inboxes')
    .select('id, workspace_id')
    .eq('id', inboxId)
    .is('deleted_at', null)
    .single();
  if (error || !visible) return fail('Inbox not found.', 404);

  const [access, role] = await Promise.all([
    loadProFeatureAccess(supabase, createServiceRoleClient(), visible.workspace_id),
    fetchWorkspaceRole(supabase, visible.workspace_id, user.id),
  ]);
  // Not visible: the same answer as any unmatched /api path.
  if (!access.visible) return fail('Not found.', 404);

  return {
    ok: true,
    scope: { inboxId, workspaceId: visible.workspace_id, allowed: access.allowed, canManage: canManageInboxes(role) },
  };
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  const { scope } = auth;
  const { data, error } = await createServiceRoleClient()
    .from('inboxes')
    .select('ai_instructions, ai_instructions_updated_at')
    .eq('id', scope.inboxId)
    .eq('workspace_id', scope.workspaceId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) {
    // 42703: the column is not there yet (migration not applied).
    if (error.code === '42703') return NextResponse.json({ error: 'unavailable' }, { status: 503 });
    console.error('[instructions] load failed:', error.message);
    return NextResponse.json({ error: 'load_failed' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Inbox not found.' }, { status: 404 });
  return NextResponse.json({
    instructions: data.ai_instructions ?? null,
    updated_at: data.ai_instructions_updated_at ?? null,
    allowed: scope.allowed,
    can_manage: scope.canManage,
    max_chars: INBOX_INSTRUCTIONS_MAX_CHARS,
  });
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!('instructions' in body)) return NextResponse.json({ error: 'invalid_instructions' }, { status: 400 });
  const input = normalizeInboxInstructionsInput(body.instructions);
  if (!input.ok) {
    return NextResponse.json(
      input.error === 'too_long'
        ? { error: 'too_long', max_chars: INBOX_INSTRUCTIONS_MAX_CHARS }
        : { error: input.error },
      { status: 400 },
    );
  }

  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  const { scope } = auth;
  if (!scope.canManage) {
    return NextResponse.json(insufficientRoleBody('Workspace viewers cannot change inbox instructions.'), { status: 403 });
  }
  if (!scope.allowed) {
    return NextResponse.json({ error: 'pro_feature_required', feature: 'inbox_instructions' }, { status: 403 });
  }

  const updatedAt = new Date().toISOString();
  const { error } = await createServiceRoleClient()
    .from('inboxes')
    .update({ ai_instructions: input.value, ai_instructions_updated_at: updatedAt })
    .eq('id', scope.inboxId)
    .eq('workspace_id', scope.workspaceId)
    .is('deleted_at', null);
  if (error) {
    if (error.code === '42703') return NextResponse.json({ error: 'unavailable' }, { status: 503 });
    console.error('[instructions] save failed:', error.message);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
  return NextResponse.json({ instructions: input.value, updated_at: updatedAt });
}
