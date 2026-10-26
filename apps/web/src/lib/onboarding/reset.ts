/**
 * Settings > "Reset onboarding", internal accounts only. Server only.
 *
 * Clears this workspace's onboarding and first-use markers so the /onboarding
 * flow (and the MCP server's first-call detection, which only stamps markers
 * that are NULL: markFirstProductUse in supabase/functions/mcp-server) can be
 * run again. Stamps onboarding_reset_at, which the status API uses to ignore
 * older handshakes, credentials, inboxes and failed calls.
 *
 * It deletes nothing: inboxes, API keys, connector grants, activity and
 * funnel history all stay. The flow copes with an inbox that is still
 * connected (flow.ts hasReusableInbox).
 *
 * Internal accounts are excluded from every growth read-out, so rewinding
 * their analytics_first_* columns cannot move a customer number.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';

type Db = SupabaseClient<Database>;
type WorkspaceUpdate = Database['public']['Tables']['workspaces']['Update'];

/** The exact columns a reset writes. Pure, so the test can pin the list. */
export function onboardingResetPatch(nowIso: string): WorkspaceUpdate {
  return {
    onboarding_reset_at: nowIso,
    onboarding_completed_at: null,
    // onboarding_stage is NOT NULL; 'started' is the first value of its CHECK.
    onboarding_stage: 'started',
    onboarding_client: null,
    onboarding_provider: null,
    onboarding_started_at: null,
    onboarding_client_selected_at: null,
    onboarding_inbox_connected_at: null,
    onboarding_connection_verified_at: null,
    onboarding_credential_issued_at: null,
    onboarding_technical_activated_at: null,
    onboarding_value_activated_at: null,
    analytics_first_tool_used_at: null,
    analytics_first_tool_name: null,
    analytics_first_tool_provider: null,
    analytics_first_tool_client: null,
    analytics_first_tool_path: null,
    analytics_first_tool_reported_at: null,
    analytics_first_inbox_connected_at: null,
    analytics_first_inbox_provider: null,
    analytics_first_credential_created_at: null,
    analytics_first_credential_method: null,
    // Flow B (WP-H): the plan summary and the grace-end note come back too.
    plan_summary_dismissed_at: null,
    grace_end_note_seen_at: null,
  };
}

/**
 * Apply the reset. `db` must be the service role: public.workspaces is not
 * writable by a user's session (20261016160100). The caller checks that the
 * user is an internal account and the workspace's owner.
 */
export async function resetOnboarding(db: Db, workspaceId: string, now: Date = new Date()): Promise<{ ok: boolean; resetAt: string }> {
  const resetAt = now.toISOString();
  const { error } = await db.from('workspaces').update(onboardingResetPatch(resetAt)).eq('id', workspaceId);
  if (error) {
    console.error('[onboarding] reset failed', { workspace_id: workspaceId, error: error.message });
    return { ok: false, resetAt };
  }
  return { ok: true, resetAt };
}
