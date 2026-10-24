// In-memory stand-ins for the webhook tests: the store (what the SQL
// functions in 20261024230000 do, in a few lines) and the transport.

import type { AttemptRecord, LeasedDelivery, WebhookPayloadMode, WebhookStore } from "../webhooks/store.ts";
import type { WebhookRequest, WebhookResponse, WebhookTransport } from "../webhooks/transport.ts";

export interface FakeEndpoint {
  id: string;
  workspace_id: string;
  url: string;
  secret_ciphertext: string;
  inbox_ids: string[] | null;
  payload_mode: WebhookPayloadMode;
  disabled_at: string | null;
  disabled_reason: string | null;
  consecutive_failures: number;
  failing_since: number | null;
  created_at: string;
}

export interface FakeDelivery {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_id: string;
  inbox_id: string | null;
  message_ids: string[] | null;
  message_count: number;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "abandoned";
  response_code: number | null;
  error_code: string | null;
  next_attempt_at: number | null;
  lease_id: string | null;
  leased_until: number | null;
  created_at: string;
}

export interface FakeWebhookStore extends WebhookStore {
  endpoints: FakeEndpoint[];
  deliveries: FakeDelivery[];
  /** Workspaces whose plan allows webhooks. */
  allowed: Set<string>;
  /** inbox id -> workspace id, provider and watch state, of live inboxes. */
  inboxes: Map<string, { workspace_id: string; provider: string; mail_host?: string | null; last_error?: string | null; backoff_until?: string | null }>;
  hasTargetsCalls: number;
  endpoint(row: Partial<FakeEndpoint> & { id: string; workspace_id: string }): FakeEndpoint;
}

export function fakeWebhookStore(now: () => number): FakeWebhookStore {
  let seq = 0;
  const covers = (e: FakeEndpoint, inboxId: string) => {
    const inbox = store.inboxes.get(inboxId);
    return inbox !== undefined && e.workspace_id === inbox.workspace_id && e.disabled_at === null &&
      (e.inbox_ids === null || e.inbox_ids.includes(inboxId)) && store.allowed.has(e.workspace_id);
  };
  const store: FakeWebhookStore = {
    endpoints: [],
    deliveries: [],
    allowed: new Set(),
    inboxes: new Map(),
    hasTargetsCalls: 0,
    endpoint(row) {
      const full: FakeEndpoint = {
        url: `https://hooks.receiver.example/${row.id}`,
        secret_ciphertext: `cipher:${row.id}`,
        inbox_ids: null,
        payload_mode: "ids",
        disabled_at: null,
        disabled_reason: null,
        consecutive_failures: 0,
        failing_since: null,
        created_at: new Date(now()).toISOString(),
        ...row,
      };
      store.endpoints.push(full);
      return full;
    },
    hasTargets(inboxId) {
      store.hasTargetsCalls++;
      return Promise.resolve(store.endpoints.some((e) => covers(e, inboxId)));
    },
    enqueue(input) {
      let inserted = 0;
      for (const e of store.endpoints.filter((x) => covers(x, input.inboxId))) {
        if (store.deliveries.some((d) => d.endpoint_id === e.id && d.event_id === input.eventId)) continue;
        store.deliveries.push({
          id: `dlv-${++seq}`,
          endpoint_id: e.id,
          workspace_id: e.workspace_id,
          event_id: input.eventId,
          inbox_id: input.inboxId,
          message_ids: input.messageIds.slice(0, 20),
          message_count: input.messageCount,
          attempt: 0,
          status: "pending",
          response_code: null,
          error_code: null,
          next_attempt_at: now(),
          lease_id: null,
          leased_until: null,
          created_at: new Date(now()).toISOString(),
        });
        inserted++;
      }
      return Promise.resolve(inserted);
    },
    leaseDue(limit, leaseSeconds) {
      const at = now();
      const due = store.deliveries
        .filter((d) => d.status === "pending" && d.next_attempt_at !== null && d.next_attempt_at <= at &&
          (d.leased_until === null || d.leased_until <= at))
        .sort((a, b) => Number(a.attempt > 0) - Number(b.attempt > 0) || a.next_attempt_at! - b.next_attempt_at!)
        .slice(0, limit);
      return Promise.resolve(due.map((d): LeasedDelivery => {
        d.lease_id = crypto.randomUUID();
        d.leased_until = at + leaseSeconds * 1000;
        const e = store.endpoints.find((x) => x.id === d.endpoint_id)!;
        return {
          delivery_id: d.id,
          lease_id: d.lease_id,
          endpoint_id: d.endpoint_id,
          workspace_id: d.workspace_id,
          event_id: d.event_id,
          inbox_id: d.inbox_id,
          provider: d.inbox_id ? store.inboxes.get(d.inbox_id)?.provider ?? null : null,
          mail_host: d.inbox_id ? store.inboxes.get(d.inbox_id)?.mail_host ?? null : null,
          inbox_last_error: d.inbox_id ? store.inboxes.get(d.inbox_id)?.last_error ?? null : null,
          backoff_until: d.inbox_id ? store.inboxes.get(d.inbox_id)?.backoff_until ?? null : null,
          message_ids: d.message_ids ? [...d.message_ids] : null,
          message_count: d.message_count,
          attempt: d.attempt,
          created_at: d.created_at,
          url: e.url,
          secret_ciphertext: e.secret_ciphertext,
          payload_mode: e.payload_mode,
          endpoint_enabled: e.disabled_at === null,
          plan_allowed: store.allowed.has(d.workspace_id),
        };
      }));
    },
    recordAttempt(r: AttemptRecord) {
      const d = store.deliveries.find((x) => x.id === r.deliveryId && x.lease_id === r.leaseId && x.status === "pending");
      if (!d) return Promise.resolve(null);
      const e = store.endpoints.find((x) => x.id === d.endpoint_id)!;
      const clear = () => Object.assign(d, { lease_id: null, leased_until: null });
      if (r.abandonCode) {
        Object.assign(d, { status: "abandoned", error_code: r.abandonCode, message_ids: null, next_attempt_at: null });
        clear();
        return Promise.resolve({ endpointId: e.id, endpointDisabled: false });
      }
      d.attempt++;
      d.response_code = r.responseCode;
      d.error_code = r.ok ? null : r.errorCode;
      d.status = r.ok ? "delivered" : r.nextAt === null ? "failed" : "pending";
      d.next_attempt_at = r.ok || r.nextAt === null ? null : Date.parse(r.nextAt);
      if (d.status !== "pending") d.message_ids = null;
      clear();
      let disabled = false;
      if (r.ok) {
        Object.assign(e, { consecutive_failures: 0, failing_since: null });
      } else {
        const since = e.failing_since ?? now();
        e.consecutive_failures++;
        e.failing_since = since;
        if (e.disabled_at === null && (e.consecutive_failures >= r.maxFailures || since <= now() - r.maxFailingSeconds * 1000)) {
          e.disabled_at = new Date(now()).toISOString();
          e.disabled_reason = "failing";
          disabled = true;
          for (const other of store.deliveries) {
            if (other.endpoint_id === e.id && other.status === "pending") {
              Object.assign(other, { status: "abandoned", error_code: "endpoint_disabled", message_ids: null, next_attempt_at: null });
            }
          }
        }
      }
      return Promise.resolve({ endpointId: e.id, endpointDisabled: disabled });
    },
  };
  return store;
}

export interface FakeTransport extends WebhookTransport {
  sent: WebhookRequest[];
  answer: (request: WebhookRequest) => WebhookResponse;
}

export function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    sent: [],
    answer: () => ({ kind: "response", status: 204 }),
    post(request) {
      t.sent.push(request);
      return Promise.resolve(t.answer(request));
    },
  };
  return t;
}

/** The fake "ciphertext" is `cipher:<endpoint id>`; the secret is derived from it. */
export const fakeDecrypt = (ciphertext: string) => Promise.resolve(`whsec_${ciphertext.replace("cipher:", "")}`);
