import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { loadProFeatureAccess } from '@/lib/plans/pro-features';
import {
  defaultMorningBriefSettings,
  MORNING_BRIEF_MAX_VIP,
  normalizeMorningBriefInput,
} from '@/lib/morning-brief/settings';
import { canManageWorkspace, fetchWorkspaceRole, insufficientRoleBody } from '@/lib/workspace/roles';

/**
 * /api/workspaces/[id]/morning-brief: the workspace's daily brief settings
 * (Pro feature `morning_brief`).
 *
 *   GET  { settings, status, allowed, can_manage, max_vips }
 *   PUT  { enabled, hour, timezone, locale, inbox_id, vip_senders } save all
 *
 * Gate (lib/plans/pro-features.ts): 404 unless the feature is VISIBLE for the
 * workspace, so before launch the route does not exist for a customer; PUT is
 * 403 `pro_feature_required` unless ALLOWED (Pro or Business). The plan is
 * checked here, server-side, on every write; the dispatcher checks it again
 * before each brief.
 *
 * Owner and admin may change it (the brief reads every inbox of the
 * workspace); members and viewers may read. Membership is proven by the
 * RLS-scoped workspace read; the row is written with the service role scoped
 * to the workspace id, and the target inbox must be a live inbox of that
 * workspace. A save clears the schedule, the failure count and any pause, so
 * the dispatcher works out the next brief from the new settings.
 */

type Params = { params: Promise<{ id: string }> };

interface Scope {
  workspaceId: string;
  allowed: boolean;
  canManage: boolean;
}

type Authorized = { ok: true; scope: Scope } | { ok: false; response: NextResponse };

const SETTINGS_COLUMNS =
  'enabled, hour, timezone, locale, inbox_id, vip_senders, last_sent_at, last_run_at, last_outcome, last_error_code, paused_at';

function fail(error: string, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/** 42P01: the table is not there yet (migration not applied). */
function missingTable(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

async function authorize(params: Params['params']): Promise<Authorized> {
  const { id: workspaceId } = await params;
  if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.length > 100) return fail('Invalid workspace ID.', 400);

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return fail('Unauthorized.', 401);

  const { data: workspace, error } = await supabase.from('workspaces').select('id').eq('id', workspaceId).maybeSingle();
  if (error || !workspace) return fail('Workspace not found.', 404);

  const [access, role] = await Promise.all([
    loadProFeatureAccess(supabase, createServiceRoleClient(), workspaceId),
    fetchWorkspaceRole(supabase, workspaceId, user.id),
  ]);
  // Not visible: the same answer as any unmatched /api path.
  if (!access.visible) return fail('Not found.', 404);
  return { ok: true, scope: { workspaceId, allowed: access.allowed, canManage: canManageWorkspace(role) } };
}

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  const { scope } = auth;
  const { data, error } = await createServiceRoleClient()
    .from('morning_briefs')
    .select(SETTINGS_COLUMNS)
    .eq('workspace_id', scope.workspaceId)
    .maybeSingle();
  if (error) {
    if (missingTable(error)) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
    console.error('[morning-brief] load failed:', error.message);
    return NextResponse.json({ error: 'load_failed' }, { status: 500 });
  }
  const defaults = defaultMorningBriefSettings();
  return NextResponse.json({
    // null when never saved: the dashboard fills the browser's time zone in.
    settings: data
      ? {
          enabled: data.enabled,
          hour: data.hour,
          timezone: data.timezone,
          locale: data.locale,
          inbox_id: data.inbox_id,
          vip_senders: data.vip_senders ?? [],
        }
      : null,
    defaults,
    status: data
      ? {
          last_sent_at: data.last_sent_at,
          last_run_at: data.last_run_at,
          last_outcome: data.last_outcome,
          last_error_code: data.last_error_code,
          paused: data.paused_at !== null,
        }
      : null,
    allowed: scope.allowed,
    can_manage: scope.canManage,
    max_vips: MORNING_BRIEF_MAX_VIP,
  });
}

export async function PUT(request: NextRequest, { params }: Params): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const input = normalizeMorningBriefInput(body);
  if (!input.ok) {
    return NextResponse.json(
      input.error === 'too_many_vips'
        ? { error: input.error, max_vips: MORNING_BRIEF_MAX_VIP }
        : { error: input.error, ...(input.detail ? { detail: input.detail } : {}) },
      { status: 400 },
    );
  }

  const auth = await authorize(params);
  if (!auth.ok) return auth.response;
  const { scope } = auth;
  if (!scope.canManage) {
    return NextResponse.json(insufficientRoleBody('Only workspace owners and admins can change the morning brief.'), {
      status: 403,
    });
  }
  if (!scope.allowed) {
    return NextResponse.json({ error: 'pro_feature_required', feature: 'morning_brief' }, { status: 403 });
  }

  const service = createServiceRoleClient();
  if (input.value.inbox_id) {
    const { data: inbox, error } = await service
      .from('inboxes')
      .select('id')
      .eq('id', input.value.inbox_id)
      .eq('workspace_id', scope.workspaceId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error || !inbox) return NextResponse.json({ error: 'invalid_inbox' }, { status: 400 });
  }

  const { error } = await service.from('morning_briefs').upsert(
    {
      workspace_id: scope.workspaceId,
      ...input.value,
      next_due_at: null,
      consecutive_failures: 0,
      last_error_code: null,
      paused_at: null,
    },
    { onConflict: 'workspace_id' },
  );
  if (error) {
    if (missingTable(error)) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
    console.error('[morning-brief] save failed:', error.message);
    return NextResponse.json({ error: 'save_failed' }, { status: 500 });
  }
  return NextResponse.json({ settings: input.value });
}
