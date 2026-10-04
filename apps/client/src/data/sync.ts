import type { QueryKey } from "@tanstack/react-query";
import type { InboxStatus, MutationNotice } from "../api/http/http-mail-api";
import {
  type FolderEntry,
  type FolderStatus,
  type ListMessagesParams,
  type MailEvent,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  parseFolderRefId,
  roleOfFolder,
} from "../api/types";
import { cachedFolderLists, refreshLists, resolveFolderEntry, rowsOfList, setFolderRefresher } from "./cache";
import { keys, type ListMeta } from "./keys";
import { queryClient } from "./query-client";

/* The sync engine (HTTP mode): how the app notices mail it did not cause.
 *
 * There is no server push yet. Instead, on window focus, on becoming visible,
 * on coming back online and every 45 s while visible, ONE batched `status`
 * call asks every inbox for its folders' fingerprints. A fingerprint that
 * changed means the folder's contents or flags changed:
 *   - an inbox folder: page 1 is fetched again and compared with the cache;
 *     the differences leave as `new_mail` / `flags_changed` / `moved` events
 *     through the same channel a server push would use (which already holds
 *     list-shifting changes while the pointer is over the list);
 *   - any other folder: its cached lists are marked stale (refetched if shown).
 * `status` also carries each folder's counts, so the sidebar, the document
 * title and the app badge follow it without listing folders again.
 *
 * The user's own actions change fingerprints too. Those are expected: the
 * cache already shows their result, so they must not come back as "new mail".
 */

export interface SyncApi {
  getStatus(requests: { inbox_id: string; folders?: string[] }[], signal?: AbortSignal): Promise<Map<string, InboxStatus>>;
  listMessages(params: ListMessagesParams, signal?: AbortSignal): Promise<MessagePage>;
  emit(event: MailEvent): void;
  onMutation(listener: (m: MutationNotice) => void): () => void;
}

export interface SyncEnv {
  isVisible(): boolean;
  isOnline(): boolean;
  /** Focus, visibility and connectivity changes. */
  subscribe(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SyncOptions {
  api: SyncApi;
  /** The inboxes to watch, read at every run. */
  inboxIds: () => string[];
  env?: Partial<SyncEnv>;
  intervalMs?: number;
  /** Focus and visibility events closer together than this share one run. */
  minGapMs?: number;
  /** How long after a mutation before counts are confirmed with `status`. */
  pokeDelayMs?: number;
  maxBackoffMs?: number;
  pageSize?: number;
}

export interface SyncEngine {
  start(): void;
  stop(): void;
  /** Ask for a status run soon (after the user's own change). */
  poke(): void;
  /** One run, now. Resolves when its events have been emitted. */
  syncNow(): Promise<void>;
}

export const SYNC_INTERVAL_MS = 45_000;
/** Folders asked about per inbox. Each one costs the provider a call (an
 *  IMAP STATUS, a Gmail label read), so only what the UI shows is asked. */
export const STATUS_FOLDERS_PER_INBOX = 8;
const OWN_KEY_TTL_MS = 120_000;
/** Lists of these are not provider folders: `status` says nothing about them. */
const VIRTUAL = new Set(["starred", "scheduled"]);

function browserEnv(): SyncEnv {
  return {
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    subscribe(listener) {
      if (typeof window === "undefined") return () => {};
      window.addEventListener("focus", listener);
      window.addEventListener("online", listener);
      window.addEventListener("offline", listener);
      document.addEventListener("visibilitychange", listener);
      return () => {
        window.removeEventListener("focus", listener);
        window.removeEventListener("online", listener);
        window.removeEventListener("offline", listener);
        document.removeEventListener("visibilitychange", listener);
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

/** The folders worth a `status` for one inbox: the inbox and drafts (their
 *  counts are in the sidebar), every folder a cached list shows, then custom
 *  folders (their counts are shown too), up to the cap. Folder ids where the
 *  folder list is cached, the `inbox` alias until then. */
export function statusFoldersFor(inbox_id: string, max = STATUS_FOLDERS_PER_INBOX): string[] {
  const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders(inbox_id));
  if (!entries?.length) return ["inbox"];
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !out.includes(id) && out.length < max) out.push(id);
  };
  add(resolveFolderEntry(entries, inbox_id, { role: "inbox" })?.id);
  add(resolveFolderEntry(entries, inbox_id, { role: "drafts" })?.id);
  for (const { meta } of cachedFolderLists()) {
    if (VIRTUAL.has(meta.folder) || (meta.scope !== "all" && meta.scope !== inbox_id)) continue;
    const ref = parseFolderRefId(meta.folder);
    if (ref) add(resolveFolderEntry(entries, inbox_id, ref)?.id);
  }
  for (const e of entries) if (!roleOfFolder(e.id) && !roleOfFolder(e.name)) add(e.id);
  return out.length ? out : ["inbox"];
}

/** Writes `status` counts into the cached folder list of one inbox. Returns
 *  false when status names a folder the cached list does not have. */
export function patchFolderCounts(inbox_id: string, folders: readonly FolderStatus[]): boolean {
  const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders(inbox_id));
  if (!entries) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let changed = false;
  const next = entries.map((e) => {
    const st = byId.get(e.id);
    if (!st) return e;
    const total = st.total ?? e.total_messages;
    const unread = st.unread ?? e.unread_messages;
    if (total === e.total_messages && unread === e.unread_messages) return e;
    changed = true;
    return { ...e, total_messages: total, unread_messages: unread };
  });
  if (changed) queryClient.setQueryData<FolderEntry[]>(keys.folders(inbox_id), next);
  return folders.every((f) => entries.some((e) => e.id === f.id));
}

interface InboxDiff {
  fresh: MessageRow[];
  flags: { keys: MessageKey[]; flags: MessageFlags }[];
  removed: MessageKey[];
}

/** Compares a freshly fetched first page with what the cache holds for the
 *  same inbox and folder. Pure. */
export function diffFirstPage(
  page: { rows: MessageRow[]; has_more: boolean },
  cached: readonly MessageRow[],
  opts: { own: (key: MessageKey) => boolean; settled: boolean },
): InboxDiff {
  const have = new Map(cached.map((r) => [r.key, r]));
  const seen = new Set(page.rows.map((r) => r.key));
  let oldestCached: string | null = null;
  for (const r of cached) if (oldestCached == null || r.date < oldestCached) oldestCached = r.date;

  const fresh: MessageRow[] = [];
  const groups: Record<string, { keys: MessageKey[]; flags: MessageFlags }> = {};
  for (const r of page.rows) {
    const c = have.get(r.key);
    if (!c) {
      // Older than everything cached: a row from beyond the cached window
      // that slid up because something above it left. Not new mail.
      if (opts.own(r.key) || (oldestCached != null && r.date < oldestCached)) continue;
      fresh.push(r);
      continue;
    }
    // While one of our own changes is in flight the server may still show
    // the old flags: the optimistic value stands.
    if (!opts.settled || opts.own(r.key)) continue;
    if (c.is_read !== r.is_read) (groups[`r${r.is_read}`] ??= { keys: [], flags: { read: r.is_read } }).keys.push(r.key);
    if (c.is_starred !== r.is_starred) {
      (groups[`s${r.is_starred}`] ??= { keys: [], flags: { starred: r.is_starred } }).keys.push(r.key);
    }
  }

  const removed: MessageKey[] = [];
  const last = page.rows[page.rows.length - 1];
  if (opts.settled) {
    for (const r of cached) {
      if (seen.has(r.key) || opts.own(r.key)) continue;
      // Only inside the range page 1 covers: older cached rows are simply
      // further down than this page reaches.
      if (page.has_more && (!last || r.date <= last.date)) continue;
      removed.push(r.key);
    }
  }
  return { fresh, flags: Object.values(groups), removed };
}

export function createSyncEngine(options: SyncOptions): SyncEngine {
  const env: SyncEnv = { ...browserEnv(), ...options.env };
  const { api } = options;
  const intervalMs = options.intervalMs ?? SYNC_INTERVAL_MS;
  const minGapMs = options.minGapMs ?? 5000;
  const pokeDelayMs = options.pokeDelayMs ?? 800;
  const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
  const pageSize = options.pageSize ?? 50;

  let started = false;
  let timer: unknown = null;
  let pokeTimer: unknown = null;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let failures = 0;
  let lastRunAt = -Infinity;
  let emitting = false;
  let unsubs: (() => void)[] = [];

  /** inbox -> folder id -> fingerprint. */
  const prints = new Map<string, Map<string, string>>();
  /** A counter shared by status runs and mutations, to order them. */
  let seq = 0;
  const inflight = new Map<string, number>();
  const mutatedAt = new Map<string, number>();
  const syncedAt = new Map<string, number>();
  const ownKeys = new Map<MessageKey, number>();

  const own = (key: MessageKey) => ownKeys.has(key);

  const onMutation = (m: MutationNotice) => {
    const until = env.now() + OWN_KEY_TTL_MS;
    for (const k of m.keys) ownKeys.set(k, until);
    for (const id of m.inbox_ids) {
      if (m.phase === "start") inflight.set(id, (inflight.get(id) ?? 0) + 1);
      else {
        inflight.set(id, Math.max(0, (inflight.get(id) ?? 0) - 1));
        mutatedAt.set(id, ++seq);
      }
    }
    if (m.phase === "end") poke();
  };

  const emit = (event: MailEvent) => {
    emitting = true;
    try {
      api.emit(event);
    } finally {
      emitting = false;
    }
  };

  /** The folder entry a cached list shows for one inbox, by id. */
  const folderIdOf = (meta: ListMeta, inbox_id: string, ids: Iterable<string>): string | null => {
    const ref = parseFolderRefId(meta.folder);
    if (!ref) return null;
    const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders(inbox_id));
    const entry = entries ? resolveFolderEntry(entries, inbox_id, ref) : undefined;
    if (entry) return entry.id;
    // No folder list cached yet: a role can still be recognised by its id.
    if ("role" in ref) for (const id of ids) if (roleOfFolder(id) === ref.role) return id;
    return null;
  };

  async function reconcile(inbox_id: string, changed: Set<string>, settled: boolean, signal: AbortSignal): Promise<void> {
    const inboxLists: QueryKey[] = [];
    const stale = new Set<string>();
    for (const { key, meta } of cachedFolderLists()) {
      if (VIRTUAL.has(meta.folder)) continue;
      if (meta.scope !== "all" && meta.scope !== inbox_id) continue;
      const id = folderIdOf(meta, inbox_id, changed);
      if (!id || !changed.has(id)) continue;
      if (meta.folder === "inbox") inboxLists.push(key);
      else stale.add(JSON.stringify(meta));
    }

    // Other folders: mark stale; what is on screen refetches. After our own
    // change the action has already refreshed what it touched.
    if (stale.size && settled) {
      refreshLists((meta) => stale.has(JSON.stringify(meta)));
      if ([...stale].some((m) => (JSON.parse(m) as ListMeta).folder === "drafts")) {
        void queryClient.invalidateQueries({ queryKey: keys.draftsRoot });
      }
    }
    if (!inboxLists.length) return;

    const page = await api.listMessages({ scope: inbox_id, folder: { role: "inbox" }, limit: pageSize }, signal);
    if (signal.aborted) return;
    // Every cached inbox list this inbox appears in (unified and its own).
    const cached = new Map<MessageKey, MessageRow>();
    for (const key of inboxLists) for (const r of rowsOfList(key, inbox_id)) cached.set(r.key, r);
    // A mutation that started while page 1 was on its way makes it unreliable.
    const stillSettled = settled && !(inflight.get(inbox_id) ?? 0);
    const diff = diffFirstPage(page, [...cached.values()], { own, settled: stillSettled });

    if (diff.removed.length) emit({ type: "moved", keys: diff.removed, to: null, from: { role: "inbox" } });
    for (const g of diff.flags) emit({ type: "flags_changed", keys: g.keys, flags: g.flags });
    if (diff.fresh.length) emit({ type: "new_mail", rows: diff.fresh });
  }

  async function run(): Promise<void> {
    const ids = options.inboxIds();
    if (!ids.length) return;
    const sentAt = ++seq;
    const abort = new AbortController();
    controller = abort;
    const now = env.now();
    for (const [k, until] of ownKeys) if (until < now) ownKeys.delete(k);

    const statuses = await api.getStatus(
      ids.map((inbox_id) => ({ inbox_id, folders: statusFoldersFor(inbox_id) })),
      abort.signal,
    );
    if (abort.signal.aborted) return;
    let ok = 0;
    const work: Promise<void>[] = [];
    for (const [inbox_id, st] of statuses) {
      if (!st.ok) continue;
      ok++;
      const busy = (inflight.get(inbox_id) ?? 0) > 0;
      // Settled: no change of ours could still be missing from this answer.
      const settled = !busy && (mutatedAt.get(inbox_id) ?? 0) <= (syncedAt.get(inbox_id) ?? 0);
      syncedAt.set(inbox_id, sentAt);

      // Counts: the optimistic ones stand while a change is in flight.
      // A folder the cached list has and the mailbox no longer does (or the
      // other way round): the folder list itself is out of date.
      if (st.missing.length || (!busy && !patchFolderCounts(inbox_id, st.folders))) {
        void queryClient.invalidateQueries({ queryKey: keys.folders(inbox_id) });
      }

      const before = prints.get(inbox_id);
      const after = new Map(st.folders.map((f) => [f.id, f.fingerprint]));
      if (!before) {
        prints.set(inbox_id, after); // first sight: this is the baseline
        continue;
      }
      // Our own change is (or may be) part of this answer. Keep the old
      // baseline and look again on the next run, once it has certainly
      // landed: by then the cache already shows it, so nothing is announced.
      if (!settled) continue;
      // Folders not asked about this time keep the fingerprint they had.
      prints.set(inbox_id, new Map([...before, ...after]));
      const changed = new Set<string>();
      // A folder seen for the first time has nothing to be compared with.
      for (const [id, fp] of after) if (before.has(id) && before.get(id) !== fp) changed.add(id);
      if (changed.size) work.push(reconcile(inbox_id, changed, settled, abort.signal));
    }
    const results = await Promise.allSettled(work);
    if (!ok || results.some((r) => r.status === "rejected")) throw new Error("sync failed");
  }

  function syncNow(): Promise<void> {
    if (running) return running;
    lastRunAt = env.now();
    running = run()
      .then(
        () => {
          failures = 0;
        },
        () => {
          failures++;
        },
      )
      .finally(() => {
        running = null;
        controller = null;
      });
    return running;
  }

  const active = () => started && env.isVisible() && env.isOnline();

  function schedule(): void {
    if (timer != null) env.clearTimeout(timer);
    timer = null;
    if (!active()) return;
    const delay = failures ? Math.min(maxBackoffMs, intervalMs * 2 ** failures) : intervalMs;
    timer = env.setTimeout(() => void tick(), delay);
  }

  async function tick(): Promise<void> {
    if (!active()) return schedule();
    await syncNow();
    if (started) schedule();
  }

  function onEnvChange(): void {
    if (!active()) {
      // Hidden or offline: nothing runs until the next change.
      if (timer != null) env.clearTimeout(timer);
      timer = null;
      return;
    }
    if (env.now() - lastRunAt >= minGapMs) void tick();
    else if (timer == null) schedule();
  }

  function poke(): void {
    if (!started || emitting) return;
    if (pokeTimer != null) env.clearTimeout(pokeTimer);
    pokeTimer = env.setTimeout(() => {
      pokeTimer = null;
      if (!started || !env.isOnline()) return;
      // A run in flight may have been sent before the change: go again after it.
      void (running ?? Promise.resolve()).then(() => (started ? tick() : undefined));
    }, pokeDelayMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      unsubs = [env.subscribe(onEnvChange), api.onMutation(onMutation)];
      setFolderRefresher(poke);
      void tick();
    },
    stop() {
      if (!started) return;
      started = false;
      for (const u of unsubs) u();
      unsubs = [];
      setFolderRefresher(null);
      if (timer != null) env.clearTimeout(timer);
      if (pokeTimer != null) env.clearTimeout(pokeTimer);
      timer = pokeTimer = null;
      controller?.abort();
      prints.clear();
      ownKeys.clear();
      inflight.clear();
      mutatedAt.clear();
      syncedAt.clear();
      failures = 0;
      lastRunAt = -Infinity;
    },
    poke,
    syncNow,
  };
}
