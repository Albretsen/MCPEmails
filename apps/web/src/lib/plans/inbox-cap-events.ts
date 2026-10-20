import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Database } from '@/types/database.types';
import type { InboxLimitCheckResult } from '@/lib/plans/check-inbox-limit';

/**
 * Log a Pro inbox-cap hit as a `usage_limit_events` row (limit_kind
 * 'inboxes', migration 20261019150000).
 *
 * WHY ONLY PRO. The 10-inbox Pro cap is new and carries a kill rule: if more
 * than 40% of the first 20 capped buyers neither buy Business nor stay on Pro
 * within 14 days, the cap comes off (docs/sql/pro-cap-readout.sql). That
 * read-out needs every hit, measured rather than guessed. The Free and
 * Personal caps are old and already measured through product_funnel_events;
 * logging them here too would flood a table whose other readers mean "the
 * action cap refused a call".
 *
 * Called where a hit is known: the five connect routes when they refuse a new
 * inbox, and the inbox paywall beacon when the connect modal shows the offer.
 * One attempt can therefore write two rows (the modal's gate, then a stale
 * 402); the read-out counts workspaces, not rows.
 *
 * Never throws and never blocks: a failed analytics write must not turn a
 * clean refusal into an error.
 */
export function shouldRecordInboxCapHit(result: InboxLimitCheckResult): boolean {
  return result.atLimit && result.plan === 'solo' && result.maxInboxes != null;
}

export async function recordInboxCapHit(
  workspaceId: string | null | undefined,
  result: InboxLimitCheckResult,
  db?: SupabaseClient<Database>,
): Promise<void> {
  if (!workspaceId || !shouldRecordInboxCapHit(result)) return;
  try {
    const client = db ?? createServiceRoleClient();
    const { error } = await client.rpc('record_inbox_cap_event', {
      p_workspace_id: workspaceId,
      p_plan: result.plan,
      p_inbox_count: result.currentCount,
      p_cap: result.maxInboxes as number,
    });
    if (error) {
      console.error('[inbox-cap] record failed', { error: error.message });
    }
  } catch (err) {
    console.error('[inbox-cap] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
