import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Persist a server-observed funnel fact. The vocabulary is deliberately small
 * and category-only, so this is useful for product analysis without becoming a
 * second audit log or storing mailbox/credential data.
 */
export type ProductFunnelEvent = {
  workspaceId: string;
  stage: 'inbox_connection' | 'credential_created';
  outcome: 'success' | 'failure';
  category: 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic_imap' | 'api_key' | 'oauth' | 'unknown';
  errorCategory?: 'auth_failed' | 'validation_failed' | 'provider_denied' | 'token_exchange_failed' | 'plan_limit' | 'conflict' | 'persistence_failed' | 'unknown';
};

export async function recordProductFunnelEvent(db: SupabaseClient, event: ProductFunnelEvent): Promise<void> {
  // Generated database types can lag migrations; this server-only table is
  // intentionally cast locally rather than weakening the application client.
  const table = (db as any).from('product_funnel_events');
  const { error } = await table.insert({
    workspace_id: event.workspaceId,
    stage: event.stage,
    outcome: event.outcome,
    category: event.category,
    error_category: event.errorCategory ?? null,
  });
  if (error) {
    console.error('[product-funnel] event insert failed', { stage: event.stage, outcome: event.outcome, error: error.message });
    return;
  }

  if (event.outcome !== 'success') return;
  const marker = event.stage === 'inbox_connection'
    ? { analytics_first_inbox_connected_at: new Date().toISOString(), analytics_first_inbox_provider: event.category }
    : { analytics_first_credential_created_at: new Date().toISOString(), analytics_first_credential_method: event.category };
  const markerColumn = event.stage === 'inbox_connection'
    ? 'analytics_first_inbox_connected_at'
    : 'analytics_first_credential_created_at';
  const { error: markerError } = await db.from('workspaces').update(marker).eq('id', event.workspaceId).is(markerColumn, null);
  if (markerError) console.error('[product-funnel] marker update failed', { stage: event.stage, error: markerError.message });
}
