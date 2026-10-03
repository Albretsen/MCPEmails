import { type InfiniteData, QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { IS_MOCK_BACKEND } from "../api";
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
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PERSIST_THROTTLE_MS = 1000;
/** Only the first pages of a list are persisted: a restored infinite query
 *  refetches every page it holds, so a deep scroll must not come back. */
const PERSISTED_PAGES = 2;

/** Query key roots worth restoring on reload. */
const PERSISTED_ROOTS = new Set(["inboxes", "folders", "messages", "message", "allowance", "scheduled", "drafts"]);

export const STALE_MS = 30_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_MS,
      // Must outlive MAX_AGE_MS or restored queries are collected before use.
      gcTime: MAX_AGE_MS,
      retry: 1,
      refetchOnWindowFocus: true,
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
  try {
    const saved = await getPlatform().storage.get<PersistedCache>(CACHE_KEY);
    if (!saved) return false;
    const fresh =
      saved.version === CACHE_VERSION && saved.buster === buster() && Date.now() - saved.savedAt < MAX_AGE_MS;
    if (!fresh) {
      await getPlatform().storage.del(CACHE_KEY);
      return false;
    }
    hydrate(queryClient, saved.state);
    // Restored data is shown at once but is stale by definition: refetch on mount.
    queryClient.invalidateQueries({ refetchType: "none" });
    return true;
  } catch {
    return false;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let stopPersisting: (() => void) | null = null;

function persistNow(): void {
  persistTimer = null;
  void getPlatform().storage.set(CACHE_KEY, snapshot());
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
  await getPlatform().storage.del(CACHE_KEY);
  await queryClient.resetQueries();
}
