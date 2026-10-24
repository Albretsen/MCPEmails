// ---------------------------------------------------------------------------
// The webhook dispatcher's database access, behind one interface (the same
// split as ../push/store.ts). Tables and functions: migration
// 20261024180000_webhook_endpoints. Service role only.
// ---------------------------------------------------------------------------

export type WebhookPayloadMode = "ids" | "headers";

/** A delivery created for this pass's first attempt, already leased to it. */
export interface EnqueuedDelivery {
  delivery_id: string;
  lease_id: string;
  endpoint_id: string;
  workspace_id: string;
  url: string;
  secret_ciphertext: string;
  payload_mode: WebhookPayloadMode;
  created_at: string;
}

/** A due retry, leased to this pass. */
export interface LeasedDelivery extends EnqueuedDelivery {
  event_id: string;
  inbox_id: string | null;
  provider: string | null;
  message_ids: string[] | null;
  message_count: number;
  /** Attempts made BEFORE this one. */
  attempt: number;
  endpoint_enabled: boolean;
  plan_allowed: boolean;
}

export interface AttemptRecord {
  deliveryId: string;
  leaseId: string;
  ok: boolean;
  responseCode: number | null;
  errorCode: string | null;
  /** ISO time of the next attempt; null = no more attempts. */
  nextAt: string | null;
  maxFailures: number;
  maxFailingSeconds: number;
  /** Abandon instead of recording an attempt (paused plan, disabled endpoint). */
  abandonCode?: string;
}

export interface WebhookStore {
  /** Does any enabled, plan-allowed endpoint cover this inbox? Decides whether the mailbox is read at all. */
  hasTargets(inboxId: string): Promise<boolean>;
  enqueue(input: {
    inboxId: string;
    eventId: string;
    messageIds: string[];
    messageCount: number;
    leaseSeconds: number;
  }): Promise<EnqueuedDelivery[]>;
  leaseDue(limit: number, leaseSeconds: number): Promise<LeasedDelivery[]>;
  /** Null when the lease no longer held the row (nothing was written). */
  recordAttempt(record: AttemptRecord): Promise<{ endpointId: string; endpointDisabled: boolean } | null>;
}

// deno-lint-ignore no-explicit-any
type Db = any;

function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}:${error?.code ?? "error"}`);
}

export function supabaseWebhookStore(db: Db): WebhookStore {
  return {
    async hasTargets(inboxId) {
      const { data, error } = await db.rpc("webhook_has_targets", { p_inbox_id: inboxId });
      if (error) fail("webhook_targets_failed", error);
      return data === true;
    },

    async enqueue(input) {
      const { data, error } = await db.rpc("webhook_enqueue_event", {
        p_inbox_id: input.inboxId,
        p_event_id: input.eventId,
        p_message_ids: input.messageIds,
        p_message_count: input.messageCount,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error) fail("webhook_enqueue_failed", error);
      return (data ?? []) as EnqueuedDelivery[];
    },

    async leaseDue(limit, leaseSeconds) {
      const { data, error } = await db.rpc("lease_webhook_deliveries", { p_limit: limit, p_lease_seconds: leaseSeconds });
      if (error) fail("webhook_lease_failed", error);
      return (data ?? []) as LeasedDelivery[];
    },

    async recordAttempt(record) {
      const { data, error } = await db.rpc("record_webhook_attempt", {
        p_delivery_id: record.deliveryId,
        p_lease_id: record.leaseId,
        p_ok: record.ok,
        p_response_code: record.responseCode,
        p_error_code: record.errorCode,
        p_next_at: record.nextAt,
        p_max_failures: record.maxFailures,
        p_max_failing_seconds: record.maxFailingSeconds,
        p_abandon_code: record.abandonCode ?? null,
      });
      if (error) fail("webhook_record_failed", error);
      const row = (Array.isArray(data) ? data[0] : data) as { endpoint_id?: string; endpoint_disabled?: boolean } | null;
      return row?.endpoint_id ? { endpointId: row.endpoint_id, endpointDisabled: row.endpoint_disabled === true } : null;
    },
  };
}
