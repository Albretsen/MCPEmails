// ---------------------------------------------------------------------------
// Webhook delivery: the second consumer of the new-mail watcher.
//
// TWO STEPS, so a slow receiver never holds a mailbox check.
//
//   ENQUEUE (inside checkWatch, ../push/dispatch.ts). When a check finds new
//   mail, `enqueueArrival` asks whether any endpoint covers the inbox, reads
//   the new message ids (the same list read the push "rich" notification
//   uses, no body bytes) and inserts one pending delivery per endpoint in one
//   statement. No HTTP request is made here. It runs BEFORE the cursor is
//   stored, and the event id is derived from the inbox and the two cursors
//   (`eventIdFor`), so a pass that dies after enqueueing re-detects the same
//   arrival next time and the insert is a no-op (unique endpoint_id +
//   event_id): no lost event, no duplicate.
//
//   SEND (`runSends`, after the checks of the pass, with its own time
//   budget). Leases due deliveries, first attempts before retries, and POSTs
//   them. Rows the enqueue step read are reused for `headers` payloads; a
//   retry from an earlier pass reads them again, but only through the
//   per-provider and per-host caps, and not at all while the inbox's watch
//   is backing off or its login was refused: then the event goes out with
//   ids only and `headers_omitted: true`.
//
// RETRIES at 1 min, 5 min, 30 min, 2 h, 6 h and 24 h after the previous
// attempt (7 in all). AUTO-DISABLE after 24 hours of failure or 50 failures
// in a row; the owner is emailed once (`onEndpointDisabled`).
//
// PAUSED. A workspace whose plan no longer allows webhooks enqueues nothing
// (the SQL checks) and its due deliveries are abandoned with `paused`.
//
// PAYLOAD (`ids`, the default):
//   { id, type: "message.received", created_at, workspace_id, inbox_id,
//     folder: "INBOX", count, message_ids: [...] }
// `headers` adds `messages: [{ id, from, subject }]`. The ids are the ones
// the MCP tools take (`email_read`).
//
// PRIVACY. Payload bodies exist in memory only. The log gets ids, counts,
// status codes and error CODES; the store gets message ids for a pending
// delivery only (see the migration).
// ---------------------------------------------------------------------------

import { loginRefusedAt, REFUSAL_WINDOW_MS } from "../mail/health.ts";
import type { NewestRow, WatchMail, WatchTarget } from "../push/mail.ts";
import { EVENT_ID_HEADER, EVENT_TYPE_HEADER, SIGNATURE_HEADER, signatureHeader } from "./sign.ts";
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
/** Rows read on a `headers` send to find sender and subject for the stored ids. */
const SEND_NEWEST_ROWS = 20;
export const DELIVERY_LEASE_SECONDS = 120;
/** POSTs in flight at once in the send step. */
export const SEND_CONCURRENCY = 4;
/** Deliveries leased per round, and rounds per pass. */
export const SEND_BATCH = 8;
export const SEND_ROUNDS = 6;
/** The send step's own budget: no new POST starts after this. Each POST has its own 10 s deadline. */
export const SEND_BUDGET_MS = 30_000;

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

/** Rows the enqueue step read, by inbox, for the send step of the same pass. In memory only. */
export type RowsCache = Map<string, NewestRow[]>;

export interface SendReport {
  leased: number;
  delivered: number;
  failed: number;
  abandoned: number;
  disabled: number;
}

/**
 * Caps on the mailbox reads of the send step: the same per-provider and
 * per-host limits the checks use (dispatch.ts passes its constants).
 */
export interface ReadLimits {
  providerConcurrency: Record<string, number>;
  hostConcurrency: number;
  providerKey: (provider: string) => string;
}

/** When to try again after `attemptsMade` attempts failed, or null when that was the last. */
export function nextAttemptAt(attemptsMade: number, nowMs: number): number | null {
  const delay = RETRY_DELAYS_MS[attemptsMade - 1];
  return delay === undefined ? null : nowMs + delay;
}

/**
 * `evt_` + 32 hex of SHA-256(inbox id, previous cursor, new cursor). The same
 * arrival seen twice (the cursor was not stored) gets the same id, so the
 * enqueue inserts nothing the second time and a receiver can dedupe on it.
 */
export async function eventIdFor(inboxId: string, previousFingerprint: string, nextFingerprint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`message.received\n${inboxId}\n${previousFingerprint}\n${nextFingerprint}`),
  );
  let hex = "";
  for (const b of new Uint8Array(digest).subarray(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `evt_${hex}`;
}

export interface MessageReceivedInput {
  eventId: string;
  createdAt: string;
  workspaceId: string;
  inboxId: string;
  count: number;
  mode: WebhookPayloadMode;
  messageIds: string[];
  /**
   * Sender and subject by id, `headers` mode only. Undefined in headers mode
   * means they could not be read: the event says so (`headers_omitted`).
   */
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
    if (input.headers) {
      event.messages = ids.map((id) => {
        const h = input.headers?.get(id);
        return { id, from: h?.from ?? null, subject: h?.subject ?? null };
      });
    } else {
      event.headers_omitted = true;
    }
  }
  return JSON.stringify(event);
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
 * The webhook half of an arrival: enqueue only, no HTTP request. Returns how
 * many deliveries were created. Never throws.
 */
export async function enqueueArrival(
  deps: WebhookDeps,
  input: {
    watch: WatchTarget;
    eventId: string;
    count: number;
    /** Gmail history named the added ids; null for IMAP and Outlook. */
    addedIds: string[] | null;
    newRows: () => Promise<NewestRow[]>;
    pick: (rows: NewestRow[], max: number) => WebhookMessage[];
    /** Filled with the rows read, for the send step of this pass. */
    rowsCache?: RowsCache;
  },
): Promise<number> {
  const log = deps.log ?? (() => {});
  try {
    if (!await deps.store.hasTargets(input.watch.inbox_id)) return 0;
    // The mailbox is read only now that somebody asked for this inbox.
    const rows = await input.newRows().catch(() => [] as NewestRow[]);
    if (rows.length > 0) input.rowsCache?.set(input.watch.inbox_id, rows);
    let picked = input.pick(rows, MAX_EVENT_MESSAGES);
    if (picked.length === 0 && input.addedIds) {
      picked = input.addedIds.slice(0, MAX_EVENT_MESSAGES).map((id) => ({ id, from: "", subject: "" }));
    }
    return await deps.store.enqueue({
      inboxId: input.watch.inbox_id,
      eventId: input.eventId,
      messageIds: picked.map((m) => m.id),
      messageCount: input.count,
    });
  } catch (error) {
    log("webhook_enqueue_failed", {
      inbox_id: input.watch.inbox_id,
      workspace_id: input.watch.workspace_id,
      error_name: error instanceof Error ? error.name : "error",
    });
    return 0;
  }
}

/** Waits for a free slot per provider and per IMAP host. */
function readGate(limits: ReadLimits) {
  const perProvider = new Map<string, number>();
  const perHost = new Map<string, number>();
  const waiting: Array<() => void> = [];
  const fits = (provider: string, host: string | null) =>
    (perProvider.get(provider) ?? 0) < (limits.providerConcurrency[provider] ?? 1) &&
    (host === null || (perHost.get(host) ?? 0) < limits.hostConcurrency);
  return async <T>(rawProvider: string, mailHost: string | null, work: () => Promise<T>): Promise<T> => {
    const provider = limits.providerKey(rawProvider);
    const host = provider === "imap" && mailHost ? mailHost.toLowerCase() : null;
    while (!fits(provider, host)) await new Promise<void>((resolve) => waiting.push(resolve));
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
    if (host) perHost.set(host, (perHost.get(host) ?? 0) + 1);
    try {
      return await work();
    } finally {
      perProvider.set(provider, perProvider.get(provider)! - 1);
      if (host) perHost.set(host, perHost.get(host)! - 1);
      for (const wake of waiting.splice(0)) wake();
    }
  };
}

/**
 * Send due deliveries, first attempts before retries, until the deadline.
 * Leases a small batch per round so nothing is held that this pass will not
 * reach. Never throws.
 */
export async function runSends(
  deps: WebhookDeps,
  mail: WatchMail | null,
  options: { deadlineMs: number; rowsCache?: RowsCache; limits: ReadLimits },
): Promise<SendReport> {
  const report: SendReport = { leased: 0, delivered: 0, failed: 0, abandoned: 0, disabled: 0 };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const gate = readGate(options.limits);
  const reads = new Map<string, Promise<Map<string, { from: string; subject: string }> | undefined>>();

  /** Sender and subject for a headers payload, or undefined when they must not or could not be read. */
  const headersFor = (delivery: LeasedDelivery) => {
    const inboxId = delivery.inbox_id!;
    const cached = options.rowsCache?.get(inboxId);
    if (cached) return Promise.resolve(headerMap(cached));
    if (!mail || !delivery.provider) return Promise.resolve(undefined);
    const at = now();
    const backoff = delivery.backoff_until ? Date.parse(delivery.backoff_until) : NaN;
    if (Number.isFinite(backoff) && backoff > at) return Promise.resolve(undefined);
    const refused = loginRefusedAt(delivery.inbox_last_error);
    if (refused !== null && at - refused < REFUSAL_WINDOW_MS) return Promise.resolve(undefined);
    let read = reads.get(inboxId);
    if (!read) {
      read = gate(delivery.provider, delivery.mail_host, () =>
        mail.newest({ inbox_id: inboxId, workspace_id: delivery.workspace_id, provider: delivery.provider! }, SEND_NEWEST_ROWS)
      ).then(headerMap, () => undefined);
      reads.set(inboxId, read);
    }
    return read;
  };

  for (let round = 0; round < SEND_ROUNDS && now() < options.deadlineMs; round++) {
    let batch: LeasedDelivery[];
    try {
      batch = await deps.store.leaseDue(SEND_BATCH, DELIVERY_LEASE_SECONDS);
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
        headers: delivery.payload_mode === "headers"
          ? ids.length > 0 ? await headersFor(delivery) : new Map()
          : undefined,
      });
      const result = await attemptOne(deps, delivery, delivery.attempt, delivery.event_id, body);
      if (result.outcome === "delivered") report.delivered++;
      else report.failed++;
      if (result.disabled) report.disabled++;
    });
    if (batch.length < SEND_BATCH) break;
  }
  return report;
}
