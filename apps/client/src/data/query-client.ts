import { type InfiniteData, QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { ApiError, IS_MOCK_BACKEND } from "../api";
import { initialMockProfile } from "../api/mock";
import type { MessagePage, PageCursor } from "../api/types";
import { getPlatform } from "../platform";

/* One QueryClient for the app, persisted to IndexedDB so a reload paints the
 * last known mailbox immediately (stale content beats a skeleton) and then
 * refreshes in the background.
 *
 * Persistence is hand-rolled on dehydrate/hydrate + the platform KV store:
 * the official persister packages are not on the dependency allow-list, and
 * this is ~60 lines.
 */

/** Bump when a cached shape changes. Old caches are dropped, not migrated. */
export const CACHE_VERSION = 1;

const CACHE_KEY = "mc-query-cache";
/** Every namespace ever written from this browser profile, so sign-out can
 *  delete them all (the KV store has no "list keys"). */
const INDEX_KEY = "mc-query-cache-index";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PERSIST_THROTTLE_MS = 1000;
/** Only the first pages of a list are persisted: a restored infinite query
 *  refetches every page it holds, so a deep scroll must not come back. */
const PERSISTED_PAGES = 2;

/** Query key roots worth restoring on reload. */
const PERSISTED_ROOTS = new Set(["session", "inboxes", "folders", "messages", "message", "allowance", "scheduled", "drafts"]);

export const STALE_MS = 30_000;
/** Folder lists. HTTP mode: never stale by age. Listing folders is the
 *  backend's slowest call; the sync engine's `status` keeps the counts right
 *  and invalidates the list when a folder appears or goes away. */
export const FOLDERS_STALE_MS = IS_MOCK_BACKEND ? STALE_MS : Number.POSITIVE_INFINITY;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_MS,
      // Must outlive MAX_AGE_MS or restored queries are collected before use.
      gcTime: MAX_AGE_MS,
      // The HTTP client already retried what is worth retrying (ApiError).
      retry: (failures, error) => !(error instanceof ApiError) && failures < 1,
      // HTTP mode: the sync engine decides what is worth refetching on focus
      // (one cheap `status` call) instead of every list on screen.
      refetchOnWindowFocus: IS_MOCK_BACKEND,
      // The cache is the offline story; do not pause queries when offline.
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});

interface PersistedCache {
  version: number;
  /** Separates caches of different backends / mock profiles. */
  buster: string;
  savedAt: number;
  state: ReturnType<typeof dehydrate>;
}

function buster(): string {
  return IS_MOCK_BACKEND ? `mock:${initialMockProfile()}` : "http";
}

/* ---- namespace: whose cache this is ----
 * Mock mode has one fixed namespace. In HTTP mode the cache belongs to one
 * user in one workspace (`{user_id}:{workspace_id}`): nothing is read or
 * written until that is known, so one account can never be shown another's
 * cached mail on a shared browser. */
let namespace: string | null = IS_MOCK_BACKEND ? "mock" : null;

export function cacheNamespaceOf(user_id: string, workspace_id: string): string {
  return `${user_id}:${workspace_id}`;
}

export function getCacheNamespace(): string | null {
  return namespace;
}

/** Points persistence at another namespace. Does not touch what is in
 *  memory: callers clear it first when the owner changes. */
export function setCacheNamespace(ns: string | null): void {
  if (ns === namespace) return;
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  namespace = ns;
}

const storageKey = (ns: string): string => (ns === "mock" ? CACHE_KEY : `${CACHE_KEY}:${ns}`);

async function rememberNamespace(ns: string): Promise<void> {
  if (ns === "mock") return;
  const storage = getPlatform().storage;
  const index = (await storage.get<string[]>(INDEX_KEY)) ?? [];
  if (!index.includes(ns)) await storage.set(INDEX_KEY, [...index, ns]);
}

function snapshot(): PersistedCache {
  const state = dehydrate(queryClient, {
    shouldDehydrateQuery: (q) =>
      q.state.status === "success" && PERSISTED_ROOTS.has(String(q.queryKey[0])) && !isSearchKey(q.queryKey),
  });
  for (const q of state.queries) {
    if (q.queryKey[0] !== "messages") continue;
    const data = q.state.data as InfiniteData<MessagePage, PageCursor | null> | undefined;
    if (data && data.pages.length > PERSISTED_PAGES) {
      q.state.data = {
        pages: data.pages.slice(0, PERSISTED_PAGES),
        pageParams: data.pageParams.slice(0, PERSISTED_PAGES),
      };
    }
  }
  return { version: CACHE_VERSION, buster: buster(), savedAt: Date.now(), state };
}

function isSearchKey(key: readonly unknown[]): boolean {
  const meta = key[1] as { query?: string } | undefined;
  return key[0] === "messages" && !!meta?.query;
}

/** Restores the persisted cache. Call (and await) before the first render so
 *  the first paint already has data. Never throws. */
export async function restoreQueryCache(): Promise<boolean> {
  const ns = namespace;
  if (!ns) return false;
  try {
    const saved = await getPlatform().storage.get<PersistedCache>(storageKey(ns));
    // The owner changed while IndexedDB was answering: this is not ours to show.
    if (ns !== namespace) return false;
    if (!saved) return false;
    const fresh =
      saved.version === CACHE_VERSION && saved.buster === buster() && Date.now() - saved.savedAt < MAX_AGE_MS;
    if (!fresh) {
      await getPlatform().storage.del(storageKey(ns));
      return false;
    }
    hydrate(queryClient, saved.state);
    // Restored data is shown at once but is stale by definition: refetch on
    // mount. HTTP mode keeps the folder lists: the sync engine's `status`
    // call corrects their counts and notices folders that came or went.
    queryClient.invalidateQueries({
      refetchType: "none",
      predicate: (q) => IS_MOCK_BACKEND || q.queryKey[0] !== "folders",
    });
    return true;
  } catch {
    return false;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let stopPersisting: (() => void) | null = null;

function persistNow(): void {
  persistTimer = null;
  const ns = namespace;
  if (!ns) return;
  void rememberNamespace(ns).then(() => {
    if (ns === namespace) void getPlatform().storage.set(storageKey(ns), snapshot());
  });
}

/** Writes the cache to IndexedDB, at most once a second, whenever it changes. */
export function startQueryPersistence(): () => void {
  if (stopPersisting) return stopPersisting;
  const unsub = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" && event.type !== "added" && event.type !== "removed") return;
    if (persistTimer == null) persistTimer = setTimeout(persistNow, PERSIST_THROTTLE_MS);
  });
  const flush = () => {
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistNow();
    }
  };
  window.addEventListener("pagehide", flush);
  stopPersisting = () => {
    unsub();
    window.removeEventListener("pagehide", flush);
    if (persistTimer != null) clearTimeout(persistTimer);
    persistTimer = null;
    stopPersisting = null;
  };
  return stopPersisting;
}

/** Drops everything, in memory and on disk (sign-out, mock profile switch). */
export async function clearQueryCache(): Promise<void> {
  await queryClient.cancelQueries();
  // `clear()` alone would leave mounted observers showing their last result:
  // drop what nothing is watching, then reset (and refetch) what is on screen.
  queryClient.removeQueries({ type: "inactive" });
  if (namespace) await getPlatform().storage.del(storageKey(namespace));
  await queryClient.resetQueries();
}

/** Empties the in-memory cache without touching disk (the owner is changing). */
export function dropMemoryCache(): void {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  void queryClient.cancelQueries();
  queryClient.clear();
}

/** Sign-out: nothing of any account stays, in memory or in IndexedDB. */
export async function purgeAllCaches(): Promise<void> {
  setCacheNamespace(null);
  dropMemoryCache();
  const storage = getPlatform().storage;
  try {
    const index = (await storage.get<string[]>(INDEX_KEY)) ?? [];
    await Promise.all(index.map((ns) => storage.del(storageKey(ns))));
    await storage.del(INDEX_KEY);
  } catch {
    /* storage unavailable: there is nothing on disk to leak either */
  }
}
