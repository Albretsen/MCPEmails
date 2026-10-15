import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, type MessageKey, makeKey } from "../types";
import { ApiClient, type ApiClientOptions, ApiError, REFUSED_RECHECK_MS, isAbortError } from "./client";
import { FakeBackend, fakeInbox, fakeMessage, fakeThreadMessage } from "./fake-backend";
import { HttpMailApi, base64Bytes, filenameFromDisposition, parseMoveResult } from "./http-mail-api";

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T12:00:00Z`;

function setup(opts: { inboxes?: string[]; client?: Partial<ApiClientOptions>; wrapFetch?: (real: typeof fetch) => typeof fetch } = {}) {
  const ids = opts.inboxes ?? ["a"];
  const backend = new FakeBackend(ids.map((id) => fakeInbox(id, `${id}@example.com`, id === "imap" ? "imap" : "gmail")));
  const state = { token: "tok-1" as string | null, refreshed: 0, authFailures: 0, online: true, slept: [] as number[] };
  let keySeq = 0;
  const client = new ApiClient({
    baseUrl: "https://api.test/functions/v1/client-api",
    getToken: async () => state.token,
    refreshToken: async () => {
      state.refreshed++;
      state.token = "tok-2";
      return state.token;
    },
    onAuthFailure: () => {
      state.authFailures++;
    },
    getWorkspaceId: () => "ws-1",
    isOnline: () => state.online,
    fetch: opts.wrapFetch ? opts.wrapFetch(backend.fetch) : backend.fetch,
    sleep: async (ms) => {
      state.slept.push(ms);
    },
    random: () => 0.5,
    ...opts.client,
  });
  const api = new HttpMailApi({ client, newId: () => `key-${++keySeq}` });
  return { backend, client, api, state };
}

describe("ApiClient: auth", () => {
  it("sends the bearer token and the workspace header", async () => {
    const { backend, api } = setup();
    await api.getSession();
    const req = backend.requests[0];
    expect(req?.headers.authorization).toBe("Bearer tok-1");
    expect(req?.headers["x-workspace-id"]).toBe("ws-1");
  });

  it("refreshes once on 401 and retries the request", async () => {
    const { backend, api, state } = setup();
    backend.tokens = new Set(["tok-2"]);
    const s = await api.getSession();
    expect(s.user.id).toBe("user-1");
    expect(state.refreshed).toBe(1);
    expect(state.authFailures).toBe(0);
    expect(backend.count("/session")).toBe(2);
  });

  it("concurrent 401s share one refresh", async () => {
    const { backend, api, state } = setup({ inboxes: ["a", "b"] });
    backend.tokens = new Set(["tok-2"]);
    await Promise.all([api.getSession(), api.setFlags([makeKey("a", "x")], { read: true }), api.setFlags([makeKey("b", "y")], { read: true })]);
    expect(state.refreshed).toBe(1);
  });

  it("signs out when the refresh does not help", async () => {
    const { backend, api, state } = setup();
    backend.tokens = new Set(["nothing-valid"]);
    await expect(api.getSession()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(state.refreshed).toBe(1);
    expect(state.authFailures).toBe(1);
  });

  it("signs out when there is no token at all", async () => {
    const { api, state, backend } = setup();
    state.token = null;
    await expect(api.getSession()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(state.authFailures).toBe(1);
    expect(backend.requests).toHaveLength(0);
  });
});

describe("ApiClient: errors, retries, timeouts", () => {
  it("maps the error envelope to a typed error", async () => {
    const { backend, api } = setup();
    backend.failNext({ op: "folders" }, { code: "reconnect_required", message: "reconnect", retryable: false });
    const err = await api.listFolders("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "reconnect_required", retryable: false });
    expect(backend.calls("folders")).toHaveLength(1);
  });

  it("a refused mailbox is not asked again by reads; `status` asks again after a while", async () => {
    let now = 1_000_000;
    const seen: [string, boolean][] = [];
    const { backend, api, client } = setup({ client: { now: () => now, onInboxAuth: (id, bad) => seen.push([id, bad]) } });
    backend.failNext({ op: "folders" }, { code: "reconnect_required", message: "reconnect", retryable: false });
    await expect(api.listFolders("a")).rejects.toMatchObject({ code: "reconnect_required" });
    const sent = backend.requests.length;
    // Answered here: no request, the same typed error.
    await expect(api.listFolders("a")).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(client.read("list", "a", { folder: "inbox" })).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(client.read("status", "a", {})).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.requests).toHaveLength(sent);
    // Later, `status` alone goes to the server; its success clears the refusal.
    now += REFUSED_RECHECK_MS;
    await expect(client.read("list", "a", { folder: "inbox" })).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.requests).toHaveLength(sent);
    await client.read("status", "a", {});
    expect(backend.requests).toHaveLength(sent + 1);
    await api.listFolders("a");
    expect(seen).toEqual([["a", true], ["a", false], ["a", false]]);
  });

  it("the session's per-inbox status decides, over what was remembered: down is never asked (the probe aside), ok is asked again", async () => {
    let now = 1_000_000;
    const { backend, api, client } = setup({ inboxes: ["a", "b"], client: { now: () => now } });
    backend.add("b", fakeMessage("n1", day(1)));
    // Remembered from an earlier load as refused; the server says it is fine.
    client.seedRefused(["a"]);
    backend.setInboxStatus("b", "reconnect_required", "access_revoked");
    const s = await api.getSession();
    // Listed after the mailboxes that work, with the server's reason.
    expect(s.inboxes.map((i) => [i.inbox_id, i.status, i.status_reason, i.sender_identity_status])).toEqual([
      ["a", "ok", null, "available"],
      ["b", "reconnect_required", "access_revoked", "unavailable"],
    ]);
    const sent = backend.requests.length;
    await client.read("list", "a", { folder: "inbox" });
    expect(backend.requests).toHaveLength(sent + 1);
    // b: reads and mutations are answered here, with no request.
    await expect(client.read("list", "b", { folder: "inbox" })).rejects.toMatchObject({ code: "reconnect_required", status: 409 });
    await expect(client.mutate("flag", "b", { message_ids: ["n1"], read: true })).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(api.sendMessage({ inbox_id: "b", to: [{ name: "", email: "x@example.com" }], subject: "s", body_text: "b" })).rejects.toMatchObject({
      code: "reconnect_required",
    });
    await expect(client.read("status", "b", {})).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.requests).toHaveLength(sent + 1);
    expect(backend.refusedCalls).toHaveLength(0);
    // The periodic probe still goes out, and a later session does not push it back.
    now += REFUSED_RECHECK_MS - 1000;
    await api.getSession();
    now += 1000;
    await expect(client.read("status", "b", {})).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.refusedCalls.map((c) => c.op)).toEqual(["status"]);
    // Reconnected: the probe succeeds and the session is corrected at once.
    backend.setInboxStatus("b", "ok");
    client.recheckRefused();
    await client.read("status", "b", {});
    expect(api.markInboxOk("b")?.inboxes.find((i) => i.inbox_id === "b")).toMatchObject({ status: "ok", status_reason: null });
    expect(api.markInboxOk("b")).toBeNull();
    const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(page.failed_inboxes).toBeUndefined();
    expect(page.rows.map((r) => r.key)).toEqual(["b:n1"]);
  });

  it("sender_identity: mail works and is asked for as usual; `error` rows answer inbox_unavailable", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b", "c"] });
    backend.add("a", fakeMessage("m1", day(2)));
    backend.add("b", fakeMessage("n1", day(1)));
    backend.setInboxStatus("a", "reconnect_required", "sender_identity");
    backend.setInboxStatus("c", "error", "unavailable");
    const s = await api.getSession();
    expect(s.inboxes.map((i) => i.inbox_id)).toEqual(["a", "b", "c"]);
    expect(s.inboxes[0]).toMatchObject({ status: "reconnect_required", status_reason: "sender_identity", sender_identity_status: "reconnect_required" });
    const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(page.rows.map((r) => r.key)).toEqual(["a:m1", "b:n1"]);
    expect(page.failed_inboxes).toEqual([{ inbox_id: "c", code: "inbox_unavailable", message: "This mailbox is unavailable." }]);
    await expect(api.listMessages({ scope: "c", folder: { role: "inbox" }, limit: 50 })).rejects.toMatchObject({ code: "inbox_unavailable" });
    expect(backend.calls().some((c) => c.inbox_id === "c")).toBe(false);
  });

  it("a server that sends no per-inbox status: what the client remembered stands", async () => {
    const { backend, api, client } = setup();
    backend.inboxes = backend.inboxes.map(({ status: _s, status_reason: _r, ...rest }) => rest);
    client.seedRefused(["a"]);
    await api.getSession();
    await expect(client.read("list", "a", { folder: "inbox" })).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.count("/mail")).toBe(0);
  });

  it("a mailbox remembered as refused: reads answer at once, the first `status` asks the server", async () => {
    const { backend, client } = setup();
    client.seedRefused(["a"]);
    await expect(client.read("list", "a", { folder: "inbox" })).rejects.toMatchObject({ code: "reconnect_required" });
    expect(backend.requests).toHaveLength(0);
    await client.read("status", "a", {});
    expect(backend.requests).toHaveLength(1);
    await client.read("list", "a", { folder: "inbox" });
    expect(backend.requests).toHaveLength(2);
  });

  it("one refusal ends the mailbox's other reads in flight", async () => {
    const { backend } = setup();
    let release: () => void = () => {};
    const real = backend.fetch;
    let n = 0;
    // The first request is refused at once; the others never answer.
    const slow = new Promise<void>((r) => (release = r));
    const c2 = new ApiClient({
      baseUrl: "https://api.test/functions/v1/client-api",
      getToken: async () => "tok-1",
      refreshToken: async () => null,
      socket: false,
      defer: (fn) => fn(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (n++ > 0) await slow;
        return real(input, init);
      }) as typeof fetch,
    });
    backend.failNext({ op: "status" }, { code: "reconnect_required", message: "reconnect", retryable: false });
    const status = c2.read("status", "a", {}).catch((e: unknown) => e);
    const list = c2.read("list", "a", { folder: "inbox" }).catch((e: unknown) => e);
    expect(await status).toMatchObject({ code: "reconnect_required" });
    expect(await list).toMatchObject({ code: "reconnect_required" });
    release();
  });

  it("retries a retryable read with jittered backoff, then succeeds", async () => {
    const { backend, api, state } = setup();
    backend.failNext({ op: "folders" }, { code: "provider_error", retryable: true }, 2);
    const folders = await api.listFolders("a");
    expect(folders.length).toBeGreaterThan(0);
    expect(backend.calls("folders")).toHaveLength(3);
    // base 400 ms, random 0.5 -> 1x: 400, then 800.
    expect(state.slept).toEqual([400, 800]);
  });

  it("gives up after the retry budget", async () => {
    const { backend, api } = setup();
    backend.failNext({ op: "folders" }, { code: "provider_error", retryable: true }, 10);
    await expect(api.listFolders("a")).rejects.toMatchObject({ code: "provider_error" });
    expect(backend.calls("folders")).toHaveLength(3);
  });

  it("never retries a mutation, even on a retryable error", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(1)));
    backend.failNext({ op: "flag" }, { code: "provider_error", retryable: true }, 5);
    await expect(api.setFlags([makeKey("a", "m1")], { read: true })).rejects.toMatchObject({ code: "provider_error" });
    expect(backend.calls("flag")).toHaveLength(1);
  });

  it("times out a request that never answers", async () => {
    const { backend, api } = setup({ client: { timeoutMs: 20, maxRetries: 0 } });
    backend.hold = new Promise(() => {});
    await expect(api.listFolders("a")).rejects.toMatchObject({ code: "timeout", retryable: false });
    expect(backend.calls("folders")).toHaveLength(1);
  });

  it("offline: mutations and reads fail fast without a request", async () => {
    const { backend, api, state } = setup();
    state.online = false;
    await expect(api.setFlags([makeKey("a", "m1")], { read: true })).rejects.toMatchObject({ code: "offline" });
    await expect(api.listFolders("a")).rejects.toMatchObject({ code: "offline" });
    expect(backend.requests).toHaveLength(0);
  });

  it("aborts with an AbortError and stops the request", async () => {
    const { backend, api } = setup();
    backend.hold = new Promise(() => {});
    const c = new AbortController();
    const p = api.listFolders("a", c.signal);
    await new Promise((r) => setTimeout(r, 5));
    c.abort();
    expect(isAbortError(await p.catch((e: unknown) => e))).toBe(true);
  });
});

describe("ApiClient: de-duplication and batching", () => {
  it("identical reads in flight share one call", async () => {
    const { backend, api } = setup();
    const [x, y] = await Promise.all([api.listFolders("a"), api.listFolders("a")]);
    expect(x).toEqual(y);
    expect(backend.calls("folders")).toHaveLength(1);
  });

  it("one caller aborting does not cancel the other", async () => {
    const { backend, api } = setup();
    const c = new AbortController();
    const p1 = api.listFolders("a", c.signal);
    const p2 = api.listFolders("a");
    c.abort();
    expect(isAbortError(await p1.catch((e: unknown) => e))).toBe(true);
    expect((await p2).length).toBeGreaterThan(0);
    expect(backend.calls("folders")).toHaveLength(1);
  });

  it("reads issued in the same tick go out as one batch", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b", "c"] });
    await Promise.all([
      api.listDrafts("a"),
      api.listDrafts("b"),
      api.listDrafts("c"),
      api.getStatus([{ inbox_id: "a" }, { inbox_id: "b" }, { inbox_id: "c" }]),
    ]);
    expect(backend.count("/mail/batch")).toBe(1);
    expect(backend.count("/mail")).toBe(0);
    expect(backend.calls()).toHaveLength(6);
  });

  it("slow reads (folder lists) travel apart, so lists never wait for them", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    await Promise.all([
      api.listFolders("a"),
      api.listFolders("b"),
      api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 }),
    ]);
    const batches = backend.requests.filter((r) => r.path === "/mail/batch").map((r) => (r.body as { calls: { op: string }[] }).calls.map((c) => c.op));
    expect(batches.sort()).toEqual([
      ["folders", "folders"],
      ["list", "list"],
    ]);
  });

  it("a single read is not wrapped in a batch", async () => {
    const { backend, api } = setup();
    await api.listFolders("a");
    expect(backend.count("/mail")).toBe(1);
    expect(backend.count("/mail/batch")).toBe(0);
  });

  it("splits more than 12 reads into several batches", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `i${i}`);
    const { backend, api } = setup({ inboxes: ids });
    await Promise.all(ids.map((id) => api.listFolders(id)));
    const batches = backend.requests.filter((r) => r.path === "/mail/batch").map((r) => (r.body as { calls: unknown[] }).calls.length);
    expect(batches).toEqual([12, 2]);
  });

  it("one failed call in a batch fails only its own promise", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.failNext({ op: "folders", inbox_id: "b" }, { code: "reconnect_required" });
    const [a, b] = await Promise.allSettled([api.listFolders("a"), api.listFolders("b")]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: { code: "reconnect_required" } });
  });

  it("reset aborts what is in flight", async () => {
    const { backend, api } = setup();
    backend.hold = new Promise(() => {});
    const p = api.listFolders("a");
    await new Promise((r) => setTimeout(r, 5));
    api.reset();
    expect(isAbortError(await p.catch((e: unknown) => e))).toBe(true);
  });
});

describe("HttpMailApi: lists", () => {
  it("maps is_flagged to is_starred and attaches key, inbox and role", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(2), { is_flagged: true }), fakeMessage("m2", day(1)));
    const page = await api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 50 });
    expect(page.rows.map((r) => [r.key, r.is_starred, r.folder_role, r.inbox_id])).toEqual([
      ["a:m1", true, "inbox", "a"],
      ["a:m2", false, "inbox", "a"],
    ]);
    expect(backend.calls("list")[0]?.args).toEqual({ folder: "inbox", limit: 50, offset: 0 });
  });

  it("merges the unified inbox by date with per-inbox cursors", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.add("a", fakeMessage("a1", day(9)), fakeMessage("a2", day(7)), fakeMessage("a3", day(1)));
    backend.add("b", fakeMessage("b1", day(8)), fakeMessage("b2", day(6)), fakeMessage("b3", day(5)));
    const seen: string[] = [];
    let cursor = null;
    for (let i = 0; i < 6; i++) {
      const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    }
    // Strictly newest first across both inboxes, nothing lost or repeated.
    expect(seen).toEqual(["a1", "b1", "a2", "b2", "b3", "a3"]);
  });

  it("shows the other inboxes when one fails, and says which", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.add("a", fakeMessage("a1", day(3)));
    backend.add("b", fakeMessage("b1", day(2)));
    backend.failNext({ op: "list", inbox_id: "b" }, { code: "reconnect_required", message: "reconnect" });
    const page = await api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 });
    expect(page.rows.map((r) => r.id)).toEqual(["a1"]);
    expect(page.failed_inboxes).toEqual([{ inbox_id: "b", code: "reconnect_required", message: "reconnect" }]);
    expect(page.total).toBeNull();
  });

  it("fails the list only when every inbox fails", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.failNext({ op: "list" }, { code: "provider_error" }, 2);
    await expect(api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 })).rejects.toMatchObject({ code: "provider_error" });
  });

  it("starred is a flagged search", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(2), { is_flagged: true }), fakeMessage("m2", day(1)));
    const page = await api.listMessages({ scope: "a", folder: { role: "starred" }, limit: 50 });
    expect(page.rows.map((r) => r.id)).toEqual(["m1"]);
    expect(backend.calls("search")[0]?.args).toEqual({ flagged: true, limit: 50, offset: 0 });
  });

  it("search sends the query as the structured text filter", async () => {
    const { backend, api } = setup({ inboxes: ["a", "imap"] });
    backend.add("a", fakeMessage("m1", day(2), { subject: "Invoice 42" }));
    const page = await api.searchMessages({ scope: "all", query: " invoice ", limit: 25 });
    expect(page.rows.map((r) => r.id)).toEqual(["m1"]);
    const calls = backend.calls("search");
    expect(calls.find((c) => c.inbox_id === "a")?.args).toEqual({ text: "invoice", limit: 25, offset: 0 });
    expect(calls.find((c) => c.inbox_id === "imap")?.args.include_folders).toEqual(["inbox", "archive", "sent"]);
  });

  it("a folder by name is skipped in inboxes that do not have it", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.customFolders.set("a", [{ id: "F1", name: "Receipts", type: "folder", total_messages: 0, unread_messages: 0 }]);
    backend.add("a", fakeMessage("r1", day(2), { folder: "F1" }));
    const page = await api.listMessages({ scope: "all", folder: { name: "receipts" }, limit: 50 });
    expect(page.rows.map((r) => r.key)).toEqual(["a:r1"]);
    expect(page.failed_inboxes).toBeUndefined();
    expect(backend.calls("list")).toHaveLength(1);
  });

  it("drafts are listed from the draft list, scheduled from the schedule list", async () => {
    const { backend, api } = setup();
    const ref = await api.createDraft({ inbox_id: "a", to: [{ name: "", email: "x@y.z" }], subject: "Hi", body_text: "..." });
    const drafts = await api.listMessages({ scope: "all", folder: { role: "drafts" }, limit: 50 });
    expect(drafts.rows.map((r) => [r.id, r.folder_role])).toEqual([[ref.draft_id, "drafts"]]);
    const s = await api.scheduleSend({ inbox_id: "a", to: [{ name: "", email: "x@y.z" }], subject: "Later", body_text: "b", send_at: day(20) });
    const scheduled = await api.listMessages({ scope: "all", folder: { role: "scheduled" }, limit: 50 });
    expect(scheduled.rows.map((r) => [r.id, r.folder_role, r.date])).toEqual([[s.id, "scheduled", day(20)]]);
    expect(backend.calls("schedule_create")[0]?.args.send_at).toBe(day(20));
  });

  it("reading keeps the star and folder the list reported", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(2), { is_flagged: true }));
    await api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 50 });
    const d = await api.readMessage("a", "m1", { include_html: true });
    expect(d).toMatchObject({ key: "a:m1", is_starred: true, folder: "INBOX", folder_role: "inbox", body_html: "<p>Body m1</p>" });
    expect(backend.calls("read")[0]?.args).toEqual({ message_id: "m1", include_html: true, include_attachments: false, body_max_chars: 2_000_000 });
  });
});

describe("HttpMailApi: mutations", () => {
  it("groups keys by inbox: one call per inbox", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    backend.add("a", fakeMessage("a1", day(1)), fakeMessage("a2", day(2)));
    backend.add("b", fakeMessage("b1", day(1)));
    await api.setFlags(["a:a1", "a:a2", "b:b1"], { read: true, starred: true });
    const calls = backend.calls("flag");
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.inbox_id === "a")?.args).toEqual({ message_ids: ["a1", "a2"], read: true, starred: true });
  });

  it("returns the ids messages have after a move", async () => {
    const { backend, api } = setup();
    backend.renumberOnMove = true;
    backend.add("a", fakeMessage("m1", day(1)), fakeMessage("m2", day(2)));
    const result = await api.archiveMessages(["a:m1", "a:m2"]);
    expect(result.moved.map((m) => m.key)).toEqual(["a:m1", "a:m2"]);
    for (const m of result.moved) expect(m.new_key).not.toBe(m.key);
    // The new key is usable: moving it back works and yields yet another id.
    const back = await api.moveMessages(
      result.moved.map((m) => m.new_key),
      { role: "inbox" },
    );
    expect(back.moved).toHaveLength(2);
    expect(backend.calls("move")[0]?.args.destination_folder_id).toBe("inbox");
  });

  it("keeps the key when the provider does not change ids", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(1)));
    const result = await api.deleteMessages(["a:m1"]);
    expect(result.moved).toEqual([{ key: "a:m1", new_key: "a:m1" }]);
    expect(backend.calls("delete")[0]?.args).toEqual({ message_ids: ["m1"], permanent: false });
  });

  it("rejects a move across inboxes without calling the server", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    await expect(api.moveMessages(["a:m1"], { inbox_id: "b", folder_id: "INBOX" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(backend.requests).toHaveLength(0);
  });

  it("a partly refused move is an error (the caller rolls back and refetches)", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeMessage("m1", day(1)));
    await expect(api.archiveMessages(["a:m1", "a:gone"])).rejects.toMatchObject({ code: "partial_failure" });
  });

  it("tells mutation listeners which keys were touched, old and new", async () => {
    const { backend, api } = setup();
    backend.renumberOnMove = true;
    backend.add("a", fakeMessage("m1", day(1)));
    const seen: { phase: string; keys: MessageKey[] }[] = [];
    api.onMutation((m) => seen.push({ phase: m.phase, keys: m.keys }));
    const { moved } = await api.archiveMessages(["a:m1"]);
    expect(seen).toEqual([
      { phase: "start", keys: ["a:m1"] },
      { phase: "end", keys: ["a:m1", moved[0]?.new_key] },
    ]);
  });
});

describe("HttpMailApi: sending", () => {
  const to = [{ name: "Maya", email: "maya@example.com" }];

  it("sends recipients as plain addresses with an idempotency key", async () => {
    const { backend, api } = setup();
    const r = await api.sendMessage({ inbox_id: "a", to, subject: "Hi", body_text: "Hello" });
    expect(r.inbox_id).toBe("a");
    expect(backend.calls("send")[0]?.args).toMatchObject({ to: ["maya@example.com"], subject: "Hi", body: "Hello", idempotency_key: "key-1" });
  });

  it("a retried send with the same key is delivered once", async () => {
    // The first answer is lost on the way back: the server did send.
    let dropped = false;
    const { backend, api } = setup({
      wrapFetch: (real) => async (input, init) => {
        const res = await real(input, init);
        if (!dropped && String(init?.body ?? "").includes('"op":"send"')) {
          dropped = true;
          throw new TypeError("network dropped");
        }
        return res;
      },
    });
    const input = { inbox_id: "a", to, subject: "Hi", body_text: "Hello", idempotency_key: "send-1" };
    await expect(api.sendMessage(input)).rejects.toMatchObject({ code: "network", retryable: true });
    // Not retried automatically: exactly one request so far.
    expect(backend.calls("send")).toHaveLength(1);
    await api.sendMessage(input);
    expect(backend.calls("send").map((c) => c.args.idempotency_key)).toEqual(["send-1", "send-1"]);
    expect(backend.delivered).toHaveLength(1);
  });

  it("a different send gets a different key", async () => {
    const { backend, api } = setup();
    await api.sendMessage({ inbox_id: "a", to, subject: "One", body_text: "1" });
    await api.replyToMessage({ key: "a:m1", body_text: "2" });
    await api.forwardMessage({ key: "a:m1", to, body_text: "3" });
    const keys = [...backend.calls("send"), ...backend.calls("reply"), ...backend.calls("forward")].map((c) => c.args.idempotency_key);
    expect(new Set(keys).size).toBe(3);
    expect(backend.calls("reply")[0]?.args).toMatchObject({ message_id: "m1", reply_all: false, body: "2" });
  });

  it("a reply is always the threaded reply op; an edited To line rides along as explicit lists", async () => {
    const { backend, api } = setup();
    // No `to`: the server derives the recipients, cc is an addition.
    await api.replyToMessage({ key: "a:m1", body_text: "ok", cc: [{ name: "", email: "c@example.com" }], subject: "Re: Hi" });
    expect(backend.calls("reply")[0]?.args).toMatchObject({ message_id: "m1", cc: ["c@example.com"] });
    expect(backend.calls("reply")[0]?.args.to).toBeUndefined();
    // With `to`: still `reply` (threaded), never an unthreaded `send`.
    await api.replyToMessage({ key: "a:m1", reply_all: true, body_text: "ok", to, cc: [], bcc: [{ name: "", email: "b@example.com" }], subject: "Re: Hi" });
    expect(backend.calls("send")).toHaveLength(0);
    expect(backend.calls("reply")).toHaveLength(2);
    expect(backend.calls("reply")[1]?.args).toMatchObject({ message_id: "m1", reply_all: true, to: ["maya@example.com"], bcc: ["b@example.com"], body: "ok" });
    expect(backend.calls("reply")[1]?.args.subject).toBeUndefined();
    expect(backend.delivered).toHaveLength(2);
  });

  it("files cannot be added to a forward: said before any request", async () => {
    const { backend, api } = setup();
    const err = await api
      .forwardMessage({ key: "a:m1", to, attachments: [{ filename: "a.txt", mime_type: "text/plain", data: "aGk=" }] })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/the file you added cannot be sent with it/);
    expect((err as ApiError).code).toBe("forward_attachments_unsupported");
    expect(backend.requests).toHaveLength(0);
  });

  it("uploads attachments as base64 parts", async () => {
    const { backend, api } = setup();
    await api.sendMessage({
      inbox_id: "a",
      to,
      subject: "File",
      body_text: "See attached",
      attachments: [{ filename: "a.txt", mime_type: "text/plain", data: btoa("hello") }],
    });
    expect(backend.calls("send")[0]?.args.attachments).toEqual([{ filename: "a.txt", mime_type: "text/plain", data: "aGVsbG8=" }]);
  });

  it("refuses more than 10 MB of attachments before any request", async () => {
    const { backend, api } = setup();
    const big = "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1024) * 4) / 3));
    const err = await api
      .sendMessage({ inbox_id: "a", to, subject: "Big", body_text: "", attachments: [{ filename: "big.bin", mime_type: "", data: big }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "attachments_too_large" });
    expect((err as Error).message).toMatch(/10 MB/);
    expect(backend.requests).toHaveLength(0);
  });

  it("downloads an attachment as a blob with its real file name", async () => {
    const { backend, api } = setup();
    const bytes = new TextEncoder().encode("PDF!");
    backend.add("a", fakeMessage("m1", day(1), { attachments: [{ filename: "Übersicht 2026.pdf", mime_type: "application/pdf", bytes }] }));
    const file = await api.downloadAttachment("a:m1", 0);
    expect(file.filename).toBe("Übersicht 2026.pdf");
    expect(file.mime_type).toBe("application/pdf");
    // The Blob is Node's or jsdom's depending on the runtime; only one of them has text().
    const blob = file.blob as Blob & { text?: () => Promise<string> };
    const text = typeof blob.text === "function"
      ? await blob.text()
      : await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(blob);
        });
    expect(text).toBe("PDF!");
    expect(backend.calls("attachment")[0]?.args).toEqual({ message_id: "m1", attachment_index: 0 });
  });
});

describe("HttpMailApi: drafts", () => {
  const input = (body: string) => ({ inbox_id: "a", to: [{ name: "", email: "x@y.z" }], subject: "S", body_text: body });

  it("a reply draft threads under its message; updates never resend that", async () => {
    const { backend, api } = setup();
    const ref = await api.createDraft({ ...input("1"), reply_to: "a:m1" });
    expect(backend.calls("draft_create")[0]?.args.message_id).toBe("m1");
    await api.updateDraft("a", ref.draft_id, { ...input("2"), reply_to: "a:m1" });
    expect(Object.keys(backend.calls("draft_update")[0]?.args ?? {}).sort()).toEqual(["bcc", "body", "cc", "draft_id", "subject", "to"]);
  });

  it("always uses the newest draft id, even when the caller still holds an old one", async () => {
    const { backend, api } = setup();
    const first = await api.createDraft(input("1"));
    // Two saves issued back to back with the SAME (soon stale) id.
    const [second, third] = await Promise.all([api.updateDraft("a", first.draft_id, input("2")), api.updateDraft("a", first.draft_id, input("3"))]);
    expect(second.draft_id).not.toBe(first.draft_id);
    expect(third.draft_id).not.toBe(second.draft_id);
    const ids = backend.calls("draft_update").map((c) => c.args.draft_id);
    expect(ids).toEqual([first.draft_id, second.draft_id]);
    expect([...(backend.drafts.get("a")?.values() ?? [])].map((d) => d.body)).toEqual(["3"]);
    // Deleting by the oldest id still deletes the live draft.
    await api.deleteDraft("a", first.draft_id);
    expect(backend.drafts.get("a")?.size).toBe(0);
  });
});

describe("HttpMailApi: session", () => {
  it("serves inboxes and the first allowance read from /session", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    // All three are asked for at once, as the panes do on mount.
    const [inboxes, allowance] = await Promise.all([api.listInboxes(), api.getAssistantAllowance(), api.getSession()]);
    expect(inboxes.map((i) => i.inbox_id)).toEqual(["a", "b"]);
    expect(allowance.cap).toBe(1000);
    expect(backend.count("/session")).toBe(1);
    expect(backend.count("/allowance")).toBe(0);
    await api.getAssistantAllowance();
    expect(backend.count("/allowance")).toBe(1);
  });

  it("cold boot with 3 inboxes: /session, then one batch", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b", "c"] });
    for (const id of ["a", "b", "c"]) backend.add(id, fakeMessage(`${id}1`, day(1)));
    api.onSession((s) => {
      // What app/backend.ts does when the session lands: folders + status.
      for (const i of s.inboxes) void api.listFolders(i.inbox_id);
      void api.getStatus(s.inboxes.map((i) => ({ inbox_id: i.inbox_id })));
    });
    const session = api.getSession();
    await Promise.all([
      session,
      api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 }),
      api.listScheduled(),
      api.listInboxes(),
    ]);
    await new Promise((r) => setTimeout(r, 5));
    // One request for what the first paint needs, one (in parallel, not
    // after it) for the folder lists.
    expect(backend.requests.map((r) => r.path)).toEqual(["/session", "/mail/batch", "/mail/batch"]);
    const batches = backend.requests.slice(1).map((r) => (r.body as { calls: { op: string }[] }).calls.map((c) => c.op).sort());
    expect(batches).toEqual([
      ["list", "list", "list", "schedule_list", "status", "status", "status"],
      ["folders", "folders", "folders"],
    ]);
  });

  it("warm boot: the cached session lets the first batch go out with /session, not after it", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b", "c"] });
    api.seedSession(backend.session());
    // Nothing answers until every request has been issued.
    let release = () => {};
    backend.hold = new Promise<void>((r) => {
      release = r;
    });
    const all = Promise.all([
      api.getSession(),
      api.listMessages({ scope: "all", folder: { role: "inbox" }, limit: 50 }),
      api.listScheduled(),
      api.getStatus([{ inbox_id: "a" }, { inbox_id: "b" }, { inbox_id: "c" }]),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(backend.requests.map((r) => r.path).sort()).toEqual(["/mail/batch", "/session"]);
    release();
    await all;
    expect(backend.requests).toHaveLength(2);
    expect(backend.calls().map((c) => c.op).sort()).toEqual(["list", "list", "list", "schedule_list", "status", "status", "status"]);
  });
});

describe("helpers", () => {
  it("reads the one move result shape", () => {
    const result = {
      succeeded: 3,
      failed: 0,
      results: [
        { message_id: "1", success: true, new_message_id: "9" },
        { message_id: "2", success: true, new_message_id: "2" },
        { message_id: "3", success: true, new_message_id: null },
      ],
    };
    expect(parseMoveResult("a", ["1", "2", "3"], result).moved).toEqual([
      { key: "a:1", new_key: "a:9" },
      { key: "a:2", new_key: "a:2" },
      { key: "a:3", new_key: "a:3", id_unknown: true },
    ]);
    // A refused row, a row the server did not report, and the retired shapes all mean "not moved".
    expect(() => parseMoveResult("a", ["1"], { results: [{ message_id: "1", success: false, error: "x" }] })).toThrow(ApiError);
    expect(() => parseMoveResult("a", ["1", "2"], { results: [{ message_id: "1", success: true, new_message_id: "1" }] })).toThrow(ApiError);
    expect(() => parseMoveResult("a", ["1"], { success: true, message_id: "1", new_message_id: "7" })).toThrow(ApiError);
    expect(() => parseMoveResult("a", ["1"], { new_message_ids: { "1": "8" } })).toThrow(ApiError);
    expect(() => parseMoveResult("a", ["1"], { plan_id: "p", status: "pending" })).toThrow(ApiError);
  });

  it("an IMAP move whose new id the server did not report is moved, not renamed, and marked as such", async () => {
    const { backend, api } = setup();
    backend.renumberOnMove = "unknown";
    backend.add("a", fakeMessage("m1", "2026-10-01T10:00:00Z"));
    const result = await api.archiveMessages(["a:m1"]);
    expect(result.moved).toEqual([{ key: "a:m1", new_key: "a:m1", id_unknown: true }]);
  });

  it("status: a folder the mailbox no longer has is reported as missing, the others still answer", async () => {
    const { api } = setup();
    const st = (await api.getStatus([{ inbox_id: "a", folders: ["inbox", "Gone"] }])).get("a");
    expect(st).toMatchObject({ ok: true, missing: ["Gone"] });
    expect(st?.ok && st.folders.map((f) => [f.folder, f.id])).toEqual([["inbox", "INBOX"]]);
    const only = (await api.getStatus([{ inbox_id: "a", folders: ["Gone"] }])).get("a");
    expect(only).toMatchObject({ ok: true, folders: [], missing: ["Gone"] });
  });

  it("scheduled sends: one workspace-wide call, rows under `scheduled_sends` with their inbox", async () => {
    const { backend, api } = setup();
    const s = await api.scheduleSend({ inbox_id: "a", to: [{ name: "Maya", email: "maya@example.com" }], subject: "Later", body_text: "x", send_at: "2026-10-05T08:00:00Z" });
    expect(s).toMatchObject({ inbox_id: "a", subject: "Later", status: "pending", to: ["maya@example.com"] });
    const all = await api.listScheduled();
    expect(backend.calls("schedule_list").at(-1)).toMatchObject({ inbox_id: null, args: { limit: 100 } });
    expect(all.map((x) => [x.id, x.inbox_id])).toEqual([[s.id, "a"]]);
  });

  it("parses Content-Disposition file names", () => {
    expect(filenameFromDisposition(`attachment; filename="plain.pdf"`)).toBe("plain.pdf");
    expect(filenameFromDisposition(`attachment; filename="a.bin"; filename*=UTF-8''na%C3%AFve%20file.pdf`)).toBe("naïve file.pdf");
    expect(filenameFromDisposition("attachment; filename=report.csv")).toBe("report.csv");
    expect(filenameFromDisposition("inline")).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });

  it("measures base64 payloads", () => {
    expect(base64Bytes(btoa("hello"))).toBe(5);
    expect(base64Bytes(btoa("hi"))).toBe(2);
    expect(base64Bytes("")).toBe(0);
  });

});

describe("HttpMailApi: conversations", () => {
  it("list rows carry the thread fields the server sends, untouched", async () => {
    const { backend, api } = setup();
    const root = fakeThreadMessage("r1", day(1), null);
    backend.add("a", root, fakeThreadMessage("r2", day(2), root), fakeMessage("old", day(3)));
    const page = await api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 10 });
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    expect([byId.get("r2")?.thread_key, byId.get("r2")?.message_id_header, byId.get("r2")?.in_reply_to, byId.get("r2")?.references]).toEqual([
      "m:r1@fake.mail",
      "r2@fake.mail",
      "r1@fake.mail",
      ["r1@fake.mail"],
    ]);
    // A server that predates threading sends none of them.
    expect(byId.get("old")?.thread_key).toBeUndefined();
  });

  it("getThread: one `thread` op, the conversation across folders oldest first, as rows with keys and roles, without bodies", async () => {
    const { backend, api } = setup({ inboxes: ["a", "b"] });
    const root = fakeThreadMessage("r1", day(1), null);
    const mine = fakeThreadMessage("r2", day(2), root, { folder: "Sent", is_read: true, is_flagged: true });
    const last = fakeThreadMessage("r3", day(3), mine);
    backend.add("a", last, mine, root, fakeThreadMessage("other", day(4), null), fakeThreadMessage("gone", day(5), root, { folder: "Trash" }));
    // The same conversation key in another mailbox is another conversation.
    backend.add("b", fakeThreadMessage("r9", day(6), root));

    const before = backend.calls().length;
    const thread = await api.getThread(makeKey("a", "r3"), { thread_key: "m:r1@fake.mail" });
    expect(backend.calls().slice(before)).toEqual([{ op: "thread", inbox_id: "a", args: { message_id: "r3", thread_key: "m:r1@fake.mail" } }]);
    expect(thread.thread_key).toBe("m:r1@fake.mail");
    expect(thread.partial).toBe(false);
    expect(thread.rows.map((r) => [r.key, r.folder, r.folder_role, r.is_starred])).toEqual([
      ["a:r1", "INBOX", "inbox", false],
      ["a:r2", "Sent", "sent", true],
      ["a:r3", "INBOX", "inbox", false],
    ]);
    expect(thread.rows.every((r) => r.inbox_id === "a" && !("body_text" in r))).toBe(true);
  });

  it("getThread: a cut answer says partial, and a message that is gone is an error", async () => {
    const { backend, api } = setup();
    const root = fakeThreadMessage("r1", day(1), null);
    backend.add("a", root, fakeThreadMessage("r2", day(2), root), fakeThreadMessage("r3", day(3), root));
    const cut = await api.getThread(makeKey("a", "r1"), { limit: 2 });
    expect([cut.rows.map((r) => r.id), cut.partial]).toEqual([["r2", "r3"], true]);
    await expect(api.getThread(makeKey("a", "nope"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("getThread: a partial answer keeps its messages and says why; a whole one carries no reason", async () => {
    const { backend, api } = setup();
    const root = fakeThreadMessage("r1", day(1), null);
    backend.add("a", root, fakeThreadMessage("r2", day(2), root));
    expect((await api.getThread(makeKey("a", "r1"), { limit: 1 })).partial_reason).toBe("limit");
    for (const reason of ["rate_limited", "time_budget", "folder_error", "candidates", "something_newer"]) {
      backend.threadPartial = reason;
      const t = await api.getThread(makeKey("a", "r1"));
      expect([t.rows.map((r) => r.id), t.partial, t.partial_reason]).toEqual([["r1", "r2"], true, reason]);
    }
    backend.threadPartial = null;
    const whole = await api.getThread(makeKey("a", "r1"));
    expect([whole.partial, "partial_reason" in whole]).toEqual([false, false]);
  });

  it("getThread: an aborted request rejects with AbortError, aborts the HTTP request, and its answer is dropped", async () => {
    const { backend, api } = setup();
    backend.add("a", fakeThreadMessage("r1", day(1), null));
    backend.delayOp("thread", 40);
    const controller = new AbortController();
    const pending = api.getThread(makeKey("a", "r1"), {}, controller.signal);
    const outcome = pending.then(
      () => "answered",
      (e: unknown) => (e as { name?: string }).name,
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(backend.calls("thread")).toHaveLength(1);
    controller.abort();
    expect(await outcome).toBe("AbortError");
    expect(backend.abortedCalls.map((c) => c.op)).toEqual(["thread"]);
  });
});
