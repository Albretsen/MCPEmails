/* ApiClient: the one place that talks to `client-api`, over a WebSocket when
 * one is open and authenticated (see ./socket.ts) and over HTTP otherwise.
 * Callers cannot tell which: the same typed errors, timeout, de-duplication,
 * read retries and 401 handling apply to both. The attachment download and
 * the assistant's event stream are always HTTP (the socket carries JSON only).
 *
 * - Bearer token on every request; on 401 the token is refreshed ONCE (shared
 *   by every request that saw the 401) and the request retried; if that fails
 *   the session is over (`onAuthFailure`).
 * - `X-Workspace-Id` when a workspace is selected.
 * - Typed errors from the error envelope (`ApiError`).
 * - 30 s timeout on every request (a timeout is final: it is not retried).
 * - Reads only: retry with jittered backoff on `retryable` errors, in-flight
 *   de-duplication of identical calls, and coalescing of reads issued in the
 *   same tick into one `POST /mail/batch` (<= 12 calls per request).
 * - Mutations are sent once, never queued and never retried here: offline
 *   they fail fast, and one whose connection dropped is reported as failed
 *   (its idempotency key is the caller's, for a retry the person asks for).
 * - On a live socket reads go out as single frames, not batches (see `enqueue`).
 */

import { ApiSocket, type ApiSocketOptions, type SocketDiagnostics, socketUrl } from "./socket";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(code: string, message: string, opts: { status?: number; retryable?: boolean; requestId?: string | null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    this.requestId = opts.requestId ?? null;
  }
}

export function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code == null || e.code === code);
}

/** Text for the user. Never the raw server message for unknown codes. */
export function describeError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  switch (e.code) {
    case "offline":
      return "You are offline. Nothing was changed.";
    case "timeout":
      return `${fallback} The server took too long to answer.`;
    case "rate_limited":
      return "Too many requests. Wait a moment and try again.";
    case "reconnect_required":
      return "This mailbox needs reconnecting in the dashboard.";
    case "forbidden":
      return "You do not have permission to do that in this workspace.";
    case "attachments_too_large":
      return e.message;
    default:
      return fallback;
  }
}

export interface MailCall {
  op: string;
  inbox_id: string | null;
  args: Record<string, unknown>;
}

export interface ApiClientOptions {
  /** `{FUNCTIONS_URL}/client-api`, no trailing slash. */
  baseUrl: string;
  /** The current access token, or null when there is no session. */
  getToken: () => Promise<string | null>;
  /** Forces a refresh. Null when the session cannot be refreshed. */
  refreshToken: () => Promise<string | null>;
  /** The session is over (no token, or a 401 that a refresh did not fix). */
  onAuthFailure?: () => void;
  getWorkspaceId?: () => string | null;
  isOnline?: () => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts for a retryable read (default 2, so 3 tries in all). */
  maxRetries?: number;
  retryBaseMs?: number;
  maxBatch?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Schedules the batch flush. Default: a 0 ms timeout, which collects every
   *  read issued in the current task. */
  defer?: (fn: () => void) => void;
  /** Told after every mail call that names an inbox: `true` when the answer
   *  was `reconnect_required`, `false` when the call succeeded. */
  onInboxAuth?: (inbox_id: string, needsReconnect: boolean) => void;
  /** Socket transport overrides (tests), or `false` for HTTP only. */
  socket?: Partial<Omit<ApiSocketOptions, "url" | "getToken" | "refreshToken" | "onAuthFailure">> | false;
}

/** The routes the socket carries, as the server lists them (ws.ts). */
const SOCKET_ROUTES: Record<string, string> = {
  "/session": "GET",
  "/mail": "POST",
  "/mail/batch": "POST",
  "/allowance": "GET",
};

function parseJsonText<T>(text: string, status: number): T {
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("invalid_response", "The server sent something unreadable.", { status, retryable: true });
  }
}

/** Reads are coalesced per lane. `slow` keeps calls that are known to take
 *  seconds (listing folders) out of the batch the first paint waits for: a
 *  batch answers only when its slowest call has. */
export type ReadLane = "fast" | "slow";

interface Queued {
  call: MailCall;
  lane: ReadLane;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Shared {
  promise: Promise<unknown>;
  controller: AbortController;
  consumers: number;
}

interface Envelope {
  error?: { code?: unknown; message?: unknown; retryable?: unknown };
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_BATCH = 12;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Keys sorted, so equal calls always produce the same string. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

export function errorFromEnvelope(status: number, body: unknown, requestId: string | null): ApiError {
  const env = (body && typeof body === "object" ? (body as Envelope).error : undefined) ?? undefined;
  if (env && typeof env.code === "string") {
    return new ApiError(env.code, typeof env.message === "string" ? env.message : env.code, {
      status,
      retryable: env.retryable === true,
      requestId,
    });
  }
  if (status === 401) return new ApiError("unauthenticated", "Sign in again.", { status, requestId });
  if (status === 403) return new ApiError("forbidden", "Not allowed.", { status, requestId });
  if (status === 429) return new ApiError("rate_limited", "Too many requests.", { status, retryable: true, requestId });
  if (status >= 500) return new ApiError("provider_error", "The server had a problem.", { status, retryable: true, requestId });
  return new ApiError("invalid_request", `Request failed (${status}).`, { status, requestId });
}

export class ApiClient {
  private readonly o: Required<Omit<ApiClientOptions, "onAuthFailure" | "getWorkspaceId" | "fetch" | "socket" | "onInboxAuth">> &
    Pick<ApiClientOptions, "onAuthFailure" | "getWorkspaceId" | "fetch" | "onInboxAuth">;
  private readonly socket: ApiSocket | null;
  private queue: Queued[] = [];
  private flushScheduled = false;
  private inflight = new Map<string, Shared>();
  private refreshing: Promise<string | null> | null = null;
  /** Aborted by `reset()`: nothing started before a sign-out may land after it. */
  private epoch = new AbortController();

  constructor(options: ApiClientOptions) {
    this.o = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: 2,
      retryBaseMs: 400,
      maxBatch: MAX_BATCH,
      sleep: defaultSleep,
      random: Math.random,
      defer: (fn) => void setTimeout(fn, 0),
      isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
      ...options,
    };
    this.socket =
      options.socket === false
        ? null
        : new ApiSocket({
            timeoutMs: this.o.timeoutMs,
            ...options.socket,
            url: socketUrl(options.baseUrl),
            getToken: options.getToken,
            // The same shared refresh as the HTTP 401 path.
            refreshToken: () => this.refreshOnce(),
            onAuthFailure: () => this.o.onAuthFailure?.(),
          });
  }

  /* ---------------- public: the socket ---------------- */

  /** There is a session: open the socket (a no-op when it is open or opening).
   *  Nothing waits for it: until it is authenticated every request is HTTP. */
  connect(): void {
    this.socket?.start();
  }

  /** The session is over: close the socket. */
  disconnect(): void {
    this.socket?.stop();
  }

  /** The session's token was refreshed: present the new one on the open
   *  socket (the server accepts `auth` again in place). */
  tokenRefreshed(token: string): void {
    if (this.socket?.isLive()) this.socket.reauth(token).catch(() => {});
  }

  /** Requests are going over the socket right now. */
  get socketLive(): boolean {
    return this.socket?.isLive() ?? false;
  }

  get socketDiagnostics(): SocketDiagnostics | null {
    return this.socket?.diagnostics ?? null;
  }

  get baseUrl(): string {
    return this.o.baseUrl;
  }

  /** Aborts everything in flight and forgets it (sign-out, workspace switch). */
  reset(): void {
    this.epoch.abort();
    this.epoch = new AbortController();
    const dropped = this.queue;
    this.queue = [];
    for (const q of dropped) q.reject(abortError());
    this.inflight.clear();
    this.refreshing = null;
    this.socket?.abortAll();
  }

  /* ---------------- public: reads ---------------- */

  /** An idempotent mail read. De-duplicated, batched and retried. */
  read<T>(
    op: string,
    inbox_id: string | null,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    lane: ReadLane = "fast",
  ): Promise<T> {
    const call: MailCall = { op, inbox_id, args };
    return this.shared<T>(`mail:${stableKey(call)}`, signal, (s) =>
      this.noteInbox(inbox_id, this.withRetry(() => this.enqueue<T>(call, s, lane), s)),
    );
  }

  private noteInbox<T>(inbox_id: string | null, work: Promise<T>): Promise<T> {
    const tell = this.o.onInboxAuth;
    if (!tell || !inbox_id) return work;
    return work.then(
      (v) => {
        tell(inbox_id, false);
        return v;
      },
      (e: unknown) => {
        if (isApiError(e, "reconnect_required")) tell(inbox_id, true);
        throw e;
      },
    );
  }

  /** An idempotent GET. De-duplicated and retried. */
  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.shared<T>(`get:${path}`, signal, (s) => this.withRetry(() => this.json<T>("GET", path, undefined, s), s));
  }

  /** A binary read (the `attachment` op). Retried, not batched. */
  binary(call: MailCall, signal?: AbortSignal): Promise<{ blob: Blob; headers: Headers }> {
    const s = signal ?? new AbortController().signal;
    return this.withRetry(
      () =>
        this.send("POST", "/mail", { body: call, signal: s, accept: "*/*" }, async (res) => ({
          blob: await res.blob(),
          headers: res.headers,
        })),
      s,
    );
  }

  /* ---------------- public: writes ---------------- */

  /** A mail mutation: one request, no retry, fails fast when offline. */
  mutate<T>(op: string, inbox_id: string | null, args: Record<string, unknown> = {}): Promise<T> {
    return this.noteInbox(inbox_id, this.json<T>("POST", "/mail", { op, inbox_id, args }));
  }

  /** A streaming POST (the assistant run). The timeout covers the wait for
   *  the response headers only; the body is the caller's to read. */
  stream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return this.send("POST", path, { body, signal, accept: "text/event-stream" }, async (res) => res);
  }

  /* ---------------- internals ---------------- */

  private json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    // Decided per request, at the moment it is sent: a request that started
    // on HTTP finishes on HTTP, and one whose socket closes is not moved (a
    // read is retried by `withRetry`, on whichever transport is up by then;
    // a mutation fails, exactly as on a dropped HTTP connection).
    if (this.socket?.isLive() && SOCKET_ROUTES[path] === method) return this.overSocket<T>(method, path, body, signal);
    return this.overHttp<T>(method, path, body, signal);
  }

  private overHttp<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.send(method, path, { body, signal, accept: "application/json" }, async (res) => {
      if (res.status === 204) return undefined as T;
      return parseJsonText<T>(await res.text(), res.status);
    });
  }

  /** One exchange over the socket, with the HTTP path's rules: offline fails
   *  fast, a 401 gets ONE shared refresh and one more try, errors come from
   *  the same envelope. */
  private async overSocket<T>(method: string, path: string, body: unknown, user?: AbortSignal): Promise<T> {
    const socket = this.socket;
    const epoch = this.epoch.signal;
    if (user?.aborted || epoch.aborted) throw abortError();
    if (!this.o.isOnline()) throw new ApiError("offline", "You are offline.");
    if (!socket) return this.overHttp<T>(method, path, body, user);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    user?.addEventListener("abort", onAbort, { once: true });
    epoch.addEventListener("abort", onAbort, { once: true });
    try {
      let res = await socket.request(path, body, this.o.getWorkspaceId?.(), controller.signal);
      if (res.status === 401) {
        const fresh = await this.refreshOnce();
        if (controller.signal.aborted) throw abortError();
        if (!fresh) {
          this.o.onAuthFailure?.();
          throw new ApiError("unauthenticated", "Sign in again.", { status: 401 });
        }
        try {
          await socket.reauth(fresh);
        } catch {
          // The socket went away meanwhile. The 401 means nothing was done,
          // so the one retry may go over HTTP (which sends the fresh token).
          if (controller.signal.aborted) throw abortError();
          return await this.overHttp<T>(method, path, body, controller.signal);
        }
        res = await socket.request(path, body, this.o.getWorkspaceId?.(), controller.signal);
      }
      if (res.status < 200 || res.status >= 300) {
        const err = errorFromEnvelope(res.status, res.body, res.requestId);
        if (res.status === 401) this.o.onAuthFailure?.();
        throw err;
      }
      return (res.body ?? undefined) as T;
    } catch (err) {
      if (!isAbortError(err) && (user?.aborted || epoch.aborted)) throw abortError();
      throw err;
    } finally {
      user?.removeEventListener("abort", onAbort);
      epoch.removeEventListener("abort", onAbort);
    }
  }

  /** One HTTP exchange with auth, 401 refresh, timeout and error mapping.
   *  `consume` runs inside the timeout, so a stalled body times out too. */
  private async send<T>(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal; accept: string },
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const user = init.signal;
    const epoch = this.epoch.signal;
    if (user?.aborted || epoch.aborted) throw abortError();
    if (!this.o.isOnline()) throw new ApiError("offline", "You are offline.");

    let token = await this.o.getToken();
    if (user?.aborted || epoch.aborted) throw abortError();
    if (!token) {
      this.o.onAuthFailure?.();
      throw new ApiError("unauthenticated", "Sign in again.", { status: 401 });
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      user?.addEventListener("abort", onAbort, { once: true });
      epoch.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.o.timeoutMs);
      const release = () => clearTimeout(timer);

      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: init.accept };
        if (init.body !== undefined) headers["Content-Type"] = "application/json";
        const ws = this.o.getWorkspaceId?.();
        if (ws) headers["X-Workspace-Id"] = ws;
        const doFetch = this.o.fetch ?? fetch;
        const res = await doFetch(`${this.o.baseUrl}${path}`, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });

        if (res.status === 401 && attempt === 0) {
          release();
          const fresh = await this.refreshOnce();
          if (fresh) {
            token = fresh;
            continue;
          }
          this.o.onAuthFailure?.();
          throw new ApiError("unauthenticated", "Sign in again.", { status: 401 });
        }
        if (!res.ok) {
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            /* not JSON: the status decides */
          }
          const err = errorFromEnvelope(res.status, body, res.headers.get("X-Request-Id"));
          if (res.status === 401) this.o.onAuthFailure?.();
          throw err;
        }
        const out = await consume(res);
        release();
        // A streamed body outlives this call: keep the abort link, drop the timer.
        return out;
      } catch (err) {
        release();
        if (err instanceof ApiError) throw err;
        if (user?.aborted || epoch.aborted) throw abortError();
        // Not retried: 30 s of waiting is the limit, after that the pane says
        // so and offers Retry (and a write may have reached the server).
        if (timedOut) throw new ApiError("timeout", "The request timed out.", { retryable: false });
        throw new ApiError("network", "Could not reach the server.", { retryable: true });
      } finally {
        if (init.accept !== "text/event-stream") {
          user?.removeEventListener("abort", onAbort);
          epoch.removeEventListener("abort", onAbort);
        }
      }
    }
  }

  private refreshOnce(): Promise<string | null> {
    if (!this.refreshing) {
      this.refreshing = this.o
        .refreshToken()
        .catch(() => null)
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  private async withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw isAbortError(err) ? err : abortError();
        const retry = err instanceof ApiError && err.retryable && attempt < this.o.maxRetries;
        if (!retry) throw err;
        // Full jitter around an exponential step: 0.5x .. 1.5x of base * 2^n.
        const step = this.o.retryBaseMs * 2 ** attempt;
        await this.o.sleep(step * (0.5 + this.o.random()), signal);
      }
    }
  }

  /** In-flight de-duplication. Every caller gets its own abortable promise;
   *  the shared work is aborted only when the last caller has let go. */
  private shared<T>(key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<unknown>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: Shared = { controller, consumers: 0, promise: Promise.resolve() };
      created.promise = start(controller.signal).finally(() => {
        if (this.inflight.get(key) === created) this.inflight.delete(key);
      });
      // The shared promise may have no listener left after aborts.
      created.promise.catch(() => {});
      this.inflight.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.consumers++;
    if (!signal) return shared.promise as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        shared.consumers--;
        if (shared.consumers <= 0) {
          if (this.inflight.get(key) === shared) this.inflight.delete(key);
          shared.controller.abort();
        }
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v as T);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private enqueue<T>(call: MailCall, signal: AbortSignal, lane: ReadLane): Promise<T> {
    if (!this.o.isOnline()) return Promise.reject(new ApiError("offline", "You are offline."));
    // On a live socket reads are NOT coalesced into `/mail/batch`: each goes
    // out as its own frame. What a batch buys over HTTP is one cold start
    // instead of twelve; on a socket there is none to save (~1 ms a frame).
    // And the server orders same-inbox work either way: every operation
    // leases the inbox's ONE pooled mailbox connection in turn (imap-pool.ts,
    // rule 2), which is what a batch does for same-inbox calls too. Separate
    // frames are answered one by one as each finishes, where a batch answers
    // only when its slowest call has (so the fast/slow lanes are not needed
    // here either). Rate-limit cost is identical (a batch costs its length).
    // The socket caps frames in flight below the server's limit of 24.
    if (this.socket?.isLive()) return this.json<T>("POST", "/mail", call, signal);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ call, lane, signal, resolve: resolve as (v: unknown) => void, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        this.o.defer(() => this.flush());
      }
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    const all = this.queue;
    this.queue = [];
    const lanes = new Map<ReadLane, Queued[]>();
    for (const q of all) {
      if (q.signal.aborted) q.reject(abortError());
      else lanes.set(q.lane, [...(lanes.get(q.lane) ?? []), q]);
    }
    for (const live of lanes.values()) {
      for (let i = 0; i < live.length; i += this.o.maxBatch) void this.sendChunk(live.slice(i, i + this.o.maxBatch));
    }
  }

  private async sendChunk(chunk: Queued[]): Promise<void> {
    // The request is only worth keeping while someone still wants an answer.
    const controller = new AbortController();
    let waiting = chunk.length;
    const cleanups: (() => void)[] = [];
    for (const q of chunk) {
      const onAbort = () => {
        q.reject(abortError());
        if (--waiting <= 0) controller.abort();
      };
      q.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => q.signal.removeEventListener("abort", onAbort));
    }
    try {
      const only = chunk[0];
      if (chunk.length === 1 && only) {
        only.resolve(await this.json("POST", "/mail", only.call, controller.signal));
        return;
      }
      const res = await this.json<{ results?: { ok?: boolean; result?: unknown; error?: unknown }[] }>(
        "POST",
        "/mail/batch",
        { calls: chunk.map((q) => q.call) },
        controller.signal,
      );
      const results = Array.isArray(res?.results) ? res.results : [];
      chunk.forEach((q, i) => {
        const r = results[i];
        if (!r) q.reject(new ApiError("invalid_response", "The server left a request unanswered.", { retryable: true }));
        else if (r.ok) q.resolve(r.result);
        else q.reject(errorFromEnvelope(0, { error: r.error }, null));
      });
    } catch (err) {
      for (const q of chunk) q.reject(err);
    } finally {
      for (const c of cleanups) c();
    }
  }
}
