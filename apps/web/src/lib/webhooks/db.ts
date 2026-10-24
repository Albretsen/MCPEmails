import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database as GeneratedDatabase } from '@/types/database.types';

/**
 * Typed access to the two webhook tables (migration 20261024180000).
 *
 * WHY A HAND-WRITTEN SCHEMA HERE. `src/types/database.types.ts` is generated
 * from the linked production project (`npm run gen:types`) and is never edited
 * by hand. These tables do not exist there until the migration is applied, so
 * the generated `Database` cannot type them yet. Rather than `as any`, the
 * routes view the same client through this narrow schema, which lists exactly
 * the columns the migration creates. After the migration is applied and the
 * types are regenerated, the extension below and `webhookDb` can go.
 */

export type WebhookPayloadMode = 'ids' | 'headers';
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export type WebhookEndpointRow = {
  id: string;
  workspace_id: string;
  url: string;
  secret_ciphertext: string;
  secret_prefix: string;
  inbox_ids: string[] | null;
  events: string[];
  payload_mode: WebhookPayloadMode;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  disabled_reason: 'manual' | 'failing' | null;
  consecutive_failures: number;
  failing_since: string | null;
  last_success_at: string | null;
};

export type WebhookDeliveryRow = {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_id: string;
  event_type: 'message.received' | 'ping';
  inbox_id: string | null;
  message_ids: string[] | null;
  message_count: number;
  attempt: number;
  status: WebhookDeliveryStatus;
  response_code: number | null;
  error_code: string | null;
  next_attempt_at: string | null;
  lease_id: string | null;
  leased_until: string | null;
  created_at: string;
  last_attempt_at: string | null;
  delivered_at: string | null;
};

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: [];
};

type GeneratedPublic = GeneratedDatabase['public'];

/**
 * The generated schema plus the two webhook tables. Every other table keeps
 * its generated type; only these two are described by hand (see the header).
 */
export type Database = Omit<GeneratedDatabase, 'public'> & {
  public: Omit<GeneratedPublic, 'Tables'> & {
    Tables: GeneratedPublic['Tables'] & {
      webhook_endpoints: Table<WebhookEndpointRow, 'workspace_id' | 'url' | 'secret_ciphertext' | 'secret_prefix'>;
      webhook_deliveries: Table<WebhookDeliveryRow, 'endpoint_id' | 'workspace_id' | 'event_id' | 'event_type'>;
    };
  };
};

/**
 * The same client, viewed through the extended schema. Takes the request's
 * user client or the service-role client; RLS and grants are whatever that
 * client already carries.
 */
export function webhookDb(client: { from: unknown; rpc: unknown }): SupabaseClient<Database> {
  return client as unknown as SupabaseClient<Database>;
}

/** Columns a browser session may read (the migration's column grant): never the secret. */
export const ENDPOINT_PUBLIC_COLUMNS =
  'id, workspace_id, url, secret_prefix, inbox_ids, events, payload_mode, created_by, created_at, updated_at, disabled_at, disabled_reason, consecutive_failures, failing_since, last_success_at';

export const DELIVERY_PUBLIC_COLUMNS =
  'id, endpoint_id, workspace_id, event_id, event_type, inbox_id, message_count, attempt, status, response_code, error_code, next_attempt_at, created_at, last_attempt_at, delivered_at';

/** Per workspace. */
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
