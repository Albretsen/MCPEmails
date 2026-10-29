import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { planCategory } from '@/lib/analytics/billing-funnel';

/**
 * The dashboard's "add your other work mailboxes" invitation, as funnel rows.
 * Shown to business-domain workspaces only (see MultiInboxInvite in
 * components/dashboard/Pages.jsx).
 *
 * TWO ROWS AT MOST PER WORKSPACE: one `started` (the invitation was actually
 * in the viewport; the browser waits for an IntersectionObserver before it
 * reports) and one `success` (it was clicked). Which of the two placements was
 * clicked is on the connect modal's own rows, in `entry_point`. The prompt sits on a page people reload, so
 * counting renders would measure page views, not exposure; the question this
 * answers is "of the workspaces that saw it, how many clicked, and how many of
 * those went on to connect a second mailbox or buy", which wants workspaces.
 * The dedupe is a read-then-insert and can race to two rows under a double
 * click; analysis counts DISTINCT workspace_id, so that costs nothing.
 *
 * The browser sends only which of the two actions happened, from a closed
 * list. The plan on the row is read from the database, like paywall_reached.
 */
export const MULTI_INBOX_PROMPT_ACTIONS = ['shown', 'clicked'] as const;
export type MultiInboxPromptAction = (typeof MULTI_INBOX_PROMPT_ACTIONS)[number];

export function parseMultiInboxPromptAction(value: unknown): MultiInboxPromptAction | null {
  return (MULTI_INBOX_PROMPT_ACTIONS as readonly unknown[]).includes(value)
    ? (value as MultiInboxPromptAction)
    : null;
}

export function multiInboxPromptOutcome(action: MultiInboxPromptAction): 'started' | 'success' {
  return action === 'shown' ? 'started' : 'success';
}

export async function recordMultiInboxPrompt(
  db: SupabaseClient<Database>,
  workspaceId: string | null,
  action: MultiInboxPromptAction,
): Promise<void> {
  if (!workspaceId) return;
  const outcome = multiInboxPromptOutcome(action);
  const { data: existing, error: lookupError } = await db
    .from('product_funnel_events')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('stage', 'multi_inbox_prompt')
    .eq('outcome', outcome)
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    console.error('[multi-inbox-prompt] dedupe lookup failed', { error: lookupError.message });
    return;
  }
  if (existing) return;
  const { data: ws } = await db.from('workspaces').select('plan').eq('id', workspaceId).maybeSingle();
  await recordProductFunnelEvent(db, {
    workspaceId,
    stage: 'multi_inbox_prompt',
    outcome,
    category: planCategory(ws?.plan),
  });
}
