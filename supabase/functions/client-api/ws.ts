// ---------------------------------------------------------------------------
// GET /ws: the same JSON routes, over one WebSocket.
//
// WHY. Measured on the hosted runtime (2026-10-04): consecutive HTTP requests
// from one browser land on different isolates almost every time (3 to 14 % came
// back to one already seen, with the isolates kept alive). Each of those pays
// the cold path: fetch the signing keys, one database round trip, and on IMAP
// a new TCP + TLS + AUTH before the first useful command. The in-isolate
// caches and the IMAP session pool only pay off when the next request reaches
// the SAME isolate, and nothing in an HTTP request can ask for that.
//
// A WebSocket is the one thing the platform pins: every frame on a socket is
// handled by the isolate that accepted it, for as long as the socket lives
// (the platform retires a worker at its wall-clock limit; the client then
// reconnects and one request is cold again).
//
// WHAT IT IS. A transport, nothing more. Each request frame is turned into the
// `Request` the HTTP route would have received and handed to the SAME handler:
// the same token verification on every frame, the same workspace gate, rate
// limit, op validation, logging and error envelope. There is no second code
// path to keep in step.
//
//   client -> { "type": "auth", "token": "<Supabase access token>" }
//   server -> { "type": "ready" }
//   client -> { "id": "r1", "path": "/mail", "body": { "op": "list", ... },
//               "workspace_id"?: "<uuid>" }
//   server -> { "id": "r1", "status": 200, "body": { ... },
//               "timing": "<Server-Timing>", "request_id": "..." }
//   client -> { "type": "ping" }            server -> { "type": "pong" }
//
// The token travels in a frame, never in the URL (URLs are logged by proxies).
// It is verified when it is presented (a socket that offers a bad one, or none
// within 10 s, is closed: an open socket holds an isolate, and that must cost
// a real session) and again by the handler on every request frame. It is
// re-sent with `auth` whenever the client refreshes its session; a frame sent
// after the token expired gets the same 401 the HTTP route gives.
//
// A socket with no frame for IDLE_CLOSE_MS is closed (4408). A visible tab
// pings; a hidden or abandoned one lets go of its isolate and its IMAP
// connection, and reconnects when it is looked at again.
//
// NOT on the socket: `attachment` (binary) and `/assistant/run` (SSE). Both
// stay on HTTP.
//
// RECYCLING (close code 4409, reason "recycling"). The platform retires a
// worker when it reaches a resource limit; for a busy socket that is the CPU
// budget (measured live: about a second of CPU, roughly 124 `list` frames).
// The Supabase runtime dispatches a `beforeunload` event on the worker before
// it shuts it down, with `event.detail.reason` (documented in "Background
// Tasks"; the CPU budget has a soft and a hard limit, "Edge Functions worker
// timeouts and WebSocket drops"). index.ts forwards that event to
// `recycleSockets`, and every open socket then:
//   1. stops taking new request frames (each is answered 503, retryable,
//      `tool_code: "socket_recycling"`, so nothing is silently dropped),
//   2. lets the frames already in flight finish and sends their replies,
//   3. closes with 4409 (after at most RECYCLE_DRAIN_MS if something hangs).
// A client that sees 4409 should open a new socket at once, without backoff
// and without treating it as a failure: the next worker is a fresh one.
//
// Each socket also holds an `EdgeRuntime.waitUntil` promise until it closes.
// The same documentation states that after the upgrade response the worker
// counts as idle and "can be terminated even with open WebSocket connections"
// unless such a promise is pending; it is also what gives the drain above the
// time between the soft and the hard limit.
// ---------------------------------------------------------------------------

import { jsonTextOf, requestWithParsedBody } from "./app.ts";
import { isAllowedOrigin } from "./cors.ts";

/** The slice of a WebSocket this module uses (so a test can stand one in). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SocketDeps {
  handle: (req: Request) => Promise<Response>;
  /** Is this a valid session token right now. Signature and expiry only; the handler does the rest. */
  authenticate: (token: string) => Promise<boolean>;
  upgrade?: (req: Request) => { socket: SocketLike; response: Response };
  log?: (event: string, fields: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Keeps the worker alive until the promise settles. Default: EdgeRuntime.waitUntil when present. */
  hold?: (until: Promise<void>) => void;
}

const SOCKET_ROUTES: Record<string, "GET" | "POST"> = {
  "/session": "GET",
  "/mail": "POST",
  "/mail/batch": "POST",
  "/allowance": "GET",
};

/** Same ceiling as the HTTP body. */
const MAX_FRAME_CHARS = 12 * 1024 * 1024;
const MAX_TOKEN_CHARS = 8192;
const MAX_IN_FLIGHT = 24;
/** A socket that has not authenticated by then is closed. */
const AUTH_DEADLINE_MS = 10_000;
/** A socket with no frame for this long is closed. */
export const IDLE_CLOSE_MS = 120_000;
/** Close code sent when the worker is about to be retired. */
export const RECYCLE_CLOSE_CODE = 4409;
/** How long a recycling socket waits for its in-flight frames. */
export const RECYCLE_DRAIN_MS = 3_000;

/** Every open socket's "the worker is being retired" hook. */
const liveSockets = new Set<() => void>();

/**
 * Called from the runtime's `beforeunload` event (index.ts). Returns how many
 * sockets were told. Safe to call more than once.
 */
export function recycleSockets(): number {
  const hooks = [...liveSockets];
  for (const recycle of hooks) {
    try {
      recycle();
    } catch { /* one socket must not stop the others */ }
  }
  return hooks.length;
}

function holdWorker(until: Promise<void>): void {
  try {
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    runtime?.waitUntil?.(until);
  } catch { /* not this runtime: the socket lives as long as the worker lets it */ }
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorFrame(id: string | null, status: number, code: string, message: string): string {
  return JSON.stringify({ id, status, body: { error: { code, message, retryable: status === 429 || status >= 500 } } });
}

/** True when this request asks to become a WebSocket. */
export function isSocketUpgrade(req: Request): boolean {
  return (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * Accept the socket and serve frames on it. Returns the 101 (or a refusal).
 */
export function serveSocket(req: Request, deps: SocketDeps): Response {
  const origin = req.headers.get("origin");
  // Browsers always send Origin on a WebSocket handshake and CORS does not
  // apply to it, so this check is the whole origin policy for the socket.
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  if (req.method !== "GET" || !isSocketUpgrade(req)) {
    return new Response(null, { status: 426, headers: { Upgrade: "websocket" } });
  }

  const upgrade = deps.upgrade ?? ((r: Request) => Deno.upgradeWebSocket(r) as unknown as { socket: SocketLike; response: Response });
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { socket, response } = upgrade(req);
  const base = new URL(req.url);
  const prefix = base.pathname.replace(/\/ws\/?$/, "");

  let token: string | null = null;
  let inFlight = 0;
  let frames = 0;
  let open = true;
  let finished = false;
  let recycling = false;
  let drainTimer: unknown = null;
  const openedAt = performance.now();
  let released: () => void = () => {};
  (deps.hold ?? holdWorker)(new Promise<void>((resolve) => (released = resolve)));

  const send = (text: string): void => {
    if (!open) return;
    try {
      socket.send(text);
    } catch {
      open = false;
    }
  };

  let authTimer: unknown = setTimer(() => {
    authTimer = null;
    if (token === null && open) {
      open = false;
      try {
        socket.close(4401, "auth_timeout");
      } catch { /* already closed */ }
      finish();
    }
  }, AUTH_DEADLINE_MS);

  const shut = (code: number, reason: string): void => {
    if (!open) return;
    open = false;
    try {
      socket.close(code, reason);
    } catch { /* already closed */ }
    // Not left to `onclose`: the worker is held until this socket is done
    // (see `holdWorker`), and a close event that never arrives must not hold it.
    finish();
  };
  let idleTimer: unknown = null;
  const armIdle = (): void => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      shut(4408, "idle");
    }, IDLE_CLOSE_MS);
  };

  const finish = (): void => {
    if (authTimer !== null) clearTimer(authTimer);
    authTimer = null;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    if (drainTimer !== null) clearTimer(drainTimer);
    drainTimer = null;
    open = false;
    liveSockets.delete(recycle);
    released();
    if (finished) return;
    finished = true;
    deps.log?.("socket_closed", { frames, recycled: recycling, open_s: Math.round((performance.now() - openedAt) / 1000) });
  };
  /** Close for recycling once nothing is in flight. */
  const closeIfDrained = (): void => {
    if (!recycling || inFlight > 0 || !open) return;
    shut(RECYCLE_CLOSE_CODE, "recycling");
  };
  const recycle = (): void => {
    if (recycling || !open) return;
    recycling = true;
    deps.log?.("socket_recycling", { frames, in_flight: inFlight });
    drainTimer = setTimer(() => {
      drainTimer = null;
      shut(RECYCLE_CLOSE_CODE, "recycling");
    }, RECYCLE_DRAIN_MS);
    closeIfDrained();
  };
  liveSockets.add(recycle);
  socket.onclose = finish;
  socket.onerror = finish;

  const run = async (id: string, frame: Record<string, unknown>): Promise<void> => {
    const path = typeof frame["path"] === "string" ? frame["path"] : "";
    if (!Object.hasOwn(SOCKET_ROUTES, path)) {
      return send(errorFrame(id, 404, "not_found", "No such route on the socket."));
    }
    if (token === null) return send(errorFrame(id, 401, "unauthenticated", "Sign in again."));
    const method = SOCKET_ROUTES[path];
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      origin: origin,
      "x-request-id": id.length >= 8 ? id : `ws-${id}`.padEnd(8, "0"),
      "x-client-transport": "ws",
    };
    const workspace = frame["workspace_id"];
    if (typeof workspace === "string" && UUID_RE.test(workspace)) headers["x-workspace-id"] = workspace;
    else if (workspace !== undefined && workspace !== null) {
      return send(errorFrame(id, 403, "forbidden", "Unknown workspace."));
    }
    const url = `${base.origin}${prefix}${path}`;
    let inner: Request;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      // The frame was parsed once, here; the handler is given that value
      // rather than a second serialisation of it to parse again.
      inner = requestWithParsedBody(url, headers, frame["body"] ?? null);
    } else {
      inner = new Request(url, { method, headers });
    }
    const result = await deps.handle(inner);
    const type = result.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      await result.body?.cancel().catch(() => {});
      return send(errorFrame(id, 400, "invalid_request", "This result is binary; request it over HTTP."));
    }
    // The handler's own JSON text when it has it (no trip through the
    // Response stream); any other handler's body is read the ordinary way.
    let text = jsonTextOf(result);
    if (text === null) text = await result.text();
    else await result.body?.cancel().catch(() => {});
    // The body is already JSON text: spliced in, not parsed and re-serialised.
    send(
      `{"id":${JSON.stringify(id)},"status":${result.status},"timing":${
        JSON.stringify(result.headers.get("server-timing") ?? "")
      },"request_id":${JSON.stringify(result.headers.get("x-request-id") ?? "")},"body":${text || "null"}}`,
    );
  };

  socket.onmessage = (event) => {
    if (!open) return;
    const data = event.data;
    if (typeof data !== "string" || data.length > MAX_FRAME_CHARS) {
      return send(errorFrame(null, 413, "invalid_request", "Frames must be JSON text within the size limit."));
    }
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      frame = parsed as Record<string, unknown>;
    } catch {
      return send(errorFrame(null, 400, "invalid_request", "Frames must be JSON objects."));
    }
    if (token !== null) armIdle();
    if (frame["type"] === "ping") return send('{"type":"pong"}');
    if (frame["type"] === "auth") {
      const given = frame["token"];
      const refuse = (): void => {
        send(errorFrame(null, 401, "unauthenticated", "Sign in again."));
        // A socket that already holds a good token keeps it and stays open
        // (a failed refresh must not drop a working session mid-click).
        if (token === null) shut(4401, "unauthenticated");
      };
      if (typeof given !== "string" || given.length === 0 || given.length > MAX_TOKEN_CHARS || /\s/.test(given)) {
        return refuse();
      }
      deps.authenticate(given).then((ok) => {
        if (!open) return;
        if (!ok) return refuse();
        token = given;
        armIdle();
        send('{"type":"ready"}');
      }, refuse);
      return;
    }
    const rawId = frame["id"];
    const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      return send(errorFrame(null, 400, "invalid_request", "Every request frame needs an 'id'."));
    }
    if (recycling) {
      // Not run and not dropped: the client retries it on its next socket.
      return send(
        JSON.stringify({
          id,
          status: 503,
          body: {
            error: {
              code: "provider_error",
              message: "Reconnecting. Try again.",
              retryable: true,
              tool_code: "socket_recycling",
            },
          },
        }),
      );
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      return send(errorFrame(id, 429, "rate_limited", "Too many requests in flight on this connection."));
    }
    inFlight++;
    frames++;
    run(id, frame)
      .catch(() => send(errorFrame(id, 500, "internal_error", "The request could not be completed.")))
      .finally(() => {
        inFlight--;
        closeIfDrained();
      });
  };

  return response;
}
