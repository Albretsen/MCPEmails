// ---------------------------------------------------------------------------
// provider-call-harness.ts — a fake network for the three executors whose
// Gmail / Graph round trips are pinned by provider-call-baseline.test.ts.
//
// TEST SUPPORT ONLY. Nothing in the server imports this file, so it is never
// bundled into the deployed function.
//
// What it replaces is `globalThis.fetch`, which is the single door every
// provider call and every PostgREST call in index.ts goes through. So a test
// drives the REAL executor (`executeListDrafts`, `executeListInbox`,
// `executeReadEmails`), the real inbox resolution, the real token decrypt and
// the real readers, and only the bytes on the wire are invented.
//
// Every mailbox, address, subject and body in here and in the suites that use
// it is made up. Nothing was copied from a real account.
//
// Two ways to run a call:
//
//   * `runTool`   every answer arrives one macrotask after it was asked for.
//                 Used to pin results and the set of requests.
//   * `runRounds` provider requests are HELD. Each time the code under test
//                 goes quiet, every held request is answered at once and that
//                 counts as one round. The number of rounds is the serial
//                 depth of the call: 20 requests issued one after another take
//                 20 rounds, the same 20 issued four at a time take 5. It is a
//                 count, not a stopwatch, so it does not depend on how busy
//                 the machine running the suite is.
//
// In both, `maxInFlight` is the most provider requests that were ever
// outstanding at the same moment.
// ---------------------------------------------------------------------------

export const SUPABASE_URL = "http://supabase.provider-harness.invalid";
export const WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const INBOX_ID = "22222222-2222-4222-8222-222222222222";

/** Invented. 32 bytes of hex, the shape `decryptStoredToken` requires. */
const ENCRYPTION_KEY = "5a".repeat(32);

const RUN_ENV: Record<string, string> = {
  ENCRYPTION_KEY,
  GMAIL_CLIENT_ID: "gmail-client-id.invalid",
  GMAIL_CLIENT_SECRET: "gmail-client-secret-invented",
  OUTLOOK_CLIENT_ID: "outlook-client-id.invalid",
  OUTLOOK_CLIENT_SECRET: "outlook-client-secret-invented",
};

/** The same wire format as `encryptForStorage`: base64url(iv || ct || tag). */
export async function encryptToken(plain: string): Promise<string> {
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(ENCRYPTION_KEY.substring(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(plain)),
  );
  const all = new Uint8Array(12 + ct.byteLength);
  all.set(iv, 0);
  all.set(ct, 12);
  return btoa(String.fromCharCode(...all)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── What a test sees of one request ─────────────────────────────────────────

export interface ProviderCall {
  /** 1-based position in the order requests were ISSUED. */
  seq: number;
  method: string;
  url: string;
  host: string;
  /** The bearer token the request carried, or null. */
  bearer: string | null;
  headers: Record<string, string>;
  body: string | null;
}

export type ProviderHandler = (call: ProviderCall) => Response | Promise<Response>;

export interface DbCall {
  method: string;
  target: string;
  query: string;
  body: unknown;
}

export interface World {
  inbox: Record<string, unknown>;
  handler: ProviderHandler;
  /** Every non-PostgREST request, in issue order. */
  calls: ProviderCall[];
  db: DbCall[];
  inFlight: number;
  maxInFlight: number;
  hold: boolean;
  held: Array<() => void>;
  /** Bumped on every request and every answer; `runRounds` watches it settle. */
  activity: number;
  /** Waits `fetchWithGraphRetry` asked for (never actually slept). */
  graphSleeps: number[];
  console: Array<{ level: string; args: unknown[] }>;
}

/** Hosts whose requests count toward `inFlight` and are held by `runRounds`. */
const MAIL_API_HOSTS = new Set(["gmail.googleapis.com", "graph.microsoft.com"]);

let current: World | null = null;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function answerDb(w: World, method: string, target: string, wantsObject: boolean): Response {
  if (target === "inboxes" && method === "GET") {
    return wantsObject ? json(w.inbox) : json([w.inbox]);
  }
  if (method === "GET") return wantsObject ? json(null) : json([]);
  return new Response(null, { status: 204 });
}

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const w = current;
  const href = input instanceof Request ? input.url : String(input);
  if (!w) return Promise.reject(new Error(`provider-call-harness: network call outside a run: ${href}`));
  const url = new URL(href);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const bodyText = typeof init?.body === "string"
    ? init.body
    : init?.body instanceof URLSearchParams
    ? init.body.toString()
    : null;
  w.activity++;

  if (href.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
    const target = url.pathname.slice("/rest/v1/".length);
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch { /* not JSON */ }
    w.db.push({ method, target, query: url.search, body });
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    return sleep(0).then(() => {
      w.activity++;
      return answerDb(w, method, target, wantsObject);
    });
  }

  const auth = headers.get("authorization");
  const call: ProviderCall = {
    seq: w.calls.length + 1,
    method,
    url: href,
    host: url.host,
    bearer: auth && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null,
    headers: Object.fromEntries([...headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
    body: bodyText,
  };
  w.calls.push(call);
  const counted = MAIL_API_HOSTS.has(url.host);
  if (counted) {
    w.inFlight++;
    if (w.inFlight > w.maxInFlight) w.maxInFlight = w.inFlight;
  }
  const respond = async (): Promise<Response> => {
    try {
      return await w.handler(call);
    } finally {
      if (counted) w.inFlight--;
      w.activity++;
    }
  };
  if (counted && w.hold) {
    return new Promise<void>((open) => w.held.push(open)).then(respond);
  }
  // An answer never arrives in the turn that asked for it.
  return sleep(0).then(respond);
}

// ── Boot the real server against the fake ───────────────────────────────────
// supabase-js is created at module load, so the URL has to be in the
// environment before the import; it is put back straight after. deno runs each
// test file in its own worker, so no other suite sees this fetch.
globalThis.fetch = fakeFetch as typeof fetch;

const ENV_FOR_IMPORT: Record<string, string | null> = {
  MCP_INTROSPECTION_ONLY: null,
  MCP_SERVER_NO_LISTEN: "1",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
};
function applyEnv(values: Record<string, string | null>): Record<string, string | null> {
  const before: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = Deno.env.get(name) ?? null;
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  return before;
}
const envBeforeImport = applyEnv(ENV_FOR_IMPORT);
const server = await import("./index.ts");
const graph = await import("./outlook-graph.ts");
applyEnv(envBeforeImport);

export const executeListDrafts = server.executeListDrafts;
export const executeListInbox = server.executeListInbox;
export const executeReadEmails = server.executeReadEmails;
export const executeReadEmail = server.executeReadEmail;

/** The API key projection the executors read. Full scopes, no inbox allowlist. */
// deno-lint-ignore no-explicit-any
export const API_KEY: any = {
  id: "33333333-3333-4333-8333-333333333333",
  workspace_id: WORKSPACE,
  name: "harness key",
  key_prefix: "mcp_test",
  key_hash: "not-a-real-hash",
  scopes: ["read:email", "write:email", "send:email"],
  inbox_ids: null,
  expires_at: null,
  last_used_at: null,
  deleted_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

export const ACCESS_TOKEN = "access-token-invented";
export const REFRESH_TOKEN = "refresh-token-invented";

/** An `inboxes` row as INBOX_SELECT_COLUMNS returns it. */
export async function inboxRow(
  provider: "gmail" | "outlook",
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    id: INBOX_ID,
    workspace_id: WORKSPACE,
    provider,
    email_address: provider === "gmail" ? "owner@gmail-harness.example" : "owner@outlook-harness.example",
    display_name: "Harness Owner",
    oauth_access_token: await encryptToken(ACCESS_TOKEN),
    oauth_refresh_token: await encryptToken(REFRESH_TOKEN),
    // Far enough out that no proactive refresh happens unless a test asks.
    oauth_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    imap_host: null,
    imap_port: null,
    imap_tls: true,
    imap_security: null,
    imap_username: null,
    imap_password: null,
    smtp_host: null,
    smtp_port: null,
    smtp_tls: true,
    smtp_security: null,
    status: "active",
    signature_html: null,
    signature_text: null,
    signature_enabled: false,
    signature_reply_mode: "always",
    signature_source: null,
    signature_updated_at: null,
    send_approval_required: false,
    ...overrides,
  };
}

/** An expiry that makes the next call refresh the token first. */
export function alreadyExpired(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function newWorld(inbox: Record<string, unknown>, handler: ProviderHandler): World {
  return {
    inbox,
    handler,
    calls: [],
    db: [],
    inFlight: 0,
    maxInFlight: 0,
    hold: false,
    held: [],
    activity: 0,
    graphSleeps: [],
    console: [],
  };
}

async function inWorld<T>(w: World, body: () => Promise<T>): Promise<T> {
  if (current) throw new Error("provider-call-harness: runs do not nest");
  const envBefore = applyEnv(RUN_ENV);
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      w.console.push({ level, args });
    };
  }
  graph.resetOutlookTokenStateForTests();
  graph.setGraphSleepForTests((ms) => {
    w.graphSleeps.push(ms);
    return Promise.resolve();
  });
  current = w;
  try {
    return await body();
  } finally {
    // Fire-and-forget work (a token persist) must land inside the run, or it
    // would hit the next test's world, or none.
    await quiet(w);
    current = null;
    graph.setGraphSleepForTests(null);
    graph.resetOutlookTokenStateForTests();
    Object.assign(console, original);
    applyEnv(envBefore);
  }
}

/** Resolve once nothing has been asked or answered for a few milliseconds. */
async function quiet(w: World): Promise<void> {
  let last = -1;
  let stable = 0;
  while (stable < 3) {
    await sleep(2);
    if (w.activity === last) stable++;
    else {
      stable = 0;
      last = w.activity;
    }
  }
}

export interface RunOutcome<T> {
  value: T;
  world: World;
}

/** Run `body` with every answer arriving one macrotask after its request. */
export async function runTool<T>(
  inbox: Record<string, unknown>,
  handler: ProviderHandler,
  body: () => Promise<T>,
): Promise<RunOutcome<T>> {
  const w = newWorld(inbox, handler);
  const value = await inWorld(w, body);
  return { value, world: w };
}

export interface RoundsOutcome<T> extends RunOutcome<T> {
  /** How many times the held mail-API requests had to be released. */
  rounds: number;
  /** How many requests each release answered. */
  roundSizes: number[];
}

/**
 * Run `body` with Gmail / Graph requests held, answering all outstanding ones
 * together each time the code under test goes quiet. See the header.
 */
export async function runRounds<T>(
  inbox: Record<string, unknown>,
  handler: ProviderHandler,
  body: () => Promise<T>,
): Promise<RoundsOutcome<T>> {
  const w = newWorld(inbox, handler);
  w.hold = true;
  const roundSizes: number[] = [];
  const value = await inWorld(w, async () => {
    let done = false;
    const pending = body().finally(() => {
      done = true;
    });
    // Keep a rejection from surfacing as unhandled while requests are held.
    pending.catch(() => {});
    let idleTurns = 0;
    while (!done) {
      await quiet(w);
      if (done) break;
      if (w.held.length === 0) {
        if (++idleTurns > 200) throw new Error("provider-call-harness: the call stalled with nothing held");
        continue;
      }
      idleTurns = 0;
      const batch = w.held.splice(0);
      roundSizes.push(batch.length);
      for (const open of batch) open();
    }
    return await pending;
  });
  return { value, world: w, rounds: roundSizes.length, roundSizes };
}

// ── Reading a recording ─────────────────────────────────────────────────────

/** `METHOD url` for every request, sorted: the requests made, as a multiset. */
export function requestMultiset(w: World): string[] {
  return w.calls.map((c) => `${c.method} ${c.url}`).sort();
}

/** `METHOD url` for every request, in the order they were issued. */
export function requestSequence(w: World): string[] {
  return w.calls.map((c) => `${c.method} ${c.url}`);
}

// ── Invented provider payloads ──────────────────────────────────────────────

export function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export interface FakeGmailMessage {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  labelIds?: string[];
  /** Milliseconds since the epoch, as Gmail sends it (a string). */
  internalDate?: string;
  snippet?: string;
  attachments?: { filename: string; mimeType: string; size: number; data?: string; attachmentId?: string }[];
}

function gmailHeaders(m: FakeGmailMessage): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  if (m.from !== undefined) out.push({ name: "From", value: m.from });
  if (m.to !== undefined) out.push({ name: "To", value: m.to });
  if (m.cc !== undefined) out.push({ name: "Cc", value: m.cc });
  if (m.subject !== undefined) out.push({ name: "Subject", value: m.subject });
  return out;
}

/** A `messages.get?format=full` body. */
export function gmailFull(m: FakeGmailMessage): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (m.text !== undefined) parts.push({ mimeType: "text/plain", body: { size: m.text.length, data: b64url(m.text) } });
  if (m.html !== undefined) parts.push({ mimeType: "text/html", body: { size: m.html.length, data: b64url(m.html) } });
  for (const a of m.attachments ?? []) {
    parts.push({
      mimeType: a.mimeType,
      filename: a.filename,
      body: { size: a.size, ...(a.data ? { data: a.data } : {}), ...(a.attachmentId ? { attachmentId: a.attachmentId } : {}) },
    });
  }
  return {
    id: m.id,
    threadId: m.threadId ?? `thread-${m.id}`,
    labelIds: m.labelIds ?? ["INBOX"],
    internalDate: m.internalDate ?? "1767225600000",
    payload: {
      mimeType: (m.attachments?.length ?? 0) > 0 ? "multipart/mixed" : "multipart/alternative",
      headers: gmailHeaders(m),
      parts,
    },
  };
}

/** A `messages.get?format=metadata` body. */
export function gmailMeta(m: FakeGmailMessage): Record<string, unknown> {
  return {
    id: m.id,
    threadId: m.threadId ?? `thread-${m.id}`,
    labelIds: m.labelIds ?? ["INBOX"],
    snippet: m.snippet ?? "",
    internalDate: m.internalDate ?? "1767225600000",
    payload: { mimeType: "text/plain", headers: gmailHeaders(m) },
  };
}

export interface FakeGraphMessage {
  id: string;
  subject?: string;
  from?: { name: string; address: string };
  to?: { name: string; address: string }[];
  contentType?: "text" | "html";
  content?: string;
  hasAttachments?: boolean;
  isRead?: boolean;
  receivedDateTime?: string;
}

/** A Graph `GET /me/messages/{id}` body. */
export function graphMessage(m: FakeGraphMessage): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: `conv-${m.id}`,
    from: m.from ? { emailAddress: m.from } : undefined,
    toRecipients: (m.to ?? []).map((emailAddress) => ({ emailAddress })),
    ccRecipients: [],
    replyTo: [],
    subject: m.subject,
    receivedDateTime: m.receivedDateTime ?? "2026-01-01T00:00:00Z",
    body: { contentType: m.contentType ?? "text", content: m.content ?? "" },
    hasAttachments: m.hasAttachments ?? false,
    isRead: m.isRead ?? true,
    internetMessageId: `<${m.id}@outlook-harness.example>`,
    internetMessageHeaders: [],
    categories: [],
  };
}

/** The last path segment of a Gmail / Graph message URL, decoded. */
export function messageIdOf(call: ProviderCall): string {
  const path = new URL(call.url).pathname;
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
}
