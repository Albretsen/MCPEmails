import type { Database } from '@/types/database.types';

/**
 * Shared shapes of the webhook routes (migration 20261024230000). Row types
 * come from the generated schema.
 */

export type WebhookEndpointRow = Database['public']['Tables']['webhook_endpoints']['Row'];
export type WebhookEndpointUpdate = Database['public']['Tables']['webhook_endpoints']['Update'];

/** Columns the routes return: never the secret. */
export const ENDPOINT_PUBLIC_COLUMNS =
  'id, workspace_id, url, secret_prefix, inbox_ids, events, payload_mode, created_by, created_at, updated_at, disabled_at, disabled_reason, consecutive_failures, failing_since, last_success_at';

/** Columns a browser session may read on deliveries (the migration's column grant). */
export const DELIVERY_PUBLIC_COLUMNS =
  'id, endpoint_id, workspace_id, event_id, event_type, inbox_id, message_count, attempt, status, response_code, error_code, next_attempt_at, created_at, last_attempt_at, delivered_at';

/** Per workspace. Mirrors the webhook_endpoints_limit trigger. */
export const MAX_WEBHOOK_ENDPOINTS = 10;
export const DELIVERY_LOG_LIMIT = 100;

export type PublicEndpoint = Omit<WebhookEndpointRow, 'secret_ciphertext'>;

/** The API shape of one endpoint. camelCase, like /api/api-keys. */
export function endpointJson(row: PublicEndpoint) {
  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    inboxIds: row.inbox_ids,
    events: row.events,
    payloadMode: row.payload_mode,
    createdBy: row.created_by,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
  };
}
