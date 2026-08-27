import type { SupabaseClient } from '@supabase/supabase-js';
import { safeDiagnosticPhase } from '@/lib/email/connection-config';

/**
 * Persist a server-observed funnel fact. The vocabulary is deliberately small
 * and category-only, so this is useful for product analysis without becoming a
 * second audit log or storing mailbox/credential data.
 */
/** Plan+interval a checkout targeted. Never a Stripe price id or amount. */
export type BillingTargetCategory =
  | 'personal_month' | 'personal_year' | 'solo_month' | 'solo_year' | 'pro_month' | 'pro_year';
/** The plan a user was on when a paywall / portal event fired. */
export type BillingPlanCategory = 'free' | 'personal' | 'solo' | 'pro';
/** Where a signed-in user saw the plans. */
export type PricingSurfaceCategory = 'pricing_page' | 'dashboard_billing';

export type ProductFunnelEvent = {
  workspaceId: string;
  stage:
    | 'onboarding_started' | 'client_selected' | 'provider_selected' | 'inbox_connection'
    | 'connection_verified' | 'credential_created' | 'technical_activation' | 'value_activation'
    | 'paywall_reached' | 'pricing_viewed' | 'checkout_started' | 'checkout_completed'
    | 'billing_portal_opened';
  outcome: 'started' | 'success' | 'failure';
  category:
    | 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic_imap'
    | 'api_key' | 'oauth' | 'claude' | 'chatgpt' | 'cursor' | 'vscode' | 'cline' | 'windsurf'
    | 'gemini' | 'zed' | 'jetbrains' | 'raycast' | 'warp' | 'curl' | 'unknown'
    | BillingTargetCategory | BillingPlanCategory | PricingSurfaceCategory;
  errorCategory?:
    | 'auth_failed' | 'validation_failed' | 'provider_denied' | 'token_exchange_failed'
    | 'plan_limit' | 'conflict' | 'persistence_failed' | 'unknown'
    | 'price_not_configured' | 'subscription_exists' | 'stripe_error' | 'no_customer';
  /** Coarse protocol phase only; never a host, address, credential, or response. */
  phase?: string;
  connectionType?: 'first_connect' | 'reconnect';
};

export async function recordProductFunnelEvent(db: SupabaseClient, event: ProductFunnelEvent): Promise<void> {
  // Generated database types can lag migrations; this server-only table is
  // intentionally cast locally rather than weakening the application client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = (db as any).from('product_funnel_events');
  const { error } = await table.insert({
    workspace_id: event.workspaceId,
    stage: event.stage,
    outcome: event.outcome,
    category: event.category,
    error_category: event.errorCategory ?? null,
    phase: safeDiagnosticPhase(event.phase),
    connection_type: event.connectionType ?? null,
  });
  if (error) {
    console.error('[product-funnel] event insert failed', { stage: event.stage, outcome: event.outcome, error: error.message });
    return;
  }

  if (event.outcome !== 'success') return;
  const now = new Date().toISOString();
  const marker = event.stage === 'inbox_connection'
    ? { analytics_first_inbox_connected_at: now, analytics_first_inbox_provider: event.category, onboarding_inbox_connected_at: now, onboarding_provider: event.category, onboarding_stage: 'inbox_connected' }
    : event.stage === 'credential_created'
      ? { analytics_first_credential_created_at: now, analytics_first_credential_method: event.category, onboarding_credential_issued_at: now, onboarding_stage: 'credential_issued' }
      : null;
  const markerColumn = event.stage === 'inbox_connection'
    ? 'analytics_first_inbox_connected_at'
    : event.stage === 'credential_created' ? 'analytics_first_credential_created_at' : null;
  if (!marker || !markerColumn) return;
  const { error: markerError } = await db.from('workspaces').update(marker).eq('id', event.workspaceId).is(markerColumn, null);
  if (markerError) console.error('[product-funnel] marker update failed', { stage: event.stage, error: markerError.message });
}

/** Record an OAuth callback failure using only its unguessable, single-use state. */
export async function recordOAuthCallbackFailure(
  db: SupabaseClient,
  state: string | null,
  provider: 'gmail' | 'outlook',
  errorCategory: 'provider_denied' | 'unknown'
): Promise<void> {
  if (!state) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const states = (db as any).from('oauth_states');
  const { data } = await states.select('id, workspace_id').eq('state', state).eq('provider', provider).maybeSingle();
  if (!data?.workspace_id) return;
  await recordProductFunnelEvent(db, { workspaceId: data.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: provider, errorCategory, phase: 'authorization' });
  // A denial/error terminally consumes the state just like a successful callback.
  await states.delete().eq('id', data.id);
}
