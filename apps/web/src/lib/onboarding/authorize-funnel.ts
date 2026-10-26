/**
 * The connector-first funnel on the OAuth consent screen (/authorize). Server
 * only. Migration 20261026232117_authorize_funnel_stages.sql.
 *
 *   authorize_signup_redirect     /authorize sent a signed-out visitor to
 *                                 /signup, and the NEW account it made came
 *                                 back (recorded by app/authorize/page.js; a
 *                                 visitor has no workspace before that)
 *   authorize_inbox_step_viewed   the inbox step was shown inside consent
 *   authorize_inbox_connected     an inbox was connected inside consent
 *   authorize_skipped             "Skip, connect later" was pressed
 *
 * At most one row per workspace and stage: a reload, a second consent or a
 * Back button never counts twice, so each stage reads as "workspaces that
 * reached it". category = the AI app's chip id, 'unknown' when not known.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { recordProductFunnelEvent, type ProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { normalizeOnboardingClient } from './state.ts';

type Db = SupabaseClient<Database>;

export const AUTHORIZE_FUNNEL_STAGES = [
  'authorize_signup_redirect',
  'authorize_inbox_step_viewed',
  'authorize_inbox_connected',
  'authorize_skipped',
] as const;
export type AuthorizeFunnelStage = (typeof AUTHORIZE_FUNNEL_STAGES)[number];

/** The stages the consent screen may report from the browser (POST /api/onboarding/authorize-event). */
export const BROWSER_AUTHORIZE_STAGES: readonly AuthorizeFunnelStage[] = [
  'authorize_inbox_step_viewed',
  'authorize_inbox_connected',
  'authorize_skipped',
];

export function isBrowserAuthorizeStage(value: unknown): value is AuthorizeFunnelStage {
  return typeof value === 'string' && (BROWSER_AUTHORIZE_STAGES as readonly string[]).includes(value);
}

/** The marker the signup redirect adds to the /authorize return path. */
export const SIGNUP_ENTRY_PARAM = 'mcpe_entry';
export const SIGNUP_ENTRY_VALUE = 'signup';

/** A workspace created less than `windowMs` ago (a bad or future date is not young). */
export function isYoungWorkspace(createdAt: string | null | undefined, windowMs: number, now: number = Date.now()): boolean {
  if (!createdAt) return false;
  const age = now - Date.parse(createdAt);
  return Number.isFinite(age) && age >= 0 && age < windowMs;
}

/**
 * Record `stage` for the workspace unless it already has one. Never throws;
 * returns whether a row was written.
 */
export async function recordAuthorizeFunnelOnce(
  db: Db,
  input: { workspaceId: string; stage: AuthorizeFunnelStage; client?: unknown },
): Promise<boolean> {
  try {
    const { data: existing, error } = await db
      .from('product_funnel_events')
      .select('id')
      .eq('workspace_id', input.workspaceId)
      .eq('stage', input.stage)
      .limit(1);
    if (error || (existing && existing.length > 0)) return false;
    const category = (normalizeOnboardingClient(input.client) ?? 'unknown') as ProductFunnelEvent['category'];
    await recordProductFunnelEvent(db, { workspaceId: input.workspaceId, stage: input.stage, outcome: 'success', category });
    return true;
  } catch (error) {
    console.error('[authorize-funnel] record failed', { stage: input.stage, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
