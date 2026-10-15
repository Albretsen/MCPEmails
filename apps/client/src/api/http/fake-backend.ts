/* A fake `client-api` for tests: a `fetch` that implements the backend
 * contract (session, mail ops, batch, status, allowance, the assistant's SSE
 * stream) over an in-memory mailbox. Not part of the app bundle.
 */

import type {
  AssistantAllowance,
  EmailSummary,
  FolderEntry,
  Inbox,
  InboxHealthStatus,
  InboxStatusReason,
  ScheduledSend,
  ServerFolderRole,
  SessionInfo,
} from "../types";

export interface FakeMessage extends EmailSummary {
  is_flagged: boolean;
  body_text: string;
  attachments?: { filename: string; mime_type: string; bytes: Uint8Array }[];
}

export interface FakeCall {
  op: string;
  inbox_id: string | null;
  args: Record<string, unknown>;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface WireError {
  code: string;
  message: string;
  retryable: boolean;
}

interface Failure {
  match: (call: FakeCall) => boolean;
  error: WireError;
  times: number;
}

/** The argument keys each op accepts. Copied from the server's op table
 *  (supabase/functions/client-api/mail/ops.ts), which refuses anything else. */
const ALLOWED: Record<string, readonly string[]> = {
  list: ["folder", "limit", "offset", "unread"],
  read: ["message_id", "include_html", "include_attachments", "body_offset", "body_html_offset", "body_max_chars"],
  search: ["text", "from", "to", "cc", "subject", "body", "since", "before", "query", "unread", "has_attachment", "flagged", "include_folders", "limit", "offset"],
  thread: ["message_id", "thread_key", "limit"],
  folders: [],
  status: ["folders"],
  flag: ["message_ids", "read", "starred", "idempotency_key"],
  move: ["message_ids", "destination_folder_id", "idempotency_key"],
  archive: ["message_ids", "idempotency_key"],
  delete: ["message_ids", "permanent", "idempotency_key"],
  send: ["to", "cc", "bcc", "subject", "body", "html_body", "reply_to", "from", "include_signature", "attachments", "idempotency_key"],
  reply: ["message_id", "to", "body", "html_body", "reply_all", "cc", "bcc", "from", "include_signature", "attachments", "idempotency_key"],
  forward: ["message_id", "to", "cc", "bcc", "body", "html_body", "include_attachments", "as_attachment", "from", "include_signature", "idempotency_key"],
  draft_list: ["limit"],
  draft_read: ["draft_id", "include_html"],
  draft_create: ["to", "cc", "bcc", "subject", "body", "html_body", "include_signature", "message_id", "reply_all", "idempotency_key"],
  draft_update: ["draft_id", "to", "cc", "bcc", "subject", "body", "html_body", "include_signature", "idempotency_key"],
  draft_delete: ["draft_id", "idempotency_key"],
  draft_send: ["draft_id", "to", "cc", "bcc", "idempotency_key"],
  schedule_list: ["limit"],
  schedule_create: ["to", "cc", "bcc", "subject", "body", "html_body", "reply_to", "send_at", "attachments", "idempotency_key"],
  schedule_cancel: ["id"],
  contacts: ["query", "limit", "offset"],
  attachment: ["message_id", "attachment_index", "filename"],
};
/** Ops that may be called without an inbox. */
const NO_INBOX = new Set(["schedule_list", "schedule_cancel", "contacts"]);

/** alias -> the folder it resolves to. A test may swap in opaque ids and
 *  localised names (Outlook) through `FakeBackend.systemFolders`. */
const SYSTEM_FOLDERS: Record<string, { id: string; name: string }> = {
  inbox: { id: "INBOX", name: "Inbox" },
  sent: { id: "Sent", name: "Sent" },
  archive: { id: "Archive", name: "Archive" },
  trash: { id: "Trash", name: "Trash" },
  drafts: { id: "Drafts", name: "Drafts" },
  spam: { id: "Spam", name: "Spam" },
};

/** Mail ops for an inbox in one of these states answer 409
 *  `reconnect_required` without touching the mailbox (run.ts, `assertReachable`). */
const REFUSING = new Set<InboxStatusReason>(["password_refused", "access_revoked", "no_mailbox"]);

export function fakeInbox(id: string, email: string, provider: Inbox["provider"] = "gmail"): Inbox {
  return {
    inbox_id: id,
    email_address: email,
    display_name: email.split("@")[0] ?? email,
    provider,
    service: null,
    sender_identities: [{ email_address: email, display_name: null, is_default: true }],
    sender_identity_status: "available",
    // Every `/session` inbox carries these two (app.ts, `sessionInboxList`).
    status: "ok",
    status_reason: null,
  };
}

export function fakeMessage(id: string, date: string, patch: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ name: "", email: "me@example.com" }],
    subject: `Subject ${id}`,
    date,
    preview: `Preview ${id}`,
    is_read: false,
    has_attachments: false,
    folder: "INBOX",
    thread_id: `t-${id}`,
    is_flagged: false,
    body_text: `Body ${id}`,
    ...patch,
  };
}

/** A reply to `parent` with the headers and the `thread_key` the real server
 *  sends for an IMAP mailbox (client-api mail/thread-key.ts): the key is the
 *  root Message-ID. `fakeMessage` alone has no key, like a row from a server
 *  that predates threading. */
export function fakeThreadMessage(id: string, date: string, parent: FakeMessage | null, patch: Partial<FakeMessage> = {}): FakeMessage {
  const own = `${id}@fake.mail`;
  const references = parent ? [...(parent.references ?? []), parent.message_id_header ?? `${parent.id}@fake.mail`] : [];
  return fakeMessage(id, date, {
    message_id_header: own,
    in_reply_to: parent ? (references[references.length - 1] ?? null) : null,
    references,
    thread_key: `m:${references[0] ?? own}`,
    ...patch,
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Request-Id": "req-test", ...headers } });

const fail = (status: number, error: WireError): Response => json(status, { error });

/** The routes the server's socket carries (ws.ts, SOCKET_ROUTES). */
const SOCKET_ROUTES: Record<string, "GET" | "POST"> = {
  "/session": "GET",
  "/mail": "POST",
  "/mail/batch": "POST",
  "/allowance": "GET",
};

/** The server end of `GET /ws`, speaking the frame protocol of
 *  supabase/functions/client-api/ws.ts: `auth` -> `ready` (or a 401 frame and
 *  close 4401), `ping` -> `pong`, and request frames answered by the SAME
 *  handler as HTTP (`FakeBackend.fetch`), as `{ id, status, timing,
 *  request_id, body }`. Shaped like a browser WebSocket for the client. */
export class FakeSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Every frame the client sent, parsed, in order. */
  received: Record<string, unknown>[] = [];
  /** The close code the CLIENT gave, when it closed the socket. */
  clientClosed: number | null = null;
  private token: string | null = null;
  private recycling = false;
  private inFlight = 0;

  /** What the server does when the platform is about to retire its worker
   *  (ws.ts, RECYCLING): new request frames are answered 503
   *  `socket_recycling` and not run, frames in flight finish, then the socket
   *  closes with 4409. `drain: "hold"` keeps it open until `finishRecycle()`
   *  (the server's drain timer), so a test can send frames into the drain. */
  recycle(drain: "auto" | "hold" = "auto"): void {
    if (this.recycling || this.readyState !== 1) return;
    this.recycling = true;
    this.heldDrain = drain === "hold";
    this.closeIfDrained();
  }

  /** The drain is over (nothing in flight, or the server's 3 s ran out). */
  finishRecycle(): void {
    this.heldDrain = false;
    if (this.recycling) this.serverClose(4409, "recycling");
  }

  private heldDrain = false;

  private closeIfDrained(): void {
    if (this.recycling && !this.heldDrain && this.inFlight <= 0) this.serverClose(4409, "recycling");
  }

  constructor(
    private readonly backend: FakeBackend,
    readonly url: string,
  ) {
    backend.sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      // An upgrade that is refused (or blocked by a proxy) is an error and a
      // close with 1006, never an open.
      if (backend.refuseSockets) {
        this.onerror?.({});
        this.serverClose(1006);
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.received.push(frame);
    void this.handle(frame);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.clientClosed = code;
    const onclose = this.onclose;
    queueMicrotask(() => onclose?.({ code }));
  }

  /** The server (or the network) ends the socket. */
  serverClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Request frames only (no `auth`, no `ping`). */
  requestFrames(): Record<string, unknown>[] {
    return this.received.filter((f) => f.type === undefined);
  }

  private push(frame: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(frame) });
  }

  private errorFrame(id: string | null, status: number, code: string, message: string): unknown {
    return { id, status, body: { error: { code, message, retryable: status === 429 || status >= 500 } } };
  }

  private async handle(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === "ping") {
      if (!this.backend.dropPongs) this.push({ type: "pong" });
      return;
    }
    if (frame.type === "auth") {
      await Promise.resolve();
      if (typeof frame.token !== "string" || !this.backend.tokens.has(frame.token)) {
        this.push(this.errorFrame(null, 401, "unauthenticated", "Sign in again."));
        // A socket that already holds a good token keeps it and stays open.
        if (this.token === null) this.serverClose(4401, "unauthenticated");
        return;
      }
      this.token = frame.token;
      this.push({ type: "ready" });
      return;
    }
    const id = frame.id;
    if (typeof id !== "string") {
      this.push(this.errorFrame(null, 400, "invalid_request", "Every request frame needs an 'id'."));
      return;
    }
    if (this.recycling) {
      // Not run and not dropped: exactly the server's frame.
      return this.push({
        id,
        status: 503,
        body: { error: { code: "provider_error", message: "Reconnecting. Try again.", retryable: true, tool_code: "socket_recycling" } },
      });
    }
    const path = typeof frame.path === "string" ? frame.path : "";
    const method = SOCKET_ROUTES[path];
    if (!method) return this.push(this.errorFrame(id, 404, "not_found", "No such route on the socket."));
    if (this.token === null) return this.push(this.errorFrame(id, 401, "unauthenticated", "Sign in again."));
    this.inFlight++;
    try {
      await this.run(id, path, method, frame);
    } finally {
      this.inFlight--;
      this.closeIfDrained();
    }
  }

  private async run(id: string, path: string, method: "GET" | "POST", frame: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, "x-client-transport": "ws" };
    if (typeof frame.workspace_id === "string") headers["x-workspace-id"] = frame.workspace_id;
    let body: string | undefined;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(frame.body ?? null);
    }
    const res = await this.backend.fetch(`https://api.test/client-api${path}`, { method, headers, body });
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      return this.push(this.errorFrame(id, 400, "invalid_request", "This result is binary; request it over HTTP."));
    }
    const text = await res.text();
    this.push({ id, status: res.status, timing: "", request_id: res.headers.get("x-request-id") ?? "", body: text ? JSON.parse(text) : null });
  }
}

export class FakeBackend {
  /** Access tokens the server accepts. */
  tokens = new Set<string>(["tok-1"]);
  /** Every socket a client opened, in order. */
  sockets: FakeSocket[] = [];
  /** Upgrades are refused (or blocked on the way): no socket ever opens. */
  refuseSockets = false;
  /** Pings go unanswered (a half-open connection). */
  dropPongs = false;
  /** The platform is retiring the worker: every open socket recycles. */
  recycleSockets(drain: "auto" | "hold" = "auto"): void {
    for (const s of this.sockets) s.recycle(drain);
  }
  /** The `WebSocket` constructor to hand to the client under test. */
  readonly WebSocket: new (url: string) => FakeSocket = (() => {
    const backend = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(backend, url);
      }
    };
  })();
  allowance: AssistantAllowance = {
    plan: "solo",
    used: 3,
    cap: 1000,
    remaining: 997,
    period_start: "2026-10-01T00:00:00Z",
    resets_at: "2026-11-01T00:00:00Z",
  };
  inboxes: Inbox[] = [];
  messages = new Map<string, FakeMessage[]>();
  customFolders = new Map<string, FolderEntry[]>();
  drafts = new Map<string, Map<string, { subject: string; body: string; to: string[] }>>();
  scheduled: ScheduledSend[] = [];
  /** Every message the fake "sent", once per idempotency key. */
  delivered: { op: string; inbox_id: string; args: Record<string, unknown> }[] = [];
  /** Every request, in order. */
  requests: FakeRequest[] = [];
  /** IMAP behaviour: a move gives the message a new id. "unknown": it does,
   *  and the server does not say which (no UIDPLUS: `new_message_id: null`). */
  renumberOnMove: boolean | "unknown" = false;
  /** alias -> folder, for every inbox. */
  systemFolders: Record<string, { id: string; name: string }> = { ...SYSTEM_FOLDERS };
  /** The `folders` op sends `role` on every entry. False: a server that
   *  predates the field (no `role` key at all). */
  folderRoles = true;
  /** Mail calls answered 409 because `/session` calls their inbox down. */
  refusedCalls: FakeCall[] = [];
  /** Each draft update returns a new id. */
  renumberDrafts = true;
  webClientEnabled = true;
  /** Events for `POST /assistant/run`, or raw SSE chunks. */
  assistantEvents: unknown[] = [];
  assistantChunks: string[] | null = null;
  assistantError: { status: number; error: WireError } | null = null;
  /** When set, requests wait for this before answering (or for an abort). */
  hold: Promise<void> | null = null;
  /** HTTP-level failures by path, consumed in order. */
  httpFailures: { path: string; status: number; error?: WireError }[] = [];
  /** When set, the `thread` op answers `partial: true` with this reason (the
   *  messages it found are still sent), as the server does when it ran out of
   *  time or was rate limited by the provider. */
  threadPartial: string | null = null;
  /** Mail calls whose HTTP request was aborted while it waited (`delayOp`). */
  abortedCalls: FakeCall[] = [];
  private opDelays = new Map<string, number>();

  /** From now on, HTTP requests carrying this op answer after `ms` (or reject
   *  when aborted first). 0 removes the delay. */
  delayOp(op: string, ms: number): void {
    if (ms > 0) this.opDelays.set(op, ms);
    else this.opDelays.delete(op);
  }

  private failures: Failure[] = [];
  private prints = new Map<string, number>();
  private idempotent = new Map<string, unknown>();
  private seq = 1;

  constructor(inboxes: Inbox[] = [fakeInbox("a", "a@example.com")]) {
    this.inboxes = inboxes;
    for (const i of inboxes) this.messages.set(i.inbox_id, []);
  }

  /* ---------- test controls ---------- */

  add(inbox_id: string, ...list: FakeMessage[]): void {
    const all = this.messages.get(inbox_id) ?? [];
    all.push(...list);
    this.messages.set(inbox_id, all);
    for (const m of list) this.touch(inbox_id, m.folder);
  }

  private inboxHolds = new Map<string, Promise<void>>();

  /** Mail calls for this inbox wait until the returned function is called
   *  (one very large mailbox on a cold connection). */
  holdInbox(inbox_id: string): () => void {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    this.inboxHolds.set(inbox_id, gate);
    return () => {
      if (this.inboxHolds.get(inbox_id) === gate) this.inboxHolds.delete(inbox_id);
      release();
    };
  }

  /** What `/session` says about one inbox from now on, as the server's
   *  `health.state` would: "ok" (reason null), "reconnect_required" with
   *  password_refused | access_revoked | sender_identity, or "error" with
   *  no_mailbox | unavailable. Mail ops for it then answer 409 unless mail
   *  still works (ok, sender_identity). */
  setInboxStatus(inbox_id: string, status: InboxHealthStatus, status_reason: InboxStatusReason | null = null): void {
    this.inboxes = this.inboxes.map((i) => {
      if (i.inbox_id !== inbox_id) return i;
      // An inbox row in `error` is listed with its primary address as the
      // only sender identity and `sender_identity_status: "unavailable"`.
      const rowError = status !== "ok" && status_reason !== "sender_identity";
      return {
        ...i,
        status,
        status_reason: status === "ok" ? null : status_reason,
        sender_identity_status: rowError ? "unavailable" : status_reason === "sender_identity" ? "reconnect_required" : "available",
      };
    });
  }

  /** The next `times` matching calls fail with this error. */
  failNext(match: Partial<Pick<FakeCall, "op" | "inbox_id">>, error: Partial<WireError> = {}, times = 1): void {
    this.failures.push({
      match: (c) => (match.op == null || c.op === match.op) && (match.inbox_id == null || c.inbox_id === match.inbox_id),
      error: { code: "provider_error", message: "boom", retryable: false, ...error },
      times,
    });
  }

  touch(inbox_id: string, folder: string): void {
    const k = `${inbox_id}|${folder}`;
    this.prints.set(k, (this.prints.get(k) ?? 0) + 1);
  }

  /** Requests to a path (`/mail`, `/mail/batch`, `/session`...). */
  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  /** Every mail call the server received, batched or not, in order. */
  calls(op?: string): FakeCall[] {
    const out: FakeCall[] = [];
    for (const r of this.requests) {
      if (r.path === "/mail") out.push(r.body as FakeCall);
      else if (r.path === "/mail/batch") out.push(...((r.body as { calls: FakeCall[] }).calls ?? []));
    }
    return op ? out.filter((c) => c.op === op) : out;
  }

  session(workspace_id = "ws-1"): SessionInfo {
    return {
      user: { id: "user-1", email: "me@example.com", display_name: "Me" },
      workspaces: [{ id: workspace_id, display_name: "Workspace", role: "owner", plan: "solo", web_client_enabled: this.webClientEnabled }],
      workspace_id,
      role: "owner",
      // Active inboxes first; the ones whose row is in an error state after them.
      inboxes: [...this.inboxes.filter((i) => !this.rowError(i)), ...this.inboxes.filter((i) => this.rowError(i))],
      allowance: this.allowance,
    };
  }

  private rowError(i: Inbox): boolean {
    return i.status !== undefined && i.status !== "ok" && i.status_reason !== "sender_identity";
  }

  /* ---------- fetch ---------- */

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "https://api.test").pathname.replace(/^.*\/client-api/, "");
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, headers, body });

    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        void this.hold?.then(resolve);
      });
    }

    // A slow mailbox: its calls answer when released. A batch answers when
    // its slowest call has, as on the server.
    const held = (path === "/mail" ? [body as FakeCall] : path === "/mail/batch" ? ((body as { calls?: FakeCall[] }).calls ?? []) : [])
      .map((c) => this.inboxHolds.get(c?.inbox_id ?? ""))
      .filter((p): p is Promise<void> => !!p);
    if (held.length) {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        void Promise.all(held).then(() => resolve());
      });
    }

    // A slow op: answers after its delay, unless the request is aborted first.
    const mailCalls = path === "/mail" ? [body as FakeCall] : path === "/mail/batch" ? ((body as { calls?: FakeCall[] }).calls ?? []) : [];
    const delay = Math.max(0, ...mailCalls.map((c) => this.opDelays.get(c?.op ?? "") ?? 0));
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            this.abortedCalls.push(...mailCalls);
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }

    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.tokens.has(token)) return fail(401, { code: "unauthenticated", message: "bad token", retryable: false });

    const http = this.httpFailures.findIndex((f) => f.path === path);
    if (http >= 0) {
      const [f] = this.httpFailures.splice(http, 1);
      if (f) return f.error ? fail(f.status, f.error) : new Response("oops", { status: f.status });
    }
    if (!this.webClientEnabled && path !== "/session") {
      return fail(403, { code: "web_client_disabled", message: "not enabled", retryable: false });
    }

    if (method === "GET" && path === "/session") return json(200, this.session(headers["x-workspace-id"] ?? "ws-1"));
    if (method === "GET" && path === "/allowance") return json(200, this.allowance);
    if (method === "POST" && path === "/mail") {
      const call = body as FakeCall;
      if (call.op === "attachment") return this.attachment(call);
      try {
        return json(200, this.call(call));
      } catch (err) {
        return fail(statusOf(err as WireError), err as WireError);
      }
    }
    if (method === "POST" && path === "/mail/batch") {
      const calls = (body as { calls: FakeCall[] }).calls;
      if (calls.length > 12) return fail(400, { code: "invalid_request", message: "too many calls", retryable: false });
      return json(200, {
        results: calls.map((c) => {
          try {
            return { ok: true, result: this.call(c) };
          } catch (err) {
            return { ok: false, error: err };
          }
        }),
      });
    }
    if (method === "POST" && path === "/assistant/run") return this.assistant();
    return fail(404, { code: "invalid_request", message: `no route ${method} ${path}`, retryable: false });
  };

  /* ---------- mail ops ---------- */

  private list(inbox_id: string, folder: string): FakeMessage[] {
    return (this.messages.get(inbox_id) ?? []).filter((m) => m.folder === folder).sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  private folderId(inbox_id: string, wanted: string): string {
    const alias = this.systemFolders[wanted.toLowerCase()];
    if (alias) return alias.id;
    const custom = (this.customFolders.get(inbox_id) ?? []).find((f) => f.id === wanted || f.name.toLowerCase() === wanted.toLowerCase());
    if (custom) return custom.id;
    throw { code: "invalid_request", message: `folder_not_found: ${wanted}`, retryable: false } satisfies WireError;
  }

  private folderEntries(inbox_id: string): FolderEntry[] {
    // `role` exactly as mail/roles.ts adds it: one of the six on the folder
    // the same alias resolves to, null on every other entry. Left out
    // altogether by a server that predates it (`folderRoles = false`).
    const role = (r: ServerFolderRole | null) => (this.folderRoles ? { role: r } : {});
    const system: FolderEntry[] = Object.entries(this.systemFolders).map(([alias, f]) => ({
      id: f.id,
      name: f.name,
      type: "folder",
      // Saved drafts are mail in the Drafts folder, and counted there.
      total_messages: this.list(inbox_id, f.id).length + (alias === "drafts" ? (this.drafts.get(inbox_id)?.size ?? 0) : 0),
      unread_messages: this.list(inbox_id, f.id).filter((m) => !m.is_read).length,
      ...role(alias as ServerFolderRole),
    }));
    const custom = (this.customFolders.get(inbox_id) ?? []).map((f) => ({
      ...f,
      total_messages: this.list(inbox_id, f.id).length,
      unread_messages: this.list(inbox_id, f.id).filter((m) => !m.is_read).length,
      ...role(null),
    }));
    return [...system, ...custom];
  }

  private page(rows: FakeMessage[], args: Record<string, unknown>) {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 50);
    const slice = rows.slice(offset, offset + limit);
    const has_more = offset + limit < rows.length;
    const messages = slice.map(({ body_text: _b, attachments: _a, ...summary }) => summary);
    return { messages, total: rows.length, has_more, next_offset: has_more ? offset + limit : null };
  }

  private relocate(inbox_id: string, ids: string[], dest: string | null) {
    const all = this.messages.get(inbox_id) ?? [];
    const results = ids.map((id) => {
      const m = all.find((x) => x.id === id);
      if (!m) return { message_id: id, success: false, error: "message_not_found" };
      this.touch(inbox_id, m.folder);
      if (dest == null) {
        all.splice(all.indexOf(m), 1);
        return { message_id: id, success: true };
      }
      m.folder = dest;
      this.touch(inbox_id, dest);
      if (this.renumberOnMove === "unknown") {
        m.id = `${id.split("~")[0]}~${this.seq++}`;
        return { message_id: id, success: true, new_message_id: null };
      }
      if (!this.renumberOnMove) return { message_id: id, success: true, new_message_id: id };
      m.id = `${id.split("~")[0]}~${this.seq++}`;
      return { message_id: id, success: true, new_message_id: m.id };
    });
    // RelocateResult, exactly as the server's `relocateResult` builds it.
    return {
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results: results.map((r) => (dest == null && r.success ? { ...r, new_message_id: null } : r)),
    };
  }

  call(c: FakeCall): unknown {
    const i = this.failures.findIndex((f) => f.match(c));
    if (i >= 0) {
      const f = this.failures[i];
      if (f) {
        if (--f.times <= 0) this.failures.splice(i, 1);
        throw f.error;
      }
    }
    const inbox_id = c.inbox_id ?? "";
    const allowed = ALLOWED[c.op];
    if (!allowed) throw { code: "invalid_request", message: `unknown op ${c.op}`, retryable: false } satisfies WireError;
    for (const key of Object.keys(c.args ?? {})) {
      if (!allowed.includes(key)) {
        throw { code: "invalid_request", message: `${c.op}: unknown argument '${key}'.`, retryable: false } satisfies WireError;
      }
    }
    if (!(NO_INBOX.has(c.op) && c.inbox_id == null) && !this.messages.has(inbox_id)) {
      throw { code: "inbox_not_found", message: "no such inbox", retryable: false } satisfies WireError;
    }
    const reason = this.inboxes.find((i) => i.inbox_id === inbox_id)?.status_reason;
    if (reason && REFUSING.has(reason)) {
      this.refusedCalls.push(c);
      throw { code: "reconnect_required", message: "Reconnect this mailbox in the dashboard.", retryable: false } satisfies WireError;
    }
    const a = c.args ?? {};
    const all = this.messages.get(inbox_id) ?? [];
    switch (c.op) {
      case "list": {
        let rows = this.list(inbox_id, this.folderId(inbox_id, String(a.folder)));
        if (a.unread) rows = rows.filter((m) => !m.is_read);
        return this.page(rows, a);
      }
      case "search": {
        let rows = [...all].sort((x, y) => (x.date < y.date ? 1 : -1));
        if (a.flagged) rows = rows.filter((m) => m.is_flagged);
        if (typeof a.text === "string") {
          const q = a.text.toLowerCase();
          rows = rows.filter((m) => `${m.subject} ${m.preview} ${m.from.email}`.toLowerCase().includes(q));
        }
        return this.page(rows, a);
      }
      case "read": {
        const m = all.find((x) => x.id === a.message_id);
        if (!m) throw { code: "provider_error", message: "message_not_found", retryable: false } satisfies WireError;
        // `is_flagged` and `folder` ride on every read (first-party fields).
        const { preview: _p, has_attachments: _h, attachments, ...rest } = m;
        return {
          ...rest,
          cc: [],
          bcc: [],
          reply_to: null,
          body_html: a.include_html ? `<p>${m.body_text}</p>` : null,
          attachments: (attachments ?? []).map((x, n) => ({
            attachment_index: n,
            filename: x.filename,
            mime_type: x.mime_type,
            size_bytes: x.bytes.length,
            data: null,
          })),
          labels: [],
          in_reply_to: null,
          references: [],
        };
      }
      case "thread": {
        // The same contract as client-api mail/thread.ts: every message of the
        // anchor's conversation in this mailbox, whatever its folder (not
        // Trash, Spam or Drafts), date ASCENDING, summaries only, the newest
        // `limit` kept and `partial` saying when that cut something.
        const anchor = all.find((x) => x.id === a.message_id);
        if (!anchor) throw { code: "not_found", message: "This message no longer exists.", retryable: false } satisfies WireError;
        const keyOf = (m: FakeMessage) => m.thread_key ?? `u:${m.id}`;
        const hidden = new Set(["trash", "spam", "drafts"].map((alias) => this.systemFolders[alias]?.id));
        const rows = all
          .filter((m) => keyOf(m) === keyOf(anchor) && !hidden.has(m.folder))
          .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
        const limit = typeof a.limit === "number" ? a.limit : 50;
        const over = rows.length > limit;
        return {
          thread_key: keyOf(anchor),
          messages: (over ? rows.slice(rows.length - limit) : rows).map(({ body_text: _b, attachments: _a, ...summary }) => summary),
          partial: over || this.threadPartial != null,
          ...(this.threadPartial != null ? { partial_reason: this.threadPartial } : over ? { partial_reason: "limit" } : {}),
          strategy: "fake",
          folders: ["*"],
        };
      }
      case "folders":
        return { folders: this.folderEntries(inbox_id) };
      case "status": {
        // Only the folders asked for; the inbox when none are.
        const wanted = Array.isArray(a.folders) && a.folders.length ? (a.folders as string[]) : ["inbox"];
        const entries = this.folderEntries(inbox_id);
        return {
          inbox_id,
          provider: "fake",
          folders: wanted.map((folder) => {
            let id: string | null = null;
            try {
              id = this.folderId(inbox_id, folder);
            } catch {
              return { folder, id: null, total: null, unread: null, fingerprint: null, error: "folder_not_found" };
            }
            const f = entries.find((e) => e.id === id);
            return {
              folder,
              id,
              total: f?.total_messages ?? null,
              unread: f?.unread_messages ?? null,
              fingerprint: `fp-${this.prints.get(`${inbox_id}|${id}`) ?? 0}`,
            };
          }),
        };
      }
      case "flag": {
        for (const id of a.message_ids as string[]) {
          const m = all.find((x) => x.id === id);
          if (!m) continue;
          if (typeof a.read === "boolean") m.is_read = a.read;
          if (typeof a.starred === "boolean") m.is_flagged = a.starred;
          this.touch(inbox_id, m.folder);
        }
        return { success: true };
      }
      case "move":
        return this.relocate(inbox_id, a.message_ids as string[], this.folderId(inbox_id, String(a.destination_folder_id)));
      case "archive":
        return this.relocate(inbox_id, a.message_ids as string[], this.folderId(inbox_id, "archive"));
      case "delete":
        return this.relocate(inbox_id, a.message_ids as string[], a.permanent ? null : this.folderId(inbox_id, "trash"));
      case "send":
      case "reply":
      case "forward":
      case "draft_send": {
        const key = String(a.idempotency_key ?? "");
        if (!key) throw { code: "invalid_request", message: "idempotency_key required", retryable: false } satisfies WireError;
        const seen = this.idempotent.get(key);
        if (seen) return seen;
        this.delivered.push({ op: c.op, inbox_id, args: a });
        this.touch(inbox_id, this.folderId(inbox_id, "sent"));
        const result = { message_id: `sent-${this.seq++}`, status: "sent" };
        this.idempotent.set(key, result);
        return result;
      }
      case "draft_list": {
        const drafts = this.drafts.get(inbox_id) ?? new Map();
        return {
          drafts: [...drafts].map(([draft_id, d]) => ({
            draft_id,
            subject: d.subject,
            to: d.to.map((email: string) => ({ name: "", email })),
            cc: [],
            created_at: "2026-10-03T10:00:00Z",
          })),
        };
      }
      case "draft_read": {
        const d = this.drafts.get(inbox_id)?.get(String(a.draft_id));
        if (!d) throw { code: "provider_error", message: "draft_not_found", retryable: false } satisfies WireError;
        return { draft_id: a.draft_id, subject: d.subject, body_text: d.body, to: d.to.map((email) => ({ name: "", email })), cc: [], bcc: [] };
      }
      case "draft_create":
      case "draft_update": {
        const drafts = this.drafts.get(inbox_id) ?? new Map<string, { subject: string; body: string; to: string[] }>();
        this.drafts.set(inbox_id, drafts);
        let id = `d-${this.seq++}`;
        if (c.op === "draft_update") {
          const old = String(a.draft_id);
          if (!drafts.has(old)) throw { code: "provider_error", message: "draft_not_found", retryable: false } satisfies WireError;
          drafts.delete(old);
          if (!this.renumberDrafts) id = old;
        }
        drafts.set(id, { subject: String(a.subject ?? ""), body: String(a.body ?? ""), to: (a.to as string[]) ?? [] });
        this.touch(inbox_id, this.folderId(inbox_id, "drafts"));
        return { draft_id: id };
      }
      case "draft_delete":
        this.drafts.get(inbox_id)?.delete(String(a.draft_id));
        return { success: true };
      case "schedule_list": {
        const rows = this.scheduled.filter((s) => c.inbox_id == null || s.inbox_id === inbox_id);
        return { scheduled_sends: rows, total: rows.length };
      }
      case "schedule_create": {
        const s: ScheduledSend = {
          id: `s-${this.seq++}`,
          inbox_id,
          send_at: String(a.send_at),
          status: "pending",
          created_at: "2026-10-03T10:00:00Z",
          to: (a.to as string[]) ?? [],
          subject: String(a.subject ?? ""),
        };
        this.scheduled.push(s);
        // Field order as executeScheduleSend answers.
        return { scheduled: true, id: s.id, inbox_id, to: s.to, subject: s.subject, send_at: s.send_at, status: s.status, created_at: s.created_at };
      }
      case "schedule_cancel": {
        const hit = this.scheduled.find((s) => s.id === a.id);
        this.scheduled = this.scheduled.filter((s) => s.id !== a.id);
        return { cancelled: true, id: a.id, inbox_id: hit?.inbox_id ?? inbox_id, send_at: hit?.send_at ?? null, previous_status: "pending" };
      }
      case "contacts":
        return { contacts: [{ email_address: "maya@example.com", display_name: "Maya", message_count: 3, last_contacted_at: "2026-10-01T00:00:00Z", inbox_id: "a" }] };
      default:
        throw { code: "invalid_request", message: `op ${c.op} is not implemented by the fake`, retryable: false } satisfies WireError;
    }
  }

  private attachment(c: FakeCall): Response {
    const m = (this.messages.get(c.inbox_id ?? "") ?? []).find((x) => x.id === c.args.message_id);
    const file = m?.attachments?.[Number(c.args.attachment_index)];
    if (!file) return fail(404, { code: "invalid_request", message: "attachment_not_found", retryable: false });
    return new Response(file.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": file.mime_type,
        "Content-Disposition": `attachment; filename="fallback.bin"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      },
    });
  }

  private assistant(): Response {
    if (this.assistantError) return fail(this.assistantError.status, this.assistantError.error);
    const chunks = this.assistantChunks ?? this.assistantEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
}

function statusOf(e: WireError): number {
  switch (e.code) {
    case "unauthenticated":
      return 401;
    case "forbidden":
    case "web_client_disabled":
      return 403;
    case "rate_limited":
      return 429;
    case "reconnect_required":
      return 409;
    case "allowance_exhausted":
      return 402;
    case "invalid_request":
    case "inbox_not_found":
      return 400;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}
