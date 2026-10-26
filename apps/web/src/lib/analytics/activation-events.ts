import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { recordProductFunnelEvent, type ProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { safeDiagnosticPhase } from '@/lib/email/connection-config';
import type { AuthFailureReason } from '@/lib/email/auth-failure';
import { ONBOARDING_CLIENTS } from '@/lib/onboarding/state';

/**
 * Activation-rescue funnel rows the dashboard reports from the browser.
 *
 * The connect fix panel and the "waiting for your first call" state are UI
 * only, so the server never sees them happen. These four stages are the whole
 * vocabulary the browser may write through POST /api/analytics/activation-event;
 * every other stage stays server-observed.
 *
 *   connect_fix_shown         the per-provider fix panel was shown after a failed
 *                             connect. category = provider; auth_reason and
 *                             phase copied from the failure it explains.
 *   connect_fix_link_clicked  a link in that panel was opened. category = provider.
 *   first_call_prompt_copied  a suggested first prompt was copied. category = client.
 *   waiting_state_shown       the "waiting for your first call" state was shown.
 *                             category = client.
 *   install_link_clicked      a one-click install button (Add to Claude, Add to
 *                             Cursor, Install in VS Code; lib/clients/install-links.mjs)
 *                             was clicked. category = client.
 *
 * Every row is outcome 'success' with no error_category. The workspace always
 * comes from the session, never from the request body.
 *
 * Keep the stage list in step with the CHECK in
 * supabase/migrations/20261024233717_activation_rescue_stages.sql and
 * 20261026203517_install_link_clicked_stage.sql.
 */
export const ACTIVATION_EVENT_STAGES = [
  'connect_fix_shown',
  'connect_fix_link_clicked',
  'first_call_prompt_copied',
  'waiting_state_shown',
  'install_link_clicked',
] as const;
export type ActivationEventStage = (typeof ACTIVATION_EVENT_STAGES)[number];

/** Providers a connect can be filed under (same list as onboarding provider_selected). */
export const ACTIVATION_PROVIDERS = [
  'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex', 'generic_imap', 'unknown',
] as const;
export type ActivationProvider = (typeof ACTIVATION_PROVIDERS)[number];

/** Every member of AuthFailureReason. The `satisfies` keeps the two in step. */
export const ACTIVATION_AUTH_REASONS = [
  'imap_disabled', 'app_password_required', 'account_password_used', 'app_password_length',
  'provider_refused_signin', 'login_username_required', 'password_rejected',
] as const satisfies readonly AuthFailureReason[];

const PROVIDER_STAGES = new Set<ActivationEventStage>(['connect_fix_shown', 'connect_fix_link_clicked']);

export type ActivationEvent = {
  stage: ActivationEventStage;
  category: ProductFunnelEvent['category'];
  authReason: AuthFailureReason | null;
  phase: string | null;
};

function member<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Narrow an untrusted request body to one event, or null.
 *
 * Body: `{ stage, provider?, client?, auth_reason?, phase? }`. The connect_fix_*
 * stages need `provider`, the other two `client`, each from its closed list.
 * auth_reason and phase are kept only on the connect_fix_* stages and only when
 * they are known values; anything else becomes null rather than a refusal, so a
 * panel shown for a new reason still counts.
 */
export function parseActivationEvent(body: unknown): ActivationEvent | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const stage = member(ACTIVATION_EVENT_STAGES, input.stage);
  if (!stage) return null;
  if (PROVIDER_STAGES.has(stage)) {
    const provider = member(ACTIVATION_PROVIDERS, input.provider);
    if (!provider) return null;
    return {
      stage,
      category: provider,
      authReason: member(ACTIVATION_AUTH_REASONS, input.auth_reason),
      phase: safeDiagnosticPhase(input.phase),
    };
  }
  const client = member(ONBOARDING_CLIENTS, input.client);
  if (!client) return null;
  return { stage, category: client, authReason: null, phase: null };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * How long one identical row suppresses the next. waiting_state_shown sits on a
 * page people reload, so it is once per workspace per day: the question is
 * whether a workspace saw it, not how often. The others are real actions; a
 * short window only absorbs double clicks and re-renders, so "fix shown, then
 * a second failure, then fix shown again" still writes two rows.
 */
export const ACTIVATION_DEDUPE_WINDOW_MS: Record<ActivationEventStage, number> = {
  connect_fix_shown: 2 * MINUTE,
  connect_fix_link_clicked: 2 * MINUTE,
  first_call_prompt_copied: 2 * MINUTE,
  waiting_state_shown: DAY,
  install_link_clicked: 2 * MINUTE,
};

/** Hard ceiling per workspace per stage per rolling day, whatever the browser sends. */
export const ACTIVATION_DAILY_CAP = 50;

export type RecordResult = 'recorded' | 'deduped' | 'capped' | 'lookup_failed';

/**
 * Write one row unless an identical one (same stage, category and, for the fix
 * panel, the same reason) landed inside the stage's window, or the workspace
 * already hit the daily cap for the stage. Read-then-insert, so a true race can
 * write two rows; analysis counts distinct workspaces, so that costs nothing.
 */
export async function recordActivationEvent(
  db: SupabaseClient<Database>,
  workspaceId: string,
  event: ActivationEvent,
  now: Date = new Date(),
): Promise<RecordResult> {
  const windowStart = new Date(now.getTime() - ACTIVATION_DEDUPE_WINDOW_MS[event.stage]).toISOString();
  let dedupe = db
    .from('product_funnel_events')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('stage', event.stage)
    .eq('category', event.category)
    .gte('occurred_at', windowStart);
  if (event.stage === 'connect_fix_shown') {
    dedupe = event.authReason ? dedupe.eq('auth_reason', event.authReason) : dedupe.is('auth_reason', null);
  }
  const { data: recent, error: dedupeError } = await dedupe.limit(1).maybeSingle();
  if (dedupeError) {
    console.error('[activation-events] dedupe lookup failed', { stage: event.stage, error: dedupeError.message });
    return 'lookup_failed';
  }
  if (recent) return 'deduped';

  const dayStart = new Date(now.getTime() - DAY).toISOString();
  const { count, error: countError } = await db
    .from('product_funnel_events')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('stage', event.stage)
    .gte('occurred_at', dayStart);
  if (countError) {
    console.error('[activation-events] cap lookup failed', { stage: event.stage, error: countError.message });
    return 'lookup_failed';
  }
  if ((count ?? 0) >= ACTIVATION_DAILY_CAP) return 'capped';

  await recordProductFunnelEvent(db, {
    workspaceId,
    stage: event.stage,
    outcome: 'success',
    category: event.category,
    authReason: event.authReason,
    phase: event.phase ?? undefined,
  });
  return 'recorded';
}

export type ActivationRequestDeps = {
  /** The signed-in user's id, or null. */
  userId: () => Promise<string | null>;
  /** The active workspace for that user, membership already checked. */
  workspaceId: (userId: string) => Promise<string | null>;
  /** Service-role client the row is written with. */
  db: () => SupabaseClient<Database>;
};

/**
 * The route body, separated from Next so it can be tested. Returns the status
 * to answer with: 401 signed out, 400 for anything outside the closed lists,
 * 404 with no workspace, 204 otherwise (also when deduped or capped, which the
 * browser has no use for knowing).
 */
export async function handleActivationEventRequest(body: unknown, deps: ActivationRequestDeps): Promise<number> {
  const event = parseActivationEvent(body);
  if (!event) return 400;
  const userId = await deps.userId();
  if (!userId) return 401;
  const workspaceId = await deps.workspaceId(userId);
  if (!workspaceId) return 404;
  await recordActivationEvent(deps.db(), workspaceId, event);
  return 204;
}
