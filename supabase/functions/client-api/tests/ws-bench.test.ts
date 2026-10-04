// CPU per WebSocket frame.
//
// The hosted runtime retires a worker once it has used about a second of CPU
// (measured live 2026-10-04: about 124 `list` frames on one socket), so what a
// frame costs in CPU is what decides how long a socket lives. This measures
// client-api's own share: one `list` frame of 50 rows through the socket, the
// router and an executor that answers at once, with the project's real token
// type (ES256 against a cached JWKS). The printed number is the result; the
// assertion is a loose ceiling so a slow CI runner does not fail it.

import { assert } from "jsr:@std/assert@1";
import process from "node:process";
import { createApp } from "../app.ts";
import { JwtVerifier, WorkspaceGate } from "../auth.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { RateLimiter } from "../rate-limit.ts";
import { serveSocket, type SocketLike } from "../ws.ts";
import { b64url, claimsFor, fakeSeam, fakeStore, INBOX_ID, membership, ok, SUPABASE_URL } from "./helpers.ts";

const rows = Array.from({ length: 50 }, (_, i) => ({
  id: `INBOX:${i + 1}`,
  subject: `Quarterly numbers and the plan for next week, part ${i}`,
  from: { name: "Maya Chen", email: "maya@lumenworks.example" },
  to: [{ name: "Owner", email: "owner@example.test" }],
  date: "2026-10-04T09:00:00.000Z",
  preview: "Hi, here are the numbers we talked about. Let me know what you think before Thursday, thanks. ".repeat(2),
  is_read: i % 3 === 0,
  is_flagged: false,
  has_attachments: false,
}));

Deno.test("bench D: CPU per socket frame (list of 50, ES256, warm)", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "bench", alg: "ES256" };
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "bench" }));
  const payload = b64url(JSON.stringify(claimsFor()));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const token = `${header}.${payload}.${b64url(signature)}`;

  const seam = fakeSeam();
  seam.respond = (call) => (call.tool === "inbox_list" ? ok({ inboxes: [] }) : ok({ messages: rows, total: 500, has_more: true }));
  const store = fakeStore([membership()]);
  const verifier = new JwtVerifier({
    supabaseUrl: SUPABASE_URL,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }))),
  });
  const big = { capacity: 1e9, refillPerSec: 1e9 };
  const handle = createApp({
    mcp: seam,
    store,
    verifier,
    gate: new WorkspaceGate(store),
    limiter: new RateLimiter({ read: big, write: big, send: big, assistant: big }, { limit: 1e9, windowMs: 10_000 }),
    pool: new ImapPool<PoolableClient>(),
    log: () => {},
  });

  let replies = 0;
  let wake: (() => void) | null = null;
  const socket: SocketLike = {
    send() {
      replies++;
      wake?.();
    },
    close() {},
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  serveSocket(
    new Request("https://project.functions.supabase.invalid/functions/v1/client-api/ws", {
      headers: { upgrade: "websocket", origin: "https://app.mcpemails.com" },
    }),
    {
      handle,
      authenticate: (t) => verifier.verify(t).then(() => true, () => false),
      upgrade: () => ({ socket, response: new Response(null) }),
      setTimer: () => 0,
      clearTimer: () => {},
    },
  );
  const say = async (frame: unknown): Promise<void> => {
    const want = replies + 1;
    const text = JSON.stringify(frame);
    socket.onmessage?.({ data: text });
    while (replies < want) await new Promise<void>((resolve) => (wake = resolve));
  };
  await say({ type: "auth", token });
  const frame = (i: number) => ({ id: `bench-${i}`, path: "/mail", body: { op: "list", inbox_id: INBOX_ID, args: { folder: "inbox", limit: 50 } } });
  for (let i = 0; i < 200; i++) await say(frame(i)); // warm up the JIT

  const N = 2000;
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < N; i++) await say(frame(i));
  const wall = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000;
  const perFrame = Math.round((cpuMs / N) * 1000) / 1000;
  console.log(
    `[bench D] socket frame, list of 50 rows: ${perFrame} ms CPU per frame (wall ${Math.round((wall / N) * 1000) / 1000} ms), ` +
      `${Math.round(1000 / perFrame)} frames per CPU second of client-api's own work`,
  );
  assert(perFrame < 5, `${perFrame} ms CPU per frame`);
});
