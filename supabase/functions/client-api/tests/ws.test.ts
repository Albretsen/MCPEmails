// The WebSocket transport: every frame goes through the same handler as HTTP.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { JwtVerifier } from "../auth.ts";
import { IDLE_CLOSE_MS, RECYCLE_DRAIN_MS, recycleSockets, serveSocket, type SocketLike } from "../ws.ts";
import { INBOX_ID, JWT_SECRET, mintHs256, SUPABASE_URL, testApp } from "./helpers.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.onclose?.({});
  }
  /** Deliver a frame and wait for the next reply. */
  async say(frame: unknown): Promise<Record<string, any>> {
    const count = this.sent.length + 1;
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
    for (let i = 0; i < 200 && this.sent.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function upgradeRequest(origin: string | null = "https://app.mcpemails.com", path = "/ws"): Request {
  const headers: Record<string, string> = { upgrade: "websocket", connection: "Upgrade" };
  if (origin) headers["origin"] = origin;
  return new Request(`https://project.functions.supabase.invalid/functions/v1/client-api${path}`, { headers });
}

function rig() {
  const app = testApp();
  const socket = new FakeSocket();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const verifier = new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET });
  const open = (req = upgradeRequest()) =>
    serveSocket(req, {
      handle: app.handle,
      authenticate: (token) => verifier.verify(token).then(() => true, () => false),
      upgrade: () => ({ socket, response: new Response(null, { status: 200, headers: { "x-test": "upgraded" } }) }),
      log: (event, fields) => logs.push({ event, fields }),
      setTimer: (fn, ms) => {
        timers.set(next, { fn, ms });
        return next++;
      },
      clearTimer: (handle) => timers.delete(handle as number),
    });
  /** Fire the pending timer armed with this delay. */
  const fire = (ms: number): boolean => {
    for (const [id, timer] of timers) {
      if (timer.ms === ms) {
        timers.delete(id);
        timer.fn();
        return true;
      }
    }
    return false;
  };
  return { app, socket, open, timers, fire, logs };
}

Deno.test("socket: another origin, or none, is refused before any upgrade", () => {
  const { open, socket } = rig();
  assertEquals(open(upgradeRequest("https://evil.example")).status, 403);
  assertEquals(open(upgradeRequest(null)).status, 403);
  assertEquals(socket.onmessage, null, "no socket was wired up");
});

Deno.test("socket: a plain GET to /ws is told to upgrade", () => {
  const { open } = rig();
  const req = new Request("https://project.functions.supabase.invalid/functions/v1/client-api/ws", {
    headers: { origin: "https://app.mcpemails.com" },
  });
  assertEquals(open(req).status, 426);
});

Deno.test("socket: auth, then requests answered by the same handler with the same bodies as HTTP", async () => {
  const { app, socket, open } = rig();
  assertEquals(open().headers.get("x-test"), "upgraded");
  const token = await mintHs256();
  assertEquals(await socket.say({ type: "auth", token }), { type: "ready" });

  const session = await socket.say({ id: "req-0001", path: "/session" });
  assertEquals([session.id, session.status, session.body.workspace_id], ["req-0001", 200, app.store.rows[0].workspace_id]);
  assert(/^auth;dur=/.test(session.timing));
  assertEquals(session.request_id, "req-0001");

  const list = await socket.say({ id: 7, path: "/mail", body: { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox" } } });
  assertEquals([list.id, list.status, list.body.tool], ["7", 200, "email_list"]);

  const batch = await socket.say({ id: "b1", path: "/mail/batch", body: { calls: [{ op: "folders", inbox_id: INBOX_ID, args: {} }] } });
  assertEquals([batch.status, batch.body.results.length, batch.body.results[0].ok], [200, 1, true]);

  // The handler's own log line marks the transport; nothing else differs.
  const lines = app.logs.filter((l) => l.event === "request");
  assertEquals(lines.map((l) => [l.fields["route"], l.fields["transport"]]), [["/session", "ws"], ["/mail", "ws"], ["/mail/batch", "ws"]]);
  assertEquals(app.store.calls.memberships, 1, "one isolate: the gate cache serves every later frame");
});

Deno.test("socket: a request before auth is a 401 frame; a bad first token closes the socket", async () => {
  const { socket, open } = rig();
  open();
  const early = await socket.say({ id: "a1", path: "/session" });
  assertEquals([early.status, early.body.error.code], [401, "unauthenticated"]);
  assertEquals(socket.closed, null);
  const bad = await socket.say({ type: "auth", token: "garbage.garbage.garbage" });
  assertEquals(bad.status, 401);
  assertEquals(socket.closed?.code, 4401, "an open socket holds an isolate: it must cost a real session");
});

Deno.test("socket: malformed, expired and non-user tokens never authenticate a socket", async () => {
  for (const token of ["not a token", "", 42, await mintHs256({ expiresIn: -120 }), await mintHs256({ role: "service_role" }), await mintHs256({ secret: "other" })]) {
    const { socket, open } = rig();
    open();
    assertEquals((await socket.say({ type: "auth", token })).status, 401);
    assertEquals(socket.closed?.code, 4401);
  }
});

Deno.test("socket: the error envelope is the HTTP one (bad op, foreign workspace)", async () => {
  const { socket, open } = rig();
  open();
  await socket.say({ type: "auth", token: await mintHs256() });
  const unknown = await socket.say({ id: "a3", path: "/mail", body: { op: "explode", args: {} } });
  assertEquals([unknown.status, unknown.body.error.code, typeof unknown.body.error.retryable], [400, "invalid_request", "boolean"]);
  const foreign = await socket.say({ id: "a4", path: "/session", workspace_id: "99999999-9999-4999-8999-999999999999" });
  assertEquals([foreign.status, foreign.body.error.code], [403, "forbidden"]);
  const notUuid = await socket.say({ id: "a5", path: "/session", workspace_id: "x" });
  assertEquals(notUuid.status, 403);
});

Deno.test("socket: only the JSON routes exist; the assistant and unknown paths are refused", async () => {
  const { socket, open } = rig();
  open();
  await socket.say({ type: "auth", token: await mintHs256() });
  for (const path of ["/assistant/run", "/ws", "/nope", "", "https://elsewhere.example/mail"]) {
    const frame = await socket.say({ id: "p1", path });
    assertEquals([frame.status, frame.body.error.code], [404, "not_found"], path);
  }
});

Deno.test("socket: malformed frames get an error frame and the socket stays usable", async () => {
  const { socket, open } = rig();
  open();
  assertEquals((await socket.say("{not json")).status, 400);
  assertEquals((await socket.say("[1,2]")).status, 400);
  assertEquals((await socket.say({ path: "/session" })).status, 400);
  assertEquals((await socket.say({ id: "has spaces", path: "/session" })).status, 400);
  socket.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
  assertEquals(JSON.parse(socket.sent[socket.sent.length - 1]).status, 413);
  assertEquals(await socket.say({ type: "ping" }), { type: "pong" });
});

Deno.test("socket: when the token expires the frames are 401; a fresh auth frame recovers; a failed refresh keeps the session", async () => {
  const { socket, open } = rig();
  open();
  const short = await mintHs256({ expiresIn: 1 });
  await socket.say({ type: "auth", token: short });
  assertEquals((await socket.say({ id: "e0", path: "/allowance" })).status, 200);
  // The handler tolerates 5 s of clock skew; wait past it.
  await new Promise((resolve) => setTimeout(resolve, 6200));
  assertEquals((await socket.say({ id: "e1", path: "/allowance" })).status, 401);
  // A refresh that fails does not close a socket that was authenticated.
  assertEquals((await socket.say({ type: "auth", token: "garbage.garbage.garbage" })).status, 401);
  assertEquals(socket.closed, null);
  assertEquals(await socket.say({ type: "auth", token: await mintHs256() }), { type: "ready" });
  assertEquals((await socket.say({ id: "e2", path: "/allowance" })).status, 200);
});

Deno.test("socket: one that never authenticates is closed after the deadline", async () => {
  const { socket, open, fire, logs } = rig();
  open();
  await socket.say({ type: "ping" });
  assert(fire(10_000));
  assertEquals(socket.closed?.code, 4401);
  assertEquals(logs.map((l) => l.event), ["socket_closed"]);
  const before = socket.sent.length;
  socket.onmessage?.({ data: '{"type":"ping"}' });
  assertEquals(socket.sent.length, before, "nothing is sent on a closed socket");
});

Deno.test("socket: an authenticated socket with no frames is closed as idle; every frame restarts the clock", async () => {
  const { socket, open, fire, timers } = rig();
  open();
  await socket.say({ type: "auth", token: await mintHs256() });
  await socket.say({ type: "ping" });
  await socket.say({ id: "i1", path: "/allowance" });
  assertEquals([...timers.values()].filter((t) => t.ms === IDLE_CLOSE_MS).length, 1, "one idle timer, re-armed, never stacked");
  assert(fire(10_000), "the auth deadline passing does nothing to an authenticated socket");
  assertEquals(socket.closed, null);
  assert(fire(IDLE_CLOSE_MS));
  assertEquals(socket.closed?.code, 4408);
});

Deno.test("socket: the token never appears in anything sent back or logged", async () => {
  const { app, socket, open, logs } = rig();
  open();
  const token = await mintHs256();
  await socket.say({ type: "auth", token });
  await socket.say({ id: "t1", path: "/session" });
  await socket.say({ id: "t2", path: "/mail", body: { op: "nope" } });
  const everything = socket.sent.join("\n") + JSON.stringify(app.logs) + JSON.stringify(logs);
  assert(!everything.includes(token));
});

// ── recycling: the worker is about to be retired ────────────────────────────

function recycleRig() {
  const socket = new FakeSocket();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const gates: Array<() => void> = [];
  let held: Promise<void> | null = null;
  let released = false;
  const response = serveSocket(upgradeRequest(), {
    // Each request waits until the test lets it go.
    handle: async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return new Response(JSON.stringify({ done: true }), { headers: { "content-type": "application/json" } });
    },
    authenticate: () => Promise.resolve(true),
    upgrade: () => ({ socket, response: new Response(null, { status: 200 }) }),
    log: (event, fields) => logs.push({ event, fields }),
    setTimer: (fn, ms) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    hold: (until) => {
      held = until;
      until.then(() => (released = true));
    },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  return { socket, timers, logs, gates, response, tick, isHeld: () => held !== null && !released };
}

Deno.test("socket recycling: in-flight frames finish, new ones are refused retryably, then the socket closes 4409", async () => {
  const r = recycleRig();
  await r.socket.say({ type: "auth", token: "t" });
  assert(r.isHeld(), "the worker is held while the socket is open");
  r.socket.onmessage?.({ data: JSON.stringify({ id: "r1-inflight", path: "/mail", body: { op: "list" } }) });
  await r.tick();
  assertEquals(r.gates.length, 1);

  assertEquals(recycleSockets() >= 1, true);
  assertEquals(r.socket.closed, null, "not closed under the request that is still running");
  const refused = await r.socket.say({ id: "r2-refused", path: "/mail", body: { op: "list" } });
  assertEquals([refused.id, refused.status, refused.body.error.retryable, refused.body.error.tool_code], ["r2-refused", 503, true, "socket_recycling"]);
  assertEquals(r.gates.length, 1, "the refused frame never reached the handler");

  r.gates[0]();
  await r.tick();
  const reply = JSON.parse(r.socket.sent[r.socket.sent.length - 1]);
  assertEquals([reply.id, reply.status, reply.body], ["r1-inflight", 200, { done: true }], "the in-flight reply was delivered first");
  assertEquals(r.socket.closed, { code: 4409, reason: "recycling" });
  await r.tick();
  assert(!r.isHeld(), "the hold on the worker is released with the socket");
  const closed = r.logs.find((l) => l.event === "socket_closed")!;
  assertEquals(closed.fields["recycled"], true);
  assertEquals(recycleSockets(), 0, "a closed socket is no longer told");
});

Deno.test("socket recycling: an idle socket closes at once; a stuck request is cut off after the drain limit", async () => {
  const idle = recycleRig();
  await idle.socket.say({ type: "auth", token: "t" });
  recycleSockets();
  assertEquals(idle.socket.closed, { code: 4409, reason: "recycling" });

  const stuck = recycleRig();
  await stuck.socket.say({ type: "auth", token: "t" });
  stuck.socket.onmessage?.({ data: JSON.stringify({ id: "r1-stuck000", path: "/mail", body: {} }) });
  await stuck.tick();
  recycleSockets();
  assertEquals(stuck.socket.closed, null);
  const drain = [...stuck.timers.values()].find((t) => t.ms === RECYCLE_DRAIN_MS);
  assert(drain, "a drain deadline was armed");
  drain.fn();
  assertEquals(stuck.socket.closed, { code: 4409, reason: "recycling" });
  stuck.gates[0]();
  await stuck.tick();
});
