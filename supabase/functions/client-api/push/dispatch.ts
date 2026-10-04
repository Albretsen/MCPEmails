// ---------------------------------------------------------------------------
// POST /push/dispatch: one pass of the new-mail watcher.
//
// Caller: pg_cron -> dispatch_inbox_watch() -> pg_net (migration
// 20261005100200), once a minute while any mailbox is due. Authenticated by
// the X-Dispatch-Secret header and nothing else (../app.ts).
//
// One pass:
//   1. LEASE up to BATCH_SIZE due mailboxes (lease_inbox_watches: FOR UPDATE
//      SKIP LOCKED, so two passes never hold the same mailbox).
//   2. CHECK each one, a few at a time (caps per provider and per mail host),
//      until the time budget is spent. Mailboxes not reached are handed back
//      untouched and are first in line for the next pass.
//   3. For a mailbox whose inbox cursor shows NEW MAIL (push/notify.ts), load
//      who to tell, read the newest few rows only if somebody wants sender and
//      subject, encrypt one message per browser, send, and record what the
//      push services answered.
//   4. RELEASE each lease with the new cursor and the next check time, or
//      with a backoff when the check failed.
//
// THE "INBOX CHANGED" ENTRY POINT. Steps 2 to 4 for one mailbox are
// `checkWatch`. It is deliberately independent of how the pass learned that
// the mailbox is worth looking at: today that is the polling lease; a provider
// push (a Gmail Pub/Sub message, a Graph change notification) would lease that
// one mailbox and call the same function, and that provider's polling interval
// can then be stretched to a safety-net sweep. See `gmailPushStub` below.
//
// PRIVACY. What a check reads from a mailbox exists in this request's memory
// only. The database gets a cursor (numbers), timestamps and an error CODE.
// The log gets ids, the provider name, outcome words, counts and timings.
// ---------------------------------------------------------------------------

import { ApiError } from "../errors.ts";
import { loginRefusedAt, REFUSAL_WINDOW_MS } from "../mail/health.ts";
import type { NewestRow, WatchMail } from "./mail.ts";
import {
  type Arrival,
  buildNewMailPayload,
  counterArrival,
  detectArrival,
  inQuietHours,
  MAX_LISTED,
  type NewMessage,
  topicFor,
} from "./notify.ts";
import type { FolderCursor, LeasedWatch, PushResults, PushStore, Recipient, WatchResult } from "./store.ts";
import type { PushOutcome, PushSender } from "./webpush.ts";

/** Mailboxes one pass leases. Keep in step with c_batch in migration 20261005100200. */
export const BATCH_SIZE = 20;
/** Longer than the budget plus one check's timeout, so a live pass never loses its lease. */
export const LEASE_SECONDS = 120;
/** No new check starts after this much of the pass. Same figure as the triage runner. */
export const BUDGET_MS = 40_000;
/** One mailbox's check (probe, history, list) is abandoned after this long. */
export const CHECK_TIMEOUT_MS = 20_000;
/** Checks in flight at once, over all providers. */
export const MAX_CONCURRENCY = 6;
/** Checks in flight per provider. Graph allows one mailbox four concurrent requests; IMAP hosts dislike bursts of logins. */
export const PROVIDER_CONCURRENCY: Record<string, number> = { gmail: 6, outlook: 4, imap: 4 };
/** Checks in flight against one IMAP host. */
export const HOST_CONCURRENCY = 2;
/**
 * Time between checks of one mailbox. Cron ticks once a minute, so the value
 * is a number of ticks: API providers every tick, password (IMAP) mailboxes
 * every second tick, because each IMAP check is a full login.
 */
export const INTERVAL_MS: Record<string, number> = { gmail: 60_000, outlook: 60_000, imap: 120_000 };
/** Subtracted from the interval so a check that finished late in a tick is still due at the next one. */
export const TICK_SLACK_MS = 10_000;
/** A cursor older than this is not compared: the watcher was off, and what arrived meanwhile is not "new". */
export const STALE_CURSOR_MS = 6 * 60 * 60_000;
/** Backoff after a failed check: base * 2^(failures-1), up to the cap. */
export const BACKOFF = {
  provider: { baseMs: 2 * 60_000, capMs: 60 * 60_000 },
  reconnect: { baseMs: 15 * 60_000, capMs: 12 * 60 * 60_000 },
};
/** How long the push service holds a new-mail message for a device that is offline. */
export const NEW_MAIL_TTL_SEC = 12 * 60 * 60;
/** Push requests in flight for one mailbox's recipients. */
const SEND_CONCURRENCY = 6;
/** Rows read for a rich notification: enough to find MAX_LISTED new ones among them. */
const NEWEST_ROWS = 10;

export interface DispatchDeps {
  store: PushStore;
  mail: WatchMail;
  /** null when the VAPID secrets are not set: mailboxes are still checked, nothing is sent. */
  sender: PushSender | null;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Overrides, for tests. */
  budgetMs?: number;
  checkTimeoutMs?: number;
  batchSize?: number;
}

export interface DispatchSummary {
  leased: number;
  checked: number;
  /** New mail was found. */
  arrivals: number;
  /** Arrivals for which at least one push was accepted. */
  notified: number;
  pushes_sent: number;
  pushes_failed: number;
  subscriptions_gone: number;
  failed: number;
  skipped_reconnect: number;
  /** Leased but not reached inside the budget; handed back untouched. */
  deferred: number;
  ms: number;
}

type CheckOutcome =
  | "first"
  | "unchanged"
  | "changed"
  | "reset"
  | "new_mail"
  | "skipped_reconnect"
  | "failed";

interface CheckReport {
  outcome: CheckOutcome;
  errorCode?: string;
  recipients: number;
  sent: number;
  failed: number;
  gone: number;
}

function providerKey(provider: string): string {
  return provider === "gmail" || provider === "outlook" ? provider : "imap";
}

export function intervalFor(provider: string): number {
  return INTERVAL_MS[providerKey(provider)];
}

export function backoffMs(code: string, failures: number, provider: string): number {
  const policy = code === "reconnect_required" ? BACKOFF.reconnect : BACKOFF.provider;
  const base = Math.max(policy.baseMs, intervalFor(provider));
  return Math.min(base * 2 ** Math.max(0, Math.min(failures, 20) - 1), policy.capMs);
}

/** A CODE for the row and the log. Never an error's message: a provider can put an address in one. */
function errorCodeOf(error: unknown): string {
  if (error instanceof ApiError) return error.body.code;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "internal_error";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("check_timeout");
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function inChunks<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(...await Promise.all(items.slice(at, at + size).map(work)));
  }
  return out;
}

/** The new messages among the newest rows: by id when the provider named them, else the newest unread. */
export function pickNew(rows: NewestRow[], count: number, addedIds: string[] | null): NewMessage[] {
  const chosen = addedIds
    ? rows.filter((row) => addedIds.includes(row.id))
    : rows.filter((row) => row.unread).slice(0, count);
  return chosen.slice(0, MAX_LISTED).map(({ id, from, subject }) => ({ id, from, subject }));
}

async function notify(
  deps: DispatchDeps,
  watch: LeasedWatch,
  probe: { label: string; cursor: FolderCursor },
  count: number,
  addedIds: string[] | null,
  nowMs: number,
): Promise<Pick<CheckReport, "recipients" | "sent" | "failed" | "gone">> {
  const report = { recipients: 0, sent: 0, failed: 0, gone: 0 };
  const sender = deps.sender;
  if (!sender) return report;
  const everyone = await deps.store.recipients(watch.inbox_id);
  const recipients = everyone.filter((r) => !inQuietHours(r, nowMs));
  report.recipients = recipients.length;
  if (recipients.length === 0) return report;

  // The mailbox is read for sender and subject only when somebody asked for them.
  let messages: NewMessage[] = [];
  if (recipients.some((r) => r.payload_mode === "rich")) {
    const rows = await deps.mail.newest(watch, NEWEST_ROWS).catch(() => [] as NewestRow[]);
    messages = pickNew(rows, count, addedIds);
  }
  const payloadFor = (mode: Recipient["payload_mode"]) =>
    buildNewMailPayload({
      mode,
      inboxId: watch.inbox_id,
      mailboxLabel: probe.label,
      count,
      unread: probe.cursor.unread,
      messages,
    });
  const rich = payloadFor("rich");
  const plain = payloadFor("private");
  const topic = topicFor(watch.inbox_id);

  const results: PushResults = { sent: [], gone: [], failed: [] };
  await inChunks(recipients, SEND_CONCURRENCY, async (recipient) => {
    const message = {
      endpoint: recipient.endpoint,
      keys: { p256dh: recipient.p256dh, auth: recipient.auth },
      ttlSec: NEW_MAIL_TTL_SEC,
      // A second arrival before the device wakes REPLACES the first at the push service.
      topic,
      urgency: "normal" as const,
    };
    let outcome: PushOutcome = await sender.send({ ...message, payload: recipient.payload_mode === "rich" ? rich : plain });
    // Too large for this push service: the count-only message always fits.
    if (outcome.kind === "too_large") outcome = await sender.send({ ...message, payload: plain });
    if (outcome.kind === "sent") results.sent.push(recipient.subscription_id);
    else if (outcome.kind === "gone") results.gone.push(recipient.subscription_id);
    else results.failed.push(recipient.subscription_id);
  });
  report.sent = results.sent.length;
  report.gone = results.gone.length;
  report.failed = results.failed.length;
  await deps.store.recordPushResults(results).catch(() => {});
  return report;
}

/**
 * Check ONE leased mailbox and release its lease. The "inbox changed" entry
 * point: polling calls it for every leased row; a provider push would call it
 * for the one mailbox the provider named. Never throws.
 */
export async function checkWatch(deps: DispatchDeps, watch: LeasedWatch): Promise<CheckReport> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const report: CheckReport = { outcome: "unchanged", recipients: 0, sent: 0, failed: 0, gone: 0 };
  const release = (result: WatchResult) => deps.store.releaseWatch(watch.inbox_id, watch.lease_id, result).catch(() => {});

  // The row already says the mail server refused this mailbox's login a few
  // minutes ago (mail/health.ts): do not dial it again inside that window.
  const refusedAt = loginRefusedAt(watch.inbox_last_error);
  if (refusedAt !== null && startedAt - refusedAt < REFUSAL_WINDOW_MS) {
    report.outcome = "skipped_reconnect";
    report.errorCode = "reconnect_required";
    await release({
      folders: watch.folders,
      last_checked_at: watch.last_checked_at,
      next_check_at: iso(refusedAt + REFUSAL_WINDOW_MS),
      failure_count: watch.failure_count,
      backoff_until: iso(refusedAt + REFUSAL_WINDOW_MS),
      last_error_code: "reconnect_required",
    });
    return report;
  }

  try {
    const work = (async () => {
      const probe = await deps.mail.probe(watch);
      const stored = watch.folders["inbox"] ?? null;
      const age = watch.last_checked_at ? startedAt - Date.parse(watch.last_checked_at) : Infinity;
      const previous = stored && age <= STALE_CURSOR_MS ? stored : null;
      let arrival: Arrival = detectArrival(watch.provider, previous, probe.cursor);
      let addedIds: string[] | null = null;
      if (arrival.kind === "ask_history" && previous) {
        try {
          addedIds = await deps.mail.gmailAdded(watch, arrival.startHistoryId);
          arrival = addedIds === null
            ? { kind: "reset" }
            : addedIds.length > 0
            ? { kind: "new", count: addedIds.length }
            : { kind: "changed" };
        } catch (error) {
          if (error instanceof ApiError && error.body.code === "reconnect_required") throw error;
          // History could not answer: the label's counters still can.
          addedIds = null;
          arrival = counterArrival(previous, probe.cursor);
        }
      }
      return { probe, arrival, addedIds };
    })();
    const { probe, arrival, addedIds } = await withTimeout(work, deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS);

    let notifiedAt: string | undefined;
    if (arrival.kind === "new") {
      report.outcome = "new_mail";
      const sent = await notify(deps, watch, probe, arrival.count, addedIds, startedAt);
      Object.assign(report, sent);
      if (sent.sent > 0) notifiedAt = iso(now());
    } else {
      report.outcome = arrival.kind === "ask_history" ? "changed" : arrival.kind;
    }
    const moved = arrival.kind !== "unchanged" && arrival.kind !== "first";
    // Stored only AFTER the pushes went out: a pass that dies in between
    // repeats the notification (which the tag collapses) instead of losing it.
    await release({
      folders: { ...watch.folders, inbox: probe.cursor },
      last_checked_at: iso(startedAt),
      ...(moved ? { last_changed_at: iso(startedAt) } : {}),
      ...(notifiedAt ? { last_notified_at: notifiedAt } : {}),
      next_check_at: iso(startedAt + intervalFor(watch.provider) - TICK_SLACK_MS),
      failure_count: 0,
      backoff_until: null,
      last_error_code: null,
    });
  } catch (error) {
    const code = errorCodeOf(error);
    const failures = watch.failure_count + 1;
    const until = iso(now() + backoffMs(code, failures, watch.provider));
    report.outcome = "failed";
    report.errorCode = code;
    await release({
      // The cursor is kept: when the mailbox answers again, mail that arrived
      // during a short outage is still new (STALE_CURSOR_MS bounds "short").
      folders: watch.folders,
      last_checked_at: watch.last_checked_at,
      next_check_at: until,
      failure_count: failures,
      backoff_until: until,
      last_error_code: code.slice(0, 40),
    });
  }
  return report;
}

/** One pass. Never throws; the summary is counts only. */
export async function runDispatch(deps: DispatchDeps): Promise<DispatchSummary> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const startedAt = now();
  const budget = deps.budgetMs ?? BUDGET_MS;
  const summary: DispatchSummary = {
    leased: 0,
    checked: 0,
    arrivals: 0,
    notified: 0,
    pushes_sent: 0,
    pushes_failed: 0,
    subscriptions_gone: 0,
    failed: 0,
    skipped_reconnect: 0,
    deferred: 0,
    ms: 0,
  };

  let watches: LeasedWatch[];
  try {
    watches = await deps.store.leaseWatches(deps.batchSize ?? BATCH_SIZE, LEASE_SECONDS);
  } catch (error) {
    log("push_dispatch_failed", { stage: "lease", error_name: error instanceof Error ? error.name : "error" });
    summary.ms = now() - startedAt;
    return summary;
  }
  summary.leased = watches.length;

  const pending = [...watches];
  const perProvider = new Map<string, number>();
  const perHost = new Map<string, number>();
  let running = 0;

  const hostKey = (watch: LeasedWatch): string | null =>
    providerKey(watch.provider) === "imap" && watch.mail_host ? watch.mail_host.toLowerCase() : null;
  const eligible = (watch: LeasedWatch): boolean => {
    const provider = providerKey(watch.provider);
    if ((perProvider.get(provider) ?? 0) >= PROVIDER_CONCURRENCY[provider]) return false;
    const host = hostKey(watch);
    return host === null || (perHost.get(host) ?? 0) < HOST_CONCURRENCY;
  };
  const bump = (watch: LeasedWatch, by: number): void => {
    const provider = providerKey(watch.provider);
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + by);
    const host = hostKey(watch);
    if (host !== null) perHost.set(host, (perHost.get(host) ?? 0) + by);
    running += by;
  };

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (now() - startedAt >= budget) {
        // Out of time: what has not started is handed back and goes first next pass.
        summary.deferred += pending.length;
        for (const watch of pending.splice(0)) {
          void deps.store.releaseWatch(watch.inbox_id, watch.lease_id, {
            folders: watch.folders,
            last_checked_at: watch.last_checked_at,
            next_check_at: new Date(startedAt).toISOString(),
            failure_count: watch.failure_count,
            backoff_until: null,
            last_error_code: null,
          }).catch(() => {});
        }
      }
      while (running < MAX_CONCURRENCY) {
        const index = pending.findIndex(eligible);
        if (index === -1) break;
        const [watch] = pending.splice(index, 1);
        bump(watch, 1);
        const checkStarted = now();
        void checkWatch(deps, watch).then((report) => {
          summary.checked++;
          if (report.outcome === "new_mail") summary.arrivals++;
          if (report.outcome === "failed") summary.failed++;
          if (report.outcome === "skipped_reconnect") summary.skipped_reconnect++;
          if (report.sent > 0) summary.notified++;
          summary.pushes_sent += report.sent;
          summary.pushes_failed += report.failed;
          summary.subscriptions_gone += report.gone;
          if (report.outcome === "new_mail" || report.outcome === "failed") {
            log("push_watch", {
              inbox_id: watch.inbox_id,
              workspace_id: watch.workspace_id,
              provider: providerKey(watch.provider),
              outcome: report.outcome,
              ...(report.errorCode ? { error_code: report.errorCode } : {}),
              recipients: report.recipients,
              pushes_sent: report.sent,
              pushes_failed: report.failed,
              subscriptions_gone: report.gone,
              ms: now() - checkStarted,
            });
          }
        }).finally(() => {
          bump(watch, -1);
          pump();
        });
      }
      if (running === 0 && pending.length === 0) resolve();
    };
    pump();
  });

  await deps.mail.close().catch(() => {});
  summary.ms = now() - startedAt;
  log("push_dispatch", { ...summary });
  return summary;
}

/**
 * NOT BUILT: Gmail push (users.watch + Cloud Pub/Sub).
 *
 * What it needs that this repository cannot provide: a Google Cloud Pub/Sub
 * topic in the OAuth client's project, publish rights on it for
 * gmail-api-push@system.gserviceaccount.com, and a push subscription that
 * delivers to an HTTPS route here with an OIDC token to verify. Then:
 *   - `users.watch` per Gmail inbox (labelIds: ["INBOX"]) when it becomes
 *     watched, renewed at least every 7 days (a daily cron), `users.stop`
 *     when it stops being watched;
 *   - the webhook verifies Google's OIDC token, maps `emailAddress` to the
 *     inbox, leases THAT row and calls `checkWatch` (the historyId in the
 *     message is the cursor `gmailAdded` already understands);
 *   - INTERVAL_MS.gmail stretches to a safety-net sweep (say 15 minutes).
 * Until then this answers 501 for the route, so a misconfigured Pub/Sub
 * subscription is visibly not wired rather than silently accepted.
 */
export function gmailPushStub(): { status: 501; code: "not_implemented" } {
  return { status: 501, code: "not_implemented" };
}
