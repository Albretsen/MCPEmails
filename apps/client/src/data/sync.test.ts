import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../api/http/client";
import { FakeBackend, fakeInbox, fakeMessage } from "../api/http/fake-backend";
import { HttpMailApi } from "../api/http/http-mail-api";
import type { FolderEntry, MailEvent, MessageRow } from "../api/types";
import { type ListData, removeMovedRows, resolveFolderEntry } from "./cache";
import { keys, listMeta } from "./keys";
import { queryClient } from "./query-client";
import { type SyncEngine, type SyncEnv, createSyncEngine, diffFirstPage, statusFoldersFor } from "./sync";

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`;
const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

interface Timer {
  fn: () => void;
  ms: number;
}

function fakeEnv() {
  const timers: Timer[] = [];
  const listeners = new Set<() => void>();
  const state = { visible: true, online: true, now: 1_000_000 };
  const env: SyncEnv = {
    isVisible: () => state.visible,
    isOnline: () => state.online,
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    setTimeout(fn, ms) {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout(h) {
      const i = timers.indexOf(h as Timer);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => state.now,
  };
  return {
    env,
    state,
    timers,
    /** Focus / visibility / connectivity changed. */
    change: () => {
      for (const l of [...listeners]) l();
    },
    /** Runs (and removes) the pending timers with this delay. */
    run: (ms: number) => {
      const due = timers.filter((t) => t.ms === ms);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
      return due.length;
    },
  };
}

let backend: FakeBackend;
let api: HttpMailApi;
let events: MailEvent[];
let engine: SyncEngine;
let env: ReturnType<typeof fakeEnv>;

async function setup(inboxes = ["a"], pageSize = 50): Promise<void> {
  backend = new FakeBackend(inboxes.map((id) => fakeInbox(id, `${id}@example.com`)));
  const client = new ApiClient({
    baseUrl: "https://api.test/client-api",
    getToken: async () => "tok-1",
    refreshToken: async () => null,
    fetch: backend.fetch,
    sleep: async () => {},
  });
  api = new HttpMailApi({ client });
  api.seedSession(backend.session());
  events = [];
  api.subscribe((e) => events.push(e));
  env = fakeEnv();
  engine = createSyncEngine({ api, inboxIds: () => inboxes, env: env.env, pageSize });
  queryClient.clear();
}

/** Loads the unified inbox and every folder list into the cache, as the UI would. */
async function prime(limit = 50): Promise<void> {
  const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit });
  queryClient.setQueryData<ListData>(keys.messages(listMeta("all", { role: "inbox" })), { pages: [page], pageParams: [null] });
  for (const i of backend.inboxes) queryClient.setQueryData(keys.folders(i.inbox_id), await api.listFolders(i.inbox_id));
}

const cachedRows = (): MessageRow[] =>
  queryClient.getQueryData<ListData>(keys.messages(listMeta("all", { role: "inbox" })))?.pages.flatMap((p) => p.rows) ?? [];
const inboxEntry = (id: string) => resolveFolderEntry(queryClient.getQueryData<FolderEntry[]>(keys.folders(id)) ?? [], id, { role: "inbox" });
const statusCalls = () => backend.calls("status").length;
const listCalls = () => backend.calls("list").length;

beforeEach(() => setup());
afterEach(() => engine.stop());

describe("sync engine: fingerprints", () => {
  it("the first status is only a baseline", async () => {
    backend.add("a", fakeMessage("m1", day(1)));
    await prime();
    const before = listCalls();
    await engine.syncNow();
    expect(events).toEqual([]);
    expect(listCalls()).toBe(before);
    expect(statusCalls()).toBe(1);
  });

  it("an unchanged fingerprint fetches nothing", async () => {
    backend.add("a", fakeMessage("m1", day(1)));
    await prime();
    await engine.syncNow();
    const before = backend.requests.length;
    await engine.syncNow();
    expect(backend.requests.length).toBe(before + 1); // one status, nothing else
    expect(events).toEqual([]);
  });

  it("new mail: refetches page 1 and emits new_mail with the rows", async () => {
    backend.add("a", fakeMessage("m1", day(1)));
    await prime();
    await engine.syncNow();
    backend.add("a", fakeMessage("m2", day(2)), fakeMessage("m3", day(3)));
    await engine.syncNow();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.type === "new_mail" && ev.rows.map((r) => r.key)).toEqual(["a:m3", "a:m2"]);
    // Counts come from the same status call: the sidebar, title and badge follow.
    expect(inboxEntry("a")).toMatchObject({ total_messages: 3, unread_messages: 3 });
  });

  it("all inboxes are asked in one request", async () => {
    await setup(["a", "b", "c"]);
    await prime();
    const before = backend.requests.length;
    await engine.syncNow();
    const mine = backend.requests.slice(before);
    expect(mine.map((r) => r.path)).toEqual(["/mail/batch"]);
    expect((mine[0]?.body as { calls: { op: string }[] }).calls.map((c) => c.op)).toEqual(["status", "status", "status"]);
  });

  it("flags changed elsewhere become flags_changed", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)));
    await prime();
    await engine.syncNow();
    backend.call({ op: "flag", inbox_id: "a", args: { message_ids: ["m1"], read: true, starred: true } });
    await engine.syncNow();
    expect(events).toEqual([
      { type: "flags_changed", keys: ["a:m1"], flags: { read: true } },
      { type: "flags_changed", keys: ["a:m1"], flags: { starred: true } },
    ]);
  });

  it("mail that left the folder elsewhere becomes moved", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)));
    await prime();
    await engine.syncNow();
    backend.call({ op: "archive", inbox_id: "a", args: { message_ids: ["m2"] } });
    await engine.syncNow();
    expect(events).toEqual([{ type: "moved", keys: ["a:m2"], to: null, from: { role: "inbox" } }]);
  });

  it("an older row sliding into page 1 is not new mail", async () => {
    await setup(["a"], 2);
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)), fakeMessage("m3", day(3)));
    await prime(2);
    expect(cachedRows().map((r) => r.id)).toEqual(["m3", "m2"]);
    await engine.syncNow();
    backend.call({ op: "delete", inbox_id: "a", args: { message_ids: ["m3"] } });
    await engine.syncNow();
    expect(events).toEqual([{ type: "moved", keys: ["a:m3"], to: null, from: { role: "inbox" } }]);
  });

  it("a change in another folder marks its cached lists stale, without fetching", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("s1", day(1), { folder: "Sent" }));
    await prime();
    const sentKey = keys.messages(listMeta("all", { role: "sent" }));
    queryClient.setQueryData<ListData>(sentKey, {
      pages: [await api.listMessages({ scope: "all", folder: { role: "sent" }, limit: 50 })],
      pageParams: [null],
    });
    await engine.syncNow();
    const before = listCalls();
    backend.add("a", fakeMessage("s2", day(2), { folder: "Sent" }));
    await engine.syncNow();
    expect(queryClient.getQueryState(sentKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(keys.messages(listMeta("all", { role: "inbox" })))?.isInvalidated).toBe(false);
    expect(listCalls()).toBe(before);
    expect(events).toEqual([]);
  });

  it("asks only about folders the UI shows: inbox, drafts, cached lists, custom folders", async () => {
    backend.customFolders.set("a", [{ id: "F1", name: "Receipts", type: "folder", total_messages: 0, unread_messages: 0 }]);
    backend.add("a", fakeMessage("m1", day(1)));
    // Before the folder list is known: the inbox, by alias.
    expect(statusFoldersFor("a")).toEqual(["inbox"]);
    await prime();
    expect(statusFoldersFor("a")).toEqual(["INBOX", "Drafts", "F1"]);
    queryClient.setQueryData<ListData>(keys.messages(listMeta("all", { role: "sent" })), {
      pages: [await api.listMessages({ scope: "all", folder: { role: "sent" }, limit: 50 })],
      pageParams: [null],
    });
    expect(statusFoldersFor("a")).toEqual(["INBOX", "Drafts", "Sent", "F1"]);
    expect(statusFoldersFor("a", 2)).toEqual(["INBOX", "Drafts"]);
    await engine.syncNow();
    expect(backend.calls("status").at(-1)?.args).toEqual({ folders: ["INBOX", "Drafts", "Sent", "F1"] });
  });

  it("a folder asked about for the first time is a baseline, not a change", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("s1", day(1), { folder: "Sent" }));
    await prime();
    await engine.syncNow();
    const sentKey = keys.messages(listMeta("all", { role: "sent" }));
    queryClient.setQueryData<ListData>(sentKey, {
      pages: [await api.listMessages({ scope: "all", folder: { role: "sent" }, limit: 50 })],
      pageParams: [null],
    });
    await engine.syncNow();
    expect(queryClient.getQueryState(sentKey)?.isInvalidated).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("sync engine: the user's own changes", () => {
  it("an own archive never comes back as news", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)), fakeMessage("m3", day(3)));
    await prime();
    engine.start();
    await flush();
    expect(statusCalls()).toBe(1);

    // What mail-actions does: the cache first, then the server.
    removeMovedRows(["a:m2"], { role: "archive" });
    await api.archiveMessages(["a:m2"]);
    // The engine was poked: counts are confirmed shortly after.
    expect(env.run(800)).toBe(1);
    await flush();
    expect(statusCalls()).toBe(2);
    // The changed fingerprint was expected: nothing fetched, nothing announced.
    expect(listCalls()).toBe(1);
    expect(events).toEqual([]);
    expect(inboxEntry("a")).toMatchObject({ total_messages: 2 });

    // The next regular run looks properly, and still finds nothing to say.
    await engine.syncNow();
    expect(listCalls()).toBe(2);
    expect(events).toEqual([]);
    // And after that the baseline is current: no more fetching.
    await engine.syncNow();
    expect(listCalls()).toBe(2);
  });

  it("undoing a move on IMAP (new ids) is not announced as new mail", async () => {
    backend.renumberOnMove = true;
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)));
    await prime();
    engine.start();
    await flush();
    const { moved } = await api.archiveMessages(["a:m2"]);
    // Undo: the snapshot (old key) is back in the cache, the server has a third id.
    await api.moveMessages([moved[0]?.new_key ?? "a:x"], { role: "inbox" });
    await engine.syncNow();
    await engine.syncNow();
    expect(events.filter((e) => e.type === "new_mail")).toEqual([]);
    expect(events.filter((e) => e.type === "moved")).toEqual([]);
  });

  it("real new mail that arrives next to an own change is still announced", async () => {
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)));
    await prime();
    engine.start();
    await flush();
    removeMovedRows(["a:m2"], { role: "archive" });
    await api.archiveMessages(["a:m2"]);
    backend.add("a", fakeMessage("m9", day(9)));
    await engine.syncNow(); // may still include our own change: baseline kept
    await engine.syncNow();
    const fresh = events.filter((e) => e.type === "new_mail");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.type === "new_mail" && fresh[0].rows.map((r) => r.id)).toEqual(["m9"]);
    expect(events.filter((e) => e.type === "moved")).toEqual([]);
  });

  it("events it emits do not poke it back", async () => {
    backend.add("a", fakeMessage("m1", day(1)));
    await prime();
    engine.start();
    await flush();
    api.subscribe(() => engine.poke()); // what refreshFolders() does on an event
    backend.add("a", fakeMessage("m2", day(2)));
    await engine.syncNow();
    expect(events).toHaveLength(1);
    expect(env.timers.filter((t) => t.ms === 800)).toHaveLength(0);
  });
});

describe("sync engine: when it runs", () => {
  it("runs at start, then every 45 s while visible", async () => {
    engine.start();
    await flush();
    expect(statusCalls()).toBe(1);
    expect(env.timers.map((t) => t.ms)).toEqual([45_000]);
    env.run(45_000);
    await flush();
    expect(statusCalls()).toBe(2);
    expect(env.timers.map((t) => t.ms)).toEqual([45_000]);
  });

  it("is paused while hidden and catches up when visible again", async () => {
    env.state.visible = false;
    engine.start();
    await flush();
    expect(statusCalls()).toBe(0);
    expect(env.timers).toHaveLength(0);

    env.state.visible = true;
    env.change();
    await flush();
    expect(statusCalls()).toBe(1);

    // Hidden again: the interval is dropped, not left ticking.
    env.state.visible = false;
    env.change();
    expect(env.timers).toHaveLength(0);
  });

  it("is paused while offline", async () => {
    env.state.online = false;
    engine.start();
    await flush();
    expect(statusCalls()).toBe(0);
    env.state.online = true;
    env.change();
    await flush();
    expect(statusCalls()).toBe(1);
  });

  it("focus events close together share one run", async () => {
    engine.start();
    await flush();
    env.change();
    env.change();
    await flush();
    expect(statusCalls()).toBe(1);
    env.state.now += 6000;
    env.change();
    await flush();
    expect(statusCalls()).toBe(2);
  });

  it("backs off when status keeps failing, and recovers", async () => {
    backend.failNext({ op: "status" }, { code: "provider_error", retryable: false }, 2);
    engine.start();
    await flush();
    expect(env.timers.map((t) => t.ms)).toEqual([90_000]);
    env.run(90_000);
    await flush();
    expect(env.timers.map((t) => t.ms)).toEqual([180_000]);
    env.run(180_000);
    await flush();
    expect(env.timers.map((t) => t.ms)).toEqual([45_000]);
  });

  it("stop cancels timers and forgets its baseline", async () => {
    backend.add("a", fakeMessage("m1", day(1)));
    await prime();
    engine.start();
    await flush();
    engine.stop();
    expect(env.timers).toHaveLength(0);
    backend.add("a", fakeMessage("m2", day(2)));
    engine.start();
    await flush();
    // A fresh baseline: what changed while stopped is not replayed as news.
    expect(events).toEqual([]);
  });
});

describe("diffFirstPage", () => {
  const row = (id: string, date: string, patch: Partial<MessageRow> = {}): MessageRow => ({
    id,
    key: `a:${id}`,
    inbox_id: "a",
    from: { name: "", email: "x@y.z" },
    to: [],
    subject: id,
    date,
    preview: "",
    is_read: false,
    is_starred: false,
    has_attachments: false,
    folder: "INBOX",
    folder_role: "inbox",
    thread_id: id,
    ...patch,
  });
  const none = () => false;

  it("with an empty cache everything on page 1 is new", () => {
    const d = diffFirstPage({ rows: [row("1", day(2))], has_more: false }, [], { own: none, settled: true });
    expect(d.fresh.map((r) => r.id)).toEqual(["1"]);
  });

  it("does not report cached rows below the page as removed", () => {
    const cached = [row("3", day(3)), row("2", day(2)), row("1", day(1))];
    const d = diffFirstPage({ rows: [row("3", day(3)), row("2", day(2))], has_more: true }, cached, { own: none, settled: true });
    expect(d).toEqual({ fresh: [], flags: [], removed: [] });
  });

  it("while a change of ours is unsettled, flags and removals are left alone", () => {
    const cached = [row("2", day(2), { is_read: true }), row("1", day(1))];
    const d = diffFirstPage({ rows: [row("2", day(2))], has_more: false }, cached, { own: none, settled: false });
    expect(d).toEqual({ fresh: [], flags: [], removed: [] });
  });
});
