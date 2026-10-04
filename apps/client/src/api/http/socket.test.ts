import { describe, expect, it } from "vitest";
import { makeKey } from "../types";
import { ApiClient, type ApiClientOptions, isAbortError } from "./client";
import { FakeBackend, fakeInbox, fakeMessage } from "./fake-backend";
import { HttpMailApi } from "./http-mail-api";
import type { SocketDiagnostics } from "./socket";

/** Lets promise chains and the fake's microtasks run. */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Hand-driven timers and page state for the socket. */
function fakeEnv() {
  let now = 0;
  let seq = 1;
  let visible = true;
  let online = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  return {
    env: {
      isVisible: () => visible,
      isOnline: () => online,
      subscribe(l: () => void) {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      setTimeout(fn: () => void, ms: number) {
        const id = seq++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        timers.delete(h as number);
      },
      now: () => now,
      random: () => 0.5,
    },
    /** Delays of the timers that are armed, soonest first. */
    armed: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle(2);
      }
      now = end;
      await settle();
    },
    setVisible(v: boolean) {
      visible = v;
      for (const l of [...listeners]) l();
    },
    setOnline(v: boolean) {
      online = v;
      for (const l of [...listeners]) l();
    },
  };
}

function setup(opts: { client?: Partial<ApiClientOptions>; refuse?: boolean } = {}) {
  const backend = new FakeBackend([fakeInbox("a", "a@example.com", "imap")]);
  backend.add("a", fakeMessage("m1", "2026-10-03T12:00:00Z"), fakeMessage("m2", "2026-10-02T12:00:00Z"));
  backend.refuseSockets = opts.refuse ?? false;
  const state = { token: "tok-1" as string | null, refreshed: 0, authFailures: 0, online: true, refreshTo: "tok-2" as string | null };
  const page = fakeEnv();
  const diag: SocketDiagnostics[] = [];
  let keySeq = 0;
  const client = new ApiClient({
    baseUrl: "https://api.test/functions/v1/client-api",
    getToken: async () => state.token,
    refreshToken: async () => {
      state.refreshed++;
      state.token = state.refreshTo;
      return state.token;
    },
    onAuthFailure: () => {
      state.authFailures++;
    },
    getWorkspaceId: () => "ws-1",
    isOnline: () => state.online,
    fetch: backend.fetch,
    sleep: async () => {},
    random: () => 0.5,
    socket: { WebSocket: backend.WebSocket, env: page.env, onDiagnostics: (d) => diag.push(d) },
    ...opts.client,
  });
  const api = new HttpMailApi({ client, newId: () => `key-${++keySeq}` });
  const viaSocket = () => backend.requests.filter((r) => r.headers["x-client-transport"] === "ws");
  const viaHttp = () => backend.requests.filter((r) => r.headers["x-client-transport"] !== "ws");
  const live = async () => {
    client.connect();
    await settle();
    expect(client.socketLive).toBe(true);
  };
  return { backend, client, api, state, page, diag, viaSocket, viaHttp, live };
}

describe("socket: handshake", () => {
  it("authenticates with a frame, never the URL, and reports live", async () => {
    const { backend, client, diag, live } = setup();
    expect(client.socketLive).toBe(false);
    await live();
    const socket = backend.sockets[0];
    expect(backend.sockets).toHaveLength(1);
    expect(socket?.url).toBe("wss://api.test/functions/v1/client-api/ws");
    expect(socket?.url).not.toContain("tok-1");
    expect(socket?.received[0]).toEqual({ type: "auth", token: "tok-1" });
    expect(diag.map((d) => d.state)).toEqual(["connecting", "live"]);
    expect(client.socketDiagnostics?.connectMs).not.toBeNull();
  });

  it("does not hold up requests: before `ready` they go over HTTP and finish there", async () => {
    const { client, api, viaSocket, viaHttp } = setup();
    client.connect();
    const session = api.getSession(); // same tick as the handshake
    await expect(session).resolves.toMatchObject({ user: { id: "user-1" } });
    expect(viaHttp().map((r) => r.path)).toEqual(["/session"]);
    expect(viaSocket()).toHaveLength(0);
  });

  it("mail reads issued during the handshake wait for it and go over the socket (no cold HTTP batch)", async () => {
    const { client, api, viaSocket, viaHttp } = setup();
    client.connect();
    // Same tick as the handshake: what a page load or a re-shown tab does.
    const reads = Promise.all([api.listFolders("a"), client.read("status", "a", {})]);
    const session = api.getSession(); // never waits
    await reads;
    await session;
    expect(viaHttp().map((r) => r.path)).toEqual(["/session"]);
    expect(viaSocket().map((r) => r.path)).toEqual(["/mail", "/mail"]);
  });

  it("a message list goes to the mailbox before a `status` or folder listing asked for at the same moment", async () => {
    const { backend, api, live } = setup({ client: { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) } });
    await live();
    const before = backend.requests.length;
    // The sync engine and the folder prefetch happen to ask first.
    await Promise.all([
      api.getStatus([{ inbox_id: "a" }]),
      api.listFolders("a"),
      api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 50 }),
    ]);
    const ops = backend.requests.slice(before).map((r) => (r.body as { op?: string } | undefined)?.op);
    expect(ops[0]).toBe("list");
    expect([...ops].sort()).toEqual(["folders", "list", "status"]);
  });

  it("a handshake that fails does not hold reads: they go over HTTP as soon as it has", async () => {
    const { client, api, viaHttp } = setup({ refuse: true }); // the upgrade fails: closed instead of `ready`
    client.connect();
    const folders = api.listFolders("a");
    await expect(folders).resolves.toBeInstanceOf(Array);
    expect(viaHttp().some((r) => r.path === "/mail")).toBe(true);
  });

  it("connect() twice opens one socket", async () => {
    const { backend, client, live } = setup();
    await live();
    client.connect();
    await settle();
    expect(backend.sockets).toHaveLength(1);
  });
});

describe("socket: requests", () => {
  it("carries session, allowance, reads and mutations, with the workspace", async () => {
    const { backend, api, client, viaSocket, viaHttp, live } = setup();
    await live();
    const [session, allowance, page, folders] = await Promise.all([
      api.getSession(),
      client.get<{ cap: number }>("/allowance"),
      api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 50 }),
      api.listFolders("a"),
    ]);
    expect(session.user.id).toBe("user-1");
    expect(allowance.cap).toBe(1000);
    expect(page.rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(folders.length).toBeGreaterThan(0);
    await api.setFlags([makeKey("a", "m1")], { read: true });
    expect(backend.messages.get("a")?.find((m) => m.id === "m1")?.is_read).toBe(true);
    expect(viaHttp()).toHaveLength(0);
    expect(viaSocket().every((r) => r.headers["x-workspace-id"] === "ws-1")).toBe(true);
    // Frames carry exactly the protocol's fields.
    for (const f of backend.sockets[0]?.requestFrames() ?? []) {
      expect(Object.keys(f).every((k) => ["id", "path", "body", "workspace_id"].includes(k))).toBe(true);
      expect(String(f.id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    }
  });

  it("answers concurrent requests to the right callers, in any order", async () => {
    const { client, live } = setup();
    await live();
    const ids = ["m1", "m2", "m1", "m2", "m1"];
    const results = await Promise.all(
      ids.map((id, i) => client.read<{ id: string }>("read", "a", { message_id: id, body_max_chars: 100 + i })),
    );
    expect(results.map((r) => r.id)).toEqual(ids);
  });

  it("sends reads as single frames, not batches, and de-duplicates identical ones", async () => {
    const { backend, client, live } = setup();
    await live();
    await Promise.all([
      client.read("list", "a", { folder: "inbox", limit: 50 }),
      client.read("list", "a", { limit: 50, folder: "inbox" }),
      client.read("status", "a", { folders: ["inbox"] }),
      client.read("folders", "a", {}, undefined, "slow"),
    ]);
    expect(backend.count("/mail/batch")).toBe(0);
    expect(backend.calls().map((c) => c.op).sort()).toEqual(["folders", "list", "status"]);
  });

  it("maps error frames to the same typed errors as HTTP", async () => {
    const { backend, client, state, live } = setup();
    await live();
    backend.failNext({ op: "list" }, { code: "reconnect_required", message: "Reconnect this mailbox.", retryable: false });
    await expect(client.read("list", "a", { folder: "inbox" })).rejects.toMatchObject({
      name: "ApiError",
      code: "reconnect_required",
      retryable: false,
      requestId: "req-test",
    });
    expect(backend.calls("list")).toHaveLength(1); // not retried
    expect(state.authFailures).toBe(0);
  });

  it("keeps the binary attachment download on HTTP", async () => {
    const { backend, client, viaHttp, live } = setup();
    backend.add("a", fakeMessage("att", "2026-10-01T12:00:00Z", { attachments: [{ filename: "a.txt", mime_type: "text/plain", bytes: new Uint8Array([1, 2, 3]) }] }));
    await live();
    const out = await client.binary({ op: "attachment", inbox_id: "a", args: { message_id: "att", attachment_index: 0 } });
    expect(out.blob.size).toBe(3);
    expect(viaHttp().map((r) => r.path)).toEqual(["/mail"]);
  });

  it("caps the frames in flight below the server's limit and queues the rest", async () => {
    const { backend, client, live } = setup({ client: {} });
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    const all = Promise.all(Array.from({ length: 40 }, (_, i) => client.read("read", "a", { message_id: "m1", body_max_chars: i + 1 })));
    await settle();
    expect(backend.sockets[0]?.requestFrames().length).toBe(16);
    release();
    backend.hold = null;
    await all;
    expect(backend.sockets[0]?.requestFrames().length).toBe(40);
  });
});

describe("socket: fallback to HTTP", () => {
  it("serves everything over HTTP when the socket cannot open, and backs off", async () => {
    const { backend, api, client, page, viaSocket, diag } = setup({ refuse: true });
    client.connect();
    await settle();
    expect(client.socketLive).toBe(false);
    expect(diag.at(-1)?.state).toBe("fallback-http");
    const list = await api.listMessages({ scope: "a", folder: { role: "inbox" }, limit: 50 });
    expect(list.rows).toHaveLength(2);
    await api.setFlags([makeKey("a", "m1")], { starred: true });
    expect(viaSocket()).toHaveLength(0);

    // Jittered exponential backoff (random = 0.5 -> exactly the step), capped.
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      const next = page.armed()[0] ?? 0;
      delays.push(next);
      await page.advance(next);
    }
    expect(delays.slice(0, 4)).toEqual([2000, 4000, 8000, 16000]);
    // A socket that never once worked is retried rarely after a few attempts.
    expect(Math.max(...delays)).toBe(300_000);
    expect(backend.sockets.length).toBe(13);

    // The network lets sockets through again: the next attempt goes live.
    backend.refuseSockets = false;
    await page.advance(page.armed()[0] ?? 0);
    expect(client.socketLive).toBe(true);
  });

  it("does not reconnect while hidden or offline", async () => {
    const { backend, client, page } = setup({ refuse: true });
    client.connect();
    await settle();
    page.setVisible(false);
    expect(page.armed()).toEqual([]);
    await page.advance(600_000);
    expect(backend.sockets).toHaveLength(1);
    backend.refuseSockets = false;
    page.setVisible(true);
    await settle();
    expect(client.socketLive).toBe(true);

    page.setOnline(false);
    await settle();
    expect(client.socketLive).toBe(false);
    expect(page.armed()).toEqual([]);
    page.setOnline(true);
    await settle();
    expect(client.socketLive).toBe(true);
    expect(backend.sockets).toHaveLength(3);
  });
});

describe("socket: closes are routine", () => {
  it("retries an idempotent read that was in flight, and reconnects", async () => {
    const { backend, client, page, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    const read = client.read<{ messages: unknown[] }>("list", "a", { folder: "inbox", limit: 50 });
    await settle();
    expect(backend.calls("list")).toHaveLength(1);
    backend.sockets[0]?.serverClose(1006);
    release();
    backend.hold = null;
    await expect(read).resolves.toMatchObject({ total: 2 });
    expect(backend.calls("list")).toHaveLength(2);
    expect(client.socketLive).toBe(false);

    // Quiet reconnect: a socket that had worked comes back after one short step.
    expect(page.armed()).toEqual([1000]);
    await page.advance(1000);
    expect(client.socketLive).toBe(true);
    expect(backend.sockets).toHaveLength(2);
  });

  it("never replays a mutation: it fails like a dropped HTTP request", async () => {
    const { backend, api, client, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    const sent = api.sendMessage({ inbox_id: "a", to: [{ name: "", email: "x@example.com" }], subject: "s", body_text: "b", idempotency_key: "user-key" });
    const outcome = sent.then(
      () => "ok",
      (e: { code?: string; retryable?: boolean }) => e,
    );
    await settle();
    expect(backend.calls("send")).toHaveLength(1);
    backend.sockets[0]?.serverClose(1011);
    release();
    backend.hold = null;
    expect(await outcome).toMatchObject({ code: "network", retryable: true });
    await settle();
    expect(backend.calls("send")).toHaveLength(1);
    expect(client.socketLive).toBe(false);
    // The caller's retry carries the same key, so the server sends it once.
    await api.sendMessage({ inbox_id: "a", to: [{ name: "", email: "x@example.com" }], subject: "s", body_text: "b", idempotency_key: "user-key" });
    expect(backend.delivered).toHaveLength(1);
  });

  it("treats the server's idle close (4408) the same way", async () => {
    const { backend, client, page, state, live } = setup();
    await live();
    backend.sockets[0]?.serverClose(4408, "idle");
    expect(client.socketDiagnostics).toMatchObject({ state: "fallback-http", lastCloseCode: 4408 });
    await page.advance(1000);
    expect(client.socketLive).toBe(true);
    expect(state.refreshed).toBe(0);
  });
});

describe("socket: auth", () => {
  it("4401 on connect: one refresh, then reconnects with the new token", async () => {
    const { backend, client, state } = setup();
    backend.tokens = new Set(["tok-2"]);
    client.connect();
    await settle();
    expect(state.refreshed).toBe(1);
    expect(state.authFailures).toBe(0);
    expect(backend.sockets).toHaveLength(2);
    expect(backend.sockets[1]?.received[0]).toEqual({ type: "auth", token: "tok-2" });
    expect(client.socketLive).toBe(true);
  });

  it("4401 again after the refresh: the session is over", async () => {
    const { backend, client, state, page } = setup();
    backend.tokens = new Set(["nothing-valid"]);
    client.connect();
    await settle();
    expect(state.refreshed).toBe(1);
    expect(state.authFailures).toBe(1);
    expect(backend.sockets).toHaveLength(2);
    expect(page.armed()).toEqual([]); // no reconnect loop
  });

  it("4401 and no refresh possible: the session is over", async () => {
    const { backend, client, state } = setup();
    backend.tokens = new Set(["tok-2"]);
    state.refreshTo = null;
    client.connect();
    await settle();
    expect(state.authFailures).toBe(1);
    expect(backend.sockets).toHaveLength(1);
  });

  it("a 401 on a request frame: refresh, re-authenticate IN PLACE, retry once", async () => {
    const { backend, client, state, live } = setup();
    await live();
    backend.tokens = new Set(["tok-2"]); // tok-1 expired
    const out = await client.read<{ total: number }>("list", "a", { folder: "inbox", limit: 50 });
    expect(out.total).toBe(2);
    expect(state.refreshed).toBe(1);
    expect(state.authFailures).toBe(0);
    expect(backend.sockets).toHaveLength(1);
    expect(backend.sockets[0]?.received.filter((f) => f.type === "auth").map((f) => f.token)).toEqual(["tok-1", "tok-2"]);
  });

  it("a 401 on a request frame that a refresh cannot fix signs out", async () => {
    const { backend, client, state, live } = setup();
    await live();
    backend.tokens = new Set(["tok-9"]);
    state.refreshTo = null;
    await expect(client.mutate("flag", "a", { message_ids: ["m1"], read: true })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(state.authFailures).toBe(1);
  });

  it("presents a refreshed token on the open socket", async () => {
    const { backend, client, live } = setup();
    await live();
    backend.tokens.add("tok-7");
    client.tokenRefreshed("tok-7");
    await settle();
    expect(backend.sockets).toHaveLength(1);
    expect(backend.sockets[0]?.received.at(-1)).toEqual({ type: "auth", token: "tok-7" });
    expect(client.socketLive).toBe(true);
  });

  it("disconnect() closes the socket and aborts what was waiting", async () => {
    const { backend, client, page, live } = setup();
    await live();
    backend.hold = new Promise<void>(() => {});
    const read = client.get("/allowance").catch((e: unknown) => e);
    await settle();
    client.disconnect();
    expect(isAbortError(await read)).toBe(true);
    expect(backend.sockets[0]?.clientClosed).toBe(1000);
    expect(client.socketLive).toBe(false);
    expect(page.armed()).toEqual([]);
  });
});

describe("socket: visibility and keep-alive", () => {
  it("lets go of the socket after 2 minutes hidden and reopens when looked at", async () => {
    const { backend, client, page, live } = setup();
    await live();
    page.setVisible(false);
    // One timer while hidden: no pings, no reconnects.
    expect(page.armed()).toEqual([120_000]);
    await page.advance(119_000);
    expect(client.socketLive).toBe(true);
    await page.advance(1000);
    expect(client.socketLive).toBe(false);
    expect(backend.sockets[0]?.clientClosed).toBe(1000);
    expect(page.armed()).toEqual([]);
    page.setVisible(true);
    await settle();
    expect(client.socketLive).toBe(true);
    expect(backend.sockets).toHaveLength(2);
  });

  it("keeps the socket when the tab is shown again in time", async () => {
    const { backend, client, page, live } = setup();
    await live();
    page.setVisible(false);
    await page.advance(60_000);
    page.setVisible(true);
    await page.advance(600_000);
    expect(client.socketLive).toBe(true);
    expect(backend.sockets).toHaveLength(1);
  });

  it("pings after 50 s of silence, and starts over when no pong comes back", async () => {
    const { backend, client, page, live } = setup();
    await live();
    await page.advance(50_000);
    expect(backend.sockets[0]?.received.at(-1)).toEqual({ type: "ping" });
    await page.advance(50_000);
    expect(backend.sockets[0]?.received.filter((f) => f.type === "ping")).toHaveLength(2);
    expect(client.socketLive).toBe(true);

    backend.dropPongs = true;
    await page.advance(50_000); // third ping, unanswered
    expect(client.socketLive).toBe(true);
    await page.advance(10_000); // pong timeout -> closed, reconnect armed
    await page.advance(1000);
    expect(backend.sockets).toHaveLength(2);
    expect(client.socketLive).toBe(true);
  });
});

describe("socket: timeout and abort", () => {
  it("times out a request that gets no answer (final, not retried)", async () => {
    const { backend, client, page, live } = setup({ client: { timeoutMs: 30_000 } });
    await live();
    backend.hold = new Promise<void>(() => {});
    const read = client.read("status", "a", { folders: ["inbox"] }).catch((e: unknown) => e);
    await settle();
    await page.advance(30_000);
    expect(await read).toMatchObject({ code: "timeout", retryable: false });
    expect(backend.calls("status")).toHaveLength(1);
    expect(client.socketLive).toBe(true);
  });

  it("an aborted request stops waiting; its late answer is dropped", async () => {
    const { backend, client, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    const controller = new AbortController();
    const read = client.read("list", "a", { folder: "inbox" }, controller.signal).catch((e: unknown) => e);
    await settle();
    controller.abort();
    expect(isAbortError(await read)).toBe(true);
    release();
    backend.hold = null;
    await settle();
    // The socket is still good for the next request.
    await expect(client.read("list", "a", { folder: "inbox" })).resolves.toMatchObject({ total: 2 });
    expect(backend.sockets).toHaveLength(1);
  });

  it("reset() aborts what is in flight and keeps the socket", async () => {
    const { backend, client, live } = setup();
    await live();
    backend.hold = new Promise<void>(() => {});
    const read = client.get("/session").catch((e: unknown) => e);
    await settle();
    client.reset();
    expect(isAbortError(await read)).toBe(true);
    expect(client.socketLive).toBe(true);
  });
});

describe("socket: recycling (4409)", () => {
  const send = (api: HttpMailApi, key = "user-key") =>
    api.sendMessage({ inbox_id: "a", to: [{ name: "", email: "x@example.com" }], subject: "s", body_text: "b", idempotency_key: key });
  const opOf = (r: { body: unknown }) => (r.body as { op?: string } | undefined)?.op;

  it("reconnects at once, with no backoff, and says nothing went wrong", async () => {
    const { backend, client, page, diag, state, live } = setup();
    await live();
    backend.recycleSockets();
    // No timer: the next socket is opened in the close handler itself.
    expect(backend.sockets).toHaveLength(2);
    expect(page.armed().filter((d) => d <= 2000)).toEqual([]);
    await settle();
    expect(client.socketLive).toBe(true);
    expect(diag.some((d) => d.lastCloseCode === 4409)).toBe(true);
    expect(state.authFailures).toBe(0);
    expect(state.refreshed).toBe(0);
  });

  it("a mutation refused with socket_recycling is sent again once over HTTP with the same idempotency key", async () => {
    const { backend, api, client, viaHttp, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    // A read in flight keeps the recycling socket open (the server's drain).
    const inFlight = client.read<{ total: number }>("list", "a", { folder: "inbox", limit: 50 });
    await settle();
    backend.recycleSockets();
    expect(client.socketLive).toBe(true); // not told yet
    const sent = send(api);
    await settle();
    // The frame went to the socket and was refused, not run.
    expect(backend.sockets[0]?.requestFrames().filter((f) => opOf({ body: f.body }) === "send")).toHaveLength(1);
    expect(client.socketLive).toBe(false);
    release();
    backend.hold = null;
    await expect(sent).resolves.toMatchObject({ inbox_id: "a" });
    await expect(inFlight).resolves.toMatchObject({ total: 2 });
    // Exactly one send reached the server, over HTTP, with the caller's key.
    expect(backend.calls("send")).toHaveLength(1);
    expect(backend.delivered).toHaveLength(1);
    expect(backend.delivered[0]?.args.idempotency_key).toBe("user-key");
    expect(viaHttp().filter((r) => opOf(r) === "send")).toHaveLength(1);
    // The in-flight read was answered on the old socket, which then closed.
    expect(backend.calls("list")).toHaveLength(1);
    await settle();
    expect(backend.sockets).toHaveLength(2);
    expect(client.socketLive).toBe(true);
  });

  it("replays a read that got the recycling error, and routes new requests over HTTP until the new socket is ready", async () => {
    const { backend, api, client, viaHttp, viaSocket, live } = setup();
    await live();
    backend.recycleSockets("hold");
    const before = viaSocket().length;
    const first = await client.read<{ total: number }>("list", "a", { folder: "inbox", limit: 50 });
    expect(first.total).toBe(2);
    expect(client.socketLive).toBe(false);
    // While the old socket drains, nothing new is written to it.
    const frames = backend.sockets[0]?.requestFrames().length;
    await client.read("status", "a", { folders: ["inbox"] });
    await api.setFlags([makeKey("a", "m1")], { read: true });
    expect(backend.sockets[0]?.requestFrames().length).toBe(frames);
    expect(viaSocket().length).toBe(before);
    expect(viaHttp().map(opOf)).toEqual(["list", "status", "flag"]);
    expect(backend.calls("list")).toHaveLength(1);

    backend.sockets[0]?.finishRecycle();
    await settle();
    expect(client.socketLive).toBe(true);
    await client.read("list", "a", { folder: "inbox", limit: 10 });
    expect(viaSocket().length).toBe(before + 1);
  });

  it("hands back frames it had not written yet instead of failing them", async () => {
    const { backend, api, client, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    // 16 in flight (the cap); the send waits behind them, unwritten.
    const reads = Promise.all(Array.from({ length: 16 }, (_, i) => client.read("read", "a", { message_id: "m1", body_max_chars: i + 1 })));
    await settle();
    const sent = send(api, "queued-key");
    await settle();
    expect(backend.calls("send")).toHaveLength(0);
    backend.recycleSockets();
    // The drain gives up (the server's 3 s): the socket closes with work in flight.
    backend.sockets[0]?.finishRecycle();
    release();
    backend.hold = null;
    await expect(sent).resolves.toMatchObject({ inbox_id: "a" });
    expect(backend.delivered.map((d) => d.args.idempotency_key)).toEqual(["queued-key"]);
    // The reads that were in flight are retried like after any close.
    await expect(reads).resolves.toHaveLength(16);
  });

  it("does not generalise: a mutation in flight when the socket closes still fails, and other 503s are not resent", async () => {
    const { backend, api, live } = setup();
    await live();
    let release = () => {};
    backend.hold = new Promise<void>((r) => (release = r));
    const sent = send(api).then(
      () => "ok",
      (e: { code?: string }) => e,
    );
    await settle();
    backend.recycleSockets();
    backend.sockets[0]?.finishRecycle(); // the drain timed out with the send still running
    release();
    backend.hold = null;
    expect(await sent).toMatchObject({ code: "network" });
    expect(backend.calls("send")).toHaveLength(1);

    await settle();
    backend.failNext({ op: "send" }, { code: "provider_error", message: "boom", retryable: true });
    await expect(send(api, "other")).rejects.toMatchObject({ code: "provider_error" });
    expect(backend.calls("send")).toHaveLength(2);
  });

  it("a second recycle right after the first waits for the usual backoff", async () => {
    const { backend, client, page, live } = setup();
    await live();
    backend.recycleSockets();
    await settle();
    expect(client.socketLive).toBe(true);
    backend.recycleSockets();
    await settle();
    expect(client.socketLive).toBe(false);
    expect(backend.sockets).toHaveLength(2);
    expect(page.armed()).toContain(1000);
    await page.advance(1000);
    expect(client.socketLive).toBe(true);
  });
});
