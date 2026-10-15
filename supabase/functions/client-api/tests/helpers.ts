// Shared fixtures for client-api's tests. No network, no database.

import type { AssistantUsage } from "../assistant-deps.ts";
import { createApp } from "../app.ts";
import { JwtVerifier, type Membership, WorkspaceGate } from "../auth.ts";
import { ImapPool, type PoolableClient } from "../imap-pool.ts";
import { RateLimiter } from "../rate-limit.ts";
import type { ApiKeyRow, ExecutorOutcome, McpSeam } from "../seam.ts";
import type { AllowanceRow, ReservationRow, Store } from "../store.ts";

export const SUPABASE_URL = "http://supabase.client-api-test.invalid";
export const JWT_SECRET = "client-api-test-secret-not-a-real-one";
export const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const SECOND_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
export const INBOX_ID = "22222222-2222-4222-8222-222222222222";
export const SECOND_INBOX_ID = "55555555-5555-4555-8555-555555555555";
export const ORIGIN = "https://app.mcpemails.com";

export function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export interface TokenOptions {
  sub?: string;
  email?: string;
  aud?: string | string[];
  role?: string;
  /** Seconds from now. Negative = already expired. */
  expiresIn?: number;
  nbfIn?: number;
  header?: Record<string, unknown>;
  secret?: string;
  extra?: Record<string, unknown>;
}

export function claimsFor(options: TokenOptions = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: options.sub ?? USER_ID,
    email: options.email ?? "owner@client-api-test.example",
    aud: options.aud ?? "authenticated",
    role: options.role ?? "authenticated",
    iat: now,
    exp: now + (options.expiresIn ?? 3600),
    ...(options.nbfIn !== undefined ? { nbf: now + options.nbfIn } : {}),
    ...(options.extra ?? {}),
  };
}

export async function mintHs256(options: TokenOptions = {}): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", ...(options.header ?? {}) }));
  const payload = b64url(JSON.stringify(claimsFor(options)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(signature)}`;
}

export function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    workspace_id: WORKSPACE_ID,
    role: "owner",
    joined_at: "2026-01-01T00:00:00.000Z",
    display_name: "Test Workspace",
    plan: "free",
    web_client_enabled: true,
    ...overrides,
  };
}

export function keyRow(workspaceId = WORKSPACE_ID): ApiKeyRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: workspaceId,
    created_by: null,
    name: "__web_client__",
    key_prefix: "mcpe_webclient",
    key_hash: "!web-client:test",
    scopes: [
      "read:email",
      "search:email",
      "send:email",
      "manage:folders",
      "delete:email",
      "manage:drafts",
      "manage:contacts",
      "schedule:email",
    ],
    inbox_ids: null,
    expires_at: null,
    last_used_at: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

export interface FakeStore extends Store {
  calls: { memberships: number; ensureKey: number; allowance: number; reserve: number; finalize: number };
  rows: Membership[];
  allowanceRow: AllowanceRow | null;
  finalized: Array<{ id: string; usage: AssistantUsage }>;
  /** `markLoginRefused` / `clearLoginRefused` calls, in order. */
  loginMarks: Array<{ op: "mark" | "clear"; inboxId: string; workspaceId: string }>;
}

export function fakeStore(rows: Membership[] = [membership()]): FakeStore {
  const period = {
    period_start: "2026-10-01T00:00:00.000Z",
    period_end: "2026-11-01T00:00:00.000Z",
  };
  const store: FakeStore = {
    calls: { memberships: 0, ensureKey: 0, allowance: 0, reserve: 0, finalize: 0 },
    rows,
    allowanceRow: { plan: "free", cap: 20, used: 3, remaining: 17, max_tokens_per_run: 120000, ...period },
    finalized: [],
    loginMarks: [],
    markLoginRefused(inboxId, workspaceId) {
      store.loginMarks.push({ op: "mark", inboxId, workspaceId });
      return Promise.resolve();
    },
    clearLoginRefused(inboxId, workspaceId) {
      store.loginMarks.push({ op: "clear", inboxId, workspaceId });
      return Promise.resolve();
    },
    memberships(_userId) {
      store.calls.memberships++;
      return Promise.resolve(store.rows.map((r) => ({ ...r })));
    },
    userProfile() {
      return Promise.resolve({ display_name: "Test Owner" });
    },
    ensureWebClientKey(workspaceId) {
      store.calls.ensureKey++;
      return Promise.resolve(keyRow(workspaceId));
    },
    allowance() {
      store.calls.allowance++;
      return Promise.resolve(store.allowanceRow);
    },
    reserveRun() {
      store.calls.reserve++;
      const row = store.allowanceRow!;
      const allowed = (row.remaining ?? 1) > 0;
      const out: ReservationRow = {
        ...row,
        used: row.used + (allowed ? 1 : 0),
        remaining: row.remaining === null ? null : Math.max(0, row.remaining - (allowed ? 1 : 0)),
        allowed,
        reservation_id: allowed ? "99999999-9999-4999-8999-999999999999" : null,
      };
      return Promise.resolve(out);
    },
    finalizeRun(id, usage) {
      store.calls.finalize++;
      store.finalized.push({ id, usage });
      return Promise.resolve();
    },
  };
  return store;
}

export interface SeamCall {
  tool: string;
  args: Record<string, unknown>;
  apiKey: ApiKeyRow;
}

export interface FakeSeam extends McpSeam {
  calls: SeamCall[];
  respond: (call: SeamCall) => ExecutorOutcome | null | Promise<ExecutorOutcome | null>;
  claims: Array<{ tool: string; key: unknown }>;
  completed: number;
}

export const ok = (body: Record<string, unknown>): ExecutorOutcome => ({
  result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body },
  logStatus: "success",
  logErrorCode: null,
});

export const toolError = (code: string, text: string): ExecutorOutcome => ({
  result: { content: [{ type: "text", text }], isError: true },
  logStatus: "error",
  logErrorCode: code,
});

/** A stand-in for the mcp-server module: records calls, answers from `respond`. */
export function fakeSeam(): FakeSeam {
  const seam = {
    calls: [] as SeamCall[],
    claims: [] as Array<{ tool: string; key: unknown }>,
    completed: 0,
    respond: (call: SeamCall): ExecutorOutcome | null | Promise<ExecutorOutcome | null> =>
      call.tool === "inbox_list" ? ok({ inboxes: [] }) : ok({ tool: call.tool, args: call.args }),
    async dispatchExecutor(tool: string, rawArgs: unknown, apiKey: ApiKeyRow) {
      const call = { tool, args: rawArgs as Record<string, unknown>, apiKey };
      seam.calls.push(call);
      return await seam.respond(call);
    },
    claimOutboundIdempotency(tool: string, rawArgs: unknown) {
      const key = (rawArgs as Record<string, unknown>)["idempotency_key"];
      seam.claims.push({ tool, key });
      return Promise.resolve({ kind: "proceed" as const, keyDigest: "k", requestDigest: "r", key: String(key) });
    },
    completeOutboundIdempotency() {
      seam.completed++;
      return Promise.resolve();
    },
    isPartialToolResult: () => false,
    pendingApprovalIdFromToolResult: () => undefined,
    replaySnapshotFromToolResult: () => null,
    resolveInbox: () => Promise.resolve(null),
    resolveFolderId: (_inbox: unknown, name: string) => Promise.resolve(name),
    imapSessionFor: () => null,
    outlookFolderPathSegment: (folder: string) => folder,
    withFreshGmailToken: () => Promise.resolve("token"),
    withFreshOutlookToken: () => Promise.resolve("token"),
    serviceRoleClient: null,
    TOOL_REGISTRY: [],
    CONSOLIDATED_SPECS: {},
    validateInputSchema: () => [],
  };
  return seam as unknown as FakeSeam;
}

export interface TestApp {
  handle: (req: Request) => Promise<Response>;
  store: FakeStore;
  seam: McpSeam;
  pool: ImapPool<PoolableClient>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  limiter: RateLimiter;
  gate: WorkspaceGate;
}

export function testApp(options: {
  seam?: McpSeam;
  store?: FakeStore;
  limiter?: RateLimiter;
  pool?: ImapPool<PoolableClient>;
  assistant?: Parameters<typeof createApp>[0]["assistant"];
  push?: Parameters<typeof createApp>[0]["push"];
  env?: (name: string) => string | undefined;
} = {}): TestApp {
  const store = options.store ?? fakeStore();
  const seam = options.seam ?? fakeSeam();
  const pool = options.pool ?? new ImapPool<PoolableClient>();
  const logs: TestApp["logs"] = [];
  const limiter = options.limiter ?? new RateLimiter();
  const gate = new WorkspaceGate(store);
  const handle = createApp({
    mcp: seam,
    store,
    verifier: new JwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    gate,
    limiter,
    pool,
    assistant: options.assistant,
    push: options.push,
    env: options.env ?? (() => undefined),
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { handle, store, seam, pool, logs, limiter, gate };
}

export function request(
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string>; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.origin !== null) headers["origin"] = options.origin ?? ORIGIN;
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://project.functions.supabase.invalid/functions/v1/client-api${path}`, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}
