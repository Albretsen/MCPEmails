// ---------------------------------------------------------------------------
// Webhook delivery: the second consumer of the new-mail watcher.
//
// FIRST ATTEMPT. When `checkWatch` (../push/dispatch.ts) finds new mail in an
// inbox, `deliverArrival` asks whether any endpoint covers it, reads the new
// message ids (and, for a `headers` endpoint, sender and subject; never body
// bytes) through the same read the push "rich" notification uses, enqueues
// one delivery per endpoint in one statement (leased to this pass) and POSTs
// each one at once.
//
// RETRIES. A failed attempt is scheduled 1 min, 5 min, 30 min, 2 h, 6 h and
// 24 h after the previous one (7 attempts in all). `runRetries` sends the due
// ones from the same per-minute dispatch pass, inside its time budget.
//
// AUTO-DISABLE. An endpoint that has failed for 24 hours, or 50 times in a
// row, is disabled and its pending deliveries abandoned; the owner is emailed
// once (`onEndpointDisabled`). Re-enabling is a dashboard action.
//
// PAUSED. A workspace whose plan no longer allows webhooks enqueues nothing
// (the SQL does the check) and its due retries are abandoned with `paused`.
//
// PAYLOAD (`ids`, the default):
//   { id, type: "message.received", created_at, workspace_id, inbox_id,
//     folder: "INBOX", count, message_ids: [...] }
// `headers` adds `messages: [{ id, from, subject }]`. The ids are the ones
// the MCP tools take (`email_read`), so the receiver fetches the body with
// its own key and that key's scopes and inbox pins still apply.
//
// PRIVACY. Payload bodies exist in memory only. The log gets ids, counts,
// status codes and error CODES; the store gets message ids for a pending
// delivery only (see the migration).
// ---------------------------------------------------------------------------

import type { NewestRow, WatchMail, WatchTarget } from "../push/mail.ts";
import { EVENT_ID_HEADER, EVENT_TYPE_HEADER, newEventId, SIGNATURE_HEADER, signatureHeader } from "./sign.ts";
import type { EnqueuedDelivery, LeasedDelivery, WebhookPayloadMode, WebhookStore } from "./store.ts";
import type { WebhookTransport } from "./transport.ts";

/** Delay before attempt n+1, after attempt n failed (index n-1). Seven attempts in all. */
export const RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Disable an endpoint after this many failed attempts in a row... */
export const DISABLE_AFTER_FAILURES = 50;
/** ...or when its current run of failures is this old. */
export const DISABLE_AFTER_FAILING_MS = 24 * 60 * 60_000;
/** Message ids listed in one event; the count may be higher. */
export const MAX_EVENT_MESSAGES = 10;
/** Rows read to find the new ones (the push read uses 10 too). */
const NEWEST_ROWS = 10;
/** Rows read on a `headers` retry to find sender and subject for the stored ids. */
const RETRY_NEWEST_ROWS = 20;
export const DELIVERY_LEASE_SECONDS = 120;
/** POSTs in flight at once, per arrival and for the retry step. */
export const SEND_CONCURRENCY = 4;
/** Retries leased per round, and rounds per pass. */
export const RETRY_BATCH = 8;
export const RETRY_ROUNDS = 5;

export interface WebhookDeps {
  store: WebhookStore;
  transport: WebhookTransport;
  /** Decrypts `secret_ciphertext` (secret.ts). */
  decrypt: (ciphertext: string) => Promise<string>;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** An attempt just disabled this endpoint: tell the owner. Best effort. */
  onEndpointDisabled?: (endpointId: string, workspaceId: string) => Promise<void>;
}

export interface WebhookMessage {
  id: string;
  from: string;
  subject: string;
}

export interface ArrivalReport {
  enqueued: number;
  delivered: number;
  failed: number;
  disabled: number;
}

export interface RetryReport {
  leased: number;
  delivered: number;
  failed: number;
  abandoned: number;
  disabled: number;
}

/** When to try again after `attemptsMade` attempts failed, or null when that was the last. */
export function nextAttemptAt(attemptsMade: number, nowMs: number): number | null {
  const delay = RETRY_DELAYS_MS[attemptsMade - 1];
  return delay === undefined ? null : nowMs + delay;
}

export interface MessageReceivedInput {
  eventId: string;
  createdAt: string;
  workspaceId: string;
  inboxId: string;
  count: number;
  mode: WebhookPayloadMode;
  messageIds: string[];
  /** Sender and subject by id, `headers` mode only. */
  headers?: Map<string, { from: string; subject: string }>;
}

export function messageReceivedBody(input: MessageReceivedInput): string {
  const ids = input.messageIds.slice(0, MAX_EVENT_MESSAGES);
  const event: Record<string, unknown> = {
    id: input.eventId,
    type: "message.received",
    created_at: input.createdAt,
    workspace_id: input.workspaceId,
    inbox_id: input.inboxId,
    folder: "INBOX",
    count: Math.max(input.count, ids.length),
    message_ids: ids,
  };
  if (input.mode === "headers") {
    event.messages = ids.map((id) => {
      const h = input.headers?.get(id);
      return { id, from: h?.from ?? null, subject: h?.subject ?? null };
    });
  }
  return JSON.stringify(event);
}

export function pingBody(input: { eventId: string; createdAt: string; workspaceId: string; endpointId: string }): string {
  return JSON.stringify({
    id: input.eventId,
    type: "ping",
    created_at: input.createdAt,
    workspace_id: input.workspaceId,
    endpoint_id: input.endpointId,
  });
}

async function inChunks<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += size) await Promise.all(items.slice(at, at + size).map(work));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type AttemptOutcome = "delivered" | "failed" | "lost";

/** Sign, POST, record. Never throws. */
async function attemptOne(
  deps: WebhookDeps,
  delivery: EnqueuedDelivery,
  attemptsBefore: number,
  eventId: string,
  body: string,
): Promise<{ outcome: AttemptOutcome; disabled: boolean }> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const started = now();
  let ok = false;
  let responseCode: number | null = null;
  let errorCode: string | null = null;
  try {
    const secret = await deps.decrypt(delivery.secret_ciphertext);
    const response = await deps.transport.post({
      url: delivery.url,
      body,
      headers: {
        [SIGNATURE_HEADER]: await signatureHeader(secret, Math.floor(now() / 1000), body),
        [EVENT_ID_HEADER]: eventId,
        [EVENT_TYPE_HEADER]: "message.received",
      },
    });
    if (response.kind === "response") {
      responseCode = response.status;
      ok = response.status >= 200 && response.status < 300;
      if (!ok) errorCode = response.status >= 300 && response.status < 400 ? "redirect" : "http_status";
    } else {
      errorCode = response.code;
    }
  } catch {
    errorCode = "internal_error";
  }
  const attemptsMade = attemptsBefore + 1;
  const next = ok ? null : nextAttemptAt(attemptsMade, now());
  let recorded: { endpointId: string; endpointDisabled: boolean } | null = null;
  try {
    recorded = await deps.store.recordAttempt({
      deliveryId: delivery.delivery_id,
      leaseId: delivery.lease_id,
      ok,
      responseCode,
      errorCode,
      nextAt: next === null ? null : iso(next),
      maxFailures: DISABLE_AFTER_FAILURES,
      maxFailingSeconds: DISABLE_AFTER_FAILING_MS / 1000,
    });
  } catch {
    recorded = null;
  }
  log("webhook_attempt", {
    delivery_id: delivery.delivery_id,
    endpoint_id: delivery.endpoint_id,
    workspace_id: delivery.workspace_id,
    attempt: attemptsMade,
    outcome: ok ? "delivered" : next === null ? "failed_final" : "failed",
    ...(responseCode !== null ? { response_code: responseCode } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ms: now() - started,
  });
  const disabled = recorded?.endpointDisabled === true;
  if (disabled) {
    log("webhook_endpoint_disabled", { endpoint_id: delivery.endpoint_id, workspace_id: delivery.workspace_id });
    await deps.onEndpointDisabled?.(delivery.endpoint_id, delivery.workspace_id).catch(() => {});
  }
  if (recorded === null) return { outcome: "lost", disabled };
  return { outcome: ok ? "delivered" : "failed", disabled };
}

function headerMap(rows: NewestRow[]): Map<string, { from: string; subject: string }> {
  return new Map(rows.map((r) => [r.id, { from: r.from, subject: r.subject }]));
}

/**
 * The webhook half of an arrival. `newRows` reads the newest inbox rows (the
 * dispatcher shares one read between push and webhooks); `pick` chooses the
 * new ones among them. Never throws.
 */
export async function deliverArrival(
  deps: WebhookDeps,
  input: {
    watch: WatchTarget;
    count: number;
    /** Gmail history named the added ids; null for IMAP and Outlook. */
    addedIds: string[] | null;
    newRows: () => Promise<NewestRow[]>;
    pick: (rows: NewestRow[], max: number) => WebhookMessage[];
  },
): Promise<ArrivalReport> {
  const report: ArrivalReport = { enqueued: 0, delivered: 0, failed: 0, disabled: 0 };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  try {
    if (!await deps.store.hasTargets(input.watch.inbox_id)) return report;
    // The mailbox is read only now that somebody asked for this inbox.
    const rows = await input.newRows().catch(() => [] as NewestRow[]);
    let picked = input.pick(rows, MAX_EVENT_MESSAGES);
    if (picked.length === 0 && input.addedIds) {
      picked = input.addedIds.slice(0, MAX_EVENT_MESSAGES).map((id) => ({ id, from: "", subject: "" }));
    }
    const eventId = newEventId();
    const deliveries = await deps.store.enqueue({
      inboxId: input.watch.inbox_id,
      eventId,
      messageIds: picked.map((m) => m.id),
      messageCount: input.count,
      leaseSeconds: DELIVERY_LEASE_SECONDS,
    });
    report.enqueued = deliveries.length;
    const headers = headerMap(rows);
    await inChunks(deliveries, SEND_CONCURRENCY, async (delivery) => {
      const body = messageReceivedBody({
        eventId,
        createdAt: new Date(Date.parse(delivery.created_at) || now()).toISOString(),
        workspaceId: delivery.workspace_id,
        inboxId: input.watch.inbox_id,
        count: input.count,
        mode: delivery.payload_mode,
        messageIds: picked.map((m) => m.id),
        headers,
      });
      const result = await attemptOne(deps, delivery, 0, eventId, body);
      if (result.outcome === "delivered") report.delivered++;
      else report.failed++;
      if (result.disabled) report.disabled++;
    });
  } catch (error) {
    log("webhook_enqueue_failed", {
      inbox_id: input.watch.inbox_id,
      workspace_id: input.watch.workspace_id,
      error_name: error instanceof Error ? error.name : "error",
    });
  }
  return report;
}

/**
 * Send due retries until the deadline. Leases a small batch per round so
 * nothing is held that this pass will not reach. Never throws.
 */
export async function runRetries(
  deps: WebhookDeps,
  mail: WatchMail | null,
  options: { deadlineMs: number },
): Promise<RetryReport> {
  const report: RetryReport = { leased: 0, delivered: 0, failed: 0, abandoned: 0, disabled: 0 };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const headerReads = new Map<string, Promise<Map<string, { from: string; subject: string }>>>();
  const headersFor = (delivery: LeasedDelivery) => {
    if (!mail || !delivery.inbox_id || !delivery.provider) return Promise.resolve(new Map());
    let read = headerReads.get(delivery.inbox_id);
    if (!read) {
      read = mail.newest(
        { inbox_id: delivery.inbox_id, workspace_id: delivery.workspace_id, provider: delivery.provider },
        RETRY_NEWEST_ROWS,
      ).then(headerMap, () => new Map());
      headerReads.set(delivery.inbox_id, read);
    }
    return read;
  };

  for (let round = 0; round < RETRY_ROUNDS && now() < options.deadlineMs; round++) {
    let batch: LeasedDelivery[];
    try {
      batch = await deps.store.leaseDue(RETRY_BATCH, DELIVERY_LEASE_SECONDS);
    } catch (error) {
      log("webhook_lease_failed", { error_name: error instanceof Error ? error.name : "error" });
      break;
    }
    report.leased += batch.length;
    if (batch.length === 0) break;
    await inChunks(batch, SEND_CONCURRENCY, async (delivery) => {
      const abandon = !delivery.endpoint_enabled
        ? "endpoint_disabled"
        : !delivery.plan_allowed
        ? "paused"
        : !delivery.inbox_id
        ? "inbox_removed"
        : delivery.attempt >= MAX_ATTEMPTS
        ? "attempts_exhausted"
        : null;
      if (abandon) {
        await deps.store.recordAttempt({
          deliveryId: delivery.delivery_id,
          leaseId: delivery.lease_id,
          ok: false,
          responseCode: null,
          errorCode: null,
          nextAt: null,
          maxFailures: DISABLE_AFTER_FAILURES,
          maxFailingSeconds: DISABLE_AFTER_FAILING_MS / 1000,
          abandonCode: abandon,
        }).catch(() => null);
        report.abandoned++;
        return;
      }
      const ids = delivery.message_ids ?? [];
      const body = messageReceivedBody({
        eventId: delivery.event_id,
        createdAt: new Date(delivery.created_at).toISOString(),
        workspaceId: delivery.workspace_id,
        inboxId: delivery.inbox_id!,
        count: delivery.message_count,
        mode: delivery.payload_mode,
        messageIds: ids,
        headers: delivery.payload_mode === "headers" && ids.length > 0 ? await headersFor(delivery) : undefined,
      });
      const result = await attemptOne(deps, delivery, delivery.attempt, delivery.event_id, body);
      if (result.outcome === "delivered") report.delivered++;
      else report.failed++;
      if (result.disabled) report.disabled++;
    });
    if (batch.length < RETRY_BATCH) break;
  }
  return report;
}
