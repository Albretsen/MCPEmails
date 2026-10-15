// In-memory stand-ins for the push tests: the store (what the SQL functions
// do, in a few lines), the mailbox reads, and the push service.

import type { NewestRow, ProbeResult, WatchMail, WatchTarget } from "../push/mail.ts";
import type {
  FolderCursor,
  LeasedWatch,
  PreferenceRow,
  PushResults,
  PushStore,
  Recipient,
  SubscriptionRow,
  WatchResult,
} from "../push/store.ts";
import { b64urlEncode, type PushMessage, type PushOutcome, type PushSender } from "../push/webpush.ts";

export interface WatchRow {
  inbox_id: string;
  workspace_id: string;
  provider: string;
  mail_host: string | null;
  folders: Record<string, FolderCursor>;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_notified_at: string | null;
  next_check_at: string;
  lease_id: string | null;
  leased_until: number | null;
  failure_count: number;
  backoff_until: string | null;
  last_error_code: string | null;
  inbox_last_error: string | null;
}

export interface FakePushStore extends PushStore {
  subs: Array<SubscriptionRow & { failure_count: number; last_success_at: string | null; user_agent: string | null }>;
  prefs: Map<string, PreferenceRow>;
  watches: WatchRow[];
  leases: number;
  releases: Array<{ inbox_id: string; applied: boolean; result: WatchResult }>;
  results: PushResults[];
  /** Add a watched mailbox that is due now. */
  watch(row: Partial<WatchRow> & { inbox_id: string }): WatchRow;
}

export function fakePushStore(now: () => number = () => Date.now(), workspaceId = "11111111-1111-4111-8111-111111111111"): FakePushStore {
  let seq = 0;
  const store: FakePushStore = {
    subs: [],
    prefs: new Map(),
    watches: [],
    leases: 0,
    releases: [],
    results: [],
    watch(row) {
      const full: WatchRow = {
        workspace_id: workspaceId,
        provider: "imap",
        mail_host: "imap.fake-server.example",
        folders: {},
        last_checked_at: null,
        last_changed_at: null,
        last_notified_at: null,
        next_check_at: new Date(now()).toISOString(),
        lease_id: null,
        leased_until: null,
        failure_count: 0,
        backoff_until: null,
        last_error_code: null,
        inbox_last_error: null,
        ...row,
      };
      store.watches.push(full);
      return full;
    },
    upsertSubscription(row) {
      const existing = store.subs.find((s) => s.endpoint === row.endpoint);
      if (existing) {
        Object.assign(existing, {
          user_id: row.userId,
          workspace_id: row.workspaceId,
          p256dh: row.p256dh,
          auth: row.auth,
          user_agent: row.userAgent,
          disabled_at: null,
          failure_count: 0,
        });
      } else {
        store.subs.push({
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          user_id: row.userId,
          workspace_id: row.workspaceId,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          user_agent: row.userAgent,
          disabled_at: null,
          failure_count: 0,
          last_success_at: null,
        });
      }
      return Promise.resolve();
    },
    countSubscriptions: (userId) => Promise.resolve(store.subs.filter((s) => s.user_id === userId).length),
    deleteSubscription(userId, endpoint) {
      const before = store.subs.length;
      store.subs = store.subs.filter((s) => !(s.user_id === userId && s.endpoint === endpoint));
      return Promise.resolve(before - store.subs.length);
    },
    subscriptions: (userId, ws) =>
      Promise.resolve(store.subs.filter((s) => s.user_id === userId && s.workspace_id === ws && s.disabled_at === null)),
    subscriptionByEndpoint: (endpoint) => Promise.resolve(store.subs.find((s) => s.endpoint === endpoint) ?? null),
    rotateSubscription(id, next) {
      const row = store.subs.find((s) => s.id === id);
      if (row) Object.assign(row, next, { disabled_at: null, failure_count: 0 });
      return Promise.resolve();
    },
    preferences: (userId, inboxIds) =>
      Promise.resolve(inboxIds.map((id) => store.prefs.get(`${userId}:${id}`)).filter((p): p is PreferenceRow => p !== undefined)),
    savePreferences(userId, rows) {
      for (const row of rows) store.prefs.set(`${userId}:${row.inbox_id}`, { ...row });
      return Promise.resolve();
    },
    leaseWatches(limit) {
      store.leases++;
      const at = now();
      const due = store.watches
        .filter((w) =>
          Date.parse(w.next_check_at) <= at &&
          (w.backoff_until === null || Date.parse(w.backoff_until) <= at) &&
          (w.leased_until === null || w.leased_until <= at)
        )
        .sort((a, b) => a.next_check_at.localeCompare(b.next_check_at))
        .slice(0, limit);
      return Promise.resolve(due.map((w): LeasedWatch => {
        w.lease_id = crypto.randomUUID();
        w.leased_until = at + 120_000;
        return {
          inbox_id: w.inbox_id,
          workspace_id: w.workspace_id,
          provider: w.provider,
          mail_host: w.mail_host,
          lease_id: w.lease_id,
          folders: structuredClone(w.folders),
          last_checked_at: w.last_checked_at,
          failure_count: w.failure_count,
          inbox_last_error: w.inbox_last_error,
        };
      }));
    },
    releaseWatch(inboxId, leaseId, result) {
      const row = store.watches.find((w) => w.inbox_id === inboxId);
      const applied = row !== undefined && row.lease_id === leaseId;
      store.releases.push({ inbox_id: inboxId, applied, result });
      if (row && applied) Object.assign(row, result, { lease_id: null, leased_until: null });
      return Promise.resolve();
    },
    recipients(inboxId) {
      const watch = store.watches.find((w) => w.inbox_id === inboxId);
      const out: Recipient[] = [];
      for (const s of store.subs) {
        if (s.disabled_at !== null || (watch && s.workspace_id !== watch.workspace_id)) continue;
        const pref = store.prefs.get(`${s.user_id}:${inboxId}`);
        if (pref && !pref.enabled) continue;
        out.push({
          subscription_id: s.id,
          user_id: s.user_id,
          endpoint: s.endpoint,
          p256dh: s.p256dh,
          auth: s.auth,
          payload_mode: pref?.payload_mode ?? "rich",
          quiet_start: pref?.quiet_start ?? null,
          quiet_end: pref?.quiet_end ?? null,
          quiet_timezone: pref?.quiet_timezone ?? null,
        });
      }
      return Promise.resolve(out);
    },
    recordPushResults(results) {
      store.results.push(results);
      const at = new Date(now()).toISOString();
      for (const s of store.subs) {
        if (results.sent.includes(s.id)) Object.assign(s, { last_success_at: at, failure_count: 0 });
        if (results.gone.includes(s.id)) s.disabled_at = at;
        if (results.failed.includes(s.id)) s.failure_count++;
      }
      return Promise.resolve();
    },
  };
  return store;
}

/** A browser: a real key pair, so a recorded push could be decrypted. */
export async function browserKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  return {
    p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

export interface FakeSender extends PushSender {
  sent: PushMessage[];
  /** Answer for an endpoint; default "sent". */
  answer: (message: PushMessage) => PushOutcome;
}

export function fakeSender(): FakeSender {
  const sender: FakeSender = {
    sent: [],
    answer: () => ({ kind: "sent", status: 201, attempts: 1 }),
    send(message) {
      sender.sent.push(message);
      return Promise.resolve(sender.answer(message));
    },
  };
  return sender;
}

export interface FakeMail extends WatchMail {
  /** What each mailbox answers to a probe, or an error to throw. */
  boxes: Map<string, ProbeResult | Error | (() => Promise<ProbeResult>)>;
  rows: Map<string, NewestRow[]>;
  added: Map<string, string[] | null | Error>;
  calls: Array<{ op: "probe" | "gmailAdded" | "newest"; inbox_id: string }>;
  closed: number;
  inFlight: number;
  maxInFlight: number;
  maxPerHost: number;
}

export function fakeMail(hostOf: (inboxId: string) => string = () => "host"): FakeMail {
  const perHost = new Map<string, number>();
  const mail: FakeMail = {
    boxes: new Map(),
    rows: new Map(),
    added: new Map(),
    calls: [],
    closed: 0,
    inFlight: 0,
    maxInFlight: 0,
    maxPerHost: 0,
    async probe(watch: WatchTarget) {
      mail.calls.push({ op: "probe", inbox_id: watch.inbox_id });
      const host = hostOf(watch.inbox_id);
      mail.inFlight++;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      mail.maxInFlight = Math.max(mail.maxInFlight, mail.inFlight);
      mail.maxPerHost = Math.max(mail.maxPerHost, perHost.get(host)!);
      try {
        await Promise.resolve();
        const box = mail.boxes.get(watch.inbox_id);
        if (box === undefined) throw new Error("no such fake mailbox");
        if (box instanceof Error) throw box;
        return typeof box === "function" ? await box() : box;
      } finally {
        mail.inFlight--;
        perHost.set(host, perHost.get(host)! - 1);
      }
    },
    gmailAdded(watch) {
      mail.calls.push({ op: "gmailAdded", inbox_id: watch.inbox_id });
      const answer = mail.added.get(watch.inbox_id) ?? [];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    newest(watch) {
      mail.calls.push({ op: "newest", inbox_id: watch.inbox_id });
      return Promise.resolve(mail.rows.get(watch.inbox_id) ?? []);
    },
    close() {
      mail.closed++;
      return Promise.resolve();
    },
  };
  return mail;
}

export const imapCursor = (uidNext: number, total: number, unread: number, uidValidity = 1700000000): FolderCursor => ({
  fingerprint: `i:${uidValidity}:${uidNext}:${total}:${unread}:-:-`,
  total,
  unread,
});
