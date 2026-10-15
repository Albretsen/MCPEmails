/* ApiSocket: one WebSocket to `client-api` (`GET /ws`), carrying the same JSON
 * routes as HTTP. The protocol is the server's (supabase/functions/client-api/ws.ts):
 *
 *   client -> { "type": "auth", "token": "<access token>" }   (a frame, never the URL)
 *   server -> { "type": "ready" }
 *   client -> { "id", "path", "body"?, "workspace_id"? }
 *   server -> { "id", "status", "body", "timing", "request_id" }
 *   client -> { "type": "ping" }      server -> { "type": "pong" }
 *
 * WHY: the hosted runtime gives every plain HTTP request a cold isolate; a
 * socket pins one, so the server's caches and its pooled mailbox connection
 * are reused between requests.
 *
 * This class owns the connection only: when to open it, when to let go of it,
 * and matching answers to requests. It never decides what to do with a failed
 * request: the ApiClient does (retry a read, surface a failed mutation), and
 * it falls back to HTTP whenever `isLive()` is false.
 *
 * - Opened when asked (`start`), while the tab is visible and online.
 * - Any close is routine (the platform retires workers at a wall-clock limit;
 *   the server closes idle sockets with 4408): what was in flight is rejected
 *   as a retryable `network` error and the socket reconnects quietly with
 *   jittered exponential backoff.
 * - 4409 ("recycling": the platform is about to retire the worker). Routine:
 *   the server first answers new frames with 503 `socket_recycling` (it did
 *   not run them), lets what is in flight finish, then closes. From the first
 *   such answer this socket is no longer `isLive()` (new requests go over
 *   HTTP), frames not yet written are handed back with the same error, and
 *   on the close a new socket is opened at once, with no backoff.
 * - 4401 (bad or missing token): ONE refresh and a reconnect; a second 4401,
 *   or a refresh that fails, ends the session (`onAuthFailure`).
 * - Hidden for `hiddenCloseMs`: the socket is closed, so a background tab does
 *   not hold a server isolate and a mailbox connection. No timers run while
 *   hidden except that single one.
 * - The protocol has ping/pong and no cancel frame: a visible tab pings when
 *   it has sent nothing for `pingMs` (the server's idle limit is 120 s); an
 *   aborted or timed-out request simply stops waiting and its late answer is
 *   dropped.
 */

import { ApiError, SOCKET_RECYCLING, abortError } from "./client";

/** Diagnostics only. `fallback-http`: no usable socket right now. */
export type ConnectionState = "connecting" | "live" | "fallback-http";

/** The slice of the browser WebSocket this module uses. */
export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = new (url: string) => WebSocketLike;

export interface SocketEnv {
  isVisible(): boolean;
  isOnline(): boolean;
  /** Focus, visibility and connectivity changes. */
  subscribe(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  random(): number;
}

export interface SocketDiagnostics {
  state: ConnectionState;
  /** Constructor to `ready`, of the last successful handshake. */
  connectMs: number | null;
  /** Round trip of the last answered request frame. */
  lastRoundTripMs: number | null;
  /** Sockets opened by this page so far. */
  connects: number;
  /** Code of the last close (1000 = ours, 4408 = server idle, 4401 = auth,
   *  4409 = the server recycled its worker). */
  lastCloseCode: number | null;
}

export interface ApiSocketOptions {
  /** `wss://…/client-api/ws`. */
  url: string;
  getToken: () => Promise<string | null>;
  /** Shared with the HTTP path: one refresh for everything that needs it. */
  refreshToken: () => Promise<string | null>;
  onAuthFailure?: () => void;
  WebSocket?: WebSocketFactory;
  env?: Partial<SocketEnv>;
  onDiagnostics?: (d: SocketDiagnostics) => void;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  hiddenCloseMs?: number;
  pingMs?: number;
  pongTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxInFlight?: number;
}

export interface SocketResponse {
  status: number;
  body: unknown;
  requestId: string | null;
}

interface Pending {
  frame: string;
  sent: boolean;
  sentAt: number;
  resolve: (r: SocketResponse) => void;
  reject: (e: unknown) => void;
  cleanup: () => void;
}

const OPEN = 1;
/** The server refuses more than 24 request frames in flight on one socket. */
const MAX_IN_FLIGHT = 16;
/** A socket that never once worked on this page (upgrades blocked) is retried
 *  rarely after a few attempts: HTTP is serving the app meanwhile. */
const NEVER_LIVE_ATTEMPTS = 4;
const NEVER_LIVE_BACKOFF_MS = 5 * 60_000;
/** The server's close code for a worker that is being retired (ws.ts). */
export const RECYCLE_CLOSE_CODE = 4409;
/** A second recycle this soon after one is not answered at once again. */
const RECYCLE_IMMEDIATE_GAP_MS = 5000;

function toolCodeOf(body: unknown): string | null {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  const code = error && typeof error === "object" ? (error as { tool_code?: unknown }).tool_code : null;
  return typeof code === "string" ? code : null;
}

export function socketUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, "ws")}/ws`;
}

function browserEnv(): SocketEnv {
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
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    random: Math.random,
  };
}

const closedError = () => new ApiError("network", "The connection closed.", { retryable: true });
/** What the server answers a frame with while recycling; also given to frames
 *  this side had not written yet. Either way the server did not run it. */
const recyclingError = () =>
  new ApiError("provider_error", "Reconnecting. Try again.", { status: 503, retryable: true, toolCode: SOCKET_RECYCLING });

export class ApiSocket {
  private readonly o: Required<Omit<ApiSocketOptions, "onAuthFailure" | "WebSocket" | "env" | "onDiagnostics">> &
    Pick<ApiSocketOptions, "onAuthFailure" | "onDiagnostics">;
  private readonly env: SocketEnv;
  private readonly Ctor: WebSocketFactory | undefined;

  private wanted = false;
  private ws: WebSocketLike | null = null;
  private ready = false;
  /** The server said it is recycling: nothing new goes to this socket. */
  private recycling = false;
  private lastRecycleAt = -Infinity;
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private waiting: string[] = [];
  private inFlight = 0;
  private seq = 0;

  private attempts = 0;
  private everLive = false;
  /** A 4401 has already been answered with a refresh that did not help yet. */
  private refreshedForAuth = false;
  private reconnectTimer: unknown = null;
  private handshakeTimer: unknown = null;
  private hiddenTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private reauthWaiters: { resolve: () => void; reject: (e: unknown) => void; timer: unknown }[] = [];
  private settleWaiters: (() => void)[] = [];

  private diag: SocketDiagnostics = { state: "fallback-http", connectMs: null, lastRoundTripMs: null, connects: 0, lastCloseCode: null };

  constructor(options: ApiSocketOptions) {
    this.o = {
      timeoutMs: 30_000,
      handshakeTimeoutMs: 10_000,
      hiddenCloseMs: 120_000,
      pingMs: 50_000,
      pongTimeoutMs: 10_000,
      backoffBaseMs: 1000,
      backoffMaxMs: 30_000,
      maxInFlight: MAX_IN_FLIGHT,
      ...options,
    };
    this.env = { ...browserEnv(), ...options.env };
    this.Ctor = options.WebSocket ?? (typeof WebSocket !== "undefined" ? (WebSocket as unknown as WebSocketFactory) : undefined);
  }

  get diagnostics(): SocketDiagnostics {
    return this.diag;
  }

  /** Authenticated and open: requests may go over it. */
  isLive(): boolean {
    return this.ready && !this.recycling && this.ws?.readyState === OPEN;
  }

  /** A handshake is under way: the socket will be live (or have failed) soon. */
  isConnecting(): boolean {
    return this.ws != null && !this.ready;
  }

  /** Resolves when the handshake under way has ended either way, or after
   *  `maxMs`. Never rejects: the caller then looks at `isLive()`. */
  settled(maxMs: number): Promise<void> {
    if (!this.isConnecting()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.env.clearTimeout(timer);
        this.settleWaiters = this.settleWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = this.env.setTimeout(done, maxMs);
      this.settleWaiters.push(done);
    });
  }

  private handshakeEnded(): void {
    for (const w of [...this.settleWaiters]) w();
  }

  /** There is a session: keep a socket while the tab is visible and online. */
  start(): void {
    if (this.wanted || !this.Ctor) return;
    this.wanted = true;
    this.unsubscribe ??= this.env.subscribe(() => this.onEnvChange());
    if (this.env.isVisible() && this.env.isOnline()) this.connect();
  }

  /** The session is over (or changed hands): let go of everything. */
  stop(): void {
    this.wanted = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clear("reconnectTimer");
    this.clear("hiddenTimer");
    this.attempts = 0;
    this.refreshedForAuth = false;
    this.drop(1000, "client_stop", abortError());
  }

  /** Rejects what is waiting (sign-out, workspace switch); the socket stays. */
  abortAll(): void {
    this.failPending(abortError());
  }

  /** Presents a refreshed token on the open socket. Resolves on `ready`. */
  reauth(token: string): Promise<void> {
    const ws = this.ws;
    if (!ws || !this.isLive()) return Promise.reject(closedError());
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: this.env.setTimeout(() => {
          this.reauthWaiters = this.reauthWaiters.filter((w) => w !== waiter);
          reject(new ApiError("timeout", "The request timed out."));
        }, this.o.handshakeTimeoutMs),
      };
      this.reauthWaiters.push(waiter);
      this.write(ws, JSON.stringify({ type: "auth", token }));
    });
  }

  /** One request frame. Rejects with `network` (retryable) when the socket
   *  closes first, `timeout` after `timeoutMs`, AbortError on abort. */
  request(path: string, body: unknown, workspaceId: string | null | undefined, signal?: AbortSignal): Promise<SocketResponse> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.isLive()) return Promise.reject(closedError());
    const id = `c${(++this.seq).toString(36)}-${Math.floor(this.env.random() * 0xffffff).toString(36)}`.padEnd(8, "0");
    const frame: Record<string, unknown> = { id, path };
    if (body !== undefined) frame.body = body;
    if (workspaceId) frame.workspace_id = workspaceId;
    return new Promise<SocketResponse>((resolve, reject) => {
      const timer = this.env.setTimeout(() => {
        // No cancel frame in the protocol: stop waiting, drop the late answer.
        this.settle(id)?.reject(new ApiError("timeout", "The request timed out.", { retryable: false }));
      }, this.o.timeoutMs);
      const onAbort = () => this.settle(id)?.reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        frame: JSON.stringify(frame),
        sent: false,
        sentAt: 0,
        resolve,
        reject,
        cleanup: () => {
          this.env.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      this.waiting.push(id);
      this.pump();
    });
  }

  /* ---------------- connection ---------------- */

  private setState(state: ConnectionState, patch: Partial<SocketDiagnostics> = {}): void {
    this.diag = { ...this.diag, ...patch, state };
    this.o.onDiagnostics?.(this.diag);
  }

  private clear(name: "reconnectTimer" | "handshakeTimer" | "hiddenTimer" | "pingTimer" | "pongTimer"): void {
    if (this[name] != null) this.env.clearTimeout(this[name]);
    this[name] = null;
  }

  private connect(): void {
    if (this.ws || !this.wanted || !this.Ctor) return;
    this.clear("reconnectTimer");
    const startedAt = this.env.now();
    let ws: WebSocketLike;
    try {
      ws = new this.Ctor(this.o.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.ready = false;
    this.recycling = false;
    this.setState("connecting", { connects: this.diag.connects + 1 });
    // The token is fetched while the socket opens.
    const token = this.o.getToken().catch(() => null);
    this.handshakeTimer = this.env.setTimeout(() => {
      if (this.ws === ws && !this.ready) this.drop(1000, "handshake_timeout", closedError(), true);
    }, this.o.handshakeTimeoutMs);

    ws.onopen = () => {
      void token.then((t) => {
        if (this.ws !== ws) return;
        if (!t) {
          // No session to present: the HTTP path reports that; do not loop.
          this.wanted = false;
          this.drop(1000, "no_session", closedError());
          return;
        }
        this.write(ws, JSON.stringify({ type: "auth", token: t }));
      });
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onFrame(event.data, startedAt);
    };
    ws.onclose = (event) => {
      if (this.ws === ws) this.onClosed(typeof event?.code === "number" ? event.code : 1006);
    };
    // An error is always followed by a close; that is where it is handled.
    ws.onerror = () => {};
  }

  private write(ws: WebSocketLike, text: string): void {
    try {
      ws.send(text);
    } catch {
      /* closing: onclose follows */
    }
    this.armPing();
  }

  private onFrame(data: unknown, startedAt: number): void {
    if (typeof data !== "string") return;
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "pong") {
      this.clear("pongTimer");
      return;
    }
    if (frame.type === "ready") {
      if (!this.ready) {
        this.ready = true;
        this.everLive = true;
        this.attempts = 0;
        this.refreshedForAuth = false;
        this.clear("handshakeTimer");
        this.setState("live", { connectMs: Math.round(this.env.now() - startedAt) });
        this.handshakeEnded();
        this.armPing();
        if (!this.env.isVisible()) this.armHidden();
      }
      for (const w of this.reauthWaiters.splice(0)) {
        this.env.clearTimeout(w.timer);
        w.resolve();
      }
      return;
    }
    const id = frame.id;
    if (typeof id !== "string") {
      // An error with no id: a refused `auth` (the server keeps a socket that
      // already holds a good token open) or a malformed frame.
      if (frame.status === 401) {
        for (const w of this.reauthWaiters.splice(0)) {
          this.env.clearTimeout(w.timer);
          w.reject(new ApiError("unauthenticated", "Sign in again.", { status: 401 }));
        }
      }
      return;
    }
    if (frame.status === 503 && toolCodeOf(frame.body) === SOCKET_RECYCLING) this.onRecycling();
    const p = this.settle(id);
    if (!p) return; // aborted or timed out: the late answer is dropped
    if (p.sent) this.setState(this.diag.state, { lastRoundTripMs: Math.round((this.env.now() - p.sentAt) * 10) / 10 });
    p.resolve({
      status: typeof frame.status === "number" ? frame.status : 0,
      body: frame.body,
      requestId: typeof frame.request_id === "string" && frame.request_id ? frame.request_id : null,
    });
  }

  /** Takes a request out of the books (answered, aborted or timed out). */
  private settle(id: string): Pending | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    p.cleanup();
    if (p.sent) this.inFlight = Math.max(0, this.inFlight - 1);
    else this.waiting = this.waiting.filter((w) => w !== id);
    this.pump();
    return p;
  }

  private pump(): void {
    const ws = this.ws;
    if (!ws || !this.isLive()) return;
    while (this.inFlight < this.o.maxInFlight && this.waiting.length) {
      const id = this.waiting.shift();
      const p = id ? this.pending.get(id) : undefined;
      if (!p) continue;
      p.sent = true;
      p.sentAt = this.env.now();
      this.inFlight++;
      this.write(ws, p.frame);
    }
  }

  /** The server is draining this socket. Frames in flight still get their
   *  answers; the ones not written yet are handed back as not run. */
  private onRecycling(): void {
    if (this.recycling) return;
    this.recycling = true;
    this.clear("pingTimer");
    this.clear("pongTimer");
    const unsent = this.waiting;
    this.waiting = [];
    for (const id of unsent) {
      const p = this.pending.get(id);
      if (!p || p.sent) continue;
      this.pending.delete(id);
      p.cleanup();
      p.reject(recyclingError());
    }
  }

  private failPending(error: unknown): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    this.waiting = [];
    this.inFlight = 0;
    for (const p of all) {
      p.cleanup();
      p.reject(error);
    }
    for (const w of this.reauthWaiters.splice(0)) {
      this.env.clearTimeout(w.timer);
      w.reject(error);
    }
  }

  /** Closes our end and forgets the socket. `reconnect`: as after a server close. */
  private drop(code: number, reason: string, error: unknown, reconnect = false): void {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.recycling = false;
    this.clear("handshakeTimer");
    this.clear("pingTimer");
    this.clear("pongTimer");
    this.clear("hiddenTimer");
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    this.failPending(error);
    this.handshakeEnded();
    if (ws || this.diag.state !== "fallback-http") this.setState("fallback-http", ws ? { lastCloseCode: code } : {});
    if (reconnect) this.scheduleReconnect();
  }

  private onClosed(code: number): void {
    const wasReady = this.ready;
    const recycled = code === RECYCLE_CLOSE_CODE;
    this.ws = null;
    this.ready = false;
    this.recycling = false;
    this.clear("handshakeTimer");
    this.clear("pingTimer");
    this.clear("pongTimer");
    this.clear("hiddenTimer");
    // Recycled: a frame this side never wrote was certainly not run. One that
    // was written and is still unanswered (the drain gave up on it) may have
    // been: that is a dropped connection like any other.
    if (recycled) this.onRecycling();
    this.recycling = false;
    this.failPending(closedError());
    this.handshakeEnded();
    this.setState("fallback-http", { lastCloseCode: code });
    if (!this.wanted) return;
    if (code === 4401) {
      void this.onAuthClose();
      return;
    }
    if (recycled && wasReady) {
      // Routine: the next worker is a fresh one. Open a socket to it now.
      // Only the first attempt skips the backoff: if it does not get ready,
      // or is recycled again right away, the usual schedule applies.
      const now = this.env.now();
      const again = now - this.lastRecycleAt < RECYCLE_IMMEDIATE_GAP_MS;
      this.lastRecycleAt = now;
      if (!again && this.env.isVisible() && this.env.isOnline()) {
        this.connect();
        return;
      }
    }
    // A socket that worked and was closed (worker retired, idle): come back
    // promptly. One that never got ready: back off.
    if (!wasReady) this.attempts++;
    this.scheduleReconnect();
  }

  /** Exactly the HTTP 401 path: one refresh, one more try, then sign-out. */
  private async onAuthClose(): Promise<void> {
    if (this.refreshedForAuth) {
      this.refreshedForAuth = false;
      this.wanted = false;
      this.o.onAuthFailure?.();
      return;
    }
    this.refreshedForAuth = true;
    const fresh = await this.o.refreshToken().catch(() => null);
    if (!this.wanted) return;
    if (!fresh) {
      this.refreshedForAuth = false;
      this.wanted = false;
      this.o.onAuthFailure?.();
      return;
    }
    if (this.env.isVisible() && this.env.isOnline()) this.connect();
  }

  private scheduleReconnect(): void {
    this.clear("reconnectTimer");
    if (!this.wanted || !this.env.isVisible() || !this.env.isOnline()) return;
    const cap = !this.everLive && this.attempts > NEVER_LIVE_ATTEMPTS ? NEVER_LIVE_BACKOFF_MS : this.o.backoffMaxMs;
    const step = Math.min(cap, this.o.backoffBaseMs * 2 ** Math.min(this.attempts, 20));
    // 0.5x .. 1.5x of the step, never above the cap.
    const delay = Math.min(cap, step * (0.5 + this.env.random()));
    this.reconnectTimer = this.env.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /* ---------------- visibility, connectivity, keep-alive ---------------- */

  private onEnvChange(): void {
    if (!this.wanted) return;
    if (!this.env.isOnline()) {
      this.clear("reconnectTimer");
      this.clear("hiddenTimer");
      if (this.ws) this.drop(1000, "offline", closedError());
      return;
    }
    if (!this.env.isVisible()) {
      // Hidden: no reconnects, no pings; one timer, then the socket is let go.
      this.clear("reconnectTimer");
      this.clear("pingTimer");
      this.clear("pongTimer");
      if (this.ws) this.armHidden();
      return;
    }
    this.clear("hiddenTimer");
    if (!this.ws) this.connect();
    else if (this.ready && this.pingTimer == null) this.armPing();
  }

  private armHidden(): void {
    if (this.hiddenTimer != null) return;
    this.hiddenTimer = this.env.setTimeout(() => {
      this.hiddenTimer = null;
      if (!this.env.isVisible() && this.ws) this.drop(1000, "hidden", closedError());
    }, this.o.hiddenCloseMs);
  }

  /** Re-armed by every frame we send: a ping goes out only after `pingMs` of
   *  silence from this side, and only while the tab is visible. */
  private armPing(): void {
    this.clear("pingTimer");
    if (!this.ready || !this.env.isVisible()) return;
    this.pingTimer = this.env.setTimeout(() => {
      this.pingTimer = null;
      const ws = this.ws;
      if (!ws || !this.isLive() || !this.env.isVisible()) return;
      if (this.pongTimer == null) {
        this.pongTimer = this.env.setTimeout(() => {
          this.pongTimer = null;
          // Half-open: nothing came back. Start over.
          if (this.ws === ws) this.drop(1000, "pong_timeout", closedError(), true);
        }, this.o.pongTimeoutMs);
      }
      this.write(ws, '{"type":"ping"}');
    }, this.o.pingMs);
  }
}
