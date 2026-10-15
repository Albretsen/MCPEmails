import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPlatform, setPlatform } from "../platform";
import { type ListData } from "./cache";
import { keys, listMeta } from "./keys";
import {
  cacheNamespaceOf,
  dropMemoryCache,
  getCacheNamespace,
  purgeAllCaches,
  queryClient,
  restoreQueryCache,
  setCacheNamespace,
  startQueryPersistence,
} from "./query-client";

/* One browser, several accounts: what one account cached must never be
 * restored for another, and sign-out must leave nothing on disk. */

const store = new Map<string, unknown>();
const original = getCacheNamespace();
let stopPersisting = () => {};

const inboxKey = keys.messages(listMeta("all", { role: "inbox" }));
const listOf = (subject: string): ListData => ({
  pages: [
    {
      rows: [
        {
          id: "m1",
          key: "a:m1",
          inbox_id: "a",
          from: { name: "", email: "x@y.z" },
          to: [],
          subject,
          date: "2026-10-03T10:00:00Z",
          preview: "",
          is_read: false,
          is_starred: false,
          has_attachments: false,
          folder: "INBOX",
          folder_role: "inbox",
          thread_id: "t",
        },
      ],
      total: 1,
      total_is_estimate: false,
      has_more: false,
      next_cursor: null,
    },
  ],
  pageParams: [null],
});

/** Writes whatever is waiting to disk (the app does this on pagehide). */
async function persist(): Promise<void> {
  window.dispatchEvent(new Event("pagehide"));
  await new Promise((r) => setTimeout(r, 5));
}

const subjectInMemory = () => queryClient.getQueryData<ListData>(inboxKey)?.pages[0]?.rows[0]?.subject;

beforeEach(() => {
  store.clear();
  setPlatform({
    ...getPlatform(),
    storage: {
      get: async <T,>(k: string) => store.get(k) as T | undefined,
      set: async (k, v) => void store.set(k, structuredClone(v)),
      del: async (k) => void store.delete(k),
    },
  });
  queryClient.clear();
  stopPersisting = startQueryPersistence();
});

afterEach(() => {
  stopPersisting();
  setPlatform(null);
  setCacheNamespace(original);
  queryClient.clear();
});

describe("cache namespaces", () => {
  it("persists under the user and workspace it belongs to", async () => {
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    queryClient.setQueryData(inboxKey, listOf("Alice's mail"));
    await persist();
    expect([...store.keys()].sort()).toEqual(["mc-query-cache-index", "mc-query-cache:alice:ws-1"]);
  });

  it("another account on the same browser never sees it", async () => {
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    queryClient.setQueryData(inboxKey, listOf("Alice's mail"));
    await persist();

    // Bob signs in: memory is dropped, the namespace changes.
    dropMemoryCache();
    setCacheNamespace(cacheNamespaceOf("bob", "ws-1"));
    expect(await restoreQueryCache()).toBe(false);
    expect(subjectInMemory()).toBeUndefined();
    queryClient.setQueryData(inboxKey, listOf("Bob's mail"));
    await persist();

    // Alice again: her cache, not Bob's.
    dropMemoryCache();
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    expect(await restoreQueryCache()).toBe(true);
    expect(subjectInMemory()).toBe("Alice's mail");
  });

  it("workspaces of one user are separate too", async () => {
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    queryClient.setQueryData(inboxKey, listOf("Workspace one"));
    await persist();
    dropMemoryCache();
    setCacheNamespace(cacheNamespaceOf("alice", "ws-2"));
    expect(await restoreQueryCache()).toBe(false);
    expect(subjectInMemory()).toBeUndefined();
  });

  it("writes nothing while nobody is signed in", async () => {
    setCacheNamespace(null);
    queryClient.setQueryData(inboxKey, listOf("Nobody's"));
    await persist();
    expect(store.size).toBe(0);
    expect(await restoreQueryCache()).toBe(false);
  });

  it("a write scheduled for one account is not flushed into the next one's namespace", async () => {
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    queryClient.setQueryData(inboxKey, listOf("Alice's mail")); // schedules a write
    dropMemoryCache();
    setCacheNamespace(cacheNamespaceOf("bob", "ws-1"));
    await persist();
    expect([...store.keys()].some((k) => k.includes("bob"))).toBe(false);
  });

  it("a restore that answers after the account changed is discarded", async () => {
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    queryClient.setQueryData(inboxKey, listOf("Alice's mail"));
    await persist();
    dropMemoryCache();
    const slow = restoreQueryCache(); // IndexedDB is still answering...
    setCacheNamespace(cacheNamespaceOf("bob", "ws-1")); // ...when Bob takes over
    expect(await slow).toBe(false);
    expect(subjectInMemory()).toBeUndefined();
  });

  it("sign-out removes every account's cache from disk and memory", async () => {
    for (const [user, ws] of [
      ["alice", "ws-1"],
      ["alice", "ws-2"],
      ["bob", "ws-1"],
    ] as const) {
      setCacheNamespace(cacheNamespaceOf(user, ws));
      queryClient.setQueryData(inboxKey, listOf(`${user} ${ws}`));
      await persist();
      dropMemoryCache();
    }
    expect(store.size).toBe(4);
    setCacheNamespace(cacheNamespaceOf("bob", "ws-1"));
    await restoreQueryCache();
    expect(subjectInMemory()).toBe("bob ws-1");

    await purgeAllCaches();
    expect(store.size).toBe(0);
    expect(getCacheNamespace()).toBeNull();
    expect(subjectInMemory()).toBeUndefined();
    setCacheNamespace(cacheNamespaceOf("alice", "ws-1"));
    expect(await restoreQueryCache()).toBe(false);
  });
});
