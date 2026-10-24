import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { planCategory } from '@/lib/analytics/billing-funnel';

/**
 * The dashboard's Invite page, as funnel rows: `referral_link_viewed` when the
 * link was on screen, `referral_link_copied` when Copy was pressed. The other
 * eight referral stages are written on the server by the referral routes.
 *
 * AT MOST ONE ROW PER WORKSPACE, STAGE AND UTC DAY. The page is one people
 * reopen, so counting renders would measure page views; "how many workspaces
 * looked at their link, and on how many days" is the question. The dedupe is a
 * read-then-insert and can race to two rows under a double click; analysis
 * counts DISTINCT workspace_id, so that costs nothing.
 *
 * The browser sends only which of two actions happened. The plan on the row is
 * read from the database. Written straight to the table rather than through
 * recordProductFunnelEvent so this file does not widen that helper's stage
 * union, which the referral server routes also extend.
 */
export const REFERRAL_LINK_ACTIONS = ['viewed', 'copied'] as const;
export type ReferralLinkAction = (typeof REFERRAL_LINK_ACTIONS)[number];

export function parseReferralLinkAction(value: unknown): ReferralLinkAction | null {
  return (REFERRAL_LINK_ACTIONS as readonly unknown[]).includes(value)
    ? (value as ReferralLinkAction)
    : null;
}

export function referralLinkStage(action: ReferralLinkAction): 'referral_link_viewed' | 'referral_link_copied' {
  return action === 'viewed' ? 'referral_link_viewed' : 'referral_link_copied';
}

/** Midnight UTC of `now`, as an ISO string: the dedupe window's start. */
export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function recordReferralLinkEvent(
  db: SupabaseClient<Database>,
  workspaceId: string | null,
  action: ReferralLinkAction,
  now: Date = new Date(),
): Promise<void> {
  if (!workspaceId) return;
  const stage = referralLinkStage(action);
  const { data: existing, error: lookupError } = await db
    .from('product_funnel_events')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('stage', stage)
    .gte('occurred_at', utcDayStart(now))
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    console.error('[referral-link] dedupe lookup failed', { error: lookupError.message });
    return;
  }
  if (existing) return;
  const { data: ws } = await db.from('workspaces').select('plan').eq('id', workspaceId).maybeSingle();
  const { error } = await db.from('product_funnel_events').insert({
    workspace_id: workspaceId,
    stage,
    outcome: 'success',
    category: planCategory(ws?.plan),
  });
  if (error) console.error('[referral-link] event insert failed', { stage, error: error.message });
}
