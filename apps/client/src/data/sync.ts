import type { QueryKey } from "@tanstack/react-query";
import type { InboxStatus, MutationNotice } from "../api/http/http-mail-api";
import {
  BACKEND_FOLDER_ALIASES,
  type FolderEntry,
  type FolderRole,
  type FolderStatus,
  type ListMessagesParams,
  type MailEvent,
  type MessageFlags,
  type MessageKey,
  type MessagePage,
  type MessageRow,
  isProviderViewFolder,
  parseFolderRefId,
  roleOfFolder,
} from "../api/types";
import {
  cachedFolderLists,
  folderRoleOf,
  learnFolderRoles,
  refreshLists,
  resolveFolderEntry,
  rowsOfList,
  setFolderRefresher,
} from "./cache";
import { keys, type ListMeta } from "./keys";
import { queryClient } from "./query-client";

/* The sync engine (HTTP mode): how the app notices mail it did not cause.
 *
 * There is no server push yet. Instead, on window focus, on becoming visible,
 * on coming back online and every 45 s while visible (every 30 s while the
 * socket is live), ONE `status` call per inbox (batched over HTTP) asks for
 * its folders' fingerprints. A fingerprint that
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
  /** Read at every scheduling, so it can follow the transport in use. */
  intervalMs?: number | (() => number);
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
/** On a live socket the server keeps the mailbox connection warm between
 *  polls (its idle limit is 70 s), so `status` is one cheap command there. */
export const SYNC_INTERVAL_LIVE_MS = 30_000;
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
export function statusFoldersFor(inbox_id: string, max = STATUS_FOLDERS_PER_INBOX, skip?: ReadonlySet<string>): string[] {
  const entries = queryClient.getQueryData<FolderEntry[]>(keys.folders(inbox_id));
  if (!entries?.length) return ["inbox"];
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !skip?.has(id) && !out.includes(id) && out.length < max) out.push(id);
  };
  const inbox = resolveFolderEntry(entries, inbox_id, { role: "inbox" });
  // No folder can be told to be the inbox (opaque ids, localised names): ask
  // by role alias. The answers carry the real ids, which are remembered.
  if (!inbox) for (const role of BACKEND_FOLDER_ALIASES) add(role);
  add(inbox?.id);
  add(resolveFolderEntry(entries, inbox_id, { role: "drafts" })?.id);
  for (const { meta } of cachedFolderLists()) {
    if (VIRTUAL.has(meta.folder) || (meta.scope !== "all" && meta.scope !== inbox_id)) continue;
    const ref = parseFolderRefId(meta.folder);
    if (ref) add(resolveFolderEntry(entries, inbox_id, ref)?.id);
  }
  for (const e of entries) if (!folderRoleOf(inbox_id, e) && !isProviderViewFolder(e.id)) add(e.id);
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
  const intervalOption = options.intervalMs ?? SYNC_INTERVAL_MS;
  const interval = () => (typeof intervalOption === "function" ? intervalOption() : intervalOption);
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
  /** Counts `stop()` calls: tells a run of a stopped engine from a current one. */
  let epoch = 0;
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
  /** inbox -> folders `status` cannot open (a container that holds folders
   *  and no mail, such as Gmail's "[Gmail]"). The folder list was refreshed
   *  once for each; asking again every run would list the folders every run. */
  const unopenable = new Map<string, Set<string>>();

  const own = (key: MessageKey) => ownKeys.has(key);

  const onMutation = (m: MutationNotice) => {
    const until = env.now() + OWN_KEY_TTL_MS;
    for (const k of m.keys) ownKeys.set(k, until);
    const folders = new Map(m.touched.map((t) => [t.inbox_id, t.folders]));
    for (const id of m.inbox_ids) {
      if (m.phase === "start") inflight.set(id, (inflight.get(id) ?? 0) + 1);
      else {
        inflight.set(id, Math.max(0, (inflight.get(id) ?? 0) - 1));
        // A mutation that changes no folder (a scheduled send) changes no
        // fingerprint either: nothing of ours can be missing from a status.
        if (folders.get(id)?.length) mutatedAt.set(id, ++seq);
      }
    }
    if (m.phase === "end") pokeOwn(m.touched);
  };

  /* After our own mutation: ONE `status` for the mailbox it touched, about
   * the folders it can have changed and nothing else (a draft autosave: that
   * mailbox's Drafts). It confirms the counts the cache shows optimistically.
   * It never moves a fingerprint baseline and never announces anything: the
   * change is ours and the cache already shows it. The next full run then
   * finds the mailbox settled (see `syncedAt`), compares against the baseline
   * from before the change, and reconciles with our own keys left out, so
   * mail that arrived from elsewhere in the same folder is still announced. */
  const ownTargets = new Map<string, Set<string>>();
  let ownTimer: unknown = null;
  let ownController: AbortController | null = null;

  function pokeOwn(touched: MutationNotice["touched"]): void {
    if (!started) return;
    let any = false;
    for (const t of touched) {
      if (!t.folders.length) continue;
      const set = ownTargets.get(t.inbox_id) ?? new Set<string>();
      for (const f of t.folders) set.add(f);
      ownTargets.set(t.inbox_id, set);
      any = true;
    }
    if (!any) return;
    if (ownTimer != null) env.clearTimeout(ownTimer);
    ownTimer = env.setTimeout(() => {
      ownTimer = null;
      void runOwn().catch(() => {});
    }, pokeDelayMs);
  }

  async function runOwn(): Promise<void> {
    if (!started || !env.isOnline() || !ownTargets.size) return;
    const requests = [...ownTargets].map(([inbox_id, set]) => ({ inbox_id, folders: [...set] }));
    ownTargets.clear();
    const sentAt = ++seq;
    const abort = new AbortController();
    ownController = abort;
    const mine = epoch;
    const statuses = await api.getStatus(requests, abort.signal);
    if (abort.signal.aborted || mine !== epoch) return;
    for (const [inbox_id, st] of statuses) {
      if (!st.ok) continue;
      learnRoles(inbox_id, st.folders);
      // Sent after the change ended: a later full run may treat it as landed.
      if ((syncedAt.get(inbox_id) ?? 0) < sentAt) syncedAt.set(inbox_id, sentAt);
      // Counts: the optimistic ones stand while another change is in flight.
      // A folder this mailbox does not have (no Archive, say) is not news.
      if (!(inflight.get(inbox_id) ?? 0) && (mutatedAt.get(inbox_id) ?? 0) <= sentAt) patchFolderCounts(inbox_id, st.folders);
    }
  }

  /** A folder asked for by role alias and answered with its real id. */
  const learnRoles = (inbox_id: string, folders: readonly FolderStatus[]) => {
    const roles = folders
      .filter((f) => f.folder != null && f.id !== f.folder && (BACKEND_FOLDER_ALIASES as readonly string[]).includes(f.folder))
      .map((f) => ({ id: f.id, role: f.folder as FolderRole }));
    if (roles.length && learnFolderRoles(inbox_id, roles)) {
      // A new identity, so what is derived from the folder list is derived again.
      queryClient.setQueryData<FolderEntry[]>(keys.folders(inbox_id), (e) => (e ? [...e] : e));
    }
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
      ids.map((inbox_id) => ({ inbox_id, folders: statusFoldersFor(inbox_id, STATUS_FOLDERS_PER_INBOX, unopenable.get(inbox_id)) })),
      abort.signal,
    );
    if (abort.signal.aborted) return;
    let ok = 0;
    const work: Promise<void>[] = [];
    for (const [inbox_id, st] of statuses) {
      if (!st.ok) continue;
      ok++;
      const busy = (inflight.get(inbox_id) ?? 0) > 0;

      learnRoles(inbox_id, st.folders);
      // Settled: no change of ours could still be missing from this answer.
      // That takes a status sent after the change ended (a full run, or the
      // targeted one that follows every mutation) BEFORE this run was sent.
      const changedAt = mutatedAt.get(inbox_id) ?? 0;
      const settled = !busy && changedAt <= (syncedAt.get(inbox_id) ?? 0) && changedAt < sentAt;
      if ((syncedAt.get(inbox_id) ?? 0) < sentAt) syncedAt.set(inbox_id, sentAt);

      // Counts: the optimistic ones stand while a change is in flight.
      // A folder the cached list has and the mailbox no longer does (or the
      // other way round): the folder list itself is out of date.
      if (st.missing.length || (!busy && !patchFolderCounts(inbox_id, st.folders))) {
        void queryClient.invalidateQueries({ queryKey: keys.folders(inbox_id) });
      }
      // Not asked about again: if it is really gone the refreshed list drops
      // it; if the list still has it, it is a folder that cannot be opened.
      if (st.missing.length) {
        const set = unopenable.get(inbox_id) ?? new Set<string>();
        for (const id of st.missing) set.add(id);
        unopenable.set(inbox_id, set);
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
    // A run that `stop()` aborted is not a failure of the engine that was
    // started again meanwhile, and must not clear that engine's run.
    const mine = epoch;
    const p: Promise<void> = run()
      .then(
        () => {
          if (mine === epoch) failures = 0;
        },
        () => {
          if (mine === epoch) failures++;
        },
      )
      .finally(() => {
        if (running === p) {
          running = null;
          controller = null;
        }
      });
    running = p;
    return p;
  }

  const active = () => started && env.isVisible() && env.isOnline();

  function schedule(): void {
    if (timer != null) env.clearTimeout(timer);
    timer = null;
    if (!active()) return;
    const intervalMs = interval();
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
      if (ownTimer != null) env.clearTimeout(ownTimer);
      timer = pokeTimer = ownTimer = null;
      ownTargets.clear();
      ownController?.abort();
      ownController = null;
      epoch++;
      controller?.abort();
      running = null;
      controller = null;
      prints.clear();
      ownKeys.clear();
      inflight.clear();
      unopenable.clear();
      mutatedAt.clear();
      syncedAt.clear();
      failures = 0;
      lastRunAt = -Infinity;
    },
    poke,
    syncNow,
  };
}
