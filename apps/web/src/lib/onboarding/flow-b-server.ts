/**
 * The server half of onboarding Flow B (flow-b.mjs has the rules): builds the
 * one `flowB` prop that /onboarding and the dashboard Overview receive.
 * Server only.
 *
 * Null for everyone outside the convert arm, and for any workspace not on
 * Free, so the control arm and every paying customer get exactly the page
 * they had and no extra query beyond the variant they already read.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import type { ActionAllowance } from '@/lib/usage/allowance';
import type { StripePricesMap } from '@/lib/stripe/getPrices';
import { PLANS } from '@/lib/stripe/plans';
import { summaryPrice } from './flow-b.mjs';

type Db = SupabaseClient<Database>;

export interface FlowBProp {
  plan: 'free';
  createdAt: string | null;
  firstCallAt: string | null;
  summaryDismissedAt: string | null;
  graceNoteSeenAt: string | null;
  graceEndsAt: string | null;
  inGrace: boolean;
  freeCap: number | null;
  triedSecondInbox: boolean;
  inboxCaps: { free: number | null; personal: number | null; solo: number | null };
  prices: {
    personal: { monthlyCents: number; yearlyCents: number | null } | null;
    solo: { monthlyCents: number; yearlyCents: number | null } | null;
  };
}

/**
 * Did this workspace already try to add a second inbox? The inbox cap panel
 * (`paywall_reached` with connection_type first_connect), a press on the
 * dashboard's multi-inbox invitation, or a press on the onboarding card.
 * A failed read is false: the card then recommends nothing rather than guess.
 */
export async function triedSecondInbox(db: Db, workspaceId: string): Promise<boolean> {
  const { data, error } = await db
    .from('product_funnel_events')
    .select('stage')
    .eq('workspace_id', workspaceId)
    .or('and(stage.eq.paywall_reached,connection_type.eq.first_connect),and(stage.eq.multi_inbox_prompt,outcome.eq.success),stage.eq.second_inbox_prompt_clicked')
    .limit(1);
  if (error) {
    console.error('[flow-b] second inbox read failed', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

export async function buildFlowBProp(input: {
  db: Db;
  convert: 'on' | 'off' | string | null | undefined;
  plan: string | null | undefined;
  workspace: {
    id: string;
    created_at?: string | null;
    analytics_first_tool_used_at?: string | null;
    plan_summary_dismissed_at?: string | null;
    grace_end_note_seen_at?: string | null;
  };
  allowance: ActionAllowance | null;
  stripePrices: StripePricesMap | null;
}): Promise<FlowBProp | null> {
  if (input.convert !== 'on' || input.plan !== 'free') return null;
  const { workspace, allowance } = input;
  return {
    plan: 'free',
    createdAt: workspace.created_at ?? null,
    firstCallAt: workspace.analytics_first_tool_used_at ?? null,
    summaryDismissedAt: workspace.plan_summary_dismissed_at ?? null,
    graceNoteSeenAt: workspace.grace_end_note_seen_at ?? null,
    graceEndsAt: allowance?.grace_ends_at ?? null,
    inGrace: allowance?.in_grace === true,
    freeCap: allowance && !allowance.exempt ? (allowance.monthly.cap ?? null) : null,
    triedSecondInbox: await triedSecondInbox(input.db, workspace.id),
    inboxCaps: {
      free: PLANS.free.limits.maxInboxes ?? null,
      personal: PLANS.personal.limits.maxInboxes ?? null,
      solo: PLANS.solo.limits.maxInboxes ?? null,
    },
    prices: {
      personal: summaryPrice(input.stripePrices, 'personal'),
      solo: summaryPrice(input.stripePrices, 'solo'),
    },
  };
}
