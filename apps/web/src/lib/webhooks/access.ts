import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { canManageWorkspace } from '@/lib/workspace/roles';
import { resolveEffectiveWorkspacePlan } from '@/lib/plans/effective-plan';

/**
 * Who is asking, in which workspace, with which role, and whether the plan
 * allows webhooks: the four questions every /api/webhook-endpoints route asks
 * first.
 *
 * The workspace is the caller's ACTIVE workspace (cookie, verified against
 * membership), never one named in the request. Reading is open to every
 * member; changing endpoints, and sending a test, is owner/admin
 * (`canManageWorkspace`), the same line the migration's RLS states. The plan
 * is resolved through the USER client (effective_workspace_plan is gated on
 * the caller's own memberships and says nothing to the service role).
 */

export type WebhookAccess =
  | {
      ok: true;
      userId: string;
      workspaceId: string;
      role: string;
      canManage: boolean;
      /** False also when the plan could not be resolved: never allow on doubt. */
      webhooksEnabled: boolean;
      plan: string | null;
    }
  | { ok: false; status: number; body: { error: string; error_code?: string } };

export async function resolveWebhookAccess(
  supabase: SupabaseClient<Database>,
  options: { manage: boolean },
): Promise<WebhookAccess> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, status: 401, body: { error: 'Unauthorized.' } };

  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return { ok: false, status: 403, body: { error: 'Workspace not found.' } };

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!member) return { ok: false, status: 403, body: { error: 'Workspace not found.' } };

  const canManage = canManageWorkspace(member.role);
  if (options.manage && !canManage) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Only workspace owners and admins can change webhooks.', error_code: 'insufficient_role' },
    };
  }

  const plan = await resolveEffectiveWorkspacePlan(supabase, workspaceId);
  return {
    ok: true,
    userId: user.id,
    workspaceId,
    role: member.role,
    canManage,
    webhooksEnabled: plan.resolved ? plan.limits.webhooksEnabled : false,
    plan: plan.resolved ? plan.plan : null,
  };
}

/**
 * How many inboxes a workspace's webhooks may add to the new-mail watcher:
 * the first 25 covered inboxes in order of connection, oldest first. The SQL
 * function webhook_capped_inboxes() (migration 20261024230000) enforces it;
 * this mirrors it for the API error and the dashboard.
 */
export const MAX_WEBHOOK_WATCHED_INBOXES = 25;

/** Mask a URL for members who may not see it whole: scheme and host, the path hidden. */
export function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hidden = parsed.pathname !== '/' || parsed.search !== '';
    return `${parsed.protocol}//${parsed.host}/${hidden ? '…' : ''}`;
  } catch {
    return 'https://…';
  }
}

/**
 * How many of the workspace's live inboxes its enabled endpoints cover (the
 * union). Above MAX_WEBHOOK_WATCHED_INBOXES, the newest ones are not watched.
 */
export function coveredInboxCount(
  inboxIds: string[],
  endpoints: Array<{ inbox_ids: string[] | null; disabled_at: string | null }>,
): number {
  const enabled = endpoints.filter((e) => e.disabled_at === null);
  if (enabled.some((e) => e.inbox_ids === null)) return inboxIds.length;
  const live = new Set(inboxIds);
  return new Set(enabled.flatMap((e) => e.inbox_ids ?? []).filter((id) => live.has(id))).size;
}

export const PLAN_REQUIRED_BODY = {
  error: 'Webhooks are part of the Pro and Business plans.',
  error_code: 'plan_required',
  upgrade_url: '/pricing',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * `inboxIds` from a request body: null (every inbox, including later ones) or
 * a non-empty list of distinct inbox ids that all belong to the workspace.
 */
export async function validateInboxIds(
  service: SupabaseClient<Database>,
  workspaceId: string,
  raw: unknown,
): Promise<{ ok: true; value: string[] | null } | { ok: false; error: string; code: 'inbox_invalid' | 'inbox_cap' }> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Choose at least one inbox, or all inboxes.', code: 'inbox_invalid' };
  }
  if (raw.length > 200 || !raw.every(isUuid)) return { ok: false, error: 'Invalid inbox ID in selection.', code: 'inbox_invalid' };
  const ids = [...new Set(raw.map((id) => id.toLowerCase()))];
  if (ids.length > MAX_WEBHOOK_WATCHED_INBOXES) {
    return {
      ok: false,
      error: `Webhooks watch up to ${MAX_WEBHOOK_WATCHED_INBOXES} inboxes per workspace. Choose ${MAX_WEBHOOK_WATCHED_INBOXES} or fewer.`,
      code: 'inbox_cap',
    };
  }
  const { data, error } = await service
    .from('inboxes')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .in('id', ids);
  if (error) return { ok: false, error: 'Could not check the inbox selection.', code: 'inbox_invalid' };
  if ((data ?? []).length !== ids.length) {
    return { ok: false, error: 'One or more inboxes are not in this workspace.', code: 'inbox_invalid' };
  }
  return { ok: true, value: ids };
}
