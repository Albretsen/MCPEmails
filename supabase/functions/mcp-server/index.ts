import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ImapAuthError, ImapClient, ImapMailboxInfo, ImapMessageSummary } from "./imap-client.ts";
import { decodeEncodedWords, getHeader, parseEmail } from "./mime.ts";
import { sendViaSmtp, SmtpAuthError } from "./smtp-client.ts";
import {
  type NormalizedSearch,
  parseIsoDate,
  SEARCH_FIELD_DESCRIPTIONS,
  toGmailQuery,
  toGraphSearch,
  toImapSearch,
  toJmapFilter,
} from "./search-translate.ts";

// ---------------------------------------------------------------------------
// Supabase service-role client
//
// The MCP server authenticates via API keys (not user JWTs), so it uses the
// service_role key to bypass RLS and look up api_keys directly.
// This is intentional — the workspace is resolved from the key, and data
// isolation is enforced in application code (inbox_ids allowlist), not RLS.
// ---------------------------------------------------------------------------

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Activity-log inbox capture
//
// Inbox-bound tools resolve their target inbox inside `resolveInboxArg` — which
// accepts an explicit inbox_id UUID, an email alias (`inbox`/`inbox_id`), OR
// auto-resolves the single accessible inbox when neither is given. The tools/call
// dispatcher cannot know the resolved id just from the raw request arguments
// (the client may pass an email alias or nothing at all), so it would log
// inbox_id = null and the dashboard would render "unknown inbox".
//
// This async-context store lets resolveInboxArg record the inbox it actually
// resolved for the in-flight request; the dispatcher reads it back for logging.
// AsyncLocalStorage keeps each concurrent tools/call isolated even when the
// edge isolate is reused across requests. If the runtime lacks ALS support the
// store is simply absent and logging falls back to the raw-argument inbox_id.
// ---------------------------------------------------------------------------

const activityInboxStore =
  new AsyncLocalStorage<{ inboxId: string | null }>();

// ---------------------------------------------------------------------------
// Reconnect / auth-failure helpers
// ---------------------------------------------------------------------------

/** Canonical app origin (apex domain). Override via APP_URL for previews. */
const APP_URL = (Deno.env.get("APP_URL") ?? "https://mcpemails.com").replace(/\/+$/, "");

/**
 * Build the URL the user should open to reconnect a broken inbox.
 *
 * For OAuth providers (gmail, outlook) we return a deep link into the OAuth
 * start route, scoped to the specific inbox. The route passes the inbox's
 * email address to the provider as a `login_hint` so the account chooser
 * pre-selects the right account — the user just has to be signed in to the
 * dashboard and approve. App-password providers (fastmail, imap) can't be
 * re-authorized via OAuth, so we send the user to the inbox list to update
 * their credentials.
 */
function reconnectUrl(provider: string, inboxId: string): string {
  if (provider === "gmail" || provider === "outlook") {
    return `${APP_URL}/auth/${provider}?inbox=${encodeURIComponent(inboxId)}`;
  }
  return `${APP_URL}/dashboard/inboxes`;
}

interface ToolErrorResult {
  result: {
    content: { type: string; text: string }[];
    isError: boolean;
    structuredContent?: Record<string, unknown>;
  };
  logStatus: "error";
  logErrorCode: string;
}

/**
 * Standard tool result for an expired/revoked inbox token. The text is written
 * for the calling agent: it names the failed action, explains the cause, and
 * gives a single clickable reconnect link the agent can relay to the user.
 *
 * @param action human-readable verb phrase, e.g. "access" / "send a reply via".
 */
function authFailedResult(
  provider: string,
  inboxId: string,
  action = "access",
): ToolErrorResult {
  return {
    result: {
      content: [{
        type: "text",
        text:
          `Unable to ${action} the ${provider} inbox: its OAuth token has been ` +
          `revoked or expired, so the inbox has been marked 'error'. Ask the user ` +
          `to reconnect it by opening this link in their browser (they may need ` +
          `to sign in to MCP Emails first): ${reconnectUrl(provider, inboxId)}`,
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "auth_failed",
  };
}

/**
 * Builds a spec-compliant successful tool-result `content` payload.
 *
 * Returns both the backwards-compatible serialized-JSON TextContent block AND
 * the `structuredContent` object (MCP 2025-06-18). `structuredContent` MUST be
 * a JSON object per spec, so callers wrap arrays/primitives before passing in.
 *
 * Usage:
 *   return {
 *     result: { ...jsonOk(payload), isError: false },
 *     logStatus: "success", logErrorCode: null,
 *   };
 */
function jsonOk(
  obj: Record<string, unknown>,
  pretty = false,
): { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> } {
  return {
    content: [{
      type: "text",
      text: pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj),
    }],
    structuredContent: obj,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  inbox_ids: string[] | null;
  expires_at: string | null;
  last_used_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  /** Absent on notifications */
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Request context — extracted from the HTTP layer, threaded through handlers
// ---------------------------------------------------------------------------

/**
 * HTTP-level metadata about an incoming request.
 * Extracted once in `handleRequest` and passed through the call chain so
 * individual handlers do not need access to the raw `Request` object.
 */
interface RequestContext {
  /** Client IP, resolved from X-Forwarded-For → X-Real-IP → null. */
  ipAddress: string | null;
  /** Raw User-Agent header value, or null if absent. */
  userAgent: string | null;
}

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

/**
 * Params sent by the client in the `initialize` request.
 * Per the MCP spec, all fields except `protocolVersion` are optional.
 */
interface InitializeParams {
  /**
   * The MCP protocol version the client wants to use.
   * Must be a non-empty string. The server always responds with the version
   * it supports (2025-06-18) regardless of what the client requests.
   */
  protocolVersion: string;
  capabilities?: {
    elicitation?: Record<string, unknown>;
    sampling?: Record<string, unknown>;
    roots?: Record<string, unknown>;
    [key: string]: unknown;
  };
  clientInfo?: {
    name?: string;
    version?: string;
  };
}

/**
 * The result shape returned by the server in response to `initialize`.
 */
interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: {
      /** False: the tool list is static — clients should not expect notifications/tools/list_changed. */
      listChanged: false;
    };
  };
  serverInfo: {
    name: string;
    version: string;
  };
  /**
   * Free-text guidance loaded into the client's context at session start (even
   * when individual tool schemas are deferred behind tool-search). Used to make
   * inbox discovery and the action-based tool surface self-explanatory without
   * relying on any single tool being surfaced by the client's tool index.
   */
  instructions?: string;
}

/** The single protocol version this server supports. */
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

/**
 * Server instructions surfaced to the client at session start. Kept well under
 * 2KB (clients truncate there). Critical detail — how to discover an inbox_id
 * without depending on any one tool being indexed — comes first.
 */
const SERVER_INSTRUCTIONS =
  "MCP Emails lets you read, search, organize, send and schedule email across " +
  "the user's connected inboxes.\n\n" +
  "INBOX SELECTION: Most tools target one inbox via `inbox_id` (a UUID) or " +
  "`inbox` (an email address). If the key has exactly one inbox it is chosen " +
  "automatically — omit both. If several inboxes exist and you don't know the " +
  "id, DON'T guess and DON'T treat it as blocked: either call `inbox_list`, or " +
  "simply call the tool you want with no inbox_id — the response lists every " +
  "inbox with its inbox_id so you can immediately retry. To answer 'which " +
  "inboxes do I have?', call `inbox_list`.\n\n" +
  "TOOL SHAPE: Tools are grouped by resource and take an `action` argument:\n" +
  "• inbox_list — list the accessible inboxes.\n" +
  "• email_read — action: list | read | read_batch | search | attachment.\n" +
  "• email_organize — action: move | move_batch | copy | copy_batch | flag | archive | search_and_move.\n" +
  "• email_delete — action: delete | delete_batch | search_and_delete (destructive — your client may ask you to confirm).\n" +
  "• email_compose — action: send | reply | forward.\n" +
  "• folder — action: list | create | rename | delete.\n" +
  "• draft — action: list | create | update | send.\n" +
  "• schedule — action: create | list | cancel.\n" +
  "• signature — action: get | set (read or configure the inbox's auto-appended signature).\n" +
  "• contact_search — search the address book.\n" +
  "Pick the tool, then set `action`; each action uses only the relevant " +
  "arguments. Message ids come from email_read/email_search; folder ids from " +
  "folder (action:list).";

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;

/**
 * MCPEmails custom code: invalid, expired, or revoked API key.
 * Same code used for scope violations — deliberately vague to prevent oracle attacks.
 */
const RPC_INVALID_API_KEY = -32001;

/**
 * MCPEmails custom code: per-key rate limit exceeded.
 * In the JSON-RPC application-defined error range (-32099 to -32000).
 * Callers should branch on data.error_code === "rate_limit_exceeded" rather
 * than this numeric code, which is implementation detail.
 */
const RPC_RATE_LIMIT_EXCEEDED = -32029;

// ---------------------------------------------------------------------------
// CORS headers — allow any MCP client origin
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-request-id, user-agent",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonRpcErrorBody(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorResponse["error"] = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id, error };
}

function jsonResponse(
  body: JsonRpcResponse | Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// API Key authentication
// ---------------------------------------------------------------------------

/**
 * Hash an incoming bearer token with SHA-256 using the Web Crypto API.
 *
 * Produces the same 64-character lowercase hex string as the Node.js
 * implementation in apps/web/lib/api-keys/generate.ts. The algorithm
 * (SHA-256), encoding (UTF-8), and output format (lowercase hex) must
 * never diverge, or authentication will silently break for all existing keys.
 */
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison.
 *
 * Compares two equal-length strings without short-circuiting on the first
 * differing character. Prevents timing side-channels that could reveal
 * partial hash matches to an attacker measuring response latency.
 *
 * Returns false immediately if lengths differ (length is not a secret here —
 * all SHA-256 hex digests are exactly 64 characters).
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/**
 * Authenticate an incoming MCP request using the `Authorization: Bearer` header.
 *
 * Process:
 *   1. Extract the bearer token from the Authorization header.
 *   2. Validate the token format (mcpe_ prefix + 64 hex characters = 69 chars).
 *   3. Hash with SHA-256.
 *   4. Query api_keys: match key_hash, require deleted_at IS NULL, check expiry.
 *   5. Apply constant-time comparison as defence-in-depth.
 *   6. Fire-and-forget: update last_used_at.
 *
 * On success: returns { apiKey: ApiKeyRow }.
 * On failure: returns an HTTP Response — the caller must return it immediately.
 *
 * All authentication failure paths return the same error message and code
 * (RPC_INVALID_API_KEY / -32001) to prevent oracle attacks that could
 * distinguish "not found", "revoked", and "expired" states.
 */
async function authenticateRequest(
  req: Request,
  requestId: string | number | null,
): Promise<{ apiKey: ApiKeyRow } | Response> {
  // ── Extract the API key ───────────────────────────────────────────────────
  // Two equally-valid sources, in priority order:
  //   1. Authorization: Bearer <key>  — used by OAuth access tokens and curl.
  //   2. ?key=<key> (or ?api_key=)    — lets users paste a single URL into an
  //                                      MCP client instead of setting a header.
  // The header wins when both are present.
  const authHeader = req.headers.get("Authorization");
  let bearerToken: string;

  if (authHeader) {
    // Malformed scheme → HTTP 401.
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse(
        jsonRpcErrorBody(
          requestId,
          RPC_INVALID_API_KEY,
          "Authorization header must use Bearer scheme.",
          { hint: "Format: Authorization: Bearer mcpe_<64 hex characters>" },
        ),
        401,
      );
    }
    bearerToken = authHeader.slice(7).trim();
  } else {
    const params = new URL(req.url).searchParams;
    const queryKey = params.get("key") ?? params.get("api_key");

    // No key from either source → HTTP 401.
    if (!queryKey) {
      return jsonResponse(
        jsonRpcErrorBody(
          requestId,
          RPC_INVALID_API_KEY,
          "API key is required. Provide it as 'Authorization: Bearer <api-key>' or '?key=<api-key>'.",
          { hint: "Generate an API key at https://mcpemails.com/dashboard/keys" },
        ),
        401,
      );
    }
    bearerToken = queryKey.trim();
  }

  // ── Token format check → HTTP 401 ────────────────────────────────────────
  // MCPEmails keys are always exactly 69 characters: "mcpe_" (5) + 64 hex chars.
  // This check runs before hashing or any DB I/O to fail fast on obviously
  // invalid tokens without consuming database resources.
  //
  // 401 (not 403) so the /api/mcp proxy attaches WWW-Authenticate. OAuth MCP
  // clients refresh their access token on 401 but treat 403 as a hard failure,
  // so an expired token must surface as 401 for the connection to auto-refresh.
  if (!bearerToken.startsWith("mcpe_") || bearerToken.length !== 69) {
    return jsonResponse(
      jsonRpcErrorBody(
        requestId,
        RPC_INVALID_API_KEY,
        "Invalid or revoked API key.",
        { hint: "Generate a new key at https://mcpemails.com/dashboard/keys" },
      ),
      401,
    );
  }

  // ── Hash the bearer token ─────────────────────────────────────────────────
  // Only the SHA-256 hash of the key is stored in the database. The raw key
  // is never logged or persisted after the user's initial key creation.
  const incomingHash = await hashApiKey(bearerToken);

  // ── Database lookup ───────────────────────────────────────────────────────
  // Single query that simultaneously:
  //   • Authenticates (key_hash equality)
  //   • Checks revocation (deleted_at IS NULL)
  //   • Checks expiry (expires_at IS NULL OR expires_at > now())
  const { data: row, error } = await supabase
    .from("api_keys")
    .select(
      "id, workspace_id, name, key_prefix, key_hash, scopes, inbox_ids, expires_at, last_used_at, deleted_at, created_at",
    )
    .eq("key_hash", incomingHash)
    .is("deleted_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .maybeSingle();

  if (error || !row) {
    // Not found, expired, or revoked. 401 (not 403) so the proxy attaches
    // WWW-Authenticate and OAuth clients refresh. Message is identical to the
    // other failures to avoid an oracle that distinguishes the cases.
    return jsonResponse(
      jsonRpcErrorBody(
        requestId,
        RPC_INVALID_API_KEY,
        "Invalid or revoked API key.",
        { hint: "Generate a new key at https://mcpemails.com/dashboard/keys" },
      ),
      401,
    );
  }

  // ── Constant-time comparison (defence-in-depth) ───────────────────────────
  // The DB already returned the correct row via key_hash equality, but this
  // application-layer check ensures no timing side-channel exists in the DB
  // response path (e.g., a race condition or replication lag returning a
  // stale row).
  if (!timingSafeStringEqual(row.key_hash as string, incomingHash)) {
    return jsonResponse(
      jsonRpcErrorBody(
        requestId,
        RPC_INVALID_API_KEY,
        "Invalid or revoked API key.",
        { hint: "Generate a new key at https://mcpemails.com/dashboard/keys" },
      ),
      401,
    );
  }

  const apiKey = row as ApiKeyRow;

  // ── Fire-and-forget: update last_used_at ─────────────────────────────────
  // Does not block the response. A failure here is non-fatal — the dashboard
  // "last seen" display may be stale, but authentication succeeded.
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKey.id)
    .then(({ error: updateError }) => {
      if (updateError) {
        console.warn("[mcp-server] last_used_at_update_failed", {
          key_id: apiKey.id,
          error: updateError.message,
        });
      }
    });

  return { apiKey };
}

// ---------------------------------------------------------------------------
// Plan limits
// ---------------------------------------------------------------------------

/**
 * Per-plan per-minute request ceiling (fair-use burst limit).
 *
 * Usage is otherwise unlimited on every tier — this rolling 60-second ceiling
 * is the only plan-based usage lever. It is enforced per WORKSPACE (aggregate
 * across all of the workspace's API keys), so adding keys does not multiply
 * throughput. The per-key rolling windows further below are a separate abuse
 * guard that applies regardless of plan.
 *
 * `enterprise` is a legacy alias (the tier was removed) mapped to the Team
 * ceiling so any pre-existing enterprise workspace is not throttled.
 */
const PLAN_REQUESTS_PER_MINUTE: Record<string, number> = {
  free: 60,
  solo: 300,
  pro: 1_000,
  enterprise: 1_000,
};

/** Ceiling applied to unknown / unrecognised plan values. */
const DEFAULT_REQUESTS_PER_MINUTE = PLAN_REQUESTS_PER_MINUTE.free;

/**
 * Launch-era ceilings preserved for grandfathered ("legacy") workspaces. Keep
 * this map frozen at the launch values even if PLAN_REQUESTS_PER_MINUTE is
 * lowered for new signups later, so legacy users keep their current plan.
 */
const LEGACY_REQUESTS_PER_MINUTE: Record<string, number> = {
  free: 60,
  solo: 300,
  pro: 1_000,
  enterprise: 1_000,
};

/** Width of the per-plan ceiling window, in milliseconds. */
const PLAN_RPM_WINDOW_MS = 60_000;

/**
 * Outcome of a per-plan per-minute ceiling check.
 */
interface PlanQuotaResult {
  /** True when the request is within the plan's per-minute ceiling. */
  allowed: boolean;
  /** The workspace's current plan. */
  plan: string;
  /** The plan's per-minute request ceiling. */
  perMinuteLimit: number;
  /** How many calls the workspace has made in the trailing 60 seconds. */
  usedThisMinute: number;
  /** Seconds until the oldest call in the window drops out, freeing a slot. */
  retryAfterSeconds: number;
}

/**
 * Check the workspace's per-plan per-minute ceiling.
 *
 * Counts the workspace's calls in the trailing 60 seconds (aggregated across
 * all of its API keys) and compares against the plan ceiling. This replaces
 * the former daily/monthly quota model — usage is unlimited; only burst rate
 * is capped.
 *
 * Fail-open: any DB error allows the request through, matching the per-key
 * rolling-window limiter.
 */
async function checkPlanQuota(
  workspaceId: string,
): Promise<PlanQuotaResult> {
  // 1. Look up workspace plan.
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("plan, grandfathered")
    .eq("id", workspaceId)
    .maybeSingle();

  if (wsError || !workspace) {
    console.error("[mcp-server] plan_quota_workspace_lookup_failed", {
      workspace_id: workspaceId,
      error: wsError?.message ?? "no row",
    });
    // Fail open.
    return {
      allowed: true,
      plan: "free",
      perMinuteLimit: DEFAULT_REQUESTS_PER_MINUTE,
      usedThisMinute: 0,
      retryAfterSeconds: 0,
    };
  }

  const plan = (workspace.plan as string) ?? "free";
  // Grandfathered ("legacy") workspaces keep the launch-era ceiling. When usage
  // caps (e.g. a monthly total) are reintroduced here later, they must also
  // exempt grandfathered workspaces — see the workspaces.grandfathered column.
  const grandfathered =
    (workspace as { grandfathered?: boolean }).grandfathered ?? false;
  const rpmMap = grandfathered
    ? LEGACY_REQUESTS_PER_MINUTE
    : PLAN_REQUESTS_PER_MINUTE;
  const perMinuteLimit = rpmMap[plan] ?? DEFAULT_REQUESTS_PER_MINUTE;

  // 2. Count the workspace's calls in the trailing 60s window.
  const windowStart = new Date(Date.now() - PLAN_RPM_WINDOW_MS).toISOString();

  const { count, error: countError } = await supabase
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("created_at", windowStart);

  if (countError) {
    // Fail open.
    console.error("[mcp-server] plan_quota_count_failed", {
      workspace_id: workspaceId,
      error: countError.message,
    });
    return {
      allowed: true,
      plan,
      perMinuteLimit,
      usedThisMinute: 0,
      retryAfterSeconds: 0,
    };
  }

  const usedThisMinute = count ?? 0;

  // 3. Within the ceiling.
  if (usedThisMinute < perMinuteLimit) {
    return {
      allowed: true,
      plan,
      perMinuteLimit,
      usedThisMinute,
      retryAfterSeconds: 0,
    };
  }

  // 4. Ceiling hit — Retry-After = when the oldest call leaves the window.
  const { data: oldest } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const oldestTs = oldest?.created_at
    ? new Date(oldest.created_at).getTime()
    : Date.now() - PLAN_RPM_WINDOW_MS;

  const windowExpiresAt = oldestTs + PLAN_RPM_WINDOW_MS;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowExpiresAt - Date.now()) / 1_000),
  );

  return {
    allowed: false,
    plan,
    perMinuteLimit,
    usedThisMinute,
    retryAfterSeconds,
  };
}

/**
 * Build an HTTP 429 response for a per-plan per-minute ceiling hit.
 *
 * Uses the same JSON-RPC error code (-32029) and `error_code:
 * "rate_limit_exceeded"` as the per-key rolling-window limiter. The
 * human_message references the pricing page so users know how to upgrade for a
 * higher ceiling.
 */
function buildQuotaExceededResponse(
  requestId: string | number | null,
  result: PlanQuotaResult,
): Response {
  const planLabel =
    result.plan.charAt(0).toUpperCase() + result.plan.slice(1);

  const humanMessage =
    `Your ${planLabel} plan allows ${result.perMinuteLimit} requests per minute, and that ceiling has been reached. ` +
    `Please wait ${result.retryAfterSeconds} seconds before retrying. ` +
    `Usage is unlimited — upgrade for a higher burst ceiling: https://www.mcpemails.com/pricing`;

  const body: JsonRpcErrorResponse = {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: RPC_RATE_LIMIT_EXCEEDED,
      message: "Rate limit exceeded",
      data: {
        error_code: "rate_limit_exceeded",
        window: "per_minute",
        plan: result.plan,
        limit: result.perMinuteLimit,
        used: result.usedThisMinute,
        retry_after: result.retryAfterSeconds,
        human_message: humanMessage,
      },
    },
  };

  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(result.retryAfterSeconds),
      "X-Plan": result.plan,
      "X-RateLimit-Limit": String(result.perMinuteLimit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Window": "per_minute",
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Definition of a single rolling-window rate-limit check.
 */
interface WindowDefinition {
  /** Human-readable label used in error responses and logs */
  label: string;
  /** Width of the rolling window in milliseconds */
  intervalMs: number;
  /** Maximum number of activity_log rows allowed in this window per key */
  limit: number;
}

/**
 * The three enforced rolling windows, checked in ascending order of width.
 * The narrowest (per-minute) check runs first so callers get the most
 * immediately actionable Retry-After value when multiple windows are saturated.
 */
const RATE_LIMIT_WINDOWS: WindowDefinition[] = [
  { label: "per_minute", intervalMs: 60_000, limit: 100 },
  { label: "per_hour", intervalMs: 3_600_000, limit: 1_000 },
  { label: "per_day", intervalMs: 86_400_000, limit: 10_000 },
];

/**
 * Outcome of a rate-limit check.
 *
 * When `allowed` is false, the caller must return a 429 response and MUST NOT
 * route the request to a tool handler.
 */
interface RateLimitResult {
  allowed: boolean;
  /** Which window was saturated. "none" when allowed. */
  windowLabel: string;
  /** Configured limit for the saturated window. 0 when allowed. */
  limit: number;
  /** Current count in the saturated window. 0 when allowed. */
  used: number;
  /** Seconds until the oldest entry in the window drops out, freeing a slot. */
  retryAfterSeconds: number;
}

/**
 * Check per-key rolling-window rate limits against the `activity_log` table.
 *
 * Queries three rolling windows in sequence (1 min, 1 hr, 1 day). The first
 * saturated window short-circuits the remaining checks and returns a denial.
 * All checks pass → returns `{ allowed: true }`.
 *
 * Fail-open behaviour: a database error in the count query is logged and the
 * window is skipped (treated as under-limit). This prevents transient DB
 * slowness from making the API entirely inaccessible. Monitoring alerts on
 * repeated DB errors independently.
 *
 * The current request is NOT yet counted (usage logging is a separate step
 * that runs after the response is sent). This means the window count reflects
 * completed calls only, allowing a ~1-call overshoot per concurrent request —
 * an accepted trade-off for keeping the log write off the critical path.
 */
async function checkRateLimit(
  apiKeyId: string,
): Promise<RateLimitResult> {
  for (const window of RATE_LIMIT_WINDOWS) {
    const windowStart = new Date(Date.now() - window.intervalMs).toISOString();

    const { count, error } = await supabase
      .from("activity_log")
      .select("*", { count: "exact", head: true })
      .eq("api_key_id", apiKeyId)
      .gte("created_at", windowStart);

    if (error) {
      // Fail open: DB error → skip this window and continue checking the rest.
      console.error("[mcp-server] rate_limit_db_error", {
        window: window.label,
        key_id: apiKeyId,
        error: error.message,
      });
      continue;
    }

    const used = count ?? 0;

    if (used >= window.limit) {
      // Find the oldest log entry in the window so we can compute an exact
      // Retry-After: the window will have a free slot when that entry falls out.
      const { data: oldest } = await supabase
        .from("activity_log")
        .select("created_at")
        .eq("api_key_id", apiKeyId)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const oldestTs = oldest?.created_at
        ? new Date(oldest.created_at).getTime()
        : Date.now() - window.intervalMs;

      const windowExpiresAt = oldestTs + window.intervalMs;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowExpiresAt - Date.now()) / 1_000),
      );

      return {
        allowed: false,
        windowLabel: window.label,
        limit: window.limit,
        used,
        retryAfterSeconds,
      };
    }
  }

  return {
    allowed: true,
    windowLabel: "none",
    limit: 0,
    used: 0,
    retryAfterSeconds: 0,
  };
}

/**
 * Sliding-window limits for the cheap methods — everything except
 * `tools/call` (`initialize`, `tools/list`, `ping`, and any unknown method
 * that falls through to the "Method not found" branch).
 *
 * None of these write to `activity_log`, so the activity_log-based
 * `checkRateLimit()` above cannot see them: a client looping any of them could
 * otherwise hammer the endpoint unbounded (observed in prod: one key looping a
 * `ping`-sized request at ~2 req/s, ~168k requests/day, with zero 429s). These
 * limits are generous for any legitimate client — a normal session calls
 * `initialize` once, `tools/list` a handful of times, and pings occasionally —
 * while capping a runaway loop to cheap 429s.
 *
 * Counted atomically per key via the `rate_limit_check` RPC against
 * `rate_limit_buckets`, independent of `activity_log`.
 */
const DISCOVERY_RATE_LIMITS: {
  label: string;
  bucket: string;
  max: number;
  windowMs: number;
}[] = [
  { label: "per_minute", bucket: "min", max: 30, windowMs: 60_000 },
  { label: "per_hour", bucket: "hr", max: 200, windowMs: 3_600_000 },
];

/**
 * Check per-key discovery-method rate limits (see DISCOVERY_RATE_LIMITS).
 *
 * Each window is an atomic UPSERT-and-count via the `rate_limit_check` RPC, so
 * concurrent isolates cannot race past the ceiling. The narrowest window is
 * checked first. Fail-open on a DB error — a transient RPC failure must never
 * block a legitimate client's handshake.
 *
 * `rate_limit_check` returns only a boolean (within-limit), not the residual
 * window, so `retryAfterSeconds` is the conservative full window width. A
 * well-behaved client honours Retry-After and backs off; that is good enough
 * to break a loop without an extra round-trip to read the bucket's age.
 */
async function checkDiscoveryRateLimit(
  apiKeyId: string,
): Promise<RateLimitResult> {
  for (const w of DISCOVERY_RATE_LIMITS) {
    const { data, error } = await supabase.rpc("rate_limit_check", {
      p_key: `mcp:discovery:${w.bucket}:${apiKeyId}`,
      p_max_count: w.max,
      p_window_ms: w.windowMs,
    });

    if (error) {
      // Fail open: skip this window on a DB/RPC error and check the rest.
      console.error("[mcp-server] discovery_rate_limit_db_error", {
        window: w.label,
        key_id: apiKeyId,
        error: error.message,
      });
      continue;
    }

    if (data === false) {
      return {
        allowed: false,
        windowLabel: w.label,
        limit: w.max,
        used: w.max,
        retryAfterSeconds: Math.ceil(w.windowMs / 1_000),
      };
    }
  }

  return {
    allowed: true,
    windowLabel: "none",
    limit: 0,
    used: 0,
    retryAfterSeconds: 0,
  };
}

/**
 * Build an HTTP 429 response with a JSON-RPC 2.0 error body.
 *
 * Headers:
 *  - Retry-After: seconds the caller must wait before retrying
 *  - X-RateLimit-Limit: the configured limit for the saturated window
 *  - X-RateLimit-Remaining: always 0 (limit was exceeded)
 *  - X-RateLimit-Window: which window was saturated (per_minute / per_hour / per_day)
 *
 * The JSON-RPC error code is -32029 (application-defined).
 * Callers should branch on data.error_code === "rate_limit_exceeded".
 */
function buildRateLimitResponse(
  requestId: string | number | null,
  result: RateLimitResult,
): Response {
  const windowReadable = result.windowLabel.replace("_", " ");
  const body: JsonRpcErrorResponse = {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: RPC_RATE_LIMIT_EXCEEDED,
      message: "Rate limit exceeded",
      data: {
        error_code: "rate_limit_exceeded",
        window: result.windowLabel,
        limit: result.limit,
        used: result.used,
        retry_after: result.retryAfterSeconds,
        human_message:
          `You have exceeded the ${windowReadable} limit of ${result.limit} calls. ` +
          `Please wait ${result.retryAfterSeconds} seconds before retrying.`,
      },
    },
  };

  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(result.retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Window": result.windowLabel,
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Usage / audit logging
// ---------------------------------------------------------------------------

/**
 * Parameters for a single `activity_log` insert.
 * All fields map directly to columns defined in the database schema.
 * @see Documents/Architecture/database-schema.md — `activity_log` table
 */
interface ActivityLogParams {
  workspaceId: string;
  apiKeyId: string;
  /** UUID of the inbox the tool operated on, or null for non-inbox operations. */
  inboxId: string | null;
  /** The name of the MCP tool that was called (e.g. "email_list"). */
  toolName: string;
  /** Outcome of the call. */
  status: "success" | "error" | "rate_limited";
  /**
   * Machine-readable error code when status is "error".
   * Uses the JSON-RPC error code as a string (e.g. "-32001").
   * Null on success or rate-limited entries.
   */
  errorCode: string | null;
  /**
   * Wall-clock duration from the start of tool dispatch to completion, in ms.
   * Null for rate-limited entries (no tool was executed).
   */
  durationMs: number | null;
  /** Client IP address. Stored as text; Postgres casts to `inet`. */
  ipAddress: string | null;
  /** Raw User-Agent header string from the HTTP request. */
  userAgent: string | null;
}

/**
 * Append one row to `activity_log`.
 *
 * Called after every `tools/call` invocation — success, error, or rate-limit.
 * Also called for rate-limited requests before the 429 is returned.
 *
 * This insert is **awaited** (not fire-and-forget) so the audit trail is
 * guaranteed to be complete before the HTTP response is sent, even if the
 * client disconnects immediately after receiving the response.
 *
 * Failures are logged to the Edge Function console but are non-fatal: the
 * original tool result is still returned to the caller. Audit-log failures
 * are monitored via Supabase log alerts.
 *
 * @see Documents/Architecture/mcp-server-architecture.md §3 Step 7
 */
async function writeActivityLog(params: ActivityLogParams): Promise<void> {
  const row: Record<string, unknown> = {
    workspace_id: params.workspaceId,
    api_key_id: params.apiKeyId,
    inbox_id: params.inboxId,
    tool_name: params.toolName,
    status: params.status,
    error_code: params.errorCode,
    duration_ms: params.durationMs,
    // ip_address is an `inet` column in Postgres. Supabase accepts a text
    // value and the DB driver casts it automatically. A null value is stored
    // as SQL NULL — no special handling needed.
    ip_address: params.ipAddress,
    user_agent: params.userAgent,
    // created_at defaults to now() — omitted to let the DB set it precisely.
  };

  const { error } = await supabase.from("activity_log").insert(row);

  if (error) {
    // Do not throw — a logging failure must never prevent a response from
    // reaching the caller. Log the failure so monitoring can alert operators.
    console.error("[mcp-server] activity_log_insert_failed", {
      workspace_id: params.workspaceId,
      key_id: params.apiKeyId,
      tool_name: params.toolName,
      status: params.status,
      error: error.message,
      error_code: error.code,
    });
  }
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

/**
 * Returns true when `obj` satisfies the minimum JSON-RPC 2.0 envelope shape.
 * Per the spec, `params` is optional and may be an object or array.
 */
function isValidJsonRpcEnvelope(obj: unknown): obj is JsonRpcRequest {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return false;
  }
  const candidate = obj as Record<string, unknown>;

  if (candidate["jsonrpc"] !== "2.0") {
    return false;
  }
  if (
    typeof candidate["method"] !== "string" ||
    candidate["method"].length === 0
  ) {
    return false;
  }
  // `params` must be absent, an object, or an array — never a primitive
  if (
    candidate["params"] !== undefined &&
    (typeof candidate["params"] !== "object" || candidate["params"] === null)
  ) {
    return false;
  }
  return true;
}

/**
 * JSON-RPC notifications have no `id` field (or it is explicitly null/undefined).
 * Notifications must be acknowledged but must not receive a response body.
 */
function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}

// ---------------------------------------------------------------------------
// Method router
// ---------------------------------------------------------------------------

/**
 * Route a validated, authenticated JSON-RPC request to the appropriate handler.
 *
 * The `apiKey` and `ctx` parameters are passed through to every handler for
 * scope checks, inbox resolution, and activity logging.
 *
 * This function is async because `handleToolsCall` performs I/O (logging).
 */
async function routeMethod(
  req: JsonRpcRequest,
  apiKey: ApiKeyRow,
  ctx: RequestContext,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return handleInitialize(req, id);

    case "tools/list":
      return handleToolsList(req, id, apiKey);

    case "tools/call":
      return await handleToolsCall(req, id, apiKey, ctx);

    case "ping":
      // MCP utility ping: the receiver MUST respond promptly with an empty
      // result. Previously this fell through to "Method not found" (-32601),
      // which buggy clients interpret as a dead connection and retry in a tight
      // loop — observed in prod as a ~2 req/s ping storm from one client.
      // https://modelcontextprotocol.io/specification/.../utilities/ping
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return jsonRpcErrorBody(
        id,
        RPC_METHOD_NOT_FOUND,
        `Method not found: ${req.method}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Tool registry
//
// Each entry defines a single MCP tool: its name, human title, description,
// required scope, and JSON Schema (Draft 7) for input validation.
//
// The registry is built at module load time (cold start). Because it is pure
// in-memory data with no I/O, it does not add measurable latency to the first
// request.
//
// Input schemas are sourced from Documents/Architecture/mcp-tool-design.md
// §3. Keep this in sync with that document — changing a schema here is a
// breaking API change for any connected MCP client.
//
// ── Destructive-action convention ────────────────────────────────────────────
// Tools that delete, permanently modify, or bulk-affect messages are marked
// with `annotations.destructiveHint: true` so the MCP client can surface a
// human-in-the-loop confirmation. The server does NOT enforce a `confirm=true`
// flag — that round-trip added friction without protecting the human.
//   - For bulk tools: enforce the `MAX_BULK_IDS` cap (500) before processing
//     and return a structured error if exceeded.
// See `MAX_BULK_IDS` below.
// ---------------------------------------------------------------------------

interface ToolDefinition {
  /** Unique tool name used in tools/list and tools/call */
  name: string;
  /** Human-readable label shown in MCP client UIs */
  title: string;
  /** Detailed description for the AI agent */
  description: string;
  /** Which api_keys.scopes[] value is required to call this tool */
  requiredScope:
    | "read:email"
    | "send:email"
    | "delete:email"
    | "manage:folders"
    | "manage:drafts"
    | "manage:contacts"
    | "schedule:email";
  /**
   * Optional alternative scopes that ALSO authorize this tool. A key is
   * authorized if it holds `requiredScope` OR any scope listed here.
   */
  altScopes?: string[];
  /** JSON Schema (Draft 7) for argument validation */
  inputSchema: Record<string, unknown>;
  /**
   * Optional JSON Schema (Draft 7) describing the structure of a successful
   * tool result's `structuredContent` object. Emitted in tools/list so MCP
   * clients can validate / type the structured output.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Optional MCP ToolAnnotations behaviour hints (title, readOnlyHint,
   * destructiveHint, idempotentHint, openWorldHint). Emitted in tools/list.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Returns true when the given scopes authorize the tool. A key is authorized if
 * it holds the tool's `requiredScope` OR any of its optional `altScopes`.
 */
function isToolAuthorized(tool: ToolDefinition, scopes: string[]): boolean {
  if (scopes.includes(tool.requiredScope)) return true;
  if (tool.altScopes) {
    for (const alt of tool.altScopes) {
      if (scopes.includes(alt)) return true;
    }
  }
  return false;
}

/**
 * Shared JSON-Schema properties for the structured, provider-agnostic search
 * fields exposed by email_search / email_search_and_move / email_search_and_delete. The
 * server translates these into each provider's native query dialect, so the
 * agent never needs to know Gmail operators, KQL, OData, JMAP filters, or IMAP
 * SEARCH syntax. Descriptions are sourced verbatim from SEARCH_FIELD_DESCRIPTIONS.
 */
const STRUCTURED_SEARCH_PROPERTIES: Record<string, Record<string, unknown>> = {
  from: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.from },
  to: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.to },
  cc: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.cc },
  subject: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.subject },
  body: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.body },
  text: { type: "string", description: SEARCH_FIELD_DESCRIPTIONS.text },
  unread: { type: "boolean", description: SEARCH_FIELD_DESCRIPTIONS.unread },
  has_attachment: {
    type: "boolean",
    description: SEARCH_FIELD_DESCRIPTIONS.has_attachment,
  },
  flagged: { type: "boolean", description: SEARCH_FIELD_DESCRIPTIONS.flagged },
  since: {
    type: "string",
    format: "date-time",
    description: SEARCH_FIELD_DESCRIPTIONS.since,
  },
  before: {
    type: "string",
    format: "date-time",
    description: SEARCH_FIELD_DESCRIPTIONS.before,
  },
};

/** Description for the legacy `query` raw escape-hatch field. */
const RAW_QUERY_DESCRIPTION =
  "Raw provider-native query string (escape hatch). Prefer the structured " +
  "fields above. Combined with them where supported; ignored on Fastmail.";

/** Shared `inbox_id` property — the standard copy inlined across most tools. */
const INBOX_ID_PROPERTY = {
  type: "string",
  format: "uuid",
  description:
    "UUID of the inbox to use. Optional when the API key has access to " +
    "exactly one inbox (it is auto-selected). Alternatively pass `inbox` " +
    "with an email address. If you don't know the inbox_id and several are " +
    "accessible, just omit it — the response then lists every inbox with its " +
    "inbox_id so you can retry (calling inbox_list does the same).",
} as const;

/** Shared `inbox` property — the email-address alternative to `inbox_id`. */
const INBOX_PROPERTY = {
  type: "string",
  description:
    "Email address of the inbox to use, as a friendly alternative to " +
    "inbox_id. Optional; ignored if inbox_id is given.",
} as const;

/**
 * Shared `include_signature` property. The inbox's configured signature is
 * appended automatically by default; pass `false` to suppress it for this one
 * call (e.g. a terse one-line reply where a signature would be noise).
 */
const INCLUDE_SIGNATURE_PROPERTY = {
  type: "boolean",
  default: true,
  description:
    "Whether to append this inbox's configured email signature to the " +
    "message. Defaults to true. Set to false to send without the signature — " +
    "useful for terse one-line replies or when you've written your own sign-off.",
} as const;

/** All tools available in MCPEmails, in canonical display order. */
const LEGACY_TOOLS: ToolDefinition[] = [
  // ── read:email scope ────────────────────────────────────────────────────────

  // inbox_list is registered FIRST, intentionally — it is the entry point that
  // supplies the inbox_id every other tool needs. Keep it first.
  //
  // NOTE: position alone is not enough. Some clients (e.g. Claude.ai connectors)
  // build a capped on-demand tool-search index and may never surface inbox_list,
  // dead-ending discovery. The robust mitigation does NOT depend on this tool
  // being reachable: when an inbox-bound tool is called without an inbox_id and
  // several are accessible, inboxResolutionError() lists every inbox (email +
  // inbox_id) inline, so the agent can self-serve via any tool it CAN reach.
  {
    name: "inbox_list",
    title: "List Inboxes",
    description:
      "List inboxes. Returns all email inboxes (mailboxes/accounts) the current " +
      "API key is permitted to access. Call this FIRST to discover the inbox_id " +
      "values that every other tool requires. Each result includes the inbox UUID, " +
      "email address, display name, provider, optional service brand " +
      "(icloud/yahoo/zoho/yandex/generic), and a capabilities object describing " +
      "which features (flags, folders, labels, move, copy, delete, forward, drafts, " +
      "contacts_api, scheduling) are supported for that inbox.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["gmail", "outlook", "fastmail", "imap"],
          description:
            "Optional filter — return only inboxes (email accounts/mailboxes) " +
            "served by this provider. One of: gmail, outlook, fastmail, imap. " +
            "Omit to list every inbox the API key can access.",
        },
        include_capabilities: {
          type: "boolean",
          default: true,
          description:
            "Whether each inbox includes its capabilities object (which inbox " +
            "features — flags, folders, labels, move, copy, delete, forward, " +
            "drafts, contacts_api, scheduling — are supported). Defaults to " +
            "true; set false for a compact inbox list of just inbox_id, email " +
            "address, display name, provider and service brand.",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "email_list",
    title: "List Messages",
    description:
      "List email messages inside an inbox. Returns message summaries " +
      "(sender, subject, date, preview, read status, attachment flag) ordered " +
      "newest first. Supports filtering by folder, unread status, and pagination. " +
      "Use email_read to fetch the full content of a specific message. " +
      "Note: this lists the MESSAGES within one inbox — to discover which inboxes " +
      "exist and obtain their inbox_id, call this tool with no inbox_id (or call " +
      "inbox_list); the response then lists every inbox and its inbox_id.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description:
            "Maximum number of email summaries to return. Defaults to 20. " +
            "Larger values increase latency; prefer pagination over large limits.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "Zero-based pagination offset. To page through results, increment " +
            "by the value of 'limit'. The inbox ordering is by received date, newest first.",
        },
        folder: {
          type: "string",
          default: "INBOX",
          description:
            "Mailbox folder to list. Defaults to 'INBOX'. Common values: 'INBOX', " +
            "'SENT', 'DRAFTS', 'TRASH'. Provider-specific folder names are supported " +
            "(e.g., '[Gmail]/Spam' for Gmail). Case-sensitive.",
        },
        unread_only: {
          type: "boolean",
          default: false,
          description:
            "When true, return only unread messages. Useful for agents that process " +
            "unread email as a task queue.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  {
    name: "email_read",
    title: "Read Email",
    description:
      "Fetch the full content of a single email by its provider message ID. " +
      "Returns headers (from, to, cc, bcc, subject, date), decoded plain-text body, " +
      "and optionally the sanitized HTML body and attachment data. " +
      "HTML is sanitized server-side — all scripts, event handlers, and external " +
      "resource references are stripped before the content is returned.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Opaque provider-native message identifier. Always obtained from a " +
            "previous call to email_list or email_search.",
        },
        include_html: {
          type: "boolean",
          default: false,
          description:
            "When true, the response includes the sanitized HTML body in addition to " +
            "the plain-text body. Set to true only when the agent needs to process " +
            "formatting, links, or structure from the HTML.",
        },
        include_attachments: {
          type: "boolean",
          default: false,
          description:
            "When true, attachments are included in the response as base64-encoded " +
            "data fields, sharing a single 10 MB budget. For safety, files larger than " +
            "2 MB are NOT inlined here — they come back as metadata with a `note` telling " +
            "you to fetch them individually. Attachment metadata (filename, mime_type, " +
            "size_bytes, attachment_index) is ALWAYS returned regardless of this flag, so " +
            "prefer leaving this false, inspect the list, then download just the file you " +
            "need with email_read (action: attachment) by its attachment_index (that path " +
            "handles files up to 25 MB). Set true only to pull several small attachments at once.",
        },
        mark_as_read: {
          type: "boolean",
          default: false,
          description:
            "When true, marks the message as read at the provider after successfully " +
            "fetching its content. Defaults to false to avoid unintended state changes.",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_read_batch",
    title: "Read Emails (batch)",
    description:
      "Read multiple emails in a single call by their provider message IDs — ideal " +
      "for triaging an inbox without one email_read round-trip per message. " +
      "Returns a `messages` array (each in the same shape as email_read) plus a " +
      "per-ID `errors` array; a single bad or missing ID never fails the whole batch. " +
      "When include_attachments is true, attachment data shares a single 10 MB budget " +
      "across the whole call — attachments beyond the budget are omitted. Max 50 IDs.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
          description:
            "Provider-native message IDs to read (from email_list or email_search). " +
            "Max 50 per call.",
        },
        include_html: {
          type: "boolean",
          default: false,
          description:
            "When true, each message includes the sanitized HTML body in addition to " +
            "the plain-text body. Set to true only when the agent needs to process " +
            "formatting, links, or structure from the HTML.",
        },
        include_attachments: {
          type: "boolean",
          default: false,
          description:
            "When true, each attachment is included as a base64-encoded data field. " +
            "Attachments increase response size significantly; request only when the " +
            "agent needs attachment content. The 10 MB total size limit is shared " +
            "across all messages in the call.",
        },
        mark_as_read: {
          type: "boolean",
          default: false,
          description:
            "When true, marks each message as read at the provider after successfully " +
            "fetching its content. Defaults to false to avoid unintended state changes.",
        },
      },
      required: ["message_ids"],
      additionalProperties: false,
    },
  },

  {
    name: "email_attachment",
    title: "Download Attachment",
    description:
      "Download a single attachment from an email. The file is returned in the " +
      "MCP-native content block for its type — `image` for images, `audio` for " +
      "audio, otherwise an embedded `resource` (decoded text for text/*, else a " +
      "base64 `blob`) — so clients can preview or save it directly. Metadata " +
      "(filename, mime_type, size_bytes, attachment_index) is also returned as " +
      "structuredContent. Select the attachment by `attachment_index` (0-based, " +
      "matching the order in email_read's `attachments` list) or by `filename`. " +
      "When the message has exactly one attachment you may omit both. Use this " +
      "instead of email_read with include_attachments when you only need one file. " +
      "A single attachment may be up to 25 MB; larger files are reported with " +
      "their size but no data.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Opaque provider-native message identifier, obtained from a previous " +
            "call to email_read (action: list/read/search).",
        },
        attachment_index: {
          type: "integer",
          minimum: 0,
          description:
            "0-based index of the attachment to download, matching the order of " +
            "the `attachments` array returned by email_read (action: read). " +
            "Takes precedence over `filename` when both are supplied.",
        },
        filename: {
          type: "string",
          description:
            "Name of the attachment to download (case-insensitive exact match). " +
            "Use when you know the filename but not its position. Ignored if " +
            "`attachment_index` is given.",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_search",
    title: "Search Emails",
    description:
      "Search an inbox using structured, provider-agnostic fields. Supply any of " +
      "from, to, cc, subject, body, text, unread, has_attachment, flagged, since, " +
      "before (combined with AND); the server translates them into the inbox's " +
      "native search syntax, so you never need to know provider query syntax. " +
      "An optional `query` field is a raw provider-native escape hatch. " +
      "Returns message summaries ordered by relevance or date depending on the provider.",
    requiredScope: "read:email",
    altScopes: ["search:email"],
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        ...STRUCTURED_SEARCH_PROPERTIES,
        query: {
          type: "string",
          description: RAW_QUERY_DESCRIPTION,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of matching emails to return. Defaults to 20.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description:
            "Pagination offset for search results. Note: not all providers support " +
            "stable offset-based pagination for search; results may overlap or skip " +
            "items if the result set changes between calls.",
        },
        include_folders: {
          type: "array",
          items: { type: "string" },
          default: [],
          description:
            "Restrict search to these folder names. Empty array (default) searches all " +
            "folders. Provider support varies — Gmail searches the entire inbox regardless; " +
            "IMAP providers support per-folder search.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  {
    name: "folder_list",
    title: "List Folders",
    description:
      "List all folders (or labels, for Gmail) for an inbox. " +
      "Returns each folder's provider-native ID, display name, type " +
      "('folder' for hierarchical providers, 'label' for Gmail), and " +
      "message counts (total and unread). " +
      "Use the returned folder names/IDs as the 'folder' argument for email_list, " +
      "and as source/destination for email_move.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ── manage:folders scope ─────────────────────────────────────────────────────

  {
    name: "folder_create",
    title: "Create Folder",
    description:
      "Create a new folder (or label, for Gmail) in an inbox. " +
      "Returns the provider-native folder/label ID and display name of the created item.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        name: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Name of the new folder or label.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },

  {
    name: "folder_rename",
    title: "Rename Folder",
    description:
      "Rename an existing folder or label. " +
      "Use folder_list to obtain the folder_id before calling this tool.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID as returned by folder_list. " +
            "For IMAP this is the mailbox name (e.g. 'INBOX/Work'); " +
            "for Gmail the label ID; for Outlook/Fastmail the opaque folder ID.",
        },
        new_name: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "New display name for the folder or label.",
        },
      },
      required: ["folder_id", "new_name"],
      additionalProperties: false,
    },
  },

  {
    name: "folder_delete",
    title: "Delete Folder",
    description:
      "Permanently delete a folder (or label, for Gmail). " +
      "THIS ACTION IS IRREVERSIBLE — all messages inside the folder may be lost " +
      "depending on the provider. " +
      "Use folder_list to obtain the folder_id before calling this tool.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID as returned by folder_list.",
        },
      },
      required: ["folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_move",
    title: "Move Email",
    description:
      "Move an email message to a different folder (or label, for Gmail). " +
      "On Gmail, moving adds the destination label and removes the INBOX label.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by email_list, email_read, or email_search.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder: a canonical alias (inbox, sent, drafts, trash, archive, spam), " +
            "a folder/label name (e.g. 'Receipts'), or a provider-native folder ID from folder_list. " +
            "Names and aliases are resolved automatically.",
        },
      },
      required: ["message_id", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_copy",
    title: "Copy Email",
    description:
      "Copy an email message into another folder, leaving the original in place. " +
      "Unlike move, the source message is not removed. Supported on IMAP, Outlook " +
      "and Fastmail inboxes (Gmail's label model has no native copy).",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by email_list, email_read, or email_search.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder: a canonical alias (inbox, sent, drafts, trash, archive, spam), " +
            "a folder/label name (e.g. 'Receipts'), or a provider-native folder ID from folder_list. " +
            "Names and aliases are resolved automatically.",
        },
      },
      required: ["message_id", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  // ── delete:email scope ─────────────────────────────────────────────────────

  {
    name: "email_delete",
    title: "Delete Email",
    description:
      "Delete (trash or permanently expunge) a single email message. " +
      "By default the message is moved to the provider's Trash folder (safer). " +
      "Set permanent:true to hard-delete (bypasses Trash). " +
      "This action may be irreversible when permanent:true is set.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by email_list, email_read, or email_search.",
        },
        permanent: {
          type: "boolean",
          description:
            "When true, hard-deletes the message (bypasses Trash). " +
            "When false or omitted, moves the message to Trash. " +
            "Default: false.",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },

  // ── bulk operations ─────────────────────────────────────────────────────────

  {
    name: "email_move_batch",
    title: "Bulk Move",
    description:
      "Move up to 500 email messages to a destination folder in one call. " +
      "On Gmail, moving adds the destination label and removes the INBOX label. " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description:
            "Provider-native message IDs to move (from email_list, email_read, or email_search). " +
            "Maximum 500 IDs per call.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder: a canonical alias (inbox, sent, drafts, trash, archive, spam), " +
            "a folder/label name (e.g. 'Receipts'), or a provider-native folder ID from folder_list. " +
            "Names and aliases are resolved automatically.",
        },
      },
      required: ["message_ids", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_copy_batch",
    title: "Bulk Copy",
    description:
      "Copy up to 500 email messages into a destination folder in one call, " +
      "leaving the originals in place. Supported on IMAP, Outlook and Fastmail " +
      "inboxes (not Gmail). Returns succeeded/failed counts and per-message results.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description:
            "Provider-native message IDs to copy (from email_list, email_read, or email_search). " +
            "Maximum 500 IDs per call.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder: a canonical alias (inbox, sent, drafts, trash, archive, spam), " +
            "a folder/label name (e.g. 'Receipts'), or a provider-native folder ID from folder_list. " +
            "Names and aliases are resolved automatically.",
        },
      },
      required: ["message_ids", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_delete_batch",
    title: "Bulk Delete",
    description:
      "Delete up to 500 email messages in one call. " +
      "By default moves messages to Trash (safer). Set permanent:true for hard delete " +
      "(bypasses Trash; irreversible). " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description:
            "Provider-native message IDs to delete. Maximum 500 IDs per call.",
        },
        permanent: {
          type: "boolean",
          description:
            "When true, hard-deletes messages (bypasses Trash). " +
            "When false or omitted, moves messages to Trash. Default: false.",
        },
      },
      required: ["message_ids"],
      additionalProperties: false,
    },
  },

  {
    name: "email_flag",
    title: "Flag or Mark Messages",
    description:
      "Apply a read/unread/flag/unflag action to one or more messages in a single call. Use action 'read' or 'unread' to change read status, or 'flag'/'unflag' to add or remove a star/follow-up flag. Pass one message ID to update a single message, or up to 500 to update many at once. Get message IDs from email_list or email_search.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description:
            "Provider-native message IDs to update. Maximum 500 IDs per call.",
        },
        action: {
          type: "string",
          enum: ["read", "unread", "flag", "unflag"],
          description:
            "Action to apply to all messages: " +
            "'read' marks as read; 'unread' marks as unread; " +
            "'flag' stars/flags; 'unflag' removes the flag/star.",
        },
      },
      required: ["message_ids", "action"],
      additionalProperties: false,
    },
  },

  // ── search-and-act (Phase 3 cont.) ───────────────────────────────────────────

  {
    name: "email_search_and_move",
    title: "Search and Move",
    description:
      "Run a search and move all matching messages to a destination folder in one " +
      "server-side operation — avoids stale message IDs. " +
      "Search uses structured, provider-agnostic fields (from, to, cc, subject, body, " +
      "text, unread, has_attachment, flagged, since, before) that the server translates " +
      "into the inbox's native search syntax, so you never need provider query syntax; " +
      "`query` is a raw escape hatch. " +
      "Capped at 500 results per call. " +
      "On Gmail, moving adds the destination label and removes the INBOX label. " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        ...STRUCTURED_SEARCH_PROPERTIES,
        query: {
          type: "string",
          description: RAW_QUERY_DESCRIPTION,
        },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder: a canonical alias (inbox, sent, drafts, trash, archive, spam), " +
            "a folder/label name (e.g. 'Receipts'), or a provider-native folder ID from folder_list. " +
            "Names and aliases are resolved automatically.",
        },
        include_folders: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of folder/mailbox names to restrict the search scope. " +
            "When omitted the search covers all folders.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description:
            "Maximum number of matching messages to move. Default: 500.",
        },
      },
      required: ["destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "email_search_and_delete",
    title: "Search and Delete",
    description:
      "Run a search and delete all matching messages in one server-side operation — " +
      "avoids stale message IDs. " +
      "Search uses structured, provider-agnostic fields (from, to, cc, subject, body, " +
      "text, unread, has_attachment, flagged, since, before) that the server translates " +
      "into the inbox's native search syntax, so you never need provider query syntax; " +
      "`query` is a raw escape hatch. " +
      "Capped at 500 results per call. " +
      "Default: move matches to Trash (safer). Set permanent:true for hard delete " +
      "(bypasses Trash; irreversible). " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        ...STRUCTURED_SEARCH_PROPERTIES,
        query: {
          type: "string",
          description: RAW_QUERY_DESCRIPTION,
        },
        permanent: {
          type: "boolean",
          description:
            "When true, hard-deletes matched messages (bypasses Trash). " +
            "When false or omitted, moves messages to Trash. Default: false.",
        },
        include_folders: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of folder/mailbox names to restrict the search scope.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description:
            "Maximum number of matching messages to delete. Default: 500.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // ── send:email scope ────────────────────────────────────────────────────────

  {
    name: "email_send",
    title: "Send Email",
    description:
      "Compose and send a new email from a connected inbox. Supports plain-text " +
      "and HTML bodies, CC/BCC recipients, file attachments (base64-encoded, max 10 MB total), " +
      "and a custom Reply-To address. Recipient addresses are validated against RFC 5322 " +
      "before the message is sent. This action is irreversible — use carefully.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        to: {
          type: "array",
          items: { type: "string", format: "email" },
          minItems: 1,
          maxItems: 50,
          description:
            "List of recipient email addresses. Each must be a valid RFC 5322 address. " +
            "Maximum 50 recipients.",
        },
        cc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "List of CC recipient email addresses. Optional.",
        },
        bcc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description:
            "List of BCC recipient email addresses. Optional. BCC recipients are not " +
            "visible to other recipients.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 998,
          description:
            "Email subject line. Must be non-empty. Maximum 998 characters per RFC 5322. " +
            "The subject is sent as-is; no prefix is added automatically.",
        },
        body: {
          type: "string",
          minLength: 1,
          description:
            "Email body as plain text. If html_body is also provided, the message is " +
            "sent as multipart/alternative with both parts. If only body is provided, " +
            "the message is sent as text/plain.",
        },
        html_body: {
          type: "string",
          description:
            "Optional HTML version of the email body. If provided, the message is sent " +
            "as multipart/alternative. The caller is responsible for ensuring the HTML " +
            "is safe and correctly structured — this field is not sanitized before sending.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: {
                type: "string",
                description: "Filename for the attachment as it will appear to the recipient.",
              },
              mime_type: {
                type: "string",
                description: "MIME type of the attachment (e.g., 'application/pdf', 'image/png').",
              },
              data: {
                type: "string",
                description: "Base64-encoded content of the attachment.",
              },
            },
            required: ["filename", "mime_type", "data"],
            additionalProperties: false,
          },
          default: [],
          maxItems: 20,
          description:
            "Optional list of file attachments. Maximum 20 attachments. Total attachment " +
            "size must not exceed 10 MB.",
        },
        reply_to: {
          type: "string",
          format: "email",
          description:
            "Optional Reply-To header address. When the recipient clicks 'Reply', their " +
            "email client will address the reply to this address rather than the sender.",
        },
        include_signature: INCLUDE_SIGNATURE_PROPERTY,
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "email_reply",
    title: "Reply to Email",
    description:
      "Reply to an existing email, maintaining correct thread headers (In-Reply-To, References). " +
      "The recipient, subject (prefixed with 'Re:'), and threading headers are derived from " +
      "the original message — only the reply body is required. Optionally reply to all " +
      "recipients of the original message using reply_all. " +
      "This action is irreversible — use carefully.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier of the email being replied to. The tool " +
            "uses this to look up the original message headers and set In-Reply-To and " +
            "References correctly.",
        },
        body: {
          type: "string",
          minLength: 1,
          description:
            "Plain-text body of the reply. The tool does not automatically quote the " +
            "original message — include quoted text if desired.",
        },
        html_body: {
          type: "string",
          description:
            "Optional HTML version of the reply body. If provided, the reply is sent " +
            "as multipart/alternative.",
        },
        reply_all: {
          type: "boolean",
          default: false,
          description:
            "When true, the reply is addressed to all recipients of the original message " +
            "(To and Cc), not just the sender. Total recipients are capped at 50.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              mime_type: { type: "string" },
              data: {
                type: "string",
                description: "Base64-encoded content.",
              },
            },
            required: ["filename", "mime_type", "data"],
            additionalProperties: false,
          },
          default: [],
          maxItems: 20,
          description: "Optional attachments to include with the reply.",
        },
        include_signature: INCLUDE_SIGNATURE_PROPERTY,
      },
      required: ["message_id", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "email_forward",
    title: "Forward Email",
    description:
      "Forward an existing email to one or more new recipients. Fetches the original " +
      "message and prepends an optional introductory note followed by the standard " +
      "'---------- Forwarded message ----------' header block (From, Date, Subject, To) " +
      "and the original body. Optionally re-attaches original attachments. " +
      "The forward subject is prefixed with 'Fwd:' if not already present. " +
      "This action is irreversible — use carefully.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier of the email to forward, as returned " +
            "by email_list, email_read, or email_search.",
        },
        to: {
          type: "array",
          items: { type: "string", format: "email" },
          minItems: 1,
          maxItems: 50,
          description:
            "List of forward recipient email addresses. Each must be a valid RFC 5322 address. " +
            "Maximum 50 recipients.",
        },
        cc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Optional CC recipient email addresses.",
        },
        bcc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Optional BCC recipient email addresses.",
        },
        body: {
          type: "string",
          description:
            "Optional plain-text introductory note to prepend above the forwarded message block. " +
            "If omitted, the forwarded block begins immediately.",
        },
        html_body: {
          type: "string",
          description:
            "Optional HTML version of the introductory note. If provided alongside body, " +
            "the message is sent as multipart/alternative.",
        },
        include_attachments: {
          type: "boolean",
          default: false,
          description:
            "When true, re-attach the original message's attachments to the forward. " +
            "Attachments that exceed the 10 MB per-call budget are silently omitted. " +
            "Defaults to false.",
        },
        include_signature: INCLUDE_SIGNATURE_PROPERTY,
      },
      required: ["message_id", "to"],
      additionalProperties: false,
    },
  },

  // ── send:email scope — state changes (non-destructive) ─────────────────────

  {
    name: "email_archive",
    title: "Archive Email",
    description:
      "Move a message out of the Inbox to the archive location. Non-destructive — the " +
      "message is preserved, not deleted. On Gmail this removes the INBOX label.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by email_list or email_search.",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },

  // ── manage:drafts scope ──────────────────────────────────────────────────────

  {
    name: "draft_list",
    title: "List Drafts",
    description:
      "Return draft messages saved in the inbox's Drafts folder. " +
      "Each result includes the draft_id, subject, recipients, and created timestamp. " +
      "Use the returned draft_id with draft_update or draft_send.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum number of drafts to return. Defaults to 20.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  {
    name: "draft_create",
    title: "Create Draft",
    description:
      "Save a new email draft in the inbox's Drafts folder without sending it. " +
      "Returns a draft_id that can be used with draft_update or draft_send. " +
      "At minimum, subject and body are required; to/cc/bcc are optional (drafts may be incomplete).",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        to: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Optional recipient addresses. Drafts may be saved without recipients.",
        },
        cc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Optional CC recipient addresses.",
        },
        bcc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Optional BCC recipient addresses.",
        },
        subject: {
          type: "string",
          description: "Draft subject line.",
        },
        body: {
          type: "string",
          description: "Plain-text body of the draft.",
        },
        html_body: {
          type: "string",
          description: "Optional HTML body of the draft.",
        },
        include_signature: INCLUDE_SIGNATURE_PROPERTY,
      },
      required: ["subject", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "draft_update",
    title: "Update Draft",
    description:
      "Replace the content of an existing draft. All supplied fields overwrite the stored draft. " +
      "Use draft_list to obtain draft_id values. " +
      "IMPORTANT: on IMAP-backed inboxes (anything other than Gmail/Outlook) the underlying message " +
      "is rewritten, so this call returns a NEW draft_id that REPLACES the one you passed in. You MUST " +
      "adopt the returned draft_id for any further draft_update/draft_send and discard the old one; " +
      "reusing the previous id will fail. Gmail and Outlook keep a stable draft_id across updates.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        draft_id: {
          type: "string",
          description: "Provider-native draft identifier as returned by the most recent draft_create, " +
            "draft_update, or draft_list. On IMAP inboxes this changes after every update, so always " +
            "use the latest one.",
        },
        to: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Updated recipient list.",
        },
        cc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Updated CC list.",
        },
        bcc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "Updated BCC list.",
        },
        subject: {
          type: "string",
          description: "Updated subject line. Optional — omit to keep the draft's existing subject.",
        },
        body: {
          type: "string",
          description: "Updated plain-text body.",
        },
        html_body: {
          type: "string",
          description: "Updated HTML body.",
        },
        include_signature: INCLUDE_SIGNATURE_PROPERTY,
      },
      required: ["draft_id", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "draft_send",
    title: "Send Draft",
    description:
      "Send a previously saved draft. The draft is removed from the Drafts folder after sending. " +
      "This action is irreversible — use carefully. " +
      "Always pass the MOST RECENT draft_id (from draft_create, the latest draft_update, or draft_list): " +
      "on IMAP-backed inboxes the id changes on every update, and a stale id will fail with a not-found error.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        draft_id: {
          type: "string",
          description: "Provider-native draft identifier as returned by the most recent draft_create, " +
            "draft_update, or draft_list. On IMAP inboxes this changes after every update, so always " +
            "use the latest one.",
        },
      },
      required: ["draft_id"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_delete",
    title: "Delete Draft",
    description:
      "Permanently delete a saved draft without sending it. Use this to clean up " +
      "drafts created by draft_create that you no longer need. This action is " +
      "irreversible — the draft is removed from the Drafts folder. " +
      "Pass the MOST RECENT draft_id (from draft_create, the latest draft_update, " +
      "or draft_list): on IMAP-backed inboxes the id changes on every update, and " +
      "a stale id will fail with a not-found error.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        draft_id: {
          type: "string",
          description: "Provider-native draft identifier as returned by the most recent draft_create, " +
            "draft_update, or draft_list. On IMAP inboxes this changes after every update, so always " +
            "use the latest one.",
        },
      },
      required: ["draft_id"],
      additionalProperties: false,
    },
  },

  // ── manage:contacts scope ────────────────────────────────────────────────────

  {
    name: "contact_search",
    title: "Search Contacts",
    description:
      "Find people matching a name or email fragment by scanning your LIVE " +
      "mailbox — there is no stored contact list. Each call performs a bounded, " +
      "header-only scan of recent matching mail and tallies the correspondents " +
      "who match the query, sorted by most-recently-contacted first (display " +
      "name, email address, matched-message count, and last-contacted " +
      "timestamp). Honesty about the tradeoff: results reflect a live scan of a " +
      "RECENT window of matching messages (not your full history), and the " +
      "message_count reflects only matched messages within that window — not an " +
      "all-time total. Nothing is stored between calls. For general or " +
      "cross-inbox questions (e.g. 'who have I emailed most with X?'), OMIT " +
      "inbox_id so ALL accessible inboxes are scanned; only set inbox_id when " +
      "the user explicitly limits the search to one specific inbox.",
    requiredScope: "manage:contacts",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Name or email address fragment to search for. Matched " +
            "case-insensitively against both the display name and email " +
            "address of correspondents found in a live scan of recent matching " +
            "mail. Must be at least 1 character. Example: 'alice' matches " +
            "'Alice Smith' and 'alice@example.com'.",
        },
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "Optional. When provided, restricts the live scan to that specific " +
            "inbox. Omit this for general or cross-inbox questions (e.g. 'who " +
            "have I emailed most with X?') so ALL accessible inboxes are " +
            "scanned — only set inbox_id when the user explicitly limits the " +
            "search to one specific inbox. Do not carry over an inbox_id from a " +
            "previous unrelated turn. Nothing is stored — every call re-scans " +
            "live mail.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum number of contacts to return. Defaults to 20.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },

  // ── schedule:email scope ─────────────────────────────────────────────────────

  {
    name: "schedule_create",
    title: "Schedule Send",
    description:
      "Schedule an email to be sent at a future date and time. " +
      "The message is stored in a pending queue and dispatched automatically " +
      "by the server when send_at is reached. All recipient addresses and the " +
      "message body are validated immediately at schedule time — if validation " +
      "fails the message will not be queued. Use schedule_list to view pending " +
      "scheduled sends and schedule_cancel to cancel before they are sent.",
    requiredScope: "schedule:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        to: {
          type: "array",
          items: { type: "string", format: "email" },
          minItems: 1,
          maxItems: 50,
          description:
            "List of recipient email addresses. Each must be a valid RFC 5322 address. " +
            "Maximum 50 recipients.",
        },
        cc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "List of CC recipient email addresses. Optional.",
        },
        bcc: {
          type: "array",
          items: { type: "string", format: "email" },
          default: [],
          description: "List of BCC recipient email addresses. Optional.",
        },
        subject: {
          type: "string",
          minLength: 1,
          maxLength: 998,
          description: "Email subject line. Must be non-empty. Maximum 998 characters.",
        },
        body: {
          type: "string",
          minLength: 1,
          description:
            "Email body as plain text. If html_body is also provided, the message is " +
            "sent as multipart/alternative.",
        },
        html_body: {
          type: "string",
          description: "Optional HTML version of the email body.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Attachment filename." },
              mime_type: { type: "string", description: "MIME type of the attachment." },
              data: { type: "string", description: "Base64-encoded attachment content." },
            },
            required: ["filename", "mime_type", "data"],
            additionalProperties: false,
          },
          default: [],
          maxItems: 20,
          description:
            "Optional file attachments. Maximum 20 items. Total size must not exceed 10 MB.",
        },
        reply_to: {
          type: "string",
          format: "email",
          description: "Optional Reply-To header address.",
        },
        send_at: {
          type: "string",
          format: "date-time",
          description:
            "ISO 8601 datetime string (with timezone) at which the message should be sent. " +
            "Must be in the future. Example: '2026-06-01T09:00:00Z' or " +
            "'2026-06-01T09:00:00+02:00'. The dispatcher runs every minute so the " +
            "actual send time may be up to 60 seconds after send_at.",
        },
      },
      required: ["to", "subject", "body", "send_at"],
      additionalProperties: false,
    },
  },

  {
    name: "schedule_list",
    title: "List Scheduled Sends",
    description:
      "List pending scheduled email sends for the workspace. Returns all messages " +
      "with status 'pending' or 'sending', ordered by scheduled send time (earliest first). " +
      "Optionally filter by inbox. Use schedule_cancel to cancel a pending send before " +
      "it is dispatched.",
    requiredScope: "schedule:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "Optional. When provided, restricts results to scheduled sends for that inbox.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "schedule_cancel",
    title: "Cancel Scheduled Send",
    description:
      "Cancel a pending scheduled email send. Sets the status to 'cancelled' so the " +
      "dispatcher will not send the message. Only messages with status 'pending' can be " +
      "cancelled — messages already in 'sending', 'sent', or 'error' state cannot be " +
      "cancelled. Use schedule_list to find the id. Pass either `id` (as returned by " +
      "schedule_create / schedule_list) or its alias `scheduled_send_id` — both work.",
    requiredScope: "schedule:email",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "UUID of the scheduled send to cancel, as returned by " +
            "schedule_create and schedule_list. Alias of scheduled_send_id.",
        },
        scheduled_send_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the scheduled send to cancel. Alias of `id` — " +
            "provide either field.",
        },
      },
      // Either `id` or `scheduled_send_id` satisfies the requirement.
      anyOf: [
        { required: ["id"] },
        { required: ["scheduled_send_id"] },
      ],
      additionalProperties: false,
    },
  },

  // ── signature (read:email for get / send:email for set) ──────────────────────

  {
    name: "signature_get",
    title: "Get Signature",
    description:
      "Read the email signature configured for an inbox. Returns the signature " +
      "HTML and plain text, whether it is enabled, the reply/forward mode " +
      "('always' | 'first_only' | 'never'), and its source ('manual', " +
      "'gmail_import', or null when none is set). The signature is appended " +
      "server-side on send/reply/forward/draft/scheduled messages.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
      },
      required: [],
      additionalProperties: false,
    },
  },

  {
    name: "signature_set",
    title: "Set Signature",
    description:
      "Set or update the email signature for an inbox. Provide the signature as " +
      "`signature_text` (plain text) and/or `signature_html` (rich HTML) — pass " +
      "either or both; the missing half is derived automatically on send. Pass an " +
      "empty string for both to clear the signature. Optionally set " +
      "`signature_enabled` (default true; set false to stop appending without " +
      "deleting the text) and `signature_reply_mode` ('always' = sign every " +
      "reply/forward, 'first_only' = only the first message in a thread, 'never' = " +
      "never sign replies/forwards). Setting a signature marks its source as " +
      "'manual', which permanently overrides Gmail auto-import for that inbox.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: INBOX_ID_PROPERTY,
        inbox: INBOX_PROPERTY,
        signature_text: {
          type: "string",
          maxLength: 10000,
          description:
            "Plain-text signature body. Omit to leave unchanged; pass an empty " +
            "string to clear it.",
        },
        signature_html: {
          type: "string",
          maxLength: 50000,
          description:
            "Optional HTML signature body. Omit to leave unchanged; pass an empty " +
            "string to clear it. If only text is provided, an HTML version is " +
            "derived automatically on send.",
        },
        signature_enabled: {
          type: "boolean",
          description:
            "Whether the signature is appended to outgoing mail. Defaults to true.",
        },
        signature_reply_mode: {
          type: "string",
          enum: ["always", "first_only", "never"],
          description:
            "When to include the signature on replies/forwards: 'always', " +
            "'first_only' (default), or 'never'.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Output schemas + annotations (MCP 2025-06-18)
//
// outputSchema describes the `structuredContent` object a successful tool
// result carries (see the jsonOk helper). annotations carry the MCP
// ToolAnnotations behaviour hints. Both are attached to the registry entries
// below and emitted in tools/list. Adding them here (rather than inline above)
// keeps each tool's argument definition readable and the metadata in one place.
// ---------------------------------------------------------------------------

/** JSON-Schema fragment for an {name,email} address entry. */
const ADDRESS_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
  },
  required: ["name", "email"],
  additionalProperties: false,
} as const;

/** JSON-Schema fragment for a message summary (email_list). */
const EMAIL_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    from: ADDRESS_ENTRY_SCHEMA,
    to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
    subject: { type: "string" },
    date: { type: "string", description: "ISO 8601 UTC timestamp." },
    preview: { type: "string" },
    is_read: { type: "boolean" },
    has_attachments: { type: "boolean" },
    folder: { type: "string" },
    thread_id: { type: "string" },
  },
  additionalProperties: true,
} as const;

/** JSON-Schema fragment for a search result summary (email_search). */
const SEARCH_EMAIL_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    ...EMAIL_SUMMARY_SCHEMA.properties,
    relevance_score: { type: ["number", "null"] },
  },
  additionalProperties: true,
} as const;

/** Output schema for tools returning `{ success, message_id, operation, inbox_id }`. */
const FLAG_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    message_id: { type: "string" },
    operation: { type: "string" },
    inbox_id: { type: "string" },
  },
  required: ["success", "message_id", "operation", "inbox_id"],
  additionalProperties: true,
} as const;

/** Output schema for the bulk / search-and-X tools (formatBulkResult shape). */
const BULK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    succeeded: { type: "integer" },
    failed: { type: "integer" },
    operation: { type: "string" },
    inbox_id: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          success: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["message_id", "success"],
        additionalProperties: true,
      },
    },
  },
  required: ["succeeded", "failed", "operation", "inbox_id", "results"],
  additionalProperties: true,
} as const;

/** Output schema for send / reply / forward / draft-send results. */
const SENT_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    thread_id: { type: "string" },
    sent_at: { type: "string", description: "ISO 8601 UTC timestamp." },
    to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
    subject: { type: "string" },
    status: { type: "string" },
  },
  required: ["message_id", "sent_at"],
  additionalProperties: true,
} as const;

/**
 * Per-tool output schemas, keyed by tool name. Each describes the
 * `structuredContent` object the tool's success path returns.
 */
const TOOL_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  inbox_list: {
    type: "object",
    properties: {
      inboxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            inbox_id: { type: "string" },
            email_address: { type: "string" },
            display_name: { type: "string" },
            provider: { type: "string" },
            service: { type: ["string", "null"] },
            capabilities: { type: "object", additionalProperties: true },
          },
          required: ["inbox_id", "email_address", "provider"],
          additionalProperties: true,
        },
      },
    },
    required: ["inboxes"],
    additionalProperties: false,
  },
  email_list: {
    type: "object",
    properties: {
      messages: { type: "array", items: EMAIL_SUMMARY_SCHEMA },
      total: {
        type: ["integer", "null"],
        description:
          "Total matching messages. Exact for IMAP/Fastmail, an estimate for " +
          "Gmail (see total_is_estimate), null when the provider cannot supply a count.",
      },
      total_is_estimate: {
        type: "boolean",
        description: "True when total is a provider estimate rather than an exact count.",
      },
      has_more: { type: "boolean" },
      next_offset: { type: "integer" },
    },
    required: ["messages", "has_more", "next_offset"],
    additionalProperties: false,
  },
  email_read: {
    type: "object",
    properties: {
      id: { type: "string" },
      thread_id: { type: "string" },
      from: ADDRESS_ENTRY_SCHEMA,
      to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
      cc: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
      bcc: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
      reply_to: { type: ["object", "null"], additionalProperties: true },
      subject: { type: "string" },
      date: { type: "string", description: "ISO 8601 UTC timestamp." },
      body_text: { type: ["string", "null"] },
      body_html: { type: ["string", "null"] },
      attachments: { type: "array", items: { type: "object", additionalProperties: true } },
      is_read: { type: "boolean" },
      labels: { type: "array", items: { type: "string" } },
      in_reply_to: { type: ["string", "null"] },
      references: { type: "array", items: { type: "string" } },
    },
    required: ["id", "thread_id", "from", "subject", "date"],
    additionalProperties: true,
  },
  email_read_batch: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        // Same per-message shape as email_read's result.
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            thread_id: { type: "string" },
            from: ADDRESS_ENTRY_SCHEMA,
            to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
            cc: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
            bcc: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
            reply_to: { type: ["object", "null"], additionalProperties: true },
            subject: { type: "string" },
            date: { type: "string", description: "ISO 8601 UTC timestamp." },
            body_text: { type: ["string", "null"] },
            body_html: { type: ["string", "null"] },
            attachments: {
              type: "array",
              items: { type: "object", additionalProperties: true },
            },
            is_read: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            in_reply_to: { type: ["string", "null"] },
            references: { type: "array", items: { type: "string" } },
          },
          required: ["id", "thread_id", "from", "subject", "date"],
          additionalProperties: true,
        },
      },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            message_id: { type: "string" },
            error: { type: "string" },
          },
          required: ["message_id", "error"],
          additionalProperties: false,
        },
      },
    },
    required: ["messages", "errors"],
    additionalProperties: false,
  },
  email_search: {
    type: "object",
    properties: {
      messages: { type: "array", items: SEARCH_EMAIL_SUMMARY_SCHEMA },
      total: {
        type: ["integer", "null"],
        description:
          "Total matching messages. Exact for IMAP/Fastmail, an estimate for " +
          "Gmail (see total_is_estimate), null when the provider cannot supply a count.",
      },
      total_is_estimate: {
        type: "boolean",
        description: "True when total is a provider estimate rather than an exact count.",
      },
      has_more: { type: "boolean" },
      next_offset: { type: "integer" },
      query_normalized: { type: "string" },
    },
    required: ["messages", "has_more", "next_offset"],
    additionalProperties: false,
  },
  folder_list: {
    type: "object",
    properties: {
      inbox_id: { type: "string" },
      folders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["folder", "label"] },
            total_messages: { type: ["integer", "null"] },
            unread_messages: { type: ["integer", "null"] },
          },
          required: ["id", "name", "type"],
          additionalProperties: true,
        },
      },
    },
    required: ["inbox_id", "folders"],
    additionalProperties: false,
  },
  folder_create: {
    type: "object",
    properties: {
      inbox_id: { type: "string" },
      created: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
        required: ["id", "name"],
        additionalProperties: true,
      },
    },
    required: ["inbox_id", "created"],
    additionalProperties: false,
  },
  folder_rename: {
    type: "object",
    properties: {
      inbox_id: { type: "string" },
      folder_id: { type: "string" },
      new_name: { type: "string" },
      status: { type: "string" },
    },
    required: ["inbox_id", "folder_id", "new_name", "status"],
    additionalProperties: false,
  },
  folder_delete: {
    type: "object",
    properties: {
      inbox_id: { type: "string" },
      folder_id: { type: "string" },
      status: { type: "string" },
    },
    required: ["inbox_id", "folder_id", "status"],
    additionalProperties: false,
  },
  email_move: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      message_id: { type: "string" },
      operation: { type: "string" },
      inbox_id: { type: "string" },
      destination_folder_id: { type: "string" },
    },
    required: ["success", "message_id", "operation", "inbox_id", "destination_folder_id"],
    additionalProperties: false,
  },
  email_copy: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      message_id: { type: "string" },
      operation: { type: "string" },
      inbox_id: { type: "string" },
      destination_folder_id: { type: "string" },
    },
    required: ["success", "message_id", "operation", "inbox_id", "destination_folder_id"],
    additionalProperties: false,
  },
  email_delete: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      message_id: { type: "string" },
      operation: { type: "string" },
      inbox_id: { type: "string" },
      permanent: { type: "boolean" },
    },
    required: ["success", "message_id", "operation", "inbox_id", "permanent"],
    additionalProperties: false,
  },
  email_move_batch: BULK_RESULT_SCHEMA,
  email_copy_batch: BULK_RESULT_SCHEMA,
  email_delete_batch: BULK_RESULT_SCHEMA,
  email_flag: BULK_RESULT_SCHEMA,
  email_search_and_move: BULK_RESULT_SCHEMA,
  email_search_and_delete: BULK_RESULT_SCHEMA,
  email_send: SENT_MESSAGE_SCHEMA,
  email_reply: SENT_MESSAGE_SCHEMA,
  email_forward: SENT_MESSAGE_SCHEMA,
  email_archive: FLAG_RESULT_SCHEMA,
  draft_list: {
    type: "object",
    properties: {
      inbox_id: { type: "string" },
      drafts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            draft_id: { type: "string" },
            subject: { type: "string" },
            to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
            cc: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
            created_at: { type: "string" },
          },
          required: ["draft_id", "subject"],
          additionalProperties: true,
        },
      },
    },
    required: ["inbox_id", "drafts"],
    additionalProperties: false,
  },
  draft_create: {
    type: "object",
    properties: {
      draft_id: { type: "string" },
      subject: { type: "string" },
      to: { type: "array", items: ADDRESS_ENTRY_SCHEMA },
      created_at: { type: "string" },
    },
    required: ["draft_id", "subject", "created_at"],
    additionalProperties: true,
  },
  draft_update: {
    type: "object",
    properties: {
      draft_id: {
        type: "string",
        description: "The draft's current identifier. On IMAP-backed inboxes the underlying " +
          "message is rewritten on update, so this MAY DIFFER from the draft_id you passed in — " +
          "adopt this value for any further draft_update/draft_send. Gmail/Outlook return the same id.",
      },
      subject: { type: "string" },
      updated_at: { type: "string" },
    },
    required: ["draft_id", "subject", "updated_at"],
    additionalProperties: true,
  },
  draft_send: {
    type: "object",
    properties: {
      draft_id: { type: "string" },
      message_id: { type: "string" },
      sent_at: { type: "string" },
    },
    required: ["draft_id", "message_id", "sent_at"],
    additionalProperties: true,
  },
  draft_delete: {
    type: "object",
    properties: {
      draft_id: { type: "string" },
      deleted: { type: "boolean" },
    },
    required: ["draft_id", "deleted"],
    additionalProperties: false,
  },
  contact_search: {
    type: "object",
    properties: {
      query: { type: "string" },
      total: { type: "integer" },
      contacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            inbox_id: { type: "string" },
            email_address: { type: "string" },
            display_name: { type: ["string", "null"] },
            message_count: { type: "integer" },
            last_contacted_at: { type: "string" },
          },
          required: ["inbox_id", "email_address"],
          additionalProperties: true,
        },
      },
    },
    required: ["query", "contacts", "total"],
    additionalProperties: false,
  },
  schedule_create: {
    type: "object",
    properties: {
      scheduled: { type: "boolean" },
      id: { type: "string" },
      inbox_id: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      send_at: { type: "string" },
      status: { type: "string" },
      created_at: { type: "string" },
    },
    required: ["scheduled", "id", "inbox_id", "send_at", "status"],
    additionalProperties: false,
  },
  schedule_list: {
    type: "object",
    properties: {
      total: { type: "integer" },
      scheduled_sends: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            inbox_id: { type: "string" },
            send_at: { type: "string" },
            status: { type: "string" },
            created_at: { type: "string" },
            to: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
          },
          required: ["id", "inbox_id", "send_at", "status"],
          additionalProperties: true,
        },
      },
    },
    required: ["scheduled_sends", "total"],
    additionalProperties: false,
  },
  schedule_cancel: {
    type: "object",
    properties: {
      cancelled: { type: "boolean" },
      id: { type: "string" },
      inbox_id: { type: "string" },
      send_at: { type: "string" },
      previous_status: { type: "string" },
    },
    required: ["cancelled", "id", "inbox_id", "send_at", "previous_status"],
    additionalProperties: false,
  },
};

/**
 * Per-tool behaviour hints (MCP ToolAnnotations). `openWorldHint` is true for
 * every tool because they all reach out to external email providers. `title`
 * is filled from each tool's existing `title` when attached below.
 */
const TOOL_ANNOTATIONS: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }
> = {
  // Read-only tools.
  inbox_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  email_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  email_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  email_read_batch: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  email_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  folder_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  draft_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  schedule_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  contact_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Non-destructive mutations — non-idempotent (each call produces a new effect).
  email_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  email_reply: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  email_forward: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  draft_send: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  schedule_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  folder_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  folder_rename: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // Non-destructive mutations — idempotent by default per spec ToolAnnotations.
  email_move: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_move_batch: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_copy: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_copy_batch: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_search_and_move: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  draft_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  draft_update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  schedule_cancel: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  // Idempotent state toggles.
  email_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_flag: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  // Destructive tools.
  email_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  email_delete_batch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  folder_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  email_search_and_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  draft_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

// Attach outputSchema + annotations to every legacy entry. Done once at module
// load so handleToolsList can emit them directly. openWorldHint is true for all
// tools (every one reaches an external email provider); title mirrors tool.title.
for (const tool of LEGACY_TOOLS) {
  const out = TOOL_OUTPUT_SCHEMAS[tool.name];
  if (out) tool.outputSchema = out;
  const ann = TOOL_ANNOTATIONS[tool.name];
  if (ann) {
    tool.annotations = {
      title: tool.title,
      readOnlyHint: ann.readOnlyHint,
      destructiveHint: ann.destructiveHint,
      idempotentHint: ann.idempotentHint,
      openWorldHint: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool consolidation (the surface clients actually see)
//
// The 28 legacy tools above are collapsed into a small set of resource-oriented
// tools that take an `action` argument. This keeps the connector under the tool
// count / token thresholds where clients (e.g. Claude.ai) defer tools behind an
// on-demand tool-search index — an index that has been observed to omit specific
// tools (notably the parameterless inbox_list), dead-ending discovery. With a
// small surface every tool is loaded directly, so nothing depends on search
// ranking. Each action routes to its untouched legacy handler at dispatch time.
// ---------------------------------------------------------------------------

const LEGACY_BY_NAME = new Map(LEGACY_TOOLS.map((t) => [t.name, t]));

/** One selectable action on a consolidated tool. */
interface ConsolidatedAction {
  /** Legacy tool name whose handler + schema back this action. */
  legacy: string;
  /** Scope required to invoke this specific action. */
  scope: string;
  /** Optional alternative scopes that also authorize this action. */
  altScopes?: string[];
  /**
   * Rename map applied when merging the legacy input schema into the
   * consolidated one: { legacyParamName: exposedParamName }. Used to avoid
   * collisions with the reserved `action` selector (email_flag's own `action`).
   * Reversed at dispatch before the legacy handler runs.
   */
  renames?: Record<string, string>;
}

interface ConsolidatedSpec {
  title: string;
  /** Per-action description lines appended to the tool description. */
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  actions: Record<string, ConsolidatedAction>;
}

const CONSOLIDATED_SPECS: Record<string, ConsolidatedSpec> = {
  email_read: {
    title: "Read Email",
    description:
      "Read, list and search email in an inbox. Set `action`: 'list' (recent " +
      "messages, optionally by folder/unread), 'read' (full content of one " +
      "message_id), 'read_batch' (several message_ids), 'search' (structured " +
      "filters: from/to/subject/body/since/before/unread/has_attachment/flagged), " +
      "or 'attachment' (download one attachment by attachment_index or filename, " +
      "returned as base64 `data`).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    actions: {
      list: { legacy: "email_list", scope: "read:email" },
      read: { legacy: "email_read", scope: "read:email" },
      read_batch: { legacy: "email_read_batch", scope: "read:email" },
      search: { legacy: "email_search", scope: "read:email", altScopes: ["search:email"] },
      attachment: { legacy: "email_attachment", scope: "read:email" },
    },
  },
  email_organize: {
    title: "Organize Email",
    description:
      "Move, copy, flag or archive messages. Set `action`: 'move'/'move_batch' " +
      "(relocate to a destination_folder_id), 'copy'/'copy_batch' (duplicate into " +
      "a destination_folder_id, leaving the original in place; IMAP/Outlook/Fastmail " +
      "only), 'flag' (set read/unread/flagged via `flag_action` on message_ids), " +
      "'archive', or 'search_and_move' (apply to all messages matching a search). " +
      "Requires the scope matching the action (manage:folders / send:email). " +
      "To delete messages, use the email_delete tool.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      move: { legacy: "email_move", scope: "manage:folders" },
      move_batch: { legacy: "email_move_batch", scope: "manage:folders" },
      copy: { legacy: "email_copy", scope: "manage:folders" },
      copy_batch: { legacy: "email_copy_batch", scope: "manage:folders" },
      flag: { legacy: "email_flag", scope: "send:email", renames: { action: "flag_action" } },
      archive: { legacy: "email_archive", scope: "send:email" },
      search_and_move: { legacy: "email_search_and_move", scope: "manage:folders" },
    },
  },
  email_delete: {
    title: "Delete Email",
    description:
      "Delete messages. This is flagged as a DESTRUCTIVE action so your MCP " +
      "client can prompt you to confirm before it runs. Set `action`: 'delete' " +
      "(one message_id), 'delete_batch' (several message_ids), or " +
      "'search_and_delete' (delete every message matching a search). By default " +
      "deleted mail goes to Trash and can be recovered; pass `permanent: true` " +
      "to delete it irreversibly. Requires the delete:email scope.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    actions: {
      delete: { legacy: "email_delete", scope: "delete:email" },
      delete_batch: { legacy: "email_delete_batch", scope: "delete:email" },
      search_and_delete: { legacy: "email_search_and_delete", scope: "delete:email" },
    },
  },
  email_compose: {
    title: "Compose Email",
    description:
      "Send new mail or respond. Set `action`: 'send' (to/subject/body, optional " +
      "cc/bcc/html_body/attachments), 'reply' (to a message_id, optional reply_all), " +
      "or 'forward' (a message_id to new recipients). The inbox's configured " +
      "signature is appended automatically (for replies/forwards it goes above the " +
      "quoted text); pass include_signature: false to suppress it for terse replies.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      send: { legacy: "email_send", scope: "send:email" },
      reply: { legacy: "email_reply", scope: "send:email" },
      forward: { legacy: "email_forward", scope: "send:email" },
    },
  },
  folder: {
    title: "Folders",
    description:
      "Manage mailbox folders/labels. Set `action`: 'list' (all folders with ids " +
      "and counts), 'create' (name), 'rename' (folder_id, new_name), or 'delete' " +
      "(folder_id — irreversible). 'list' needs read:email; the rest need manage:folders.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      list: { legacy: "folder_list", scope: "read:email" },
      create: { legacy: "folder_create", scope: "manage:folders" },
      rename: { legacy: "folder_rename", scope: "manage:folders" },
      delete: { legacy: "folder_delete", scope: "manage:folders" },
    },
  },
  draft: {
    title: "Drafts",
    description:
      "Manage draft messages. Set `action`: 'list', 'create' (subject/body, optional " +
      "to/cc/bcc/html_body), 'update' (draft_id + fields), or 'send' (draft_id). On " +
      "IMAP inboxes a draft_id changes on every update — always use the latest. " +
      "'delete' permanently removes a draft (draft_id) without sending it. The inbox " +
      "signature is embedded into the draft on create/update (pass " +
      "include_signature: false to skip); 'send' transmits the stored body as-is and " +
      "never re-appends, so the signature is never doubled.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      list: { legacy: "draft_list", scope: "manage:drafts" },
      create: { legacy: "draft_create", scope: "manage:drafts" },
      update: { legacy: "draft_update", scope: "manage:drafts" },
      // SECURITY: 'send' transmits mail, so it is gated by send:email — NOT
      // manage:drafts. Otherwise a key with only manage:drafts could create a
      // draft and send it, bypassing the send:email consent that email_compose
      // enforces (scope-confusion privilege escalation). Do NOT add manage:drafts
      // as an altScope here: altScopes are OR'd, which would reopen the bypass.
      send: { legacy: "draft_send", scope: "send:email" },
      delete: { legacy: "draft_delete", scope: "manage:drafts" },
    },
  },
  schedule: {
    title: "Scheduled Send",
    description:
      "Schedule mail for later delivery. Set `action`: 'create' (to/subject/body + " +
      "send_at ISO timestamp), 'list' (pending scheduled sends), or 'cancel' " +
      "(pass `id` or its alias `scheduled_send_id`).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      create: { legacy: "schedule_create", scope: "schedule:email" },
      list: { legacy: "schedule_list", scope: "schedule:email" },
      cancel: { legacy: "schedule_cancel", scope: "schedule:email" },
    },
  },
  signature: {
    title: "Signature",
    description:
      "Read or set the inbox's email signature (appended server-side on " +
      "send/reply/forward/draft/scheduled mail). Set `action`: 'get' (returns the " +
      "current signature_html/text, enabled flag, reply_mode and source) or 'set' " +
      "(write signature_text and/or signature_html, optionally signature_enabled " +
      "and signature_reply_mode). Setting marks the signature source as 'manual', " +
      "which overrides Gmail auto-import. 'get' needs read:email; 'set' needs send:email.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    actions: {
      get: { legacy: "signature_get", scope: "read:email" },
      set: { legacy: "signature_set", scope: "send:email" },
    },
  },
};

/** Fast lookup at dispatch: consolidated tool name → spec. */
const CONSOLIDATED_BY_NAME = CONSOLIDATED_SPECS;

/**
 * Build a consolidated tool's input schema by merging the input schemas of its
 * actions' legacy tools. A required `action` enum selects the operation; every
 * other property is optional at the schema level (which params are required
 * depends on the action — the legacy handlers still enforce their own). The
 * first action to contribute a property wins (shared props like inbox_id are
 * identical across tools), except keys listed in an action's `renames`.
 */
function buildConsolidatedTool(name: string, spec: ConsolidatedSpec): ToolDefinition {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: Object.keys(spec.actions),
      description:
        "Which operation to perform. Determines which other arguments are used.",
    },
  };
  let requiredScope = "";
  const altScopeSet = new Set<string>();
  for (const [actionName, action] of Object.entries(spec.actions)) {
    if (!requiredScope) requiredScope = action.scope;
    else altScopeSet.add(action.scope);
    for (const a of action.altScopes ?? []) altScopeSet.add(a);

    const legacy = LEGACY_BY_NAME.get(action.legacy);
    if (!legacy) continue;
    const legacyProps =
      (legacy.inputSchema.properties as Record<string, unknown>) ?? {};
    for (const [propKey, propVal] of Object.entries(legacyProps)) {
      const exposedKey = action.renames?.[propKey] ?? propKey;
      if (exposedKey === "action") continue; // never shadow the selector
      if (!(exposedKey in properties)) properties[exposedKey] = propVal;
    }
    void actionName;
  }
  // requiredScope must not also appear in altScopes.
  altScopeSet.delete(requiredScope);

  return {
    name,
    title: spec.title,
    description: spec.description,
    requiredScope: requiredScope as ToolDefinition["requiredScope"],
    ...(altScopeSet.size > 0 ? { altScopes: [...altScopeSet] } : {}),
    inputSchema: {
      type: "object",
      properties,
      required: ["action"],
      additionalProperties: false,
    },
    annotations: {
      title: spec.title,
      readOnlyHint: spec.annotations.readOnlyHint,
      destructiveHint: spec.annotations.destructiveHint,
      idempotentHint: spec.annotations.idempotentHint,
      openWorldHint: true,
    },
  };
}

/**
 * The tool surface clients actually see: the standalone entry-point tools kept
 * as-is (inbox_list, contact_search) plus the consolidated resource tools.
 * inbox_list stays first as the discovery entry point.
 */
const TOOL_REGISTRY: ToolDefinition[] = [
  LEGACY_BY_NAME.get("inbox_list")!,
  buildConsolidatedTool("email_read", CONSOLIDATED_SPECS.email_read),
  buildConsolidatedTool("email_organize", CONSOLIDATED_SPECS.email_organize),
  buildConsolidatedTool("email_delete", CONSOLIDATED_SPECS.email_delete),
  buildConsolidatedTool("email_compose", CONSOLIDATED_SPECS.email_compose),
  buildConsolidatedTool("folder", CONSOLIDATED_SPECS.folder),
  buildConsolidatedTool("draft", CONSOLIDATED_SPECS.draft),
  buildConsolidatedTool("schedule", CONSOLIDATED_SPECS.schedule),
  buildConsolidatedTool("signature", CONSOLIDATED_SPECS.signature),
  LEGACY_BY_NAME.get("contact_search")!,
];

// ---------------------------------------------------------------------------
// Provider capability matrix (single source of truth)
//
// Maps every provider/service value to the set of features MCPEmails
// supports for that backend.  Later tools MUST consult this before
// attempting an operation and MUST return unsupportedFeatureError() when
// the relevant field is false.
//
// Keep in sync with Documents/provider-support.md and the Task-3 web page.
// ---------------------------------------------------------------------------

/**
 * Feature flags exposed per provider.  Each field corresponds to a capability
 * that may or may not be available depending on the backing protocol.
 */
interface ProviderCapabilities {
  /** IMAP \Seen / \Flagged or equivalent flag/keyword support */
  flags: boolean;
  /** Hierarchical folder support (IMAP, Graph mailFolders, JMAP Mailbox) */
  folders: boolean;
  /** Flat label / tag support (Gmail only) */
  labels: boolean;
  /** Moving messages between folders / mailboxes */
  move: boolean;
  /** Copying messages to another folder */
  copy: boolean;
  /** Deleting / trashing messages */
  delete: boolean;
  /**
   * Whether the provider supports soft-delete to Trash, hard expunge, or both.
   *   'trash'   — only move-to-Trash is safe (Gmail, Outlook)
   *   'expunge' — only hard expunge (rare)
   *   'both'    — Trash or permanent delete selectable (IMAP, Fastmail)
   */
  trash_vs_expunge: "trash" | "expunge" | "both";
  /** Forwarding messages (synthesising a forwarded MIME body + send) */
  forward: boolean;
  /** Draft create / update / list / send */
  drafts: boolean;
  /** Provider-native contacts / address-book API */
  contacts_api: boolean;
  /**
   * contact_search support (the manage:contacts tool). True for all providers:
   * contact_search is served by a LIVE, header-only scan of recent matching
   * mail — there is no contacts table and nothing is persisted. (Field name
   * kept as-is to avoid churn across the codebase / capability consumers.)
   */
  contacts_db: boolean;
  /** Server-side scheduled send (via scheduled_sends queue — Task 17-18) */
  scheduling: boolean;
  /**
   * Query syntax accepted by email_search for this provider.
   *   'gmail'  — Gmail query language (from:, subject:, after:, …)
   *   'odata'  — Microsoft OData $filter
   *   'jmap'   — JMAP FilterCondition
   *   'imap'   — IMAP SEARCH criteria
   */
  search_syntax: "gmail" | "odata" | "jmap" | "imap";
}

/**
 * Authoritative capability map.
 *
 * Key = `inbox.provider` value as stored in the DB:
 *   'gmail' | 'outlook' | 'fastmail' | 'imap'
 *
 * The 'imap' entry covers every service variant (icloud, yahoo, zoho,
 * yandex, generic) — they all run through the same Deno IMAP/SMTP client.
 */
const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  gmail: {
    flags: true,         // read/unread + starred via Gmail labels
    folders: false,      // Gmail uses labels, not folders
    labels: true,
    move: true,          // label add/remove simulates move
    copy: false,         // Gmail API has no native copy
    delete: true,
    trash_vs_expunge: "trash",
    forward: true,
    drafts: true,        // Gmail Drafts API
    contacts_api: true,  // Google People API
    contacts_db: true,   // live header scan (no DB)
    scheduling: true,    // via scheduled_sends queue
    search_syntax: "gmail",
  },
  outlook: {
    flags: true,         // isRead, flag.flagStatus via Graph
    folders: true,       // Graph mailFolders
    labels: false,
    move: true,          // Graph messages/{id}/move
    copy: true,          // Graph messages/{id}/copy
    delete: true,
    trash_vs_expunge: "trash",
    forward: true,       // Graph createForward or MIME send
    drafts: true,        // Graph createDraft / send
    contacts_api: true,  // Graph /contacts
    contacts_db: true,   // live header scan (no DB)
    scheduling: true,    // via scheduled_sends queue
    search_syntax: "odata",
  },
  fastmail: {
    flags: true,         // JMAP Email/set keywords
    folders: true,       // JMAP Mailbox/get
    labels: false,
    move: true,          // JMAP Email/set mailboxIds
    copy: true,          // JMAP Email/copy
    delete: true,
    trash_vs_expunge: "both",
    forward: true,       // Compose + JMAP send
    drafts: true,        // JMAP Email/set $draft keyword
    contacts_api: false, // CardDAV out of scope for v0.1
    contacts_db: true,   // live header scan (no DB)
    scheduling: true,    // via scheduled_sends queue
    search_syntax: "jmap",
  },
  imap: {
    flags: true,         // IMAP UID STORE \Seen \Flagged
    folders: true,       // IMAP LIST + SELECT
    labels: false,
    move: true,          // IMAP MOVE (or COPY+STORE \Deleted+EXPUNGE fallback)
    copy: true,          // IMAP UID COPY
    delete: true,
    trash_vs_expunge: "both",
    forward: true,       // Compose + SMTP send
    drafts: true,        // IMAP APPEND to Drafts with \Draft flag
    contacts_api: false, // No standard contacts API over IMAP/SMTP
    contacts_db: true,   // live header scan (no DB)
    scheduling: true,    // via scheduled_sends queue
    search_syntax: "imap",
  },
};

/**
 * Returns the capability set for the given provider, defaulting to the
 * generic IMAP set for any unknown provider (fail-safe for new service values).
 */
function getProviderCapabilities(provider: string): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider] ?? PROVIDER_CAPABILITIES["imap"];
}

/**
 * Returns a structured handler result indicating that the requested feature
 * is not supported for the given provider.  Every tool that gates on a
 * capability MUST call this (rather than crafting ad-hoc error strings) so
 * the shape is consistent and parseable by MCP clients.
 *
 * Usage:
 *   const caps = getProviderCapabilities(inbox.provider);
 *   if (!caps.copy) return unsupportedFeatureError("copy", inbox.provider);
 */
function unsupportedFeatureError(
  feature: string,
  provider: string,
): {
  result: { content: { type: string; text: string }[] };
  logStatus: "error";
  logErrorCode: string;
} {
  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "unsupported_feature",
          feature,
          provider,
          message:
            `The '${feature}' feature is not supported for provider '${provider}'.`,
        }),
      }],
    },
    logStatus: "error",
    logErrorCode: String(-32601),
  };
}

/**
 * Structured error for permanent=true on a trash-only provider (Gmail/Outlook).
 * These providers can only move messages to Trash; they cannot expunge. Tell
 * the caller exactly how to retry rather than attempting a doomed API call.
 */
function permanentDeleteUnsupportedError(
  provider: string,
): {
  result: { content: { type: string; text: string }[]; isError: true };
  logStatus: "error";
  logErrorCode: string;
} {
  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "unsupported_permanent_delete",
          provider,
          message:
            `Provider '${provider}' only supports moving messages to Trash and ` +
            `cannot permanently delete (expunge) them. Retry with permanent: false ` +
            `(or omit permanent) to move the message to Trash.`,
        }),
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "unsupported_permanent_delete",
  };
}

// ---------------------------------------------------------------------------
// Destructive-action plumbing
//
// MAX_BULK_IDS — hard cap on bulk-UID operations to prevent runaway calls.
//
// Usage (in any bulk handler):
//
//   if (Array.isArray(input.message_ids) && input.message_ids.length > MAX_BULK_IDS) {
//     return bulkCapError(input.message_ids.length);
//   }
// ---------------------------------------------------------------------------

/** Maximum number of message UIDs accepted by any bulk tool in a single call. */
const MAX_BULK_IDS = 500;

/**
 * Returns a structured error result when a bulk tool receives more IDs than
 * `MAX_BULK_IDS` allows.
 *
 *   if (ids.length > MAX_BULK_IDS) return bulkCapError(ids.length);
 */
function bulkCapError(
  received: number,
): {
  result: { content: { type: string; text: string }[] };
  logStatus: "error";
  logErrorCode: string;
} {
  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "bulk_cap_exceeded",
          max: MAX_BULK_IDS,
          received,
          message:
            `Bulk operations are capped at ${MAX_BULK_IDS} message IDs per call. ` +
            `Received ${received}. Split the request into smaller batches.`,
        }),
      }],
    },
    logStatus: "error",
    logErrorCode: String(-32602),
  };
}

// ---------------------------------------------------------------------------
// Inbox types and credential helpers
// ---------------------------------------------------------------------------

/**
 * Selected columns from the `inboxes` table needed by tool handlers.
 * Only credential-related and provider-routing columns are fetched — no
 * unrestricted SELECT * is ever issued on this table.
 */
interface InboxRow {
  id: string;
  workspace_id: string;
  /** 'gmail' | 'outlook' | 'fastmail' | 'imap' */
  provider: string;
  email_address: string;
  display_name: string | null;
  /** AES-256-GCM ciphertext encoded as base64url text. */
  oauth_access_token: string | null;
  /** AES-256-GCM ciphertext encoded as base64url text. */
  oauth_refresh_token: string | null;
  oauth_token_expires_at: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_tls: boolean;
  /** Optional SASL login username; falls back to email_address when null. */
  imap_username: string | null;
  /** AES-256-GCM ciphertext encoded as base64url text. */
  imap_password: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_tls: boolean;
  status: string;
  /** Optional HTML signature appended server-side on send. Plaintext (not secret). */
  signature_html: string | null;
  /** Optional plain-text signature appended server-side on send. Plaintext (not secret). */
  signature_text: string | null;
  /** When false, no signature is appended for this inbox. */
  signature_enabled: boolean;
  /** Reply/forward behaviour: 'always' | 'first_only' | 'never'. (Used in Phase 1.) */
  signature_reply_mode: string;
  /** Origin of the stored signature: 'manual' | 'gmail_import' | null. */
  signature_source: string | null;
  signature_updated_at: string | null;
}

const INBOX_SELECT_COLUMNS =
  "id, workspace_id, provider, email_address, display_name, " +
  "oauth_access_token, oauth_refresh_token, oauth_token_expires_at, " +
  "imap_host, imap_port, imap_tls, imap_username, imap_password, " +
  "smtp_host, smtp_port, smtp_tls, status, " +
  "signature_html, signature_text, signature_enabled, " +
  "signature_reply_mode, signature_source, signature_updated_at";

/**
 * The SASL login username for IMAP/SMTP auth. Most providers authenticate with
 * the email address, but some independent hosts (e.g. domeneshop) issue a
 * distinct username, stored in imap_username. The sender identity / From header
 * always remains email_address — this is only the credential's login name.
 */
function imapAuthUser(inbox: InboxRow): string {
  return inbox.imap_username || inbox.email_address;
}

/**
 * Decrypts an AES-256-GCM ciphertext produced by
 * `apps/web/src/lib/crypto.ts#encryptToken` using the Web Crypto API.
 *
 * Ciphertext layout (base64url-encoded):
 *   bytes  0–11 : 12-byte random IV
 *   bytes 12–N  : encrypted payload
 *   bytes N–N+15: 16-byte GCM authentication tag
 *
 * Web Crypto's `decrypt()` for AES-GCM expects: payload || authTag
 * concatenated in one Uint8Array with the IV passed separately, so
 * `raw.slice(12)` is the exact input needed.
 *
 * ENCRYPTION_KEY must be a 64-character lowercase hex string (32 bytes)
 * that matches the key used to encrypt the stored token.
 *
 * @throws if ENCRYPTION_KEY is misconfigured or if decryption fails.
 */
async function decryptStoredToken(encrypted: string): Promise<string> {
  const keyHex = Deno.env.get("ENCRYPTION_KEY");
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY env var is not set or is not 64 hex characters.",
    );
  }

  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  // base64url → Uint8Array
  const b64 = encrypted.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binaryStr = atob(padded);
  const raw = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    raw[i] = binaryStr.charCodeAt(i);
  }

  if (raw.length < 12 + 16) {
    throw new Error("Encrypted token is too short to be valid.");
  }

  const iv = raw.slice(0, 12);
  // raw.slice(12) = ciphertext || authTag — exactly what Web Crypto AES-GCM needs.
  const ciphertextWithTag = raw.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    ciphertextWithTag,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypts a plaintext string using AES-256-GCM and returns the ciphertext
 * encoded as base64url. Mirror of `apps/web/src/lib/crypto.ts#encryptToken`.
 *
 * Layout: IV(12) || ciphertext || authTag(16), base64url-encoded.
 * Used to persist refreshed OAuth access tokens back to the database.
 */
async function encryptForStorage(plaintext: string): Promise<string> {
  const keyHex = Deno.env.get("ENCRYPTION_KEY")!;
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  );

  // IV || ciphertext || authTag (Web Crypto appends the tag automatically)
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);

  return btoa(String.fromCharCode(...combined))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * inbox_list — returns all inboxes the API key may access.
 *
 * If the key has a non-null inbox_ids allowlist, only those inboxes are
 * returned. Otherwise all active inboxes in the workspace are returned.
 * Credential columns are never included in the output.
 */
async function executeListInboxes(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[] };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const args: Record<string, unknown> =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
  const providerFilter = typeof args.provider === "string" ? args.provider : null;
  // include_capabilities defaults to true; only an explicit `false` opts out.
  const includeCapabilities = args.include_capabilities !== false;

  let query = supabase
    .from("inboxes")
    .select("id, email_address, display_name, provider, service, status")
    .eq("workspace_id", apiKey.workspace_id)
    .is("deleted_at", null)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
    query = query.in("id", apiKey.inbox_ids);
  }

  if (providerFilter !== null) {
    query = query.eq("provider", providerFilter);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[mcp-server] inbox_list: db_error", { error: error.message });
    return {
      result: { content: [{ type: "text", text: "Failed to retrieve inboxes." }] },
      logStatus: "error",
      logErrorCode: String(-32603),
    };
  }

  const inboxes = (data ?? []).map((row: {
    id: string;
    email_address: string;
    display_name: string | null;
    provider: string;
    service: string | null;
  }) => ({
    inbox_id: row.id,
    email_address: row.email_address,
    display_name: row.display_name ?? row.email_address,
    provider: row.provider,
    service: row.service ?? null,
    ...(includeCapabilities
      ? { capabilities: getProviderCapabilities(row.provider) }
      : {}),
  }));

  return {
    result: jsonOk({ inboxes }, true),
    logStatus: "success",
    logErrorCode: null,
  };
}

/**
 * Resolve and authorise an inbox for an incoming MCP tool call.
 *
 * Checks (in order):
 *   1. `inbox_id` matches a UUID format (fast pre-check).
 *   2. If `apiKey.inbox_ids` is non-null, the inbox ID must be in that list.
 *   3. Row exists in `inboxes` with matching `workspace_id` and no `deleted_at`.
 *   4. `inbox.status` is 'active'.
 *
 * Returns the InboxRow on success, or null on any failure.
 * "Not found" and "wrong workspace" intentionally return the same null to
 * prevent inbox ID enumeration across workspaces.
 */
async function resolveInbox(
  inboxId: string,
  apiKey: ApiKeyRow,
): Promise<InboxRow | null> {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(inboxId)) return null;

  if (apiKey.inbox_ids !== null && !apiKey.inbox_ids.includes(inboxId)) {
    return null;
  }

  const { data, error } = await supabase
    .from("inboxes")
    .select(INBOX_SELECT_COLUMNS)
    .eq("id", inboxId)
    .eq("workspace_id", apiKey.workspace_id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return null;

  const inbox = data as unknown as InboxRow;
  if (inbox.status !== "active") return null;

  return inbox;
}

/**
 * Resolve an inbox for a tool call from the `inbox_id` / `inbox` arguments,
 * with two ergonomic conveniences:
 *   1. Auto-resolve: when the API key can access exactly one inbox and neither
 *      argument is given, that inbox is selected automatically.
 *   2. Email alias: an email address may be passed via `inbox` (or via
 *      `inbox_id` when it isn't a UUID) instead of the opaque UUID.
 *
 * Returns `{ ok: true, inbox }` on success, or `{ ok: false, reason }` where
 * reason is "not_found" (no match), "ambiguous" (>1 accessible inbox and none
 * specified), or "none" (the key can access no inbox at all).
 */
async function resolveInboxArg(
  args: Record<string, unknown>,
  apiKey: ApiKeyRow,
): Promise<
  | { ok: true; inbox: InboxRow }
  | { ok: false; reason: "not_found" | "ambiguous" | "none"; inboxes?: InboxRow[] }
> {
  const resolved = await resolveInboxArgInner(args, apiKey);
  // Record the inbox this request actually resolved so the tools/call dispatcher
  // can log it (the raw arguments alone don't reveal an alias- or auto-resolved
  // inbox). No-op when called outside an activity-log async context.
  if (resolved.ok) {
    const store = activityInboxStore.getStore();
    if (store) store.inboxId = resolved.inbox.id;

    // Best-effort, one-time Gmail signature seed (Phase 2). This is the single
    // invocation point for every inbox-bound tool (covers UUID, email-alias,
    // and auto-resolve paths). The gate inside returns instantly with no
    // network call for non-Gmail inboxes and for any inbox that already has a
    // signature/source, so the only Gmail API request happens on the first
    // touch of a freshly connected Gmail inbox. It mutates the resolved row in
    // place so a following send/reply/forward/draft signs with the imported
    // value immediately; any failure is swallowed and never blocks the call.
    // DEFERRED (signatures Phase 2): Gmail signature auto-import is disabled until
    // the gmail.settings.basic scope is verified. See Documents/signatures-dev-plan.md.
    // await maybeImportGmailSignature(resolved.inbox);
  }
  return resolved;
}

async function resolveInboxArgInner(
  args: Record<string, unknown>,
  apiKey: ApiKeyRow,
): Promise<
  | { ok: true; inbox: InboxRow }
  | { ok: false; reason: "not_found" | "ambiguous" | "none"; inboxes?: InboxRow[] }
> {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const rawInboxId = typeof args["inbox_id"] === "string"
    ? (args["inbox_id"] as string).trim()
    : "";
  const rawInbox = typeof args["inbox"] === "string"
    ? (args["inbox"] as string).trim()
    : "";

  // Resolve an active, accessible inbox by its email address (case-insensitive,
  // unique within a workspace), honouring the key's inbox_ids allowlist.
  const resolveByEmail = async (
    email: string,
  ): Promise<{ ok: true; inbox: InboxRow } | { ok: false; reason: "not_found" }> => {
    let query = supabase
      .from("inboxes")
      .select(INBOX_SELECT_COLUMNS)
      .eq("workspace_id", apiKey.workspace_id)
      .is("deleted_at", null)
      .eq("status", "active")
      .ilike("email_address", email);

    if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
      query = query.in("id", apiKey.inbox_ids);
    }

    const { data, error } = await query.limit(1).maybeSingle();
    if (error || !data) return { ok: false, reason: "not_found" };
    return { ok: true, inbox: data as unknown as InboxRow };
  };

  if (rawInboxId) {
    if (UUID_RE.test(rawInboxId)) {
      const inbox = await resolveInbox(rawInboxId, apiKey);
      return inbox ? { ok: true, inbox } : { ok: false, reason: "not_found" };
    }
    if (rawInboxId.includes("@")) {
      return await resolveByEmail(rawInboxId);
    }
    return { ok: false, reason: "not_found" };
  }

  if (rawInbox) {
    return await resolveByEmail(rawInbox);
  }

  // Neither provided — auto-resolve only when exactly one inbox is accessible.
  let query = supabase
    .from("inboxes")
    .select(INBOX_SELECT_COLUMNS)
    .eq("workspace_id", apiKey.workspace_id)
    .is("deleted_at", null)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
    query = query.in("id", apiKey.inbox_ids);
  }

  const { data, error } = await query;
  if (error) return { ok: false, reason: "none" };

  const rows = (data ?? []) as unknown as InboxRow[];
  if (rows.length === 1) return { ok: true, inbox: rows[0] };
  if (rows.length === 0) return { ok: false, reason: "none" };
  // Carry the accessible inboxes back so the error can name them inline, sparing
  // the caller a separate inbox_list round-trip (which some MCP clients fail to
  // surface on demand — see inboxResolutionError).
  return { ok: false, reason: "ambiguous", inboxes: rows };
}

/**
 * Standard, agent-actionable error result for a failed inbox resolution.
 * Messages tell the calling agent exactly what to do next (call inbox_list
 * / pass inbox_id / ask the user to connect an inbox) — never "check the
 * dashboard".
 */
function inboxResolutionError(
  failure: {
    reason: "not_found" | "ambiguous" | "none";
    inboxes?: InboxRow[];
  },
  _toolName: string,
): ToolErrorResult {
  let text: string;
  let structuredContent: Record<string, unknown> | undefined;
  switch (failure.reason) {
    case "not_found":
      text =
        "No inbox matches the given inbox_id/inbox. Call inbox_list to see " +
        "the available inboxes (each with its inbox_id and email address).";
      break;
    case "ambiguous": {
      // Name the accessible inboxes inline so the agent can immediately retry
      // with an inbox_id — without having to discover and call inbox_list. That
      // separate tool is not always surfaced by a client's on-demand tool index,
      // which otherwise dead-ends every inbox-bound call (the "catch-22").
      const inboxes = (failure.inboxes ?? []).map((ib) => ({
        inbox_id: ib.id,
        email_address: ib.email_address,
        display_name: ib.display_name ?? null,
        provider: ib.provider,
      }));
      const lines = inboxes
        .map((ib) => `  • ${ib.email_address} — inbox_id: ${ib.inbox_id}`)
        .join("\n");
      text =
        "Multiple inboxes are accessible, so inbox_id (or inbox) is required. " +
        "Retry this same tool with one of the inbox_id values below — you do " +
        "not need to call any other tool first:\n" + lines;
      structuredContent = { inboxes };
      break;
    }
    case "none":
      text =
        "No inbox is connected for this API key. The user must connect an " +
        "inbox in MCP Emails before this tool can be used.";
      break;
  }
  const result: ToolErrorResult["result"] = {
    content: [{ type: "text", text }],
    isError: true,
  };
  if (structuredContent) result.structuredContent = structuredContent;
  return {
    result,
    logStatus: "error",
    logErrorCode: "inbox_not_found",
  };
}

// ---------------------------------------------------------------------------
// Token refresh helpers (Gmail and Outlook)
// ---------------------------------------------------------------------------

/** 5-minute proactive refresh window in milliseconds. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1_000;

/**
 * Returns a fresh, decrypted Gmail access token.
 *
 * If the stored token expires within 5 minutes, calls Google's token
 * endpoint, persists the new encrypted token (fire-and-forget), and
 * returns the plaintext token for immediate use.
 *
 * @throws "gmail_auth_failed" if Google returns `invalid_grant`.
 * @throws on missing credentials or unexpected provider errors.
 */
async function withFreshGmailToken(inbox: InboxRow): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new Error(
      `Gmail inbox ${inbox.id} is missing OAuth tokens — user must reconnect.`,
    );
  }

  const now = Date.now();
  const expiresAt = inbox.oauth_token_expires_at
    ? new Date(inbox.oauth_token_expires_at).getTime()
    : 0;

  if (expiresAt > now + REFRESH_THRESHOLD_MS) {
    return await decryptStoredToken(inbox.oauth_access_token);
  }

  const refreshToken = await decryptStoredToken(inbox.oauth_refresh_token);
  const clientId = Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET is not configured in Edge Function secrets.",
    );
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = (await resp.json()) as { error?: string };
    if (body.error === "invalid_grant") {
      supabase
        .from("inboxes")
        .update({
          status: "error",
          last_error: "Gmail refresh token revoked — user must reconnect.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id)
        .then(() => {});
      throw new Error("gmail_auth_failed");
    }
    throw new Error(
      `Gmail token refresh failed: ${body.error ?? resp.statusText}`,
    );
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Fire-and-forget: persist the new access token.
  // A failure here is non-fatal — the token is still usable for this call.
  (async () => {
    try {
      const encrypted = await encryptForStorage(tokens.access_token);
      const newExpiry = new Date(
        Date.now() + tokens.expires_in * 1_000,
      ).toISOString();
      await supabase
        .from("inboxes")
        .update({
          oauth_access_token: encrypted,
          oauth_token_expires_at: newExpiry,
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id);
    } catch (e) {
      console.warn("[mcp-server] gmail_token_persist_failed", {
        inbox_id: inbox.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  return tokens.access_token;
}

/**
 * Best-effort, one-time import of a Gmail inbox's existing signature.
 *
 * Gmail is the only provider that exposes the user's configured signature via
 * an API (`GET users/me/settings/sendAs/{email}`, requires the
 * `gmail.settings.basic` read scope added in Phase 2). This seeds the per-inbox
 * signature columns so Gmail inboxes are signed with zero manual setup.
 *
 * Rules (kept deliberately simple):
 *   - Only runs for Gmail inboxes whose signature is unimported AND empty —
 *     `signature_source` is null AND both `signature_html`/`signature_text` are
 *     blank. This means it fires at most once per inbox (after a successful
 *     import the columns are non-empty, so it never runs again), and it NEVER
 *     overwrites a manual edit (`signature_source = 'manual'`) or a prior
 *     `gmail_import` that produced content.
 *   - The returned `signature` field is HTML. We store it verbatim in
 *     `signature_html`, derive `signature_text` via the same `stripHtmlToText`
 *     that `composeSignatureBlocks` uses, and stamp
 *     `signature_source = 'gmail_import'`.
 *   - BEST-EFFORT: a missing scope (403 / insufficient permission), a sendAs
 *     entry with no signature, an empty signature, a token refresh failure, or
 *     any other error is logged and swallowed. This must NEVER block the
 *     surrounding read/send.
 *
 * Mutates the passed `inbox` row in place on success so the caller's subsequent
 * (synchronous) `composeSignatureBlocks`/`applySignature` immediately sees the
 * imported signature on the very first send/reply/forward/draft.
 */
async function maybeImportGmailSignature(inbox: InboxRow): Promise<void> {
  // Gate: only Gmail, only when nothing has been imported or set yet.
  if (inbox.provider !== "gmail") return;
  if (inbox.signature_source !== null) return;
  if (
    (inbox.signature_html ?? "").trim() ||
    (inbox.signature_text ?? "").trim()
  ) {
    return;
  }

  try {
    const accessToken = await withFreshGmailToken(inbox);
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${
        encodeURIComponent(inbox.email_address)
      }`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!resp.ok) {
      // 403 = the gmail.settings.basic scope was not granted (existing users who
      // connected before Phase 2 and haven't reconnected). Degrade silently.
      console.warn("[mcp-server] gmail_signature_import_skipped", {
        inbox_id: inbox.id,
        status: resp.status,
      });
      return;
    }

    const data = (await resp.json()) as { signature?: string };
    const signatureHtml = (data.signature ?? "").trim();
    if (!signatureHtml) {
      // No signature configured in Gmail — nothing to import. Leave the columns
      // (and signature_source) untouched so a later manual set still works.
      return;
    }

    const signatureText = stripHtmlToText(signatureHtml);

    const { error } = await supabase
      .from("inboxes")
      .update({
        signature_html: signatureHtml,
        signature_text: signatureText,
        signature_source: "gmail_import",
        signature_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", inbox.id)
      // Concurrency guard: only seed if still unimported, so a racing manual
      // set or parallel send can't be clobbered.
      .is("signature_source", null);

    if (error) {
      console.warn("[mcp-server] gmail_signature_import_persist_failed", {
        inbox_id: inbox.id,
        error: error.message,
      });
      return;
    }

    // Reflect the import on the in-memory row so the immediate send signs.
    inbox.signature_html = signatureHtml;
    inbox.signature_text = signatureText;
    inbox.signature_source = "gmail_import";
    inbox.signature_updated_at = new Date().toISOString();
  } catch (e) {
    // Never block the caller — log and move on.
    console.warn("[mcp-server] gmail_signature_import_failed", {
      inbox_id: inbox.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Returns a fresh, decrypted Outlook access token.
 * Same proactive-refresh pattern as Gmail.
 *
 * @throws "outlook_auth_failed" on `invalid_grant` / `interaction_required`.
 */
async function withFreshOutlookToken(inbox: InboxRow): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new Error(
      `Outlook inbox ${inbox.id} is missing OAuth tokens — user must reconnect.`,
    );
  }

  const now = Date.now();
  const expiresAt = inbox.oauth_token_expires_at
    ? new Date(inbox.oauth_token_expires_at).getTime()
    : 0;

  if (expiresAt > now + REFRESH_THRESHOLD_MS) {
    return await decryptStoredToken(inbox.oauth_access_token);
  }

  const refreshToken = await decryptStoredToken(inbox.oauth_refresh_token);
  const clientId = Deno.env.get("OUTLOOK_CLIENT_ID");
  const clientSecret = Deno.env.get("OUTLOOK_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "OUTLOOK_CLIENT_ID or OUTLOOK_CLIENT_SECRET is not configured in Edge Function secrets.",
    );
  }

  const resp = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope:
          "https://graph.microsoft.com/Mail.ReadWrite " +
          "https://graph.microsoft.com/Mail.Send " +
          "offline_access",
      }),
    },
  );

  if (!resp.ok) {
    const body = (await resp.json()) as { error?: string };
    if (
      body.error === "invalid_grant" ||
      body.error === "interaction_required"
    ) {
      supabase
        .from("inboxes")
        .update({
          status: "error",
          last_error: "Outlook refresh token revoked — user must reconnect.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id)
        .then(() => {});
      throw new Error("outlook_auth_failed");
    }
    throw new Error(
      `Outlook token refresh failed: ${body.error ?? resp.statusText}`,
    );
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  (async () => {
    try {
      const encrypted = await encryptForStorage(tokens.access_token);
      const newExpiry = new Date(
        Date.now() + tokens.expires_in * 1_000,
      ).toISOString();
      await supabase
        .from("inboxes")
        .update({
          oauth_access_token: encrypted,
          oauth_token_expires_at: newExpiry,
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id);
    } catch (e) {
      console.warn("[mcp-server] outlook_token_persist_failed", {
        inbox_id: inbox.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Fastmail token refresh + JMAP auth header
// ---------------------------------------------------------------------------

const FASTMAIL_TOKEN_ENDPOINT = "https://www.fastmail.com/oauth/token";

/**
 * Returns a fresh Fastmail OAuth access token, refreshing via the stored
 * refresh token when the current one is within REFRESH_THRESHOLD_MS of expiry.
 * Fastmail access tokens last ~1 year, so the refresh path rarely runs, but it
 * keeps long-lived OAuth inboxes working after expiry or early revocation.
 */
async function withFreshFastmailToken(inbox: InboxRow): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new Error(
      `Fastmail inbox ${inbox.id} is missing OAuth tokens — user must reconnect.`,
    );
  }

  const now = Date.now();
  const expiresAt = inbox.oauth_token_expires_at
    ? new Date(inbox.oauth_token_expires_at).getTime()
    : 0;

  if (expiresAt > now + REFRESH_THRESHOLD_MS) {
    return await decryptStoredToken(inbox.oauth_access_token);
  }

  const refreshToken = await decryptStoredToken(inbox.oauth_refresh_token);
  const clientId = Deno.env.get("FASTMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("FASTMAIL_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "FASTMAIL_CLIENT_ID or FASTMAIL_CLIENT_SECRET is not configured in Edge Function secrets.",
    );
  }

  const resp = await fetch(FASTMAIL_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    // Fastmail signals refresh-token invalidation with a 4xx — mark the inbox
    // for reconnection rather than retrying.
    if (resp.status === 400 || resp.status === 401) {
      supabase
        .from("inboxes")
        .update({
          status: "error",
          last_error: "Fastmail refresh token revoked — user must reconnect.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id)
        .then(() => {});
      throw new Error("fastmail_auth_failed");
    }
    throw new Error(`Fastmail token refresh failed: ${resp.statusText}`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    expires_in?: number;
  };

  (async () => {
    try {
      const encrypted = await encryptForStorage(tokens.access_token);
      const newExpiry = new Date(
        Date.now() + (tokens.expires_in ?? 365 * 24 * 60 * 60) * 1_000,
      ).toISOString();
      await supabase
        .from("inboxes")
        .update({
          oauth_access_token: encrypted,
          oauth_token_expires_at: newExpiry,
          updated_at: new Date().toISOString(),
        })
        .eq("id", inbox.id);
    } catch (e) {
      console.warn("[mcp-server] fastmail_token_persist_failed", {
        inbox_id: inbox.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  return tokens.access_token;
}

/**
 * Builds the JMAP Authorization header for a Fastmail inbox: a (refreshed)
 * Bearer token for OAuth inboxes, or HTTP Basic for app-password inboxes.
 */
async function buildFastmailAuthHeader(inbox: InboxRow): Promise<string> {
  if (inbox.oauth_access_token) {
    return `Bearer ${await withFreshFastmailToken(inbox)}`;
  }
  if (inbox.imap_password) {
    const password = await decryptStoredToken(inbox.imap_password);
    return `Basic ${btoa(`${inbox.email_address}:${password}`)}`;
  }
  throw new Error(
    `Fastmail inbox ${inbox.id} has no usable credentials — user must reconnect.`,
  );
}

// ---------------------------------------------------------------------------
// Email summary types (shared across email_list and email_search tools)
// ---------------------------------------------------------------------------

interface EmailAddressEntry {
  name: string;
  email: string;
}

interface EmailSummary {
  id: string;
  from: EmailAddressEntry;
  to: EmailAddressEntry[];
  subject: string;
  /** ISO 8601 UTC timestamp. */
  date: string;
  /** First ≤200 characters of the plain-text body, whitespace-normalised. */
  preview: string;
  is_read: boolean;
  has_attachments: boolean;
  folder: string;
  thread_id: string;
}

interface ListInboxResult {
  messages: EmailSummary[];
  /**
   * Total number of messages matching the query. Exact for IMAP and Fastmail;
   * an estimate for Gmail (see `total_is_estimate`); `null` when the provider
   * cannot supply a count (Outlook without `@odata.count`).
   */
  total: number | null;
  /** True when `total` is a provider estimate rather than an exact count. */
  total_is_estimate?: boolean;
  has_more: boolean;
  next_offset: number;
}

/**
 * Parses an RFC 5322 address header ("Name <email>" or "bare@email.com")
 * into an EmailAddressEntry.
 */
function parseEmailAddress(header: string): EmailAddressEntry {
  const trimmed = header.trim();
  const angleMatch = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angleMatch) {
    const name = angleMatch[1].replace(/^["']|["']$/g, "").trim();
    return { name, email: angleMatch[2].trim() };
  }
  return { name: "", email: trimmed };
}

/**
 * Parses a comma-separated RFC 5322 address list, respecting display names
 * that contain commas inside quoted strings.
 */
function parseAddressList(header: string): EmailAddressEntry[] {
  if (!header.trim()) return [];
  const results: EmailAddressEntry[] = [];
  let depth = 0;
  let current = "";
  for (const ch of header) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) results.push(parseEmailAddress(current));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) results.push(parseEmailAddress(current));
  return results;
}

/**
 * Render an EmailAddressEntry back into an RFC 5322 address string suitable for
 * a DraftParams recipient array ("Name <email>" or bare "email"). Each entry is
 * one array element, so a display name containing commas is safe — the draft
 * builders parse per-element with parseEmailAddress, not parseAddressList.
 */
function formatAddressEntry(a: EmailAddressEntry): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

/** Collapses whitespace and trims the input to ≤200 characters. */
function normalizePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Gmail provider — email_list
// ---------------------------------------------------------------------------

/**
 * Maps MCPEmails canonical folder names to Gmail label IDs.
 * Unmapped values (e.g. "[Gmail]/All Mail") are passed through as-is.
 */
function gmailFolderToLabel(folder: string): string {
  const MAP: Record<string, string> = {
    INBOX: "INBOX",
    SENT: "SENT",
    DRAFTS: "DRAFT",
    DRAFT: "DRAFT",
    TRASH: "TRASH",
    SPAM: "SPAM",
    STARRED: "STARRED",
    IMPORTANT: "IMPORTANT",
  };
  return MAP[folder.toUpperCase()] ?? folder;
}

interface GmailMessageMeta {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: { name: string; value: string }[];
    parts?: { mimeType?: string; filename?: string }[];
  };
}

/**
 * Heuristic attachment check.
 * `format=metadata` does not return body content, but does return the top-
 * level MIME type and the `parts` array with filenames (without bodies).
 */
function gmailHasAttachments(msg: GmailMessageMeta): boolean {
  if (msg.payload?.mimeType === "multipart/mixed") return true;
  return (msg.payload?.parts ?? []).some(
    (p) => typeof p.filename === "string" && p.filename.length > 0,
  );
}

/**
 * Implements `email_list` for Gmail.
 *
 * Flow:
 *   1. GET /users/me/messages?labelIds=…&q=…&maxResults=… → {id, threadId}[]
 *   2. Apply offset slice to the returned IDs.
 *   3. Parallel GET /users/me/messages/{id}?format=metadata for each message.
 *   4. Assemble EmailSummary[].
 *
 * Note: Gmail uses cursor-based pagination (nextPageToken); this implementation
 * fetches up to `offset + limit` items in a single API call (max 100 per
 * request) and slices the result. For large offsets, callers should prefer
 * page-token-based navigation rather than a high offset value.
 */
async function listGmailMessages(
  inbox: InboxRow,
  folder: string,
  limit: number,
  offset: number,
  unreadOnly: boolean,
): Promise<ListInboxResult> {
  const accessToken = await withFreshGmailToken(inbox);
  const label = gmailFolderToLabel(folder);

  // Gmail's list endpoint is cursor-based (nextPageToken) and has no numeric
  // offset parameter. To honor our numeric `offset` API contract, page forward
  // with nextPageToken, accumulating message refs until we've collected
  // `offset + limit` of them (or Gmail runs out). Gmail caps maxResults at 500
  // per page, so deep offsets cost a few sequential calls rather than one.
  const target = offset + limit;
  const allRefs: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  let nextPageToken: string | undefined;
  let resultSizeEstimate = 0;

  do {
    const params = new URLSearchParams({
      labelIds: label,
      // Request only as many as we still need to reach `target`, capped at
      // Gmail's per-page maximum of 500.
      maxResults: String(Math.min(target - allRefs.length, 500)),
    });
    if (unreadOnly) params.set("q", "is:unread");
    if (pageToken) params.set("pageToken", pageToken);

    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!listResp.ok) {
      if (listResp.status === 401) throw new Error("gmail_auth_failed");
      const errBody = (await listResp.json()) as {
        error?: { message?: string };
      };
      throw new Error(
        `Gmail API error: ${errBody.error?.message ?? listResp.statusText}`,
      );
    }

    const listData = (await listResp.json()) as {
      messages?: { id: string; threadId: string }[];
      resultSizeEstimate?: number;
      nextPageToken?: string;
    };

    allRefs.push(...(listData.messages ?? []));
    // Gmail's resultSizeEstimate is an approximation, not an exact count.
    resultSizeEstimate = listData.resultSizeEstimate ?? resultSizeEstimate;
    nextPageToken = listData.nextPageToken;
    pageToken = nextPageToken;
  } while (pageToken && allRefs.length < target);

  // Default to Gmail's approximate resultSizeEstimate. Gmail exposes EXACT
  // per-label counts via labels.get (messagesTotal / messagesUnread), so when
  // we're listing a single label (the common case) prefer that for an exact
  // total. Only the list-by-label path runs through here; the free-form search
  // path (email_search) intentionally keeps the estimate. Degrade gracefully:
  // any failure falls back to the estimate and never throws.
  let total = resultSizeEstimate || allRefs.length;
  let totalIsEstimate = true;
  try {
    if (label && !label.includes(" ")) {
      const labelResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(label)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (labelResp.ok) {
        const labelData = (await labelResp.json()) as {
          messagesTotal?: number;
          messagesUnread?: number;
        };
        const exact = unreadOnly
          ? labelData.messagesUnread
          : labelData.messagesTotal;
        if (typeof exact === "number" && Number.isFinite(exact)) {
          total = exact;
          totalIsEstimate = false;
        }
      }
    }
  } catch {
    // Keep the estimate-based total; this enhancement must never break listing.
  }
  // More pages remain only if Gmail still has a cursor beyond what we fetched,
  // or we somehow over-fetched past this page. When Gmail ran out of pages
  // (no nextPageToken), there is nothing more regardless of the offset.
  const hasMore = !!nextPageToken || allRefs.length > offset + limit;

  const pageRefs = allRefs.slice(offset, offset + limit);

  if (pageRefs.length === 0) {
    return {
      messages: [],
      total,
      total_is_estimate: totalIsEstimate,
      has_more: hasMore,
      next_offset: offset + limit,
    };
  }

  // Fetch message metadata in parallel.
  // format=metadata returns headers + snippet without downloading body content.
  const metaResults = await Promise.all(
    pageRefs.map(({ id }) => {
      const mp = new URLSearchParams({ format: "metadata" });
      // Multiple metadataHeaders values must be repeated params.
      for (const h of ["From", "To", "Subject", "Date"]) {
        mp.append("metadataHeaders", h);
      }
      return fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${mp}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((r) => r.json() as Promise<GmailMessageMeta>);
    }),
  );

  const messages: EmailSummary[] = metaResults.map((msg, i) => {
    const hdrs: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) {
      hdrs[h.name.toLowerCase()] = h.value;
    }
    return {
      id: msg.id ?? pageRefs[i].id,
      from: parseEmailAddress(hdrs["from"] ?? ""),
      to: parseAddressList(hdrs["to"] ?? ""),
      subject: hdrs["subject"] ?? "(no subject)",
      date: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
      preview: normalizePreview(msg.snippet ?? ""),
      is_read: !(msg.labelIds ?? []).includes("UNREAD"),
      has_attachments: gmailHasAttachments(msg),
      folder,
      thread_id: msg.threadId ?? pageRefs[i].threadId,
    };
  });

  return {
    messages,
    total,
    total_is_estimate: totalIsEstimate,
    has_more: hasMore,
    next_offset: offset + limit,
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — email_list
// ---------------------------------------------------------------------------

/**
 * Single source of truth mapping a canonical folder alias to each provider's
 * native value. Every provider-specific folder map (`outlookWellKnownFolder`,
 * `imapFolderName`) and the cross-provider `resolveFolderId` helper derive from
 * this table — keep this the only place provider folder vocabulary lives.
 *
 * - `gmail`: system label ID (e.g. "INBOX", "TRASH"). Gmail has no system
 *   "archive" label — archiving means removing the INBOX label — so the
 *   `archive` alias has no Gmail value (`null`); resolveFolderId falls through
 *   to listing / pass-through, and email_archive handles the real archive op.
 * - `outlook`: Graph well-known folder name (e.g. "inbox", "deleteditems").
 * - `fastmail`: JMAP mailbox `role`; resolved to a concrete mailbox id at
 *   runtime via the folder list (no static id exists).
 * - `imap`: common mailbox name; for IMAP the name *is* the id.
 *
 * `aliases` lists every accepted user-facing token (case-insensitive) for the
 * canonical entry, including the legacy UPPER canonical names used by callers.
 */
interface CanonicalFolderAlias {
  /** Accepted user-facing tokens (matched case-insensitively). */
  aliases: string[];
  /** Gmail system label ID, or null when no system label exists (archive). */
  gmail: string | null;
  /** Microsoft Graph well-known folder name. */
  outlook: string;
  /** Fastmail JMAP mailbox role (resolved to a mailbox id at runtime). */
  fastmail: string;
  /** Common IMAP mailbox name (the name is the id). */
  imap: string;
}

const CANONICAL_FOLDER_ALIASES: CanonicalFolderAlias[] = [
  { aliases: ["inbox"], gmail: "INBOX", outlook: "inbox", fastmail: "inbox", imap: "INBOX" },
  { aliases: ["sent"], gmail: "SENT", outlook: "sentitems", fastmail: "sent", imap: "Sent" },
  { aliases: ["drafts", "draft"], gmail: "DRAFT", outlook: "drafts", fastmail: "drafts", imap: "Drafts" },
  { aliases: ["trash", "deleted"], gmail: "TRASH", outlook: "deleteditems", fastmail: "trash", imap: "Trash" },
  { aliases: ["archive"], gmail: null, outlook: "archive", fastmail: "archive", imap: "Archive" },
  { aliases: ["spam", "junk"], gmail: "SPAM", outlook: "junkemail", fastmail: "junk", imap: "Junk" },
];

/** Case-insensitive lookup of a canonical alias entry by any of its tokens. */
function lookupCanonicalAlias(token: string): CanonicalFolderAlias | undefined {
  const lower = token.trim().toLowerCase();
  return CANONICAL_FOLDER_ALIASES.find((e) => e.aliases.includes(lower));
}

/**
 * Maps a canonical folder alias (matched by its first token) to the IMAP
 * SPECIAL-USE attribute flag a mailbox advertises for that role (RFC 6154),
 * lower-cased for case-insensitive comparison against LIST flags.
 *
 * Used to resolve aliases ("archive", "trash", …) against the server's ACTUAL
 * mailbox layout instead of assuming a fixed English name like "Archive" — the
 * generic-IMAP move bug where "archive" hard-resolved to a non-existent
 * "Archive" mailbox. "inbox" has no SPECIAL-USE flag (it is always the reserved
 * name "INBOX"), so it is intentionally absent.
 */
const IMAP_ALIAS_SPECIAL_USE: Record<string, string> = {
  archive: "\\archive",
  sent: "\\sent",
  drafts: "\\drafts",
  trash: "\\trash",
  spam: "\\junk",
};

/**
 * Match a canonical folder alias against an already-fetched IMAP mailbox list.
 * Pure (no I/O) so it can be shared by callers that own a connection. Matches:
 *   1. "inbox" → always the reserved name "INBOX".
 *   2. SPECIAL-USE flag match (\\Archive, \\Trash, \\Sent, \\Drafts, \\Junk).
 *   3. Case-insensitive match against the canonical English name (e.g.
 *      a mailbox literally named "Archive").
 * Returns null when nothing matches.
 */
function matchImapAliasMailbox(
  mailboxes: ImapMailboxInfo[],
  alias: CanonicalFolderAlias,
): string | null {
  const canonicalToken = alias.aliases[0];
  if (canonicalToken === "inbox") return "INBOX";

  // (2) SPECIAL-USE flag match.
  const wantFlag = IMAP_ALIAS_SPECIAL_USE[canonicalToken];
  if (wantFlag) {
    const bySpecialUse = mailboxes.find((mb) =>
      mb.flags.some((f) => f.toLowerCase() === wantFlag)
    );
    if (bySpecialUse) return bySpecialUse.name;
  }

  // (3) Case-insensitive match against the canonical English name.
  const wantName = alias.imap.toLowerCase();
  const byName = mailboxes.find((mb) => mb.name.toLowerCase() === wantName);
  if (byName) return byName.name;

  return null;
}

/**
 * Resolve a canonical folder alias to a concrete IMAP mailbox name using the
 * server's real layout (one LIST + {@link matchImapAliasMailbox}).
 *
 * When the server advertises neither the SPECIAL-USE flag nor a mailbox with
 * the canonical English name, returns null so the caller can fall back — UNLESS
 * `createIfMissing` is set, in which case the canonical mailbox (e.g. "Archive")
 * is CREATEd and its name returned. Auto-create exists so archiving works on
 * generic IMAP accounts that ship without an Archive folder (mirrors
 * appendToSentFolder auto-filing Sent on send); without it the move dead-ended
 * with a raw "[TRYCREATE] Mailbox doesn't exist: Archive" leak.
 */
async function resolveImapAliasMailbox(
  inbox: InboxRow,
  alias: CanonicalFolderAlias,
  opts: { createIfMissing?: boolean } = {},
): Promise<string | null> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  if (alias.aliases[0] === "inbox") return "INBOX";

  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    const mailboxes = await client.listMailboxes();
    const matched = matchImapAliasMailbox(mailboxes, alias);
    if (matched) return matched;

    if (opts.createIfMissing) {
      await client.createMailbox(alias.imap);
      return alias.imap;
    }
    return null;
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Maps MCPEmails canonical folder names to Microsoft Graph well-known
 * folder names. Unknown names are passed through as displayName filters.
 * Derives from CANONICAL_FOLDER_ALIASES (single source of truth).
 */
function outlookWellKnownFolder(folder: string): string {
  return lookupCanonicalAlias(folder)?.outlook ?? folder;
}

interface OutlookMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  /** Populated by contact_search's $select; absent on email_list responses. */
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
}

/**
 * Implements `email_list` for Outlook using Microsoft Graph.
 *
 * Single API call returns all required fields including the attachment flag.
 * Graph's `$count=true` is used to get an accurate total message count.
 */
async function listOutlookMessages(
  inbox: InboxRow,
  folder: string,
  limit: number,
  offset: number,
  unreadOnly: boolean,
): Promise<ListInboxResult> {
  const accessToken = await withFreshOutlookToken(inbox);
  const folderName = outlookWellKnownFolder(folder);

  const params = new URLSearchParams({
    $select:
      "id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments",
    $top: String(limit),
    $skip: String(offset),
    $orderby: "receivedDateTime desc",
    $count: "true",
  });
  if (unreadOnly) params.set("$filter", "isRead eq false");

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${folderName}/messages?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ConsistencyLevel: "eventual",
      },
    },
  );

  if (!resp.ok) {
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    const errBody = (await resp.json()) as { error?: { message?: string } };
    throw new Error(
      `Outlook Graph API error: ${errBody.error?.message ?? resp.statusText}`,
    );
  }

  const data = (await resp.json()) as {
    value?: OutlookMessage[];
    "@odata.count"?: number;
    "@odata.nextLink"?: string;
  };

  const rawMessages = data.value ?? [];
  // `$count=true` (with ConsistencyLevel: eventual) yields an exact count.
  // When Graph omits it, report `null` (unknown) rather than fabricate one.
  const total = data["@odata.count"] ?? null;
  const hasMore = !!data["@odata.nextLink"];

  const messages: EmailSummary[] = rawMessages.map((msg) => ({
    id: msg.id,
    from: {
      name: msg.from?.emailAddress?.name ?? "",
      email: msg.from?.emailAddress?.address ?? "",
    },
    to: (msg.toRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    subject: msg.subject ?? "(no subject)",
    date: msg.receivedDateTime ?? new Date().toISOString(),
    preview: normalizePreview(msg.bodyPreview ?? ""),
    is_read: msg.isRead ?? true,
    has_attachments: msg.hasAttachments ?? false,
    folder,
    thread_id: msg.conversationId ?? msg.id,
  }));

  // `@odata.count` is exact when present, null otherwise — never an estimate.
  return { messages, total, total_is_estimate: false, has_more: hasMore, next_offset: offset + limit };
}

// ---------------------------------------------------------------------------
// Fastmail provider — email_list (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `email_list` for Fastmail using JMAP (RFC 8620/8621).
 *
 * JMAP is Fastmail's native HTTP protocol and is preferred over raw IMAP in
 * Edge Function contexts because it is purely HTTP-based. Fastmail supports
 * both Bearer token auth (OAuth connections) and HTTP Basic auth (app-password
 * connections where `imap_password` holds an encrypted app-specific password).
 *
 * Flow:
 *   1. GET  /jmap/session → discover accountId and apiUrl.
 *   2. POST to apiUrl     → Mailbox/query + Email/query + Email/get in one batch.
 *      The three method calls are linked via JMAP result references so only one
 *      HTTP round-trip is needed after session discovery.
 */
async function listFastmailMessages(
  inbox: InboxRow,
  folder: string,
  limit: number,
  offset: number,
  unreadOnly: boolean,
): Promise<ListInboxResult> {
  // Build auth header based on connection type.
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Step 1: Discover JMAP session.
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }

  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };

  const accountId =
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl =
    session.apiUrl ?? "https://api.fastmail.com/jmap/api/";

  if (!accountId) {
    throw new Error(
      "Fastmail JMAP: could not determine accountId from session.",
    );
  }

  // Map folder name to a JMAP mailbox role (for standard folders) or a
  // display-name filter (for custom labels).
  const JMAP_ROLE_MAP: Record<string, string> = {
    INBOX: "inbox",
    SENT: "sent",
    DRAFTS: "drafts",
    DRAFT: "drafts",
    TRASH: "trash",
    SPAM: "junk",
    JUNK: "junk",
    ARCHIVE: "archive",
  };
  const mailboxRole = JMAP_ROLE_MAP[folder.toUpperCase()];

  // Step 2: Single JMAP batch with three linked method calls.
  const jmapBody = {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
    ],
    methodCalls: [
      // a) Find the mailbox ID matching the requested folder.
      [
        "Mailbox/query",
        {
          accountId,
          filter: mailboxRole ? { role: mailboxRole } : { name: folder },
          limit: 1,
        },
        "a",
      ],
      // b) Query email IDs in that mailbox, newest first.
      [
        "Email/query",
        {
          accountId,
          filter: {
            ...(unreadOnly ? { notKeyword: "$seen" } : {}),
            "#inMailbox": {
              resultOf: "a",
              name: "Mailbox/query",
              path: "/ids/0",
            },
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          position: offset,
          limit,
          calculateTotal: true,
        },
        "b",
      ],
      // c) Fetch email metadata for the page of IDs from step b.
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "b",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id",
            "threadId",
            "subject",
            "from",
            "to",
            "receivedAt",
            "preview",
            "keywords",
            "hasAttachment",
          ],
        },
        "c",
      ],
    ],
  };

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jmapBody),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP error: ${apiResp.statusText}`);
  }

  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const responses = apiData.methodResponses ?? [];
  const queryResp = responses.find(([n]) => n === "Email/query");
  const getResp = responses.find(([n]) => n === "Email/get");

  if (!queryResp || !getResp) {
    throw new Error(
      "Fastmail JMAP returned unexpected response structure.",
    );
  }

  const queryResult = queryResp[1] as { total?: number };
  const getResult = getResp[1] as {
    list?: {
      id: string;
      threadId?: string;
      subject?: string;
      from?: { name?: string; email?: string }[];
      to?: { name?: string; email?: string }[];
      receivedAt?: string;
      preview?: string;
      keywords?: Record<string, boolean>;
      hasAttachment?: boolean;
    }[];
  };

  const total = queryResult.total ?? 0;
  const emailList = getResult.list ?? [];
  const hasMore = offset + limit < total;

  const messages: EmailSummary[] = emailList.map((email) => ({
    id: email.id,
    from: email.from?.[0]
      ? { name: email.from[0].name ?? "", email: email.from[0].email ?? "" }
      : { name: "", email: "" },
    to: (email.to ?? []).map((r) => ({
      name: r.name ?? "",
      email: r.email ?? "",
    })),
    subject: email.subject ?? "(no subject)",
    date: email.receivedAt ?? new Date().toISOString(),
    preview: normalizePreview(email.preview ?? ""),
    is_read: !!(email.keywords?.["$seen"]),
    has_attachments: email.hasAttachment ?? false,
    folder,
    thread_id: email.threadId ?? email.id,
  }));

  // JMAP Email/query returns an exact total — never an estimate.
  return { messages, total, total_is_estimate: false, has_more: hasMore, next_offset: offset + limit };
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — shared helpers (iCloud, Yahoo, Zoho, Yandex, generic)
// ---------------------------------------------------------------------------

/**
 * IMAP UIDs are unique only within a mailbox, so the message id exposed to MCP
 * clients encodes the folder: "<folder>:<uid>". email_read/email_reply decode
 * it to know which mailbox to SELECT. A bare numeric id is treated as INBOX.
 */
function encodeImapId(folder: string, uid: number): string {
  return `${folder}:${uid}`;
}

function decodeImapId(id: string): { folder: string; uid: number } {
  const idx = id.lastIndexOf(":");
  if (idx === -1) return { folder: "INBOX", uid: Number(id) };
  return { folder: id.slice(0, idx), uid: Number(id.slice(idx + 1)) };
}

/** Strip surrounding angle brackets from a Message-ID header value. */
function stripAngleBrackets(s: string): string {
  return s.replace(/^<|>$/g, "").trim();
}

/** Convert an RFC 5322 date header to ISO 8601; fall back to now on parse failure. */
function imapDateToIso(raw: string | null): string {
  if (!raw) return new Date().toISOString();
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** Base64-encode raw bytes (standard, not URL-safe), chunked to avoid call-stack limits. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode a standard (not URL-safe) base64 string to a UTF-8 string. */
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Per-attachment inclusion budget (bytes). Larger attachments return data: null. */
const ATTACHMENT_DATA_BUDGET = 10 * 1024 * 1024;

/**
 * Per-file size ceiling for the BULK include_attachments path. Any attachment
 * larger than this is listed (metadata only, data:null) rather than encoded, so
 * a heavy message can never base64-encode several megabytes at once and OOM the
 * shared isolate. Large files are fetched one at a time via the single-file
 * download path (email_read action: attachment), which has its own 25 MB cap and
 * encodes exactly one file. Does NOT apply when a specific attachment is selected
 * (select_only_index) — that path is already bounded to one file.
 */
const BULK_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Generic IMAP provider — email_list
// ---------------------------------------------------------------------------

/**
 * Maps MCPEmails canonical folder names to common IMAP folder names.
 * Unknown values are passed through unchanged. Folder naming varies by provider
 * (e.g. iCloud uses "Sent Messages"); INBOX is universal.
 */
function imapFolderName(folder: string): string {
  return lookupCanonicalAlias(folder)?.imap ?? folder;
}

/**
 * Decode RFC 2047 MIME encoded-words in an envelope subject. The IMAP ENVELOPE
 * is returned verbatim by the server (e.g. "=?UTF-8?Q?...?="); `email_read`
 * decodes its headers via decodeEncodedWords, so the list/search summary path
 * must do the same for parity (otherwise non-ASCII subjects show as gibberish).
 */
function decodeEnvelopeSubject(subject: string): string {
  return decodeEncodedWords(subject);
}

/**
 * Decode RFC 2047 MIME encoded-words in an address display name, preserving the
 * email. The IMAP ENVELOPE personal-name field arrives encoded the same way as
 * the Subject header.
 */
function decodeEnvelopeAddress(
  addr: { name: string; email: string },
): { name: string; email: string } {
  return { name: decodeEncodedWords(addr.name), email: addr.email };
}

/**
 * Implements `email_list` for IMAP inboxes connected with an app password.
 *
 * Opens a TLS IMAP session, selects the folder, UID-searches (ALL or UNSEEN),
 * takes the newest `limit` UIDs at `offset`, and fetches ENVELOPE + FLAGS +
 * BODYSTRUCTURE. Body preview is not fetched during listing (deferred to
 * email_read), so `preview` is empty here.
 *
 * Throws "imap_auth_failed" on credential rejection so the dispatcher can emit
 * a reconnect prompt.
 */
async function listImapMessages(
  inbox: InboxRow,
  folder: string,
  limit: number,
  offset: number,
  unreadOnly: boolean,
): Promise<ListInboxResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });

    await client.selectMailbox(imapFolderName(folder));

    const allUids = await client.uidSearch(unreadOnly ? "UNSEEN" : "ALL");
    const total = allUids.length;

    // Newest first: highest UID first.
    const ordered = allUids.slice().sort((a, b) => b - a);
    const pageUids = ordered.slice(offset, offset + limit);

    const summaries = await client.fetchSummaries(pageUids);
    // Preserve newest-first ordering (FETCH may return any order).
    const byUid = new Map(summaries.map((s) => [s.uid, s]));

    const messages: EmailSummary[] = [];
    for (const uid of pageUids) {
      const s = byUid.get(uid);
      if (!s) continue;
      messages.push({
        id: encodeImapId(folder, s.uid),
        from: decodeEnvelopeAddress(s.envelope.from[0] ?? { name: "", email: "" }),
        to: s.envelope.to.map(decodeEnvelopeAddress),
        subject: decodeEnvelopeSubject(s.envelope.subject),
        date: s.envelope.date,
        preview: s.preview,
        is_read: s.flags.includes("\\Seen"),
        has_attachments: s.hasAttachments,
        folder,
        thread_id: String(s.uid),
      });
    }

    return {
      messages,
      total,
      // IMAP reports an exact mailbox/search count, never an estimate.
      total_is_estimate: false,
      has_more: offset + limit < total,
      next_offset: offset + limit,
    };
  } catch (err) {
    if (err instanceof ImapAuthError) {
      throw new Error("imap_auth_failed");
    }
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — email_read
// ---------------------------------------------------------------------------

/**
 * Implements `email_read` for IMAP inboxes. The message id is "<folder>:<uid>"
 * (see encodeImapId); the folder is SELECTed and the full RFC 822 message is
 * fetched and parsed via mime.ts.
 *
 * Throws "message_not_found" for a bad id/UID and "imap_auth_failed" on
 * credential rejection.
 */
async function readImapMessage(
  inbox: InboxRow,
  messageId: string,
  includeHtml: boolean,
  includeAttachments: boolean,
  markAsRead: boolean,
  attachmentBudgetBytes: number = ATTACHMENT_DATA_BUDGET,
  selectOnlyIndex?: number,
): Promise<ReadEmailResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error("message_not_found");
  }
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));

    const msg = await client.fetchMessageRaw(uid);
    if (!msg) throw new Error("message_not_found");

    const parsed = parseEmail(msg.raw);
    const h = parsed.headers;

    const subject = decodeEncodedWords(getHeader(h, "subject") ?? "(no subject)");
    const from = parseEmailAddress(decodeEncodedWords(getHeader(h, "from") ?? ""));
    const to = parseAddressList(decodeEncodedWords(getHeader(h, "to") ?? ""));
    const cc = parseAddressList(decodeEncodedWords(getHeader(h, "cc") ?? ""));
    const bcc = parseAddressList(decodeEncodedWords(getHeader(h, "bcc") ?? ""));
    const replyToList = parseAddressList(decodeEncodedWords(getHeader(h, "reply-to") ?? ""));
    const inReplyToHeader = getHeader(h, "in-reply-to");
    const referencesHeader = getHeader(h, "references") ?? "";

    if (markAsRead && !msg.flags.includes("\\Seen")) {
      await client.markSeen(uid);
    }

    // IMAP parses the whole message locally, so the budget is applied per
    // attachment. On the bulk path the per-file cap is clamped to 2 MB so a heavy
    // message never base64-encodes several MB at once (OOM); the single-file path
    // (selectOnlyIndex set) encodes ONLY that attachment up to its 25 MB cap.
    const perFileCap = selectOnlyIndex === undefined
      ? Math.min(attachmentBudgetBytes, BULK_ATTACHMENT_MAX_BYTES)
      : attachmentBudgetBytes;
    const attachments: ReadEmailAttachmentMeta[] = parsed.attachments.map((a, i) => ({
      filename: a.filename,
      mime_type: a.mimeType,
      size_bytes: a.size,
      data: includeAttachments &&
          (selectOnlyIndex === undefined || i === selectOnlyIndex) &&
          a.size <= perFileCap
        ? bytesToBase64(a.content)
        : null,
    }));

    return {
      id: messageId,
      thread_id: String(uid),
      from,
      to,
      cc,
      bcc,
      reply_to: replyToList[0] ?? null,
      subject,
      date: imapDateToIso(getHeader(h, "date")),
      body_text: parsed.text ?? (parsed.html ? stripHtmlToText(parsed.html) : null),
      body_html: includeHtml && parsed.html ? sanitizeEmailHtml(parsed.html) : null,
      attachments,
      is_read: markAsRead ? true : msg.flags.includes("\\Seen"),
      labels: [],
      in_reply_to: inReplyToHeader ? stripAngleBrackets(inReplyToHeader) : null,
      references: referencesHeader
        .split(/\s+/)
        .map(stripAngleBrackets)
        .filter(Boolean),
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — email_search
// ---------------------------------------------------------------------------

/**
 * Implements `email_search` for IMAP inboxes using IMAP SEARCH TEXT (matches
 * headers + body). IMAP SEARCH is single-mailbox, so when includeFolders is
 * empty this fans out across every selectable mailbox on the account (per the
 * tool's documented "empty array searches all folders" default) instead of
 * silently scanning INBOX alone. Newest first across the merged set; no
 * relevance score.
 */
async function searchImapMessages(
  inbox: InboxRow,
  search: NormalizedSearch,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });

    // `folders` holds names ready to pass straight to selectMailbox. Explicit
    // includeFolders entries are user/agent-supplied tokens (e.g. "sent",
    // "archive") and still need imapFolderName's canonical-alias mapping;
    // auto-discovered names come verbatim from LIST and are already real
    // mailbox names, so mapping them again would corrupt ones that happen to
    // collide with an alias token (e.g. a server's real "Spam" mailbox getting
    // remapped to the alias's generic "Junk", which doesn't exist there).
    let folders: string[];
    if (includeFolders.length > 0) {
      folders = includeFolders.map(imapFolderName);
    } else {
      const mailboxes = await client.listMailboxes();
      // \Noselect mailboxes (pure hierarchy nodes) can't be SELECTed/SEARCHed.
      const selectable = mailboxes.filter(
        (mb) => !mb.flags.some((f) => f.toLowerCase() === "\\noselect"),
      );
      // Cap the number of mailboxes fanned out to bound worst-case latency on
      // accounts with an unusually large folder tree; mirrors the count-enrichment
      // cap in imapListFolders. Every folder is still reachable via include_folders.
      const IMAP_SEARCH_FOLDER_CAP = 25;
      folders = selectable.slice(0, IMAP_SEARCH_FOLDER_CAP).map((mb) => mb.name);
      if (folders.length === 0) folders = ["INBOX"];
    }

    // Translate the normalized search into RFC 3501 SEARCH criteria. The
    // translator quotes/escapes string operands; "ALL" is a valid match-all.
    // SECURITY: strip CR/LF and other control chars from the final criteria
    // string before interpolating it into the raw `UID SEARCH …` command line —
    // otherwise CRLF (e.g. via the `raw` escape hatch) would break out and
    // inject arbitrary IMAP commands.
    // deno-lint-ignore no-control-regex
    const criteria = toImapSearch(search).replace(/[\x00-\x1F\x7F]+/g, " ");

    // IMAP UID SEARCH returns matches in ascending UID order, and UID is only a
    // rough proxy for arrival order — re-filed/migrated/redelivered messages can
    // carry a UID that doesn't match their Date header. Sorting by UID alone
    // (the old behaviour) could push a genuinely recent message past the page
    // window and surface an older same-subject match instead. To return true
    // newest-first results, fetch envelopes and sort by the actual message date
    // before paginating. Bound the work to the highest-UID CANDIDATE_CAP matches
    // per folder (UID-desc is a good first-pass recency filter) so a huge match
    // set doesn't fetch unbounded envelopes; within that pool ordering is exact
    // by date.
    const CANDIDATE_CAP = Math.max(offset + limit, 200);

    let total = 0;
    const candidates: Array<{ folder: string; summary: ImapMessageSummary }> = [];
    for (const folder of folders) {
      await client.selectMailbox(folder);
      const allUids = await client.uidSearch(criteria);
      total += allUids.length;
      const candidateUids = allUids
        .slice()
        .sort((a, b) => b - a)
        .slice(0, CANDIDATE_CAP);
      const summaries = await client.fetchSummaries(candidateUids);
      for (const summary of summaries) candidates.push({ folder, summary });
    }

    // Sort by envelope date descending; messages with an unparseable/absent date
    // sort last, tie-broken by UID descending (newest arrival first).
    const sorted = candidates.slice().sort((a, b) => {
      const da = Date.parse(a.summary.envelope.date ?? "");
      const db = Date.parse(b.summary.envelope.date ?? "");
      const va = Number.isFinite(da) ? da : -Infinity;
      const vb = Number.isFinite(db) ? db : -Infinity;
      if (vb !== va) return vb - va;
      return b.summary.uid - a.summary.uid;
    });
    const page = sorted.slice(offset, offset + limit);

    const messages: SearchEmailSummary[] = page.map(({ folder, summary: s }) => ({
      id: encodeImapId(folder, s.uid),
      from: decodeEnvelopeAddress(s.envelope.from[0] ?? { name: "", email: "" }),
      to: s.envelope.to.map(decodeEnvelopeAddress),
      subject: decodeEnvelopeSubject(s.envelope.subject),
      date: s.envelope.date,
      preview: s.preview,
      is_read: s.flags.includes("\\Seen"),
      has_attachments: s.hasAttachments,
      folder,
      thread_id: String(s.uid),
      relevance_score: null,
    }));

    return {
      messages,
      total,
      // IMAP UID SEARCH returns the full matching set for every folder scanned,
      // so total is exact (not just the CANDIDATE_CAP-bounded envelope pool).
      total_is_estimate: false,
      has_more: offset + limit < total,
      next_offset: offset + limit,
      query_normalized: criteria,
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — email_send / email_reply (SMTP)
// ---------------------------------------------------------------------------

/**
 * Submit a pre-built RFC 822 message via the inbox's SMTP server using the
 * stored app password. Implicit TLS on 465; STARTTLS is inferred for port 587.
 * Maps SMTP auth failure to the "imap_auth_failed" sentinel.
 */
async function imapSmtpSend(
  inbox: InboxRow,
  mimeMessage: string,
  recipients: string[],
): Promise<void> {
  if (!inbox.smtp_host || !inbox.smtp_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  const security = inbox.smtp_port === 587 ? "starttls" : "tls";
  try {
    await sendViaSmtp(
      {
        host: inbox.smtp_host,
        port: inbox.smtp_port,
        security,
        email: imapAuthUser(inbox),
        password,
      },
      { from: inbox.email_address, recipients, rawMessage: mimeMessage },
    );
  } catch (err) {
    if (err instanceof SmtpAuthError) throw new Error("imap_auth_failed");
    throw err;
  }
}

/** Common names for the Sent mailbox across IMAP providers, tried in order. */
const SENT_FOLDER_CANDIDATES = ["Sent", "Sent Messages", "Sent Items", "INBOX.Sent"];

/**
 * Best-effort: file a copy of an outgoing message in the Sent folder via IMAP
 * APPEND. SMTP submission does not do this automatically (unlike the Gmail /
 * Graph / JMAP send APIs). Never throws — a failed Sent copy must not fail the
 * send itself.
 */
async function appendToSentFolder(inbox: InboxRow, mimeMessage: string): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) return;
  let client: ImapClient | null = null;
  try {
    const password = await decryptStoredToken(inbox.imap_password);
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    for (const mbox of SENT_FOLDER_CANDIDATES) {
      try {
        if (await client.append(mbox, mimeMessage)) break;
      } catch {
        // Try the next candidate folder name.
      }
    }
  } catch (err) {
    console.warn("[mcp-server] imap_sent_append_failed", {
      inbox_id: inbox.id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/** Implements `email_send` for IMAP inboxes via SMTP submission. */
async function sendImapMessage(
  inbox: InboxRow,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const messageId = crypto.randomUUID();
  const mime = buildMimeMessage({
    from: inbox.display_name
      ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
      : inbox.email_address,
    to: params.to,
    cc: params.cc.length ? params.cc : undefined,
    subject: params.subject,
    textBody: params.textBody,
    htmlBody: params.htmlBody,
    attachments: params.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      data: a.data,
    })),
    replyTo: params.replyTo,
    messageId,
  });

  const recipients = [...params.to, ...params.cc, ...params.bcc]
    .map((e) => parseEmailAddress(e).email)
    .filter(Boolean);
  await imapSmtpSend(inbox, mime, recipients);
  await appendToSentFolder(inbox, mime);

  const fullId = `<${messageId}@mcpemails.com>`;
  return {
    message_id: fullId,
    thread_id: fullId,
    sent_at: new Date().toISOString(),
    to: params.to.map((e) => parseEmailAddress(e)),
    cc: params.cc.map((e) => parseEmailAddress(e)),
    bcc: params.bcc.map((e) => parseEmailAddress(e)),
    subject: params.subject,
    status: "sent",
  };
}

/** Implements `email_reply` for IMAP inboxes: read original, then SMTP send. */
async function replyImapMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ReplyToEmailParams,
): Promise<ReplyToEmailResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  // Place the signature into the new reply text BEFORE the original is quoted
  // below (buildReplyTextBody appends the quote after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const { folder, uid } = decodeImapId(originalMessageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");
  const password = await decryptStoredToken(inbox.imap_password);

  // Read the original message for threading headers + recipients.
  let original: ReturnType<typeof parseEmail> | null = null;
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    const msg = await client.fetchMessageRaw(uid);
    if (!msg) throw new Error("message_not_found");
    original = parseEmail(msg.raw);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }

  if (!original) throw new Error("message_not_found");
  const h = original.headers;
  const origMessageId = getHeader(h, "message-id") ?? "";
  const origReferences = getHeader(h, "references") ?? "";
  const origSubject = decodeEncodedWords(getHeader(h, "subject") ?? "(no subject)");
  const replySubject = /^re:/i.test(origSubject.trim()) ? origSubject : `Re: ${origSubject}`;
  const origFromHeader = decodeEncodedWords(getHeader(h, "from") ?? "");
  const origDateHeader = getHeader(h, "date") ?? "";
  const origBodyText = original.text ?? (original.html ? stripHtmlToText(original.html) : "");

  const fromAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "from") ?? ""));
  const toAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "to") ?? ""));
  const ccAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "cc") ?? ""));

  const self = inbox.email_address.toLowerCase();
  let recipients: EmailAddressEntry[];
  if (params.replyAll) {
    const seen = new Set<string>();
    recipients = [];
    for (const a of [...fromAddrs, ...toAddrs, ...ccAddrs]) {
      const key = a.email.toLowerCase();
      if (!a.email || key === self || seen.has(key)) continue;
      seen.add(key);
      recipients.push(a);
    }
    recipients = recipients.slice(0, 50);
  } else {
    recipients = fromAddrs.slice(0, 1);
  }

  if (recipients.length === 0) {
    throw new Error(
      "email_reply: could not determine reply recipients from original message.",
    );
  }

  const references = [origReferences, origMessageId].filter(Boolean).join(" ").trim();
  const messageId = crypto.randomUUID();
  const toStrings = recipients.map((a) =>
    a.name ? `${encodeMimeHeaderValue(a.name)} <${a.email}>` : a.email
  );

  const mime = buildMimeMessage({
    from: inbox.display_name
      ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
      : inbox.email_address,
    to: toStrings,
    subject: replySubject,
    textBody: buildReplyTextBody(
      params.body,
      origFromHeader,
      origDateHeader,
      origBodyText,
    ),
    htmlBody: params.htmlBody,
    attachments: params.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      data: a.data,
    })),
    messageId,
    inReplyTo: origMessageId || undefined,
    references: references || undefined,
  });

  await imapSmtpSend(inbox, mime, recipients.map((a) => a.email));
  await appendToSentFolder(inbox, mime);

  return {
    message_id: `<${messageId}@mcpemails.com>`,
    thread_id: String(uid),
    sent_at: new Date().toISOString(),
    in_reply_to: origMessageId,
    to: recipients,
    subject: replySubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_list — top-level handler
// ---------------------------------------------------------------------------

interface ListInboxArgs {
  inbox_id: string;
  limit?: number;
  offset?: number;
  folder?: string;
  unread_only?: boolean;
}

/**
 * Executes the `email_list` tool end-to-end.
 *
 * Returns the JSON-RPC result object plus the values needed for activity
 * logging. Never throws — all errors are captured and returned as
 * structured tool execution errors (`isError: true`).
 */
async function executeListInbox(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_list: arguments must be an object with at least inbox_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const limit = Math.min(
    Math.max(
      1,
      typeof args["limit"] === "number" ? Math.floor(args["limit"]) : 20,
    ),
    100,
  );
  const offset = Math.max(
    0,
    typeof args["offset"] === "number" ? Math.floor(args["offset"]) : 0,
  );
  const folder =
    typeof args["folder"] === "string" ? args["folder"] : "INBOX";
  const unreadOnly = args["unread_only"] === true;

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_list");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch ─────────────────────────────────────────────────────
  let listResult: ListInboxResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        listResult = await listGmailMessages(
          inbox,
          folder,
          limit,
          offset,
          unreadOnly,
        );
        break;
      case "outlook":
        listResult = await listOutlookMessages(
          inbox,
          folder,
          limit,
          offset,
          unreadOnly,
        );
        break;
      case "fastmail":
        listResult = await listFastmailMessages(
          inbox,
          folder,
          limit,
          offset,
          unreadOnly,
        );
        break;
      case "imap":
        listResult = await listImapMessages(
          inbox,
          folder,
          limit,
          offset,
          unreadOnly,
        );
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_list. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }

    console.error("[mcp-server] email_list: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });

    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error while listing inbox: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── Success ───────────────────────────────────────────────────────────────
  return {
    result: { ...jsonOk(listResult as unknown as Record<string, unknown>), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// HTML sanitization — Deno-compatible (no jsdom/DOMPurify)
// ---------------------------------------------------------------------------

/**
 * Strips dangerous HTML from an email body before returning it to MCP clients.
 *
 * Implements a defence-in-depth regex approach suitable for Deno Edge Functions
 * where jsdom and isomorphic-dompurify are unavailable. Removes:
 *   - <script>, <style>, <link>, <meta>, <iframe>, <object>, <embed> and
 *     their full content (including content between open/close tags)
 *   - All event-handler attributes (on*=...)
 *   - External src attributes (keeps data: URIs for inline images)
 *   - javascript: href values
 *   - <input>, <button>, <textarea>, <select> form elements
 *
 * This is intentionally conservative — false positives (stripping harmless
 * content) are preferred over false negatives (leaving XSS vectors). The
 * output is safe to embed in an LLM context but should not be rendered
 * directly in a user-facing browser without an additional pass through a
 * DOM-based sanitizer.
 */

/**
 * Convert an HTML body to readable plain text: drop <style>/<script> blocks and
 * all tags, decode common entities, and collapse whitespace. Used as the
 * `body_text` fallback for HTML-only messages so an agent reading `body_text`
 * always gets the content (e.g. OTP codes) without needing `include_html`.
 */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeEmailHtml(html: string): string {
  let result = html;

  // Remove dangerous block elements and their full content.
  // The inner [\s\S]*? is non-greedy to avoid stripping too much in edge cases
  // where two script tags appear on the same line.
  for (const tag of [
    "script",
    "style",
    "link",
    "meta",
    "iframe",
    "object",
    "embed",
    "base",
    "form",
    "noscript",
  ]) {
    // Paired open+content+close: <tag ...>...</tag>
    result = result.replace(
      new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"),
      "",
    );
    // Self-closing variants: <tag ... />
    result = result.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
    // Orphaned opening tags (content already removed or tag was standalone):
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  }

  // Remove all event-handler attributes: onclick="...", onload='...', onerror=foo
  result = result.replace(
    /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );

  // Remove src attributes pointing to external URLs.
  // data: URIs are allowed (inline images); http/https/ftp/etc. are stripped.
  result = result.replace(
    /\s+src\s*=\s*(?:"https?:[^"]*"|'https?:[^']*'|"ftp:[^"]*"|'ftp:[^']*')/gi,
    "",
  );

  // Remove href="javascript:..." and href='javascript:...'
  result = result.replace(
    /\s+href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi,
    "",
  );

  // Remove interactive form elements to prevent UX-level injection.
  result = result.replace(
    /<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi,
    "",
  );

  return result;
}

/**
 * Sanitize per-inbox SIGNATURE HTML (defense-in-depth for the MCP `signature`
 * tool path and the send-time injection). Mirrors sanitizeEmailHtml's regex
 * structure but is signature-tuned:
 *
 *   - Strips script/style/iframe/object/embed/form/svg blocks, base/meta/link,
 *     all on*= event handlers, and javascript: URLs.
 *   - UNLIKE sanitizeEmailHtml, it PRESERVES external `https:` image `src`
 *     (hosted logos are the whole point of rich signatures), while still
 *     removing non-https img src (http:, data:, ftp:) as an XSS / plaintext
 *     leak guard.
 *
 * The authoritative signature sanitizer is the web app's DOMPurify-based
 * sanitizeSignatureHtml (apps/web/src/lib/sanitizeSignatureHtml.js) run on
 * save; this Deno pass is a belt-and-suspenders layer so anything written via
 * the MCP tool or already sitting in the DB is scrubbed before it ships in
 * outgoing mail. Idempotent: re-running on already-clean HTML is a no-op.
 *
 * PURE: no I/O.
 */
function sanitizeSignatureHtml(html: string): string {
  if (!html) return html;
  let result = html;

  // Remove dangerous block elements and their full content.
  for (const tag of [
    "script",
    "style",
    "link",
    "meta",
    "iframe",
    "object",
    "embed",
    "base",
    "form",
    "noscript",
    "svg",
    "math",
  ]) {
    // Paired open+content+close: <tag ...>...</tag>
    result = result.replace(
      new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "gi"),
      "",
    );
    // Self-closing variants: <tag ... />
    result = result.replace(new RegExp(`<${tag}[^>]*/>`, "gi"), "");
    // Orphaned opening/standalone tags:
    result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  }

  // Remove all event-handler attributes: onclick="...", onload='...', onerror=x
  result = result.replace(
    /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );

  // Remove href/src="javascript:..." (any quoting).
  result = result.replace(
    /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    "",
  );

  // Drop non-https image sources. https: img src is intentionally KEPT (hosted
  // logos); http:, data:, ftp: and other schemes are removed.
  result = result.replace(
    /\s+src\s*=\s*(?:"(?:http|ftp|data):[^"]*"|'(?:http|ftp|data):[^']*'|(?:http|ftp|data):[^\s>]+)/gi,
    "",
  );

  // Remove interactive form elements.
  result = result.replace(
    /<(input|button|textarea|select)[^>]*(?:\/?>|>[\s\S]*?<\/\1>)/gi,
    "",
  );

  return result;
}

// ---------------------------------------------------------------------------
// email_read — shared output types
// ---------------------------------------------------------------------------

interface ReadEmailAttachmentMeta {
  /**
   * Zero-based position of this attachment in the message. Stamped centrally by
   * readOneMessage so it is always present in tool output. Pass it as
   * `attachment_index` to email_read (action: attachment) to download just this
   * one file instead of pulling every attachment with include_attachments.
   * Optional on the type only because the per-provider readers build the array
   * before the index is assigned.
   */
  attachment_index?: number;
  /** Sanitised filename. */
  filename: string;
  /** MIME type string. */
  mime_type: string;
  /** Decoded byte size. */
  size_bytes: number;
  /**
   * Base64-encoded binary content.
   * Only populated when `include_attachments: true` was requested and
   * the attachment's byte count is within the 10 MB per-call budget. When null,
   * download the file on its own via email_read (action: attachment) using
   * `attachment_index` — this avoids fetching the other attachments.
   */
  data: string | null;
  /**
   * Set only on a bulk include_attachments read when this file's bytes were
   * deliberately omitted (too large for bulk, or over the per-call budget),
   * telling the agent how to retrieve it. Absent when data is present.
   */
  note?: string;
}

interface ReadEmailResult {
  id: string;
  thread_id: string;
  from: EmailAddressEntry;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  bcc: EmailAddressEntry[];
  reply_to: EmailAddressEntry | null;
  subject: string;
  /** ISO 8601 UTC timestamp. */
  date: string;
  /** Decoded, UTF-8-normalised plain-text body. */
  body_text: string | null;
  /**
   * Sanitised HTML body. null unless `include_html: true` was requested.
   */
  body_html: string | null;
  /**
   * Attachment metadata, always listed when the message has attachments
   * (regardless of `include_attachments`). Each entry carries an
   * `attachment_index`, `filename`, `mime_type` and `size_bytes`; the base64
   * `data` field is populated only when `include_attachments: true` and the
   * file fits the per-call budget. To get one file's bytes without downloading
   * the rest, call email_read (action: attachment) with its `attachment_index`.
   */
  attachments: ReadEmailAttachmentMeta[];
  /** True when the message is marked read (may reflect `mark_as_read` effect). */
  is_read: boolean;
  /** Provider-native labels / categories (Gmail labels, Outlook categories). */
  labels: string[];
  /** Message-ID of the parent message if this is a reply. */
  in_reply_to: string | null;
  /** Full References header chain. */
  references: string[];
}

// ---------------------------------------------------------------------------
// Gmail provider — email_read
// ---------------------------------------------------------------------------

/**
 * Single MIME part as returned by Gmail's `format=full` API response.
 * All fields are optional because Gmail may omit them for simple messages.
 */
interface GmailFullPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: {
    size?: number;
    /** Base64url-encoded part content. Present when part is a leaf. */
    data?: string;
    /** Attachment ID for fetching large attachments separately. */
    attachmentId?: string;
  };
  parts?: GmailFullPart[];
}

interface GmailFullMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailFullPart;
}

/**
 * Decode a base64url string to a UTF-8 string.
 * Gmail encodes body data as base64url.
 */
function base64urlToUtf8(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binaryStr = atob(padded);
  // Re-interpret binary as UTF-8 bytes.
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Decode a base64url string to a raw base64 string (for attachment data).
 * Converts base64url → standard base64 without decoding to text.
 */
function base64urlToBase64(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
}

/**
 * Intermediate attachment record during MIME tree traversal.
 * Carries the Gmail attachment ID needed to fetch content separately.
 */
interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Inline body data (base64url) — present for small attachments. */
  inlineData: string | null;
  /** Attachment ID for fetching via the Gmail Attachments API. */
  attachmentId: string | null;
}

/**
 * Recursively walk a Gmail MIME payload tree to extract text/plain, text/html,
 * and attachment metadata.
 *
 * Gmail nests MIME parts as a tree. The top-level mimeType may be:
 *   - text/plain or text/html (simple single-part message)
 *   - multipart/alternative (plain + html variants)
 *   - multipart/mixed (body + attachments)
 *   - multipart/related (body + inline images)
 * Each case is handled by recursion; the first encountered text/plain and
 * text/html wins (they are usually encountered depth-first, alternatives first).
 */
function walkGmailPayload(part: GmailFullPart): {
  textPlain: string | null;
  textHtml: string | null;
  attachments: GmailAttachmentRef[];
} {
  const out: {
    textPlain: string | null;
    textHtml: string | null;
    attachments: GmailAttachmentRef[];
  } = { textPlain: null, textHtml: null, attachments: [] };

  const isAttachment =
    typeof part.filename === "string" && part.filename.length > 0;

  if (!isAttachment) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      out.textPlain = base64urlToUtf8(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      out.textHtml = base64urlToUtf8(part.body.data);
    }
  } else {
    // Attachment: record metadata; data is fetched separately if requested.
    out.attachments.push({
      filename: part.filename as string,
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size ?? 0,
      inlineData: part.body?.data ?? null,
      attachmentId: part.body?.attachmentId ?? null,
    });
  }

  // Recurse into sub-parts.
  for (const subPart of part.parts ?? []) {
    const sub = walkGmailPayload(subPart);
    if (sub.textPlain && !out.textPlain) out.textPlain = sub.textPlain;
    if (sub.textHtml && !out.textHtml) out.textHtml = sub.textHtml;
    out.attachments.push(...sub.attachments);
  }

  return out;
}

/**
 * Implements `email_read` for Gmail.
 *
 * Flow:
 *   1. GET /users/me/messages/{id}?format=full → full MIME payload
 *   2. Walk payload to extract text/plain, text/html, and attachment refs
 *   3. If include_attachments: fetch each attachment's content in parallel
 *   4. If mark_as_read: PATCH to remove UNREAD label
 *   5. Assemble ReadEmailResult
 */
async function readGmailMessage(
  inbox: InboxRow,
  messageId: string,
  includeHtml: boolean,
  includeAttachments: boolean,
  markAsRead: boolean,
  attachmentBudgetBytes: number = ATTACHMENT_DATA_BUDGET,
  selectOnlyIndex?: number,
): Promise<ReadEmailResult> {
  const accessToken = await withFreshGmailToken(inbox);

  // Step 1: Fetch the full message.
  const msgResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!msgResp.ok) {
    if (msgResp.status === 401) throw new Error("gmail_auth_failed");
    // 404, or 400 "Invalid id value" (a malformed/stale message id) → both are
    // permanent "bad id" errors. Map to message_not_found so the handler emits a
    // clean "call email_list/search" message instead of leaking the Gmail error
    // body or appending a misleading "try again in a moment" (the id won't fix
    // itself). Other 4xx/5xx fall through to the sanitized helper.
    if (msgResp.status === 404 || msgResp.status === 400) {
      throw new Error("message_not_found");
    }
    throw new Error(await gmailErrorMessage("Gmail API error", msgResp));
  }

  const msg = (await msgResp.json()) as GmailFullMessage;

  // Step 2: Parse headers.
  const hdrs: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    hdrs[h.name.toLowerCase()] = h.value;
  }

  // Step 3: Walk MIME tree.
  const { textPlain, textHtml, attachments: attachmentRefs } =
    walkGmailPayload(msg.payload ?? {});

  // Step 4: Fetch attachment content if requested. Budget defaults to 10 MB for
  // a whole-message read; the single-file download path raises it so one file
  // up to its own cap can be fetched. On the bulk path the per-file ceiling is
  // clamped to 2 MB so a heavy message can't OOM the isolate.
  let budgetRemaining = attachmentBudgetBytes;
  const perFileCap = selectOnlyIndex === undefined
    ? Math.min(attachmentBudgetBytes, BULK_ATTACHMENT_MAX_BYTES)
    : attachmentBudgetBytes;

  const attachments: ReadEmailAttachmentMeta[] = await Promise.all(
    attachmentRefs.map(async (ref, idx) => {
      // Skip content for non-selected attachments on the single-file path so we
      // never fetch/encode every attachment (memory-safe for large messages),
      // and skip oversized files on the bulk path (fetch them individually).
      if (
        !includeAttachments ||
        (selectOnlyIndex !== undefined && idx !== selectOnlyIndex) ||
        ref.sizeBytes > perFileCap
      ) {
        return {
          filename: ref.filename,
          mime_type: ref.mimeType,
          size_bytes: ref.sizeBytes,
          data: null,
        };
      }

      if (ref.sizeBytes > budgetRemaining) {
        return {
          filename: ref.filename,
          mime_type: ref.mimeType,
          size_bytes: ref.sizeBytes,
          data: null,
        };
      }
      budgetRemaining -= ref.sizeBytes;

      // Prefer inline data (small attachments); use attachment API for large ones.
      if (ref.inlineData) {
        return {
          filename: ref.filename,
          mime_type: ref.mimeType,
          size_bytes: ref.sizeBytes,
          data: base64urlToBase64(ref.inlineData),
        };
      }

      if (!ref.attachmentId) {
        return {
          filename: ref.filename,
          mime_type: ref.mimeType,
          size_bytes: ref.sizeBytes,
          data: null,
        };
      }

      const attResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(ref.attachmentId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (!attResp.ok) {
        return {
          filename: ref.filename,
          mime_type: ref.mimeType,
          size_bytes: ref.sizeBytes,
          data: null,
        };
      }

      const attData = (await attResp.json()) as { data?: string };
      return {
        filename: ref.filename,
        mime_type: ref.mimeType,
        size_bytes: ref.sizeBytes,
        data: attData.data ? base64urlToBase64(attData.data) : null,
      };
    }),
  );

  // Step 5: Mark as read if requested.
  if (markAsRead && (msg.labelIds ?? []).includes("UNREAD")) {
    fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      },
    ).catch(() => {
      // Fire-and-forget: mark-as-read failures are non-fatal.
    });
  }

  // Parse References header: space/comma-separated list of Message-IDs.
  const references = (hdrs["references"] ?? "")
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const labelIds = msg.labelIds ?? [];
  const isRead = !labelIds.includes("UNREAD") ||
    (markAsRead ? true : !labelIds.includes("UNREAD"));

  return {
    id: msg.id ?? messageId,
    thread_id: msg.threadId ?? messageId,
    from: parseEmailAddress(hdrs["from"] ?? ""),
    to: parseAddressList(hdrs["to"] ?? ""),
    cc: parseAddressList(hdrs["cc"] ?? ""),
    bcc: [],
    reply_to: hdrs["reply-to"]
      ? parseEmailAddress(hdrs["reply-to"])
      : null,
    subject: hdrs["subject"] ?? "(no subject)",
    date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
    body_text: textPlain ?? (textHtml ? stripHtmlToText(textHtml) : null),
    body_html: includeHtml && textHtml ? sanitizeEmailHtml(textHtml) : null,
    attachments,
    is_read: markAsRead ? true : isRead,
    labels: labelIds,
    in_reply_to: hdrs["in-reply-to"] ?? null,
    references,
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — email_read
// ---------------------------------------------------------------------------

/**
 * Implements `email_read` for Outlook via Microsoft Graph.
 *
 * Flow:
 *   1. GET /me/messages/{id}?$select=... → message with body
 *   2. If include_attachments: GET /me/messages/{id}/attachments
 *   3. If mark_as_read: PATCH /me/messages/{id} with { isRead: true }
 *   4. Assemble ReadEmailResult
 */
async function readOutlookMessage(
  inbox: InboxRow,
  messageId: string,
  includeHtml: boolean,
  includeAttachments: boolean,
  markAsRead: boolean,
  attachmentBudgetBytes: number = ATTACHMENT_DATA_BUDGET,
  selectOnlyIndex?: number,
): Promise<ReadEmailResult> {
  const accessToken = await withFreshOutlookToken(inbox);

  const selectFields = [
    "id",
    "conversationId",
    "from",
    "toRecipients",
    "ccRecipients",
    "subject",
    "receivedDateTime",
    "body",
    "hasAttachments",
    "isRead",
    "internetMessageHeaders",
    "categories",
    "flag",
  ].join(",");

  const msgResp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=${selectFields}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!msgResp.ok) {
    if (msgResp.status === 401) throw new Error("outlook_auth_failed");
    if (msgResp.status === 404) throw new Error("message_not_found");
    const errBody = (await msgResp.json()) as { error?: { message?: string } };
    throw new Error(
      `Outlook Graph error: ${errBody.error?.message ?? msgResp.statusText}`,
    );
  }

  interface OutlookFullMessage {
    id: string;
    conversationId?: string;
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    subject?: string;
    receivedDateTime?: string;
    body?: { contentType?: string; content?: string };
    hasAttachments?: boolean;
    isRead?: boolean;
    internetMessageHeaders?: { name: string; value: string }[];
    categories?: string[];
  }

  const msg = (await msgResp.json()) as OutlookFullMessage;

  // Extract internet message headers for threading.
  const iHeaders: Record<string, string> = {};
  for (const h of msg.internetMessageHeaders ?? []) {
    iHeaders[h.name.toLowerCase()] = h.value;
  }

  // Determine plain text and HTML from the body.
  // Graph returns body as either text/plain or text/html depending on what the
  // message contained. When contentType is "html" we have the HTML; we derive
  // plain text by stripping tags.
  const bodyContent = msg.body?.content ?? "";
  const bodyContentType = (msg.body?.contentType ?? "text").toLowerCase();

  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  if (bodyContentType === "html") {
    bodyHtml = bodyContent;
    // Derive plain text from the HTML so body_text always has the content.
    bodyText = stripHtmlToText(bodyContent);
  } else {
    bodyText = bodyContent;
  }

  // Fetch attachments if requested. Budget defaults to 10 MB; the single-file
  // download path raises it so one larger file can be fetched on its own.
  let budgetRemaining = attachmentBudgetBytes;
  const attachments: ReadEmailAttachmentMeta[] = [];

  if (msg.hasAttachments) {
    interface OutlookAttachment {
      id: string;
      name?: string;
      contentType?: string;
      size?: number;
      contentBytes?: string;
      "@odata.type"?: string;
    }

    const attResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (attResp.ok) {
      const attData = (await attResp.json()) as {
        value?: OutlookAttachment[];
      };
      for (const att of attData.value ?? []) {
        // Skip inline reference attachments (itemAttachment, referenceAttachment).
        if (
          att["@odata.type"] &&
          !att["@odata.type"].includes("fileAttachment")
        ) {
          continue;
        }
        // Output index = position among the kept attachments (matches the
        // attachment_index stamped later), so the single-file path can target one.
        const outIndex = attachments.length;
        const sizeBytes = att.size ?? 0;
        // Bulk path clamps the per-file ceiling to 2 MB (large files fetched
        // individually); the single-file path allows up to its 25 MB cap.
        const perFileCap = selectOnlyIndex === undefined
          ? Math.min(budgetRemaining, BULK_ATTACHMENT_MAX_BYTES)
          : budgetRemaining;
        let data: string | null = null;
        if (
          includeAttachments &&
          (selectOnlyIndex === undefined || outIndex === selectOnlyIndex) &&
          sizeBytes <= perFileCap
        ) {
          budgetRemaining -= sizeBytes;
          data = att.contentBytes ?? null;
        }
        attachments.push({
          filename: att.name ?? "attachment",
          mime_type: att.contentType ?? "application/octet-stream",
          size_bytes: sizeBytes,
          data,
        });
      }
    }
  }

  // Mark as read if requested.
  if (markAsRead && !msg.isRead) {
    fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isRead: true }),
      },
    ).catch(() => {});
  }

  const references = (iHeaders["references"] ?? "")
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  return {
    id: msg.id,
    thread_id: msg.conversationId ?? msg.id,
    from: {
      name: msg.from?.emailAddress?.name ?? "",
      email: msg.from?.emailAddress?.address ?? "",
    },
    to: (msg.toRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    cc: (msg.ccRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    bcc: [],
    reply_to: iHeaders["reply-to"]
      ? parseEmailAddress(iHeaders["reply-to"])
      : null,
    subject: msg.subject ?? "(no subject)",
    date: msg.receivedDateTime ?? new Date().toISOString(),
    body_text: bodyText,
    body_html: includeHtml && bodyHtml ? sanitizeEmailHtml(bodyHtml) : null,
    attachments,
    is_read: markAsRead ? true : (msg.isRead ?? true),
    labels: msg.categories ?? [],
    in_reply_to: iHeaders["in-reply-to"] ?? null,
    references,
  };
}

// ---------------------------------------------------------------------------
// Fastmail provider — email_read (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `email_read` for Fastmail using JMAP (RFC 8621).
 *
 * Flow:
 *   1. GET /jmap/session → discover accountId and apiUrl
 *   2. POST to apiUrl → Email/get with textBody, htmlBody, bodyValues, attachments
 *   3. If mark_as_read: Email/set { keywords: { "$seen": true } }
 *   4. Assemble ReadEmailResult
 */
async function readFastmailMessage(
  inbox: InboxRow,
  messageId: string,
  includeHtml: boolean,
  includeAttachments: boolean,
  markAsRead: boolean,
  attachmentBudgetBytes: number = ATTACHMENT_DATA_BUDGET,
  selectOnlyIndex?: number,
): Promise<ReadEmailResult> {
  // Build auth header.
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Step 1: Discover session.
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }

  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };

  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  // JMAP blob download endpoint template. Placeholders {accountId}/{blobId}/
  // {type}/{name} are substituted per attachment when fetching content. The
  // Fastmail default host is used only if the session omits downloadUrl.
  const downloadUrl =
    (session as { downloadUrl?: string }).downloadUrl ??
    "https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}";

  if (!accountId) {
    throw new Error(
      "Fastmail JMAP: could not determine accountId from session.",
    );
  }

  // Step 2: Fetch the full message via JMAP Email/get.
  // JMAP bodyValues contains the actual body content keyed by part ID.
  // We request both textBody and htmlBody part lists, then resolve them
  // using bodyValues.
  const jmapBody = {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
    ],
    methodCalls: [
      [
        "Email/get",
        {
          accountId,
          ids: [messageId],
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "keywords",
            "from",
            "to",
            "cc",
            "bcc",
            "replyTo",
            "subject",
            "receivedAt",
            "textBody",
            "htmlBody",
            "bodyValues",
            "attachments",
            "messageId",
            "inReplyTo",
            "references",
            "headers",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          fetchAllBodyValues: false,
          maxBodyValueBytes: 5 * 1024 * 1024, // 5 MB per body part
        },
        "a",
      ],
    ],
  };

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jmapBody),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP error: ${apiResp.statusText}`);
  }

  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const responses = apiData.methodResponses ?? [];
  const getResp = responses.find(([name]) => name === "Email/get");

  if (!getResp) {
    throw new Error("Fastmail JMAP returned unexpected response structure.");
  }

  interface JmapEmailAddress {
    name?: string;
    email?: string;
  }

  interface JmapBodyPart {
    partId?: string;
    blobId?: string;
    size?: number;
    name?: string;
    type?: string;
    charset?: string;
    disposition?: string;
    cid?: string;
  }

  interface JmapBodyValue {
    value?: string;
    isEncodingProblem?: boolean;
    isTruncated?: boolean;
  }

  interface JmapEmail {
    id?: string;
    threadId?: string;
    keywords?: Record<string, boolean>;
    from?: JmapEmailAddress[];
    to?: JmapEmailAddress[];
    cc?: JmapEmailAddress[];
    bcc?: JmapEmailAddress[];
    replyTo?: JmapEmailAddress[];
    subject?: string;
    receivedAt?: string;
    textBody?: JmapBodyPart[];
    htmlBody?: JmapBodyPart[];
    bodyValues?: Record<string, JmapBodyValue>;
    attachments?: JmapBodyPart[];
    messageId?: string[];
    inReplyTo?: string[];
    references?: string[];
  }

  const getResult = getResp[1] as { list?: JmapEmail[]; notFound?: string[] };

  if ((getResult.notFound ?? []).includes(messageId)) {
    throw new Error("message_not_found");
  }

  const email = (getResult.list ?? [])[0];
  if (!email) {
    throw new Error("message_not_found");
  }

  // Extract body text and HTML from bodyValues.
  const bodyValues = email.bodyValues ?? {};

  let bodyText: string | null = null;
  for (const part of email.textBody ?? []) {
    if (part.partId && bodyValues[part.partId]?.value) {
      bodyText = bodyValues[part.partId].value ?? null;
      break;
    }
  }

  let bodyHtml: string | null = null;
  for (const part of email.htmlBody ?? []) {
    if (part.partId && bodyValues[part.partId]?.value) {
      bodyHtml = bodyValues[part.partId].value ?? null;
      break;
    }
  }

  // Build attachment metadata.
  // JMAP attachments with `disposition: "attachment"` or a non-null `name`.
  // When include_attachments is requested we download each blob from the JMAP
  // downloadUrl endpoint (the symmetric counterpart of the uploadUrl used by
  // compose), base64-encode it, and share a single 10 MB budget across the
  // message — matching the Gmail/IMAP readers. Metadata is always returned even
  // when bytes are not fetched, so callers can pick one file to download via
  // email_read (action: attachment).
  const attachmentParts = (email.attachments ?? []).filter(
    (p) =>
      p.disposition === "attachment" ||
      (p.name && p.name.length > 0 && p.disposition !== "inline"),
  );

  // Budget defaults to 10 MB for a whole-message read; the single-file download
  // path raises it so one larger file can be fetched on its own.
  let attachmentBudgetRemaining = attachmentBudgetBytes;

  const attachments: ReadEmailAttachmentMeta[] = [];
  for (const p of attachmentParts) {
    const outIndex = attachments.length;
    const sizeBytes = p.size ?? 0;
    const filename = p.name ?? "attachment";
    const mimeType = p.type ?? "application/octet-stream";
    // Bulk path clamps the per-file ceiling to 2 MB (large files fetched
    // individually); the single-file path allows up to its 25 MB cap.
    const perFileCap = selectOnlyIndex === undefined
      ? Math.min(attachmentBudgetRemaining, BULK_ATTACHMENT_MAX_BYTES)
      : attachmentBudgetRemaining;
    let data: string | null = null;

    if (
      includeAttachments &&
      (selectOnlyIndex === undefined || outIndex === selectOnlyIndex) &&
      p.blobId &&
      sizeBytes <= perFileCap
    ) {
      try {
        const blobUrl = downloadUrl
          .replace("{accountId}", encodeURIComponent(accountId))
          .replace("{blobId}", encodeURIComponent(p.blobId))
          .replace("{name}", encodeURIComponent(filename))
          .replace("{type}", encodeURIComponent(mimeType));
        const blobResp = await fetch(blobUrl, {
          headers: { Authorization: authHeader },
        });
        if (blobResp.ok) {
          const bytes = new Uint8Array(await blobResp.arrayBuffer());
          data = bytesToBase64(bytes);
          attachmentBudgetRemaining -= sizeBytes;
        }
      } catch {
        // Leave data null on transient download failure; the caller can retry
        // via email_read (action: attachment), which surfaces a clear error.
      }
    }

    attachments.push({
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      data,
    });
  }

  // Step 3: Mark as read if requested.
  if (markAsRead && !(email.keywords?.["$seen"])) {
    // Fire-and-forget JMAP Email/set.
    fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          [
            "Email/set",
            {
              accountId,
              update: {
                [messageId]: { "keywords/$seen": true },
              },
            },
            "b",
          ],
        ],
      }),
    }).catch(() => {});
  }

  const mapAddr = (a: JmapEmailAddress): EmailAddressEntry => ({
    name: a.name ?? "",
    email: a.email ?? "",
  });

  return {
    id: email.id ?? messageId,
    thread_id: email.threadId ?? messageId,
    from: email.from?.[0] ? mapAddr(email.from[0]) : { name: "", email: "" },
    to: (email.to ?? []).map(mapAddr),
    cc: (email.cc ?? []).map(mapAddr),
    bcc: (email.bcc ?? []).map(mapAddr),
    reply_to: email.replyTo?.[0] ? mapAddr(email.replyTo[0]) : null,
    subject: email.subject ?? "(no subject)",
    date: email.receivedAt ?? new Date().toISOString(),
    body_text: bodyText ?? (bodyHtml ? stripHtmlToText(bodyHtml) : null),
    body_html: includeHtml && bodyHtml ? sanitizeEmailHtml(bodyHtml) : null,
    attachments,
    is_read: markAsRead ? true : !!(email.keywords?.["$seen"]),
    labels: [], // Fastmail uses mailboxIds, not labels — omitted for simplicity
    in_reply_to: email.inReplyTo?.[0] ?? null,
    references: email.references ?? [],
  };
}

// ---------------------------------------------------------------------------
// email_read — top-level handler
// ---------------------------------------------------------------------------

interface ReadEmailArgs {
  inbox_id: string;
  message_id: string;
  include_html?: boolean;
  include_attachments?: boolean;
  mark_as_read?: boolean;
}

/**
 * Executes the `email_read` tool end-to-end.
 *
 * Validates arguments, resolves the inbox, dispatches to the correct provider
 * implementation, and returns a fully assembled ReadEmailResult.
 * Never throws — all errors are captured as structured tool execution errors.
 */
/**
 * Dispatch a single message read to the correct provider reader. Shared by
 * email_read (single) and email_read_batch (batch) so the provider switch lives in
 * one place. Throws provider sentinels ("gmail_auth_failed", "message_not_found",
 * etc.) on failure; callers translate those into tool errors / per-ID errors.
 */
async function readOneMessage(
  inbox: InboxRow,
  messageId: string,
  opts: {
    include_html: boolean;
    include_attachments: boolean;
    mark_as_read: boolean;
    /**
     * Max bytes to download for attachment content. Defaults to the 10 MB
     * whole-message budget; the single-file download path (email_attachment)
     * raises it so one file up to its own cap can be fetched on its own.
     */
    attachment_max_bytes?: number;
    /**
     * When set, ONLY the attachment at this zero-based index has its bytes
     * fetched/encoded; all others return data:null (metadata still listed).
     * The single-file download path uses this so a multi-attachment message
     * never base64-encodes (and JSON-serialises) every attachment at once —
     * which OOM-kills the isolate on large mail (see email_attachment).
     */
    select_only_index?: number;
  },
): Promise<ReadEmailResult> {
  const attachmentBudgetBytes = opts.attachment_max_bytes ?? ATTACHMENT_DATA_BUDGET;
  const selectOnlyIndex = opts.select_only_index;
  let result: ReadEmailResult;
  switch (inbox.provider) {
    case "gmail":
      result = await readGmailMessage(
        inbox,
        messageId,
        opts.include_html,
        opts.include_attachments,
        opts.mark_as_read,
        attachmentBudgetBytes,
        selectOnlyIndex,
      );
      break;
    case "outlook":
      result = await readOutlookMessage(
        inbox,
        messageId,
        opts.include_html,
        opts.include_attachments,
        opts.mark_as_read,
        attachmentBudgetBytes,
        selectOnlyIndex,
      );
      break;
    case "fastmail":
      result = await readFastmailMessage(
        inbox,
        messageId,
        opts.include_html,
        opts.include_attachments,
        opts.mark_as_read,
        attachmentBudgetBytes,
        selectOnlyIndex,
      );
      break;
    case "imap":
      result = await readImapMessage(
        inbox,
        messageId,
        opts.include_html,
        opts.include_attachments,
        opts.mark_as_read,
        attachmentBudgetBytes,
        selectOnlyIndex,
      );
      break;
    default:
      throw new Error("unsupported_provider");
  }

  // Stamp a stable zero-based index onto each attachment so callers can select
  // exactly one for single-file download via email_read (action: attachment).
  // Centralised here so every provider reader gets consistent indices. On a bulk
  // include_attachments read, attach a note to any file whose bytes were omitted
  // (too large for bulk, or over budget) so the agent knows to fetch it singly.
  const bulkRead = opts.include_attachments && selectOnlyIndex === undefined;
  result.attachments = result.attachments.map((a, i) => {
    const stamped: ReadEmailAttachmentMeta = { ...a, attachment_index: i };
    if (bulkRead && stamped.data === null) {
      stamped.note =
        `Not included inline (${stamped.size_bytes} bytes exceeds the ` +
        `${BULK_ATTACHMENT_MAX_BYTES}-byte bulk limit or the per-call budget). ` +
        `Download it on its own with email_read action: attachment, ` +
        `attachment_index: ${i}.`;
    }
    return stamped;
  });

  return result;
}

async function executeReadEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_read: arguments must be an object with inbox_id and message_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const messageId =
    typeof args["message_id"] === "string" ? args["message_id"].trim() : null;
  if (!messageId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_read: message_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const includeHtml = args["include_html"] === true;
  const includeAttachments = args["include_attachments"] === true;
  const markAsRead = args["mark_as_read"] === true;

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_read");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch ─────────────────────────────────────────────────────
  const supportedProviders = ["gmail", "outlook", "fastmail", "imap"];
  if (!supportedProviders.includes(inbox.provider)) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Provider '${inbox.provider}' is not yet supported by email_read. ` +
            "Supported providers: gmail, outlook, fastmail, imap.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  let readResult: ReadEmailResult;
  try {
    readResult = await readOneMessage(inbox, messageId, {
      include_html: includeHtml,
      include_attachments: includeAttachments,
      mark_as_read: markAsRead,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "message_not_found") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Message ${messageId} not found in inbox ${inboxId}. ` +
              "The message may have been deleted or the ID is stale — " +
              "call email_list or email_search to get current message IDs.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "message_not_found",
      };
    }

    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }

    console.error("[mcp-server] email_read: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      message_id: messageId,
      error: message,
    });

    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error while reading email: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── Success ───────────────────────────────────────────────────────────────
  return {
    result: { ...jsonOk(readResult as unknown as Record<string, unknown>), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_attachment — download a single attachment
// ---------------------------------------------------------------------------

/**
 * Per-attachment download cap for email_attachment. Larger than the 10 MB
 * whole-message include_attachments budget because a dedicated download fetches
 * exactly one file, so a bigger ceiling is safe.
 */
const SINGLE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Executes the `email_attachment` tool end-to-end.
 *
 * Reads the target message with attachment content, selects ONE attachment by
 * `attachment_index` (preferred) or `filename`, and returns it as base64 `data`.
 * When the message has a single attachment, both selectors may be omitted.
 *
 * Reuses the per-provider readers (readOneMessage with include_attachments) so
 * attachment fetching/decoding lives in one place. Never throws — all failures
 * are returned as structured tool errors.
 */
async function executeReadAttachment(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: {
    content: Record<string, unknown>[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const toolError = (text: string, code: string) => ({
    result: { content: [{ type: "text", text }], isError: true },
    logStatus: "error" as const,
    logErrorCode: code,
  });

  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return toolError(
      "email_attachment: arguments must be an object with message_id and an inbox.",
      "-32602",
    );
  }

  const args = rawArgs as Record<string, unknown>;

  const messageId =
    typeof args["message_id"] === "string" ? args["message_id"].trim() : null;
  if (!messageId) {
    return toolError(
      "email_attachment: message_id is required and must be a non-empty string.",
      "-32602",
    );
  }

  // Attachment selectors. attachment_index wins when both are supplied.
  let attachmentIndex: number | null = null;
  if (args["attachment_index"] !== undefined && args["attachment_index"] !== null) {
    const raw = args["attachment_index"];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      return toolError(
        "email_attachment: attachment_index must be a non-negative integer.",
        "-32602",
      );
    }
    attachmentIndex = n;
  }
  const filename =
    typeof args["filename"] === "string" && args["filename"].trim() !== ""
      ? args["filename"].trim()
      : null;

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_attachment");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const supportedProviders = ["gmail", "outlook", "fastmail", "imap"];
  if (!supportedProviders.includes(inbox.provider)) {
    return toolError(
      `Provider '${inbox.provider}' is not yet supported by email_attachment. ` +
        "Supported providers: gmail, outlook, fastmail, imap.",
      "provider_error",
    );
  }

  // Shared mapping of provider read errors → structured tool errors. Used for
  // both the metadata read and the targeted content read below.
  const mapReadError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "message_not_found") {
      return toolError(
        `Message ${messageId} not found in inbox ${inboxId}. The message may have ` +
          "been deleted or the ID is stale — call email_read (action: list/search) " +
          "to get current message IDs.",
        "message_not_found",
      );
    }
    if (
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed"
    ) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    console.error("[mcp-server] email_attachment: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      message_id: messageId,
      error: message,
    });
    return toolError(
      `Provider error while reading email: ${message}. Please try again in a moment.`,
      "provider_error",
    );
  };

  // ── Pass 1: metadata-only read to list attachments and resolve the selector ─
  // Deliberately NOT include_attachments: encoding every attachment of a large
  // message OOM-kills the isolate. We fetch the chosen file's bytes in pass 2.
  let readResult: ReadEmailResult;
  try {
    readResult = await readOneMessage(inbox, messageId, {
      include_html: false,
      include_attachments: false,
      mark_as_read: false,
    });
  } catch (err) {
    return mapReadError(err);
  }

  const attachments = readResult.attachments;

  // Compact metadata used in disambiguation / error messages.
  const manifest = attachments.map((a, i) => ({
    index: i,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
  }));

  if (attachments.length === 0) {
    return toolError(
      JSON.stringify({
        error: "no_attachments",
        message: `Message ${messageId} has no attachments.`,
      }),
      "no_attachments",
    );
  }

  // ── Select the target attachment ──────────────────────────────────────────
  let selectedIndex: number;
  if (attachmentIndex !== null) {
    if (attachmentIndex >= attachments.length) {
      return toolError(
        JSON.stringify({
          error: "attachment_index_out_of_range",
          requested_index: attachmentIndex,
          total_attachments: attachments.length,
          attachments: manifest,
          message:
            `attachment_index ${attachmentIndex} is out of range; this message has ` +
            `${attachments.length} attachment(s) (indices 0–${attachments.length - 1}).`,
        }),
        "-32602",
      );
    }
    selectedIndex = attachmentIndex;
  } else if (filename !== null) {
    const lower = filename.toLowerCase();
    const idx = attachments.findIndex((a) => a.filename.toLowerCase() === lower);
    if (idx === -1) {
      return toolError(
        JSON.stringify({
          error: "attachment_not_found",
          requested_filename: filename,
          attachments: manifest,
          message:
            `No attachment named '${filename}' on message ${messageId}. ` +
            "See `attachments` for the available filenames.",
        }),
        "attachment_not_found",
      );
    }
    selectedIndex = idx;
  } else if (attachments.length === 1) {
    selectedIndex = 0;
  } else {
    return toolError(
      JSON.stringify({
        error: "attachment_selector_required",
        total_attachments: attachments.length,
        attachments: manifest,
        message:
          `Message ${messageId} has ${attachments.length} attachments. Specify ` +
          "`attachment_index` or `filename` to choose one.",
      }),
      "-32602",
    );
  }

  const selectedMeta = attachments[selectedIndex];

  // ── Enforce the single-attachment size cap (from metadata, before fetching) ─
  if (selectedMeta.size_bytes > SINGLE_ATTACHMENT_MAX_BYTES) {
    return toolError(
      JSON.stringify({
        error: "attachment_too_large",
        index: selectedIndex,
        filename: selectedMeta.filename,
        mime_type: selectedMeta.mime_type,
        size_bytes: selectedMeta.size_bytes,
        max_bytes: SINGLE_ATTACHMENT_MAX_BYTES,
        message:
          `Attachment '${selectedMeta.filename}' is ${selectedMeta.size_bytes} bytes, which ` +
          `exceeds the ${SINGLE_ATTACHMENT_MAX_BYTES}-byte download limit.`,
      }),
      "attachment_too_large",
    );
  }

  // ── Pass 2: fetch the bytes of ONLY the selected attachment ─────────────────
  // select_only_index ensures the provider reader encodes just this one file,
  // so a 5 MB multi-attachment message never blows the isolate's memory.
  let contentResult: ReadEmailResult;
  try {
    contentResult = await readOneMessage(inbox, messageId, {
      include_html: false,
      include_attachments: true,
      mark_as_read: false,
      attachment_max_bytes: SINGLE_ATTACHMENT_MAX_BYTES,
      select_only_index: selectedIndex,
    });
  } catch (err) {
    return mapReadError(err);
  }

  // The message is unchanged between the two reads, so indices line up. Fall
  // back to the metadata entry if the array somehow shrank (defensive).
  const selected = contentResult.attachments[selectedIndex] ?? selectedMeta;

  if (selected.data === null) {
    // Provider returned metadata but no bytes (fetch failed or JMAP returns
    // metadata only without a separate blob download path here).
    return toolError(
      JSON.stringify({
        error: "attachment_unavailable",
        index: selectedIndex,
        filename: selected.filename,
        mime_type: selected.mime_type,
        size_bytes: selected.size_bytes,
        message:
          `Attachment content for '${selected.filename}' could not be retrieved ` +
          "from the provider. Try again in a moment.",
      }),
      "attachment_unavailable",
    );
  }

  // ── Success ───────────────────────────────────────────────────────────────
  // Return the bytes through the MCP-idiomatic typed content block so clients
  // can render/save the file instead of treating a base64 blob as model text:
  //   image/*  → ImageContent      audio/*  → AudioContent
  //   text/*   → EmbeddedResource (decoded `text`)
  //   else     → EmbeddedResource (`blob`, base64)
  // The bytes live ONLY in this block (not duplicated into structuredContent),
  // which carries lightweight metadata the model can reason about cheaply.
  const meta = {
    message_id: messageId,
    inbox_id: inboxId,
    attachment_index: selectedIndex,
    total_attachments: attachments.length,
    filename: selected.filename,
    mime_type: selected.mime_type,
    size_bytes: selected.size_bytes,
  };

  const mt = selected.mime_type.toLowerCase();
  // Synthetic, informative URI identifying this attachment (any scheme is valid
  // per the MCP resource spec; clients use it as an opaque identifier).
  const uri =
    `mcpemails://inbox/${inboxId}/message/${encodeURIComponent(messageId)}` +
    `/attachment/${selectedIndex}/${encodeURIComponent(selected.filename)}`;

  let payloadBlock: Record<string, unknown>;
  if (mt.startsWith("image/")) {
    payloadBlock = { type: "image", data: selected.data, mimeType: selected.mime_type };
  } else if (mt.startsWith("audio/")) {
    payloadBlock = { type: "audio", data: selected.data, mimeType: selected.mime_type };
  } else if (mt.startsWith("text/")) {
    payloadBlock = {
      type: "resource",
      resource: {
        uri,
        name: selected.filename,
        mimeType: selected.mime_type,
        text: base64ToUtf8(selected.data),
      },
    };
  } else {
    payloadBlock = {
      type: "resource",
      resource: {
        uri,
        name: selected.filename,
        mimeType: selected.mime_type,
        blob: selected.data,
      },
    };
  }

  return {
    result: {
      content: [
        payloadBlock,
        // Backwards-compat text block mirroring structuredContent (metadata only).
        { type: "text", text: JSON.stringify(meta) },
      ],
      structuredContent: meta,
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

/** Max number of message IDs email_read_batch will accept in one call. */
const READ_EMAILS_MAX_IDS = 50;

/**
 * Executes the `email_read_batch` batch-read tool end-to-end.
 *
 * Reads up to 50 messages by provider message ID. Per-message failures are
 * collected into an `errors` array rather than failing the whole batch — except
 * an auth failure, which is fatal (every read would fail) and returns the
 * standard reconnect prompt.
 *
 * When include_attachments is true, attachment data shares a single 10 MB budget
 * (ATTACHMENT_DATA_BUDGET) across the whole batch: once the cumulative byte count
 * is exceeded, further attachments are returned with `data: null` and a note.
 *
 * Never throws — all errors are captured as structured results.
 */
async function executeReadEmails(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_read_batch: arguments must be an object with message_ids and an inbox.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const messageIds = Array.isArray(args["message_ids"])
    ? (args["message_ids"] as unknown[])
        .filter((m): m is string => typeof m === "string" && m.trim() !== "")
        .map((m) => m.trim())
    : [];

  if (messageIds.length === 0) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_read_batch: message_ids is required and must be a non-empty array of strings.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  if (messageIds.length > READ_EMAILS_MAX_IDS) {
    return {
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "too_many_message_ids",
            max: READ_EMAILS_MAX_IDS,
            received: messageIds.length,
            message:
              `email_read_batch accepts at most ${READ_EMAILS_MAX_IDS} message IDs per call. ` +
              `Received ${messageIds.length}. Split the request into smaller batches.`,
          }),
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const includeHtml = args["include_html"] === true;
  const includeAttachments = args["include_attachments"] === true;
  const markAsRead = args["mark_as_read"] === true;

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_read_batch");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const supportedProviders = ["gmail", "outlook", "fastmail", "imap"];
  if (!supportedProviders.includes(inbox.provider)) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Provider '${inbox.provider}' is not yet supported by email_read_batch. ` +
            "Supported providers: gmail, outlook, fastmail, imap.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── Read each message; collect successes + per-ID errors ──────────────────
  const messages: ReadEmailResult[] = [];
  const errors: { message_id: string; error: string }[] = [];

  // Cumulative attachment-byte budget shared across the batch.
  let attachmentBudgetRemaining = ATTACHMENT_DATA_BUDGET;

  for (const messageId of messageIds) {
    let readResult: ReadEmailResult;
    try {
      readResult = await readOneMessage(inbox, messageId, {
        include_html: includeHtml,
        include_attachments: includeAttachments,
        mark_as_read: markAsRead,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Auth failure is fatal for the whole batch — every read would fail.
      const isAuthFailure =
        message === "gmail_auth_failed" ||
        message === "outlook_auth_failed" ||
        message === "fastmail_auth_failed" ||
        message === "imap_auth_failed";
      if (isAuthFailure) {
        return authFailedResult(inbox.provider, inbox.id, "access");
      }

      if (message === "message_not_found") {
        errors.push({
          message_id: messageId,
          error:
            "Message not found. The message may have been deleted or the ID is stale — " +
            "call email_list or email_search to get current message IDs.",
        });
      } else {
        console.error("[mcp-server] email_read_batch: provider_error", {
          inbox_id: inboxId,
          provider: inbox.provider,
          message_id: messageId,
          error: message,
        });
        errors.push({ message_id: messageId, error: `Provider error: ${message}` });
      }
      continue;
    }

    // Enforce the shared attachment budget across the batch: once exceeded,
    // omit further attachment data (keep metadata) and mark it.
    if (includeAttachments && readResult.attachments.length > 0) {
      for (const att of readResult.attachments) {
        if (att.data === null) continue; // already omitted by the reader
        if (att.size_bytes <= attachmentBudgetRemaining) {
          attachmentBudgetRemaining -= att.size_bytes;
        } else {
          att.data = null;
        }
      }
    }

    messages.push(readResult);
  }

  return {
    result: {
      ...jsonOk({ messages, errors } as unknown as Record<string, unknown>),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Email address validation
// ---------------------------------------------------------------------------

/**
 * Validates an email address against a simplified RFC 5322 pattern.
 * Rejects addresses with invalid local parts, missing @, or invalid domains.
 * This is intentionally conservative — false positives (rejecting valid but
 * unusual addresses) are preferred over allowing malformed input that could
 * result in misaddressed email.
 *
 * Does not make DNS lookups or MX checks — structural validation only.
 */
function isValidEmailAddress(email: string): boolean {
  const trimmed = (email ?? "").trim();
  if (!trimmed || trimmed.length > 320) return false;
  // Simplified RFC 5322: local@domain.tld
  // Does not handle quoted strings or IP literals — rare and not needed here.
  const EMAIL_RE =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return EMAIL_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// MIME message builder (for Gmail and generic SMTP-style construction)
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 text string as base64, split into 76-character lines per
 * MIME spec (RFC 2045). Used for text/plain and text/html body parts with
 * Content-Transfer-Encoding: base64.
 */
function encodeTextAsBase64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  const b64 = btoa(binaryStr);
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}

/**
 * Encode a MIME header value containing non-ASCII characters using RFC 2047
 * encoded-word syntax: =?UTF-8?B?<base64>?=
 * ASCII-only values are returned unchanged.
 */
function encodeMimeHeaderValue(value: string): string {
  // SECURITY: strip CR/LF (and other control chars) BEFORE the ASCII
  // fast-path. CR and LF are ASCII, so without this an attacker-controlled
  // value containing CRLF would be injected verbatim into MIME headers
  // (header injection → hidden Bcc:, header/body splitting). Collapse any
  // run of control characters into a single space.
  // deno-lint-ignore no-control-regex
  const sanitized = value.replace(/[\x00-\x1F\x7F]+/g, " ");
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(sanitized)) {
    return sanitized;
  }
  const bytes = new TextEncoder().encode(sanitized);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return `=?UTF-8?B?${btoa(binaryStr)}?=`;
}

/**
 * Split base64 attachment data into 76-character lines per MIME spec.
 * Strips existing whitespace before re-chunking.
 */
function chunkBase64(b64: string): string {
  const clean = b64.replace(/\s/g, "");
  return clean.match(/.{1,76}/g)?.join("\r\n") ?? clean;
}

interface MimeMessageParams {
  /** "Display Name <email>" or just "email" */
  from: string;
  to: string[];
  cc?: string[];
  /**
   * BCC recipients. By default these are NOT written to any MIME header (the
   * direct-send path applies BCC at the SMTP envelope / send-API level only).
   * They are emitted as a real `Bcc:` header ONLY when `includeBccHeader` is
   * set — used exclusively when persisting an IMAP DRAFT so that draft_send,
   * which reconstructs its recipient list by re-parsing the stored MIME, can
   * recover the BCC addresses. The Bcc header is stripped again before the
   * draft is transmitted (see imapSendDraft / stripBccHeader).
   */
  bcc?: string[];
  /**
   * When true, write a `Bcc:` header into the MIME (draft persistence only).
   * Never set on the direct-send path — see the security note in buildMimeMessage.
   */
  includeBccHeader?: boolean;
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    /** Standard base64-encoded binary data */
    data: string;
  }>;
  replyTo?: string;
  /** Pre-generated UUID (without angle brackets) used as Message-ID */
  messageId: string;
  /**
   * RFC 5322 Message-ID of the message being replied to.
   * Written as the `In-Reply-To` MIME header.
   */
  inReplyTo?: string;
  /**
   * Full RFC 5322 References header chain (existing refs + original message ID).
   * Written as the `References` MIME header.
   */
  references?: string;
}

// ---------------------------------------------------------------------------
// Email signatures — central, pure helpers (single injection point)
// ---------------------------------------------------------------------------
//
// No mail backend (Gmail messages.send, Graph sendMail, JMAP Email/send, SMTP)
// appends a signature — the signature you normally see is added by the client
// UI. These helpers append a per-inbox signature server-side so programmatic
// mail looks like mail the user sends. Signature storage lives on the inboxes
// row (signature_html / signature_text / signature_enabled / ...).
//
// PURE: no DB or network I/O. Reply/forward placement (signature before the
// quoted block, honouring signature_reply_mode) is handled separately — these
// helpers only cover the plain "new message" case.

/** Minimal HTML-escape for deriving an HTML signature from plain text. */
function escapeSignatureHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve the signature for an inbox into a normalized `{ text, html }` pair.
 *
 * Returns `null` when no signature should be appended (disabled, or both
 * stored fields empty). When only one half is stored, the other is derived:
 *   - missing text  ← stripHtmlToText(signature_html)
 *   - missing html  ← escaped signature_text with newlines as <br>
 *
 * The returned `html` is the inner signature markup only — callers wrap it in
 * the `<div class="mcpemails-signature">…</div>` container.
 */
function composeSignatureBlocks(
  inbox: InboxRow,
): { text: string; html: string } | null {
  if (inbox.signature_enabled === false) return null;

  const storedText = (inbox.signature_text ?? "").trim();
  const storedHtml = (inbox.signature_html ?? "").trim();
  if (!storedText && !storedHtml) return null;

  const text = storedText || stripHtmlToText(storedHtml);
  // Belt-and-suspenders: scrub the stored HTML at send-time injection (covers
  // rows written before the tool-side sanitizer, or via any other write path)
  // before it is wrapped in the mcpemails-signature div. Idempotent on
  // already-clean HTML; https images and formatting survive.
  const html = storedHtml
    ? sanitizeSignatureHtml(storedHtml)
    : escapeSignatureHtml(storedText).replace(/\n/g, "<br>\n");

  // Guard against a signature that strips down to nothing (e.g. html was only
  // markup with no text content and no text counterpart was stored).
  if (!text.trim() && !html.trim()) return null;

  return { text, html };
}

/** Options controlling signature application on a send. */
interface ApplySignatureOptions {
  /**
   * Per-call override (Phase 1 wires this from the tool input). When explicitly
   * `false`, the signature is never applied. `undefined`/`true` → apply.
   */
  include_signature?: boolean;
}

/**
 * Apply the inbox signature to a NEW-MESSAGE body params object in place,
 * before `buildMimeMessage()` serializes it. Mutates and returns `params`.
 *
 * Rules:
 *   - No-op when `include_signature` is explicitly false, the signature is
 *     disabled, or both stored fields are empty.
 *   - Plain text: append `\n\n-- \n` + signature text (RFC 3676 delimiter:
 *     dash-dash-space-newline).
 *   - HTML: append the signature wrapped in
 *     `<div class="mcpemails-signature">…</div>`.
 *   - If only `textBody` was supplied but the inbox has any signature, an
 *     `htmlBody` is synthesized from the (escaped) plain body + rich signature
 *     so HTML clients render the rich sig — mirroring the multipart/alternative
 *     pair that buildMimeMessage emits whenever htmlBody is present.
 *
 * PURE: reads only the passed objects; performs no I/O.
 */
function applySignature<T extends { textBody: string; htmlBody?: string }>(
  params: T,
  inbox: InboxRow,
  opts: ApplySignatureOptions = {},
): T {
  if (opts.include_signature === false) return params;

  const sig = composeSignatureBlocks(inbox);
  if (!sig) return params;

  const sigTextBlock = `\n\n-- \n${sig.text}`;
  const sigHtmlBlock = `\n<div class="mcpemails-signature">${sig.html}</div>`;

  if (params.htmlBody && params.htmlBody.trim()) {
    // Caller already supplied rich HTML — append to both parts so the
    // multipart/alternative pair stays consistent.
    params.htmlBody = `${params.htmlBody}${sigHtmlBlock}`;
    params.textBody = `${params.textBody}${sigTextBlock}`;
  } else {
    // Text-only send. Synthesize the HTML part from the ORIGINAL body (before
    // appending the text delimiter) so the signature appears exactly once in
    // each part, then sign the text part.
    const bodyHtml = escapeSignatureHtml(params.textBody).replace(/\n/g, "<br>\n");
    params.htmlBody = `${bodyHtml}${sigHtmlBlock}`;
    params.textBody = `${params.textBody}${sigTextBlock}`;
  }

  return params;
}

/**
 * Markers that indicate the new reply/forward body ALREADY contains a quoted
 * block or a previously-appended signature. Used by the `first_only` reply mode
 * to avoid double-signing when Claude iterates on a thread (each turn passes the
 * previous turn's output back in as `body`).
 *
 * Detects:
 *   - our own plain-text signature delimiter (`\n-- \n`)
 *   - our own HTML signature container
 *   - the attribution / quote lines that buildReplyTextBody / the forward
 *     header block emit ("On … wrote:", "> " quote prefix, the forwarded-message
 *     separator)
 */
function bodyAlreadyHasQuoteOrSignature(text: string, html?: string): boolean {
  if (/\n-- \n/.test(text)) return true;
  if (/^\s*On .+ wrote:\s*$/m.test(text)) return true;
  if (/^>\s?/m.test(text)) return true;
  if (/-{3,}\s*Forwarded message\s*-{3,}/i.test(text)) return true;
  if (html && /class="mcpemails-signature"/.test(html)) return true;
  return false;
}

/**
 * Options for reply/forward signature placement.
 */
interface ReplySignatureOptions {
  /** Per-call override (Task 6). Explicit `false` suppresses the signature. */
  include_signature?: boolean;
}

/**
 * Insert the inbox signature into a reply/forward's NEW body, AFTER the user's
 * new text and BEFORE the quoted/forwarded block is appended downstream.
 *
 * This mutates the caller-supplied new-text fields (`body` / `htmlBody`) in
 * place. Because every reply/forward path quotes the original AFTER this new
 * text (either via buildReplyTextBody / the forward header block, or — for
 * Fastmail JMAP — by leaving the quote out entirely), appending the signature
 * to the new text here always lands it before the quote. Single source of
 * signature strings: composeSignatureBlocks().
 *
 * Honours `signature_reply_mode`:
 *   - `never`      → no-op
 *   - `always`     → always append
 *   - `first_only` → append only when the new body has no existing quote or
 *                    signature marker yet (so iterating a thread doesn't stack
 *                    signatures)
 *
 * The `include_signature === false` per-call override also forces a no-op.
 */
function applyReplyForwardSignature<
  T extends { body?: string; htmlBody?: string },
>(
  params: T,
  inbox: InboxRow,
  opts: ReplySignatureOptions = {},
): T {
  if (opts.include_signature === false) return params;

  const mode = inbox.signature_reply_mode ?? "first_only";
  if (mode === "never") return params;

  const sig = composeSignatureBlocks(inbox);
  if (!sig) return params;

  const currentBody = params.body ?? "";
  if (
    mode === "first_only" &&
    bodyAlreadyHasQuoteOrSignature(currentBody, params.htmlBody)
  ) {
    return params;
  }

  const sigTextBlock = `\n\n-- \n${sig.text}`;
  const sigHtmlBlock = `\n<div class="mcpemails-signature">${sig.html}</div>`;

  // For a forward with no intro the signature becomes the only new text; the
  // leading blank lines are still fine ahead of the forwarded-message block.
  params.body = `${currentBody}${sigTextBlock}`;
  // Only sign the HTML part when the caller supplied one — reply/forward paths
  // send htmlBody raw (no HTML quoting), so a missing htmlBody means the message
  // is text-only and the text signature above already covers it.
  if (params.htmlBody && params.htmlBody.trim()) {
    params.htmlBody = `${params.htmlBody}${sigHtmlBlock}`;
  }

  return params;
}

/**
 * Build an RFC 5322 / MIME message string from the given parameters.
 *
 * Structure selection:
 *   - Plain text only, no attachments       → text/plain
 *   - Text + HTML, no attachments           → multipart/alternative
 *   - Text only + attachments               → multipart/mixed
 *   - Text + HTML + attachments             → multipart/mixed with nested
 *                                             multipart/alternative
 *
 * Body content is base64-encoded (Content-Transfer-Encoding: base64) for
 * reliable UTF-8 transport. Attachment data passes through as-is — the caller
 * provides base64 data from the MCP tool arguments.
 *
 * SECURITY: BCC addresses are NOT written to any MIME header for the direct
 * send path; they are handled at the send-API level (RCPT TO / toRecipients
 * etc.) only, so To/Cc recipients never see BCC addresses. The single, opt-in
 * exception is `includeBccHeader: true`, used ONLY when storing an IMAP draft
 * (the user's own private copy); that header is stripped before the draft is
 * ever transmitted. No other caller may set `includeBccHeader`.
 */
function buildMimeMessage(params: MimeMessageParams): string {
  const boundary = `mcpe_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines: string[] = [];

  // ── Required headers ──────────────────────────────────────────────────────
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to.join(", ")}`);
  if (params.cc?.length) lines.push(`Cc: ${params.cc.join(", ")}`);
  // Bcc is written ONLY for draft persistence (includeBccHeader). It is stripped
  // before transmission so To/Cc recipients never see BCC addresses.
  if (params.includeBccHeader && params.bcc?.length) {
    lines.push(`Bcc: ${params.bcc.join(", ")}`);
  }
  lines.push(`Subject: ${encodeMimeHeaderValue(params.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${params.messageId}@mcpemails.com>`);
  if (params.replyTo) lines.push(`Reply-To: ${params.replyTo}`);
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) lines.push(`References: ${params.references}`);
  lines.push(`MIME-Version: 1.0`);

  const hasHtml = !!params.htmlBody;
  const hasAttachments = !!(params.attachments?.length);

  if (!hasHtml && !hasAttachments) {
    // ── Simple text/plain ─────────────────────────────────────────────────
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.textBody));
  } else if (hasHtml && !hasAttachments) {
    // ── multipart/alternative (plain text + HTML, no attachments) ─────────
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.textBody));
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.htmlBody!));
    lines.push("");
    lines.push(`--${boundary}--`);
  } else {
    // ── multipart/mixed (body ± HTML alternative + attachments) ───────────
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");

    if (hasHtml) {
      // Nested multipart/alternative for the body
      const altBoundary = `mcpe_alt_${crypto.randomUUID().replace(/-/g, "")}`;
      lines.push(`--${boundary}`);
      lines.push(
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      );
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.textBody));
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.htmlBody!));
      lines.push("");
      lines.push(`--${altBoundary}--`);
    } else {
      // Plain text body part only
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.textBody));
    }

    // Attachment parts
    for (const att of params.attachments ?? []) {
      lines.push("");
      lines.push(`--${boundary}`);
      lines.push(
        // SECURITY: att.mimeType previously interpolated raw — route it through
        // encodeMimeHeaderValue so CR/LF/control chars can't inject headers.
        `Content-Type: ${encodeMimeHeaderValue(att.mimeType)}; name="${encodeMimeHeaderValue(att.filename)}"`,
      );
      lines.push(
        `Content-Disposition: attachment; filename="${encodeMimeHeaderValue(att.filename)}"`,
      );
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(chunkBase64(att.data));
    }

    lines.push("");
    lines.push(`--${boundary}--`);
  }

  return lines.join("\r\n");
}

/**
 * Convert an RFC 5322 MIME message string to base64url as required by the
 * Gmail API `messages.send` endpoint (the `raw` field).
 *
 * The message must already use \r\n line endings (per MIME spec).
 */
function mimeMessageToBase64url(mimeText: string): string {
  const bytes = new TextEncoder().encode(mimeText);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binaryStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// email_send — output and parameter types
// ---------------------------------------------------------------------------

interface SendEmailResult {
  /** Provider-assigned ID of the sent message. */
  message_id: string;
  /** Thread ID — same as message_id for new threads. */
  thread_id: string;
  /** ISO 8601 timestamp when the provider accepted the message. */
  sent_at: string;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  bcc: EmailAddressEntry[];
  subject: string;
  /** Always "sent" on success. */
  status: "sent";
}

interface SendEmailParams {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: Array<{ filename: string; mime_type: string; data: string }>;
  replyTo?: string;
}

// ---------------------------------------------------------------------------
// Gmail provider — email_send
// ---------------------------------------------------------------------------

/**
 * Sends an email via the Gmail REST API (`users.messages.send`).
 *
 * Constructs a full RFC 5322 / MIME message, base64url-encodes it, and
 * submits it as the `raw` field. Gmail handles SMTP delivery internally.
 * BCC recipients are excluded from MIME headers but are addressed by the
 * API automatically when included in the MIME message's BCC header — however,
 * Gmail's API strips the BCC header from the stored sent message for privacy.
 * We omit BCC from MIME headers entirely and rely on SMTP envelope resolution.
 */
async function sendGmailMessage(
  inbox: InboxRow,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const accessToken = await withFreshGmailToken(inbox);
  const messageId = crypto.randomUUID();

  const mimeMessage = buildMimeMessage({
    from: inbox.display_name
      ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
      : inbox.email_address,
    to: params.to,
    cc: params.cc.length ? params.cc : undefined,
    subject: params.subject,
    textBody: params.textBody,
    htmlBody: params.htmlBody,
    attachments: params.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      data: a.data,
    })),
    replyTo: params.replyTo,
    messageId,
  });

  const rawBase64url = mimeMessageToBase64url(mimeMessage);

  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawBase64url }),
    },
  );

  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    let errMsg = resp.statusText;
    let isQuota = resp.status === 429;
    try {
      const errBody = (await resp.json()) as {
        error?: { message?: string; status?: string };
      };
      if (errBody.error?.message) errMsg = errBody.error.message;
      if (errBody.error?.status === "RESOURCE_EXHAUSTED") isQuota = true;
    } catch { /* ignore JSON parse errors */ }
    if (isQuota) throw new Error("quota_exceeded");
    throw new Error(`Gmail send error: ${errMsg}`);
  }

  const sent = (await resp.json()) as {
    id?: string;
    threadId?: string;
  };

  const sentAt = new Date().toISOString();

  return {
    message_id: sent.id ?? messageId,
    thread_id: sent.threadId ?? sent.id ?? messageId,
    sent_at: sentAt,
    to: params.to.map((e) => parseEmailAddress(e)),
    cc: params.cc.map((e) => parseEmailAddress(e)),
    bcc: params.bcc.map((e) => parseEmailAddress(e)),
    subject: params.subject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — email_send
// ---------------------------------------------------------------------------

/**
 * Sends an email via the Microsoft Graph API (`POST /me/sendMail`).
 *
 * Graph accepts a structured JSON message body — no MIME construction needed.
 * The API returns 202 Accepted with no body on success. Since Graph does not
 * return the assigned message ID from `sendMail`, a synthetic UUID is used as
 * a local tracking ID. A future enhancement could query Sent Items to resolve
 * the real message ID.
 */
async function sendOutlookMessage(
  inbox: InboxRow,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const accessToken = await withFreshOutlookToken(inbox);

  const toRecipients = params.to.map((email) => {
    const parsed = parseEmailAddress(email);
    return {
      emailAddress: {
        ...(parsed.name ? { name: parsed.name } : {}),
        address: parsed.email,
      },
    };
  });

  const ccRecipients = params.cc.map((email) => {
    const parsed = parseEmailAddress(email);
    return {
      emailAddress: {
        ...(parsed.name ? { name: parsed.name } : {}),
        address: parsed.email,
      },
    };
  });

  const bccRecipients = params.bcc.map((email) => {
    const parsed = parseEmailAddress(email);
    return {
      emailAddress: {
        ...(parsed.name ? { name: parsed.name } : {}),
        address: parsed.email,
      },
    };
  });

  // Graph only supports a single body content type per message.
  // When html_body is provided, send HTML (the plain text is visible in the
  // HTML itself). When only body is provided, send text/plain.
  const body = params.htmlBody
    ? { contentType: "HTML", content: params.htmlBody }
    : { contentType: "Text", content: params.textBody };

  const message: Record<string, unknown> = {
    subject: params.subject,
    body,
    toRecipients,
    ccRecipients,
    bccRecipients,
  };

  if (params.replyTo) {
    const parsed = parseEmailAddress(params.replyTo);
    message.replyTo = [{
      emailAddress: {
        ...(parsed.name ? { name: parsed.name } : {}),
        address: parsed.email,
      },
    }];
  }

  if (params.attachments.length > 0) {
    message.attachments = params.attachments.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.filename,
      contentType: att.mime_type,
      // Graph accepts standard base64 for contentBytes
      contentBytes: att.data.replace(/\s/g, ""),
    }));
  }

  const resp = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );

  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 429) throw new Error("quota_exceeded");
    let errMsg = resp.statusText;
    try {
      const errBody = (await resp.json()) as {
        error?: { message?: string };
      };
      if (errBody.error?.message) errMsg = errBody.error.message;
    } catch { /* ignore */ }
    throw new Error(`Outlook send error: ${errMsg}`);
  }

  // 202 Accepted — Graph's sendMail returns no body, so no provider message id
  // is available. Return empty ids rather than a fabricated UUID that a caller
  // could mistake for a fetchable Graph id.
  const sentAt = new Date().toISOString();

  return {
    message_id: "",
    thread_id: "",
    sent_at: sentAt,
    to: params.to.map((e) => parseEmailAddress(e)),
    cc: params.cc.map((e) => parseEmailAddress(e)),
    bcc: params.bcc.map((e) => parseEmailAddress(e)),
    subject: params.subject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// Fastmail provider — mailbox role resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the Drafts and Sent mailbox ids for a Fastmail account.
 *
 * JMAP (RFC 8621) requires every Email to belong to at least one Mailbox, so an
 * outgoing message must be created inside a real mailbox (Drafts) before it can
 * be submitted. `mailboxIds` keys cannot be JMAP result back-references, so the
 * ids have to be resolved in a separate request before the send batch.
 */
async function resolveFastmailRoleMailboxes(
  apiUrl: string,
  authHeader: string,
  accountId: string,
): Promise<{ draftsId?: string; sentId?: string }> {
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/query", { accountId, filter: { role: "drafts" }, limit: 1 }, "drafts"],
        ["Mailbox/query", { accountId, filter: { role: "sent" }, limit: 1 }, "sent"],
      ],
    }),
  });
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Mailbox/query error: ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    methodResponses?: [string, { ids?: string[] }, string][];
  };
  const responses = data.methodResponses ?? [];
  const draftsId = responses.find(([, , callId]) => callId === "drafts")?.[1]?.ids?.[0];
  const sentId = responses.find(([, , callId]) => callId === "sent")?.[1]?.ids?.[0];
  return { draftsId, sentId };
}

// ---------------------------------------------------------------------------
// Fastmail provider — email_send (JMAP)
// ---------------------------------------------------------------------------

/**
 * Sends an email via Fastmail's JMAP API using a two-step batch:
 *
 *   1. Email/set (create draft) — creates the email object in the sent mailbox.
 *   2. EmailSubmission/set (submit) — triggers delivery via SMTP submission.
 *
 * Attachments require uploading blobs to the JMAP upload endpoint before the
 * Email/set call. Each attachment is uploaded individually, and the resulting
 * blobId is referenced in the email body.
 *
 * The `urn:ietf:params:jmap:submission` capability is required for EmailSubmission.
 * Fastmail supports this capability on all standard accounts.
 */
async function sendFastmailMessage(
  inbox: InboxRow,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  // Build auth header
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Step 1: Discover JMAP session
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }

  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
    uploadUrl?: string;
  };

  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  const uploadUrl = (session.uploadUrl ?? "https://api.fastmail.com/jmap/upload/{accountId}/")
    .replace("{accountId}", encodeURIComponent(accountId ?? ""));

  if (!accountId) {
    throw new Error("Fastmail JMAP: could not determine accountId from session.");
  }

  // Step 2: Upload any attachments to get blobIds
  const jmapAttachments: unknown[] = [];
  for (const att of params.attachments) {
    const attBytes = Uint8Array.from(
      atob(att.data.replace(/\s/g, "")),
      (c) => c.charCodeAt(0),
    );
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": att.mime_type,
      },
      body: attBytes,
    });
    if (!uploadResp.ok) {
      throw new Error(
        `Fastmail attachment upload failed for '${att.filename}': ${uploadResp.statusText}`,
      );
    }
    const uploadResult = (await uploadResp.json()) as { blobId?: string };
    if (!uploadResult.blobId) {
      throw new Error(
        `Fastmail did not return a blobId for attachment '${att.filename}'.`,
      );
    }
    jmapAttachments.push({
      blobId: uploadResult.blobId,
      name: att.filename,
      type: att.mime_type,
      disposition: "attachment",
    });
  }

  // Resolve the Drafts/Sent mailboxes — JMAP requires the email to live in a
  // mailbox before it can be submitted.
  const { draftsId, sentId } = await resolveFastmailRoleMailboxes(
    apiUrl,
    authHeader,
    accountId,
  );
  const placementId = draftsId ?? sentId;
  if (!placementId) {
    throw new Error(
      "Fastmail JMAP: could not resolve a Drafts or Sent mailbox to place the outgoing message.",
    );
  }

  // Step 3: Build the JMAP email object
  const fromAddress = inbox.display_name
    ? { name: inbox.display_name, email: inbox.email_address }
    : { email: inbox.email_address };

  const mapAddr = (e: string) => {
    const parsed = parseEmailAddress(e);
    return parsed.name ? { name: parsed.name, email: parsed.email } : { email: parsed.email };
  };

  const bodyValues: Record<string, unknown> = {};
  const textBodyParts: unknown[] = [];
  const htmlBodyParts: unknown[] = [];

  bodyValues["textPart"] = { value: params.textBody, charset: "utf-8" };
  textBodyParts.push({ partId: "textPart", type: "text/plain" });

  if (params.htmlBody) {
    bodyValues["htmlPart"] = { value: params.htmlBody, charset: "utf-8" };
    htmlBodyParts.push({ partId: "htmlPart", type: "text/html" });
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [placementId]: true },
    from: [fromAddress],
    to: params.to.map(mapAddr),
    ...(params.cc.length ? { cc: params.cc.map(mapAddr) } : {}),
    ...(params.bcc.length ? { bcc: params.bcc.map(mapAddr) } : {}),
    subject: params.subject,
    bodyValues,
    textBody: textBodyParts,
    ...(params.htmlBody ? { htmlBody: htmlBodyParts } : {}),
    ...(jmapAttachments.length ? { attachments: jmapAttachments } : {}),
    keywords: { "$draft": true },
  };

  if (params.replyTo) {
    emailCreate.replyTo = [mapAddr(params.replyTo)];
  }

  // All RCPT TO addresses (to + cc + bcc)
  const allRcptTo = [...params.to, ...params.cc, ...params.bcc].map((e) => ({
    email: parseEmailAddress(e).email,
  }));

  // Step 4: JMAP batch — Email/set (create) + EmailSubmission/set (send).
  // On successful submission, clear the $draft flag and move the message out of
  // Drafts into Sent so it doesn't linger as an unsent draft.
  const submissionSet: Record<string, unknown> = {
    accountId,
    create: {
      sub1: {
        emailId: "#draft",
        envelope: {
          mailFrom: { email: inbox.email_address },
          rcptTo: allRcptTo,
        },
      },
    },
  };
  if (sentId) {
    const patch: Record<string, unknown> = {
      "keywords/$draft": null,
      "keywords/$seen": true,
    };
    if (placementId !== sentId) {
      patch[`mailboxIds/${placementId}`] = null;
      patch[`mailboxIds/${sentId}`] = true;
    }
    submissionSet.onSuccessUpdateEmail = { "#sub1": patch };
  }

  const jmapBody = {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ],
    methodCalls: [
      [
        "Email/set",
        {
          accountId,
          create: { draft: emailCreate },
        },
        "e1",
      ],
      ["EmailSubmission/set", submissionSet, "s1"],
    ],
  };

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jmapBody),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP send error: ${apiResp.statusText}`);
  }

  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const responses = apiData.methodResponses ?? [];
  const emailSetResp = responses.find(([n]) => n === "Email/set");
  const submissionResp = responses.find(([n]) => n === "EmailSubmission/set");

  if (!emailSetResp || !submissionResp) {
    throw new Error("Fastmail JMAP returned unexpected response structure for send.");
  }

  const emailSetResult = emailSetResp[1] as {
    created?: Record<string, { id: string; threadId?: string }>;
    notCreated?: Record<string, { type: string; description?: string }>;
  };

  const submissionResult = submissionResp[1] as {
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, { type: string; description?: string }>;
  };

  if (emailSetResult.notCreated?.["draft"]) {
    const err = emailSetResult.notCreated["draft"];
    throw new Error(
      `Fastmail email creation failed (${err.type}): ${err.description ?? "unknown error"}`,
    );
  }

  if (submissionResult.notCreated?.["sub1"]) {
    const err = submissionResult.notCreated["sub1"];
    throw new Error(
      `Fastmail email submission failed (${err.type}): ${err.description ?? "unknown error"}`,
    );
  }

  const createdEmail = emailSetResult.created?.["draft"];
  const sentAt = new Date().toISOString();

  return {
    message_id: createdEmail?.id ?? crypto.randomUUID(),
    thread_id: createdEmail?.threadId ?? createdEmail?.id ?? crypto.randomUUID(),
    sent_at: sentAt,
    to: params.to.map((e) => parseEmailAddress(e)),
    cc: params.cc.map((e) => parseEmailAddress(e)),
    bcc: params.bcc.map((e) => parseEmailAddress(e)),
    subject: params.subject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_reply — types
// ---------------------------------------------------------------------------

/**
 * Internal parameters passed to each provider's reply implementation.
 * The original message ID and subject are fetched from the provider and
 * are NOT part of these params — they are derived during execution.
 */
interface ReplyToEmailParams {
  /** Plain-text reply body (always required). */
  body: string;
  /** Optional HTML version of the reply body. */
  htmlBody?: string;
  /**
   * When true, address the reply to all recipients of the original message
   * (original To + Cc), not just the original sender.
   */
  replyAll: boolean;
  /** Attachments to include with the reply (same shape as email_send). */
  attachments: Array<{ filename: string; mime_type: string; data: string }>;
  /**
   * Per-call signature override (Task 6). When explicitly `false`, the inbox
   * signature is not appended even if reply-mode would otherwise add it.
   */
  include_signature?: boolean;
}

interface ReplyToEmailResult {
  /** Provider-assigned ID of the sent reply message. */
  message_id: string;
  /** Thread ID — same as the original message's thread. */
  thread_id: string;
  /** ISO 8601 timestamp when the provider accepted the message. */
  sent_at: string;
  /** Provider-native ID of the message being replied to. */
  in_reply_to: string;
  /** Resolved To recipients for the reply. */
  to: EmailAddressEntry[];
  /** Reply subject (prefixed with "Re:" if necessary). */
  subject: string;
  /** Always "sent" on success. */
  status: "sent";
}

// ---------------------------------------------------------------------------
// email_reply — Gmail provider
// ---------------------------------------------------------------------------

/**
 * Sends a reply to an existing Gmail message.
 *
 * Flow:
 *   1. Fetch the original message with format=metadata to extract threading
 *      headers (Message-ID, References, From, To, Cc, Subject, threadId).
 *   2. Compute the reply-to recipients (From only, or From + To + Cc for
 *      reply_all), capped at 50 recipients.
 *   3. Build a full RFC 5322 MIME reply with In-Reply-To and References headers
 *      set correctly to maintain thread continuity in all email clients.
 *   4. Send via `users.messages.send` with the original `threadId` so Gmail
 *      keeps the reply in the same conversation.
 */
async function replyGmailMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ReplyToEmailParams,
): Promise<ReplyToEmailResult> {
  // Sign the new reply text before the original is quoted (buildReplyTextBody
  // appends the quote after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const accessToken = await withFreshGmailToken(inbox);

  // ── Step 1: Fetch original message metadata ───────────────────────────────
  const mp = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References"]) {
    mp.append("metadataHeaders", h);
  }
  const origResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${originalMessageId}?${mp}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!origResp.ok) {
    if (origResp.status === 401) throw new Error("gmail_auth_failed");
    if (origResp.status === 404) throw new Error("message_not_found");
    const errBody = (await origResp.json()) as { error?: { message?: string } };
    throw new Error(
      `Gmail API error fetching original: ${errBody.error?.message ?? origResp.statusText}`,
    );
  }

  const origMsg = (await origResp.json()) as GmailMessageMeta & { threadId?: string };
  const hdrs: Record<string, string> = {};
  for (const h of origMsg.payload?.headers ?? []) {
    hdrs[h.name.toLowerCase()] = h.value;
  }

  const origRfc5322MessageId = hdrs["message-id"] ?? "";
  const origReferences = hdrs["references"] ?? "";
  const origSubject = hdrs["subject"] ?? "(no subject)";
  const origFromHeader = hdrs["from"] ?? "";
  const origDateHeader = hdrs["date"] ?? "";

  // Fetch the original body so the reply can quote it (parity with forward).
  // Best-effort: if the body read fails, fall back to no quote rather than
  // failing the whole reply.
  let origBodyText = "";
  try {
    const origRead = await readGmailMessage(inbox, originalMessageId, false, false, false);
    origBodyText = origRead.body_text ?? "";
  } catch {
    origBodyText = "";
  }

  // Build RFC 5322 References chain: existing refs + original Message-ID.
  const referencesChain = origReferences
    ? `${origReferences} ${origRfc5322MessageId}`
    : origRfc5322MessageId;

  // ── Step 2: Resolve reply recipients ─────────────────────────────────────
  let replyAddresses: string[];
  if (params.replyAll) {
    const fromEntry = parseEmailAddress(hdrs["from"] ?? "");
    const toEntries = parseAddressList(hdrs["to"] ?? "");
    const ccEntries = parseAddressList(hdrs["cc"] ?? "");
    // Exclude the sending inbox address from the recipient list.
    const everyone = [fromEntry, ...toEntries, ...ccEntries]
      .filter((e) => e.email && e.email !== inbox.email_address);
    replyAddresses = everyone.slice(0, 50).map((e) =>
      e.name ? `${encodeMimeHeaderValue(e.name)} <${e.email}>` : e.email
    );
  } else {
    const fromEntry = parseEmailAddress(hdrs["from"] ?? "");
    replyAddresses = fromEntry.email ? [
      fromEntry.name
        ? `${encodeMimeHeaderValue(fromEntry.name)} <${fromEntry.email}>`
        : fromEntry.email,
    ] : [];
  }

  if (replyAddresses.length === 0) {
    throw new Error(
      "email_reply: could not determine reply recipients from original message headers.",
    );
  }

  // ── Step 3: Build reply subject ───────────────────────────────────────────
  const replySubject = /^re:/i.test(origSubject.trim())
    ? origSubject
    : `Re: ${origSubject}`;

  // ── Step 4: Construct MIME reply with threading headers ───────────────────
  const newMessageId = crypto.randomUUID();
  const mimeMessage = buildMimeMessage({
    from: inbox.display_name
      ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
      : inbox.email_address,
    to: replyAddresses,
    subject: replySubject,
    textBody: buildReplyTextBody(
      params.body,
      origFromHeader,
      origDateHeader,
      origBodyText,
    ),
    htmlBody: params.htmlBody,
    attachments: params.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      data: a.data,
    })),
    messageId: newMessageId,
    inReplyTo: origRfc5322MessageId || undefined,
    references: referencesChain || undefined,
  });

  const rawBase64url = mimeMessageToBase64url(mimeMessage);

  // ── Step 5: Send with threadId to keep Gmail thread continuity ────────────
  const sendBody: Record<string, string> = { raw: rawBase64url };
  if (origMsg.threadId) sendBody["threadId"] = origMsg.threadId;

  const sendResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
    },
  );

  if (!sendResp.ok) {
    if (sendResp.status === 401) throw new Error("gmail_auth_failed");
    let errMsg = sendResp.statusText;
    let isQuota = sendResp.status === 429;
    try {
      const errBody = (await sendResp.json()) as {
        error?: { message?: string; status?: string };
      };
      if (errBody.error?.message) errMsg = errBody.error.message;
      if (errBody.error?.status === "RESOURCE_EXHAUSTED") isQuota = true;
    } catch { /* ignore JSON parse errors */ }
    if (isQuota) throw new Error("quota_exceeded");
    throw new Error(`Gmail reply error: ${errMsg}`);
  }

  const sent = (await sendResp.json()) as { id?: string; threadId?: string };
  const sentAt = new Date().toISOString();

  return {
    message_id: sent.id ?? newMessageId,
    thread_id: sent.threadId ?? origMsg.threadId ?? newMessageId,
    sent_at: sentAt,
    in_reply_to: originalMessageId,
    to: replyAddresses.map((e) => parseEmailAddress(e)),
    subject: replySubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_reply — Outlook provider
// ---------------------------------------------------------------------------

/**
 * Sends a reply to an existing Outlook / Microsoft 365 message.
 *
 * Flow:
 *   1. GET the original message from Graph to extract recipients, subject,
 *      internetMessageId (RFC 5322 Message-ID), and the References header.
 *   2. Build and send the reply via `POST /me/sendMail` with the correct
 *      In-Reply-To and References `internetMessageHeaders` so that
 *      Outlook and other clients maintain thread continuity.
 */
async function replyOutlookMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ReplyToEmailParams,
): Promise<ReplyToEmailResult> {
  // Sign the new reply text before the original is quoted (buildReplyTextBody
  // appends the quote after params.body; the HTML path sends params.htmlBody raw).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const accessToken = await withFreshOutlookToken(inbox);

  // ── Step 1: Fetch original message ────────────────────────────────────────
  const selectFields = [
    "from",
    "toRecipients",
    "ccRecipients",
    "subject",
    "conversationId",
    "internetMessageId",
    "internetMessageHeaders",
    "body",
    "receivedDateTime",
  ].join(",");

  const origResp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(originalMessageId)}?$select=${selectFields}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!origResp.ok) {
    if (origResp.status === 401) throw new Error("outlook_auth_failed");
    if (origResp.status === 404) throw new Error("message_not_found");
    const errBody = (await origResp.json()) as { error?: { message?: string } };
    throw new Error(
      `Outlook Graph API error: ${errBody.error?.message ?? origResp.statusText}`,
    );
  }

  const origMsg = (await origResp.json()) as {
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    subject?: string;
    conversationId?: string;
    internetMessageId?: string;
    internetMessageHeaders?: { name: string; value: string }[];
    body?: { contentType?: string; content?: string };
    receivedDateTime?: string;
  };

  const origSubject = origMsg.subject ?? "(no subject)";
  const replySubject = /^re:/i.test(origSubject.trim())
    ? origSubject
    : `Re: ${origSubject}`;
  const origFromStr = origMsg.from?.emailAddress
    ? (origMsg.from.emailAddress.name
      ? `${origMsg.from.emailAddress.name} <${origMsg.from.emailAddress.address ?? ""}>`
      : (origMsg.from.emailAddress.address ?? ""))
    : "";
  const origDateStr = origMsg.receivedDateTime ?? "";
  const origBodyText = origMsg.body
    ? (origMsg.body.contentType?.toLowerCase() === "html"
      ? stripHtmlToText(origMsg.body.content ?? "")
      : (origMsg.body.content ?? ""))
    : "";

  const origMsgId = origMsg.internetMessageId ?? "";
  const refsHeader =
    origMsg.internetMessageHeaders?.find(
      (h) => h.name.toLowerCase() === "references",
    )?.value ?? "";
  const referencesChain = refsHeader
    ? `${refsHeader} ${origMsgId}`
    : origMsgId;

  // ── Step 2: Resolve reply recipients ─────────────────────────────────────
  type GraphRecipient = { emailAddress?: { name?: string; address?: string } };
  let toRecipients: GraphRecipient[];

  if (params.replyAll) {
    const fromAddr = origMsg.from?.emailAddress;
    const allTo = origMsg.toRecipients ?? [];
    const allCc = origMsg.ccRecipients ?? [];
    const everyone: GraphRecipient[] = [
      ...(fromAddr ? [{ emailAddress: fromAddr }] : []),
      ...allTo,
      ...allCc,
    ].filter(
      (r) => r.emailAddress?.address && r.emailAddress.address !== inbox.email_address,
    );
    toRecipients = everyone.slice(0, 50);
  } else {
    const fromAddr = origMsg.from?.emailAddress;
    toRecipients = fromAddr?.address
      ? [{ emailAddress: fromAddr }]
      : [];
  }

  if (toRecipients.length === 0) {
    throw new Error(
      "email_reply: could not determine reply recipients from original message.",
    );
  }

  // ── Step 3: Build and send the reply ─────────────────────────────────────
  const body = params.htmlBody
    ? { contentType: "HTML", content: params.htmlBody }
    : {
      contentType: "Text",
      content: buildReplyTextBody(
        params.body,
        origFromStr,
        origDateStr,
        origBodyText,
      ),
    };

  const message: Record<string, unknown> = {
    subject: replySubject,
    body,
    toRecipients: toRecipients.map((r) => ({
      emailAddress: {
        ...(r.emailAddress?.name ? { name: r.emailAddress.name } : {}),
        address: r.emailAddress?.address ?? "",
      },
    })),
    // Threading headers — Graph supports setting these via internetMessageHeaders.
    internetMessageHeaders: [
      ...(origMsgId ? [{ name: "In-Reply-To", value: origMsgId }] : []),
      ...(referencesChain ? [{ name: "References", value: referencesChain }] : []),
    ],
  };

  if (params.attachments.length > 0) {
    message.attachments = params.attachments.map((att) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.filename,
      contentType: att.mime_type,
      contentBytes: att.data.replace(/\s/g, ""),
    }));
  }

  const sendResp = await fetch(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );

  if (!sendResp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (sendResp.status === 401 || sendResp.status === 403) throw new Error("outlook_auth_failed");
    if (sendResp.status === 429) throw new Error("quota_exceeded");
    let errMsg = sendResp.statusText;
    try {
      const errBody = (await sendResp.json()) as {
        error?: { message?: string };
      };
      if (errBody.error?.message) errMsg = errBody.error.message;
    } catch { /* ignore */ }
    throw new Error(`Outlook reply error: ${errMsg}`);
  }

  // Graph's sendMail returns no body, so no provider message id is available
  // for the reply. The conversation id (real) is preserved as the thread id.
  const sentAt = new Date().toISOString();

  return {
    message_id: "",
    thread_id: origMsg.conversationId ?? "",
    sent_at: sentAt,
    in_reply_to: originalMessageId,
    to: toRecipients.map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    subject: replySubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_reply — Fastmail provider (JMAP)
// ---------------------------------------------------------------------------

/**
 * Sends a reply to an existing Fastmail message via JMAP.
 *
 * Flow:
 *   1. GET /jmap/session to discover accountId and apiUrl.
 *   2. Email/get to fetch the original email's messageId header, references,
 *      subject, from, to, cc.
 *   3. Upload any attachments to get blobIds.
 *   4. Email/set + EmailSubmission/set in a single JMAP batch to create and
 *      submit the reply. The `inReplyTo` and `references` JMAP fields are set
 *      to maintain thread continuity per RFC 8621.
 */
async function replyFastmailMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ReplyToEmailParams,
): Promise<ReplyToEmailResult> {
  // Sign the new reply text. Fastmail sends params.body / params.htmlBody as the
  // message parts without re-quoting the original, so appending the signature
  // here places it after the user's text (single source: composeSignatureBlocks).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  // ── Build auth header ─────────────────────────────────────────────────────
  const authHeader = await buildFastmailAuthHeader(inbox);

  // ── Step 1: Discover JMAP session ─────────────────────────────────────────
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
    uploadUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  const uploadUrl = (
    session.uploadUrl ?? "https://api.fastmail.com/jmap/upload/{accountId}/"
  ).replace("{accountId}", encodeURIComponent(accountId ?? ""));

  if (!accountId) {
    throw new Error(
      "Fastmail JMAP: could not determine accountId from session.",
    );
  }

  // ── Step 2: Fetch original email metadata ─────────────────────────────────
  const fetchBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/get",
        {
          accountId,
          ids: [originalMessageId],
          properties: [
            "id",
            "threadId",
            "messageId",
            "references",
            "subject",
            "from",
            "to",
            "cc",
          ],
        },
        "f1",
      ],
    ],
  };

  const fetchResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fetchBody),
  });
  if (!fetchResp.ok) {
    if (fetchResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP error fetching original: ${fetchResp.statusText}`);
  }

  const fetchData = (await fetchResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const emailGetResp = fetchData.methodResponses?.find(([n]) => n === "Email/get");
  const emailGetResult = (emailGetResp?.[1] ?? null) as {
    list?: Array<{
      id: string;
      threadId?: string;
      messageId?: string[];
      references?: string[];
      subject?: string;
      from?: { name?: string; email?: string }[];
      to?: { name?: string; email?: string }[];
      cc?: { name?: string; email?: string }[];
    }>;
    notFound?: string[];
  } | null;

  const origEmail = emailGetResult?.list?.[0];
  if (
    !origEmail ||
    (emailGetResult?.notFound ?? []).includes(originalMessageId)
  ) {
    throw new Error("message_not_found");
  }

  const origRfc5322MessageIds = origEmail.messageId ?? [];
  const origRfc5322MessageId = origRfc5322MessageIds[0] ?? "";
  const origReferencesList = origEmail.references ?? [];
  const origSubject = origEmail.subject ?? "(no subject)";
  const replySubject = /^re:/i.test(origSubject.trim())
    ? origSubject
    : `Re: ${origSubject}`;

  // JMAP references = existing references + original messageId
  const newReferences = origRfc5322MessageId
    ? [...origReferencesList, origRfc5322MessageId]
    : origReferencesList;

  // ── Step 3: Resolve reply recipients ─────────────────────────────────────
  type JmapAddr = { name?: string; email?: string };
  let toAddresses: { name: string; email: string }[];

  if (params.replyAll) {
    const fromAddr = origEmail.from?.[0];
    const allTo = origEmail.to ?? [];
    const allCc = origEmail.cc ?? [];
    const everyone: JmapAddr[] = [
      ...(fromAddr ? [fromAddr] : []),
      ...allTo,
      ...allCc,
    ].filter((a) => a.email && a.email !== inbox.email_address);
    toAddresses = everyone.slice(0, 50).map((a) => ({
      name: a.name ?? "",
      email: a.email ?? "",
    }));
  } else {
    const fromAddr = origEmail.from?.[0];
    toAddresses = fromAddr?.email
      ? [{ name: fromAddr.name ?? "", email: fromAddr.email }]
      : [];
  }

  if (toAddresses.length === 0) {
    throw new Error(
      "email_reply: could not determine reply recipients from original message.",
    );
  }

  // ── Step 4: Upload attachments ────────────────────────────────────────────
  const jmapAttachments: unknown[] = [];
  for (const att of params.attachments) {
    const attBytes = Uint8Array.from(
      atob(att.data.replace(/\s/g, "")),
      (c) => c.charCodeAt(0),
    );
    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": att.mime_type,
      },
      body: attBytes,
    });
    if (!uploadResp.ok) {
      throw new Error(
        `Fastmail attachment upload failed for '${att.filename}': ${uploadResp.statusText}`,
      );
    }
    const uploadResult = (await uploadResp.json()) as { blobId?: string };
    if (!uploadResult.blobId) {
      throw new Error(
        `Fastmail did not return a blobId for attachment '${att.filename}'.`,
      );
    }
    jmapAttachments.push({
      blobId: uploadResult.blobId,
      name: att.filename,
      type: att.mime_type,
      disposition: "attachment",
    });
  }

  // ── Step 5: Build and submit the reply ───────────────────────────────────
  // Resolve the Drafts/Sent mailboxes — JMAP requires the email to live in a
  // mailbox before it can be submitted.
  const { draftsId, sentId } = await resolveFastmailRoleMailboxes(
    apiUrl,
    authHeader,
    accountId,
  );
  const placementId = draftsId ?? sentId;
  if (!placementId) {
    throw new Error(
      "Fastmail JMAP: could not resolve a Drafts or Sent mailbox to place the reply.",
    );
  }

  const fromAddress = inbox.display_name
    ? { name: inbox.display_name, email: inbox.email_address }
    : { email: inbox.email_address };

  const bodyValues: Record<string, unknown> = {};
  const textBodyParts: unknown[] = [];
  const htmlBodyParts: unknown[] = [];

  bodyValues["textPart"] = { value: params.body, charset: "utf-8" };
  textBodyParts.push({ partId: "textPart", type: "text/plain" });

  if (params.htmlBody) {
    bodyValues["htmlPart"] = { value: params.htmlBody, charset: "utf-8" };
    htmlBodyParts.push({ partId: "htmlPart", type: "text/html" });
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [placementId]: true },
    from: [fromAddress],
    to: toAddresses.map((a) =>
      a.name ? { name: a.name, email: a.email } : { email: a.email }
    ),
    subject: replySubject,
    bodyValues,
    textBody: textBodyParts,
    ...(params.htmlBody ? { htmlBody: htmlBodyParts } : {}),
    ...(jmapAttachments.length ? { attachments: jmapAttachments } : {}),
    // JMAP RFC 8621 threading fields
    ...(origRfc5322MessageId
      ? { inReplyTo: [origRfc5322MessageId] }
      : {}),
    ...(newReferences.length ? { references: newReferences } : {}),
    keywords: { "$draft": true },
  };

  const allRcptTo = toAddresses.map((a) => ({ email: a.email }));

  // On successful submission, clear the $draft flag and move the reply out of
  // Drafts into Sent so it doesn't linger as an unsent draft.
  const submissionSet: Record<string, unknown> = {
    accountId,
    create: {
      sub1: {
        emailId: "#draft",
        envelope: {
          mailFrom: { email: inbox.email_address },
          rcptTo: allRcptTo,
        },
      },
    },
  };
  if (sentId) {
    const patch: Record<string, unknown> = {
      "keywords/$draft": null,
      "keywords/$seen": true,
    };
    if (placementId !== sentId) {
      patch[`mailboxIds/${placementId}`] = null;
      patch[`mailboxIds/${sentId}`] = true;
    }
    submissionSet.onSuccessUpdateEmail = { "#sub1": patch };
  }

  const jmapBody = {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ],
    methodCalls: [
      [
        "Email/set",
        {
          accountId,
          create: { draft: emailCreate },
        },
        "e1",
      ],
      ["EmailSubmission/set", submissionSet, "s1"],
    ],
  };

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jmapBody),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP reply error: ${apiResp.statusText}`);
  }

  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const responses = apiData.methodResponses ?? [];
  const emailSetResp = responses.find(([n]) => n === "Email/set");
  const submissionResp = responses.find(([n]) => n === "EmailSubmission/set");

  if (!emailSetResp || !submissionResp) {
    throw new Error(
      "Fastmail JMAP returned unexpected response structure for reply.",
    );
  }

  const emailSetResult = emailSetResp[1] as {
    created?: Record<string, { id: string; threadId?: string }>;
    notCreated?: Record<string, { type: string; description?: string }>;
  };
  const submissionResult = submissionResp[1] as {
    created?: Record<string, { id: string }>;
    notCreated?: Record<string, { type: string; description?: string }>;
  };

  if (emailSetResult.notCreated?.["draft"]) {
    const err = emailSetResult.notCreated["draft"];
    throw new Error(
      `Fastmail reply creation failed (${err.type}): ${err.description ?? "unknown error"}`,
    );
  }
  if (submissionResult.notCreated?.["sub1"]) {
    const err = submissionResult.notCreated["sub1"];
    throw new Error(
      `Fastmail reply submission failed (${err.type}): ${err.description ?? "unknown error"}`,
    );
  }

  const createdEmail = emailSetResult.created?.["draft"];
  const sentAt = new Date().toISOString();

  return {
    message_id: createdEmail?.id ?? crypto.randomUUID(),
    thread_id:
      createdEmail?.threadId ??
      origEmail.threadId ??
      createdEmail?.id ??
      crypto.randomUUID(),
    sent_at: sentAt,
    in_reply_to: originalMessageId,
    to: toAddresses.map((a) => ({ name: a.name, email: a.email })),
    subject: replySubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_forward — types
// ---------------------------------------------------------------------------

interface ForwardEmailParams {
  /** Forward recipients (To field). */
  to: string[];
  /** Optional CC recipients. */
  cc: string[];
  /** Optional BCC recipients. */
  bcc: string[];
  /** Optional introductory plain-text note prepended above the forwarded block. */
  body?: string;
  /** Optional HTML version of the introductory note. */
  htmlBody?: string;
  /** When true, include original message attachments in the forward. */
  includeAttachments: boolean;
  /**
   * Per-call signature override (Task 6). When explicitly `false`, the inbox
   * signature is not appended to the forward intro even if reply-mode would.
   */
  include_signature?: boolean;
}

interface ForwardEmailResult {
  /** Provider-assigned ID of the forwarded message. */
  message_id: string;
  /** Thread ID. */
  thread_id: string;
  /** ISO 8601 timestamp when the provider accepted the message. */
  sent_at: string;
  /** Provider-native ID of the original message that was forwarded. */
  forwarded_from: string;
  /** Resolved To recipients. */
  to: EmailAddressEntry[];
  /** Forward subject (prefixed with "Fwd:"). */
  subject: string;
  /** Always "sent" on success. */
  status: "sent";
}

// ---------------------------------------------------------------------------
// email_forward — shared helpers
// ---------------------------------------------------------------------------

/**
 * Build the plain-text forwarded-message body.
 *
 * Format:
 *   [optional intro text]
 *
 *   ---------- Forwarded message ----------
 *   From: <original sender>
 *   Date: <original date>
 *   Subject: <original subject>
 *   To: <original to>
 *
 *   <original body>
 */
function buildForwardedTextBody(
  intro: string | undefined,
  from: string,
  date: string,
  subject: string,
  to: string,
  origBody: string,
): string {
  const block = [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `To: ${to}`,
    "",
    origBody,
  ].join("\n");
  return intro ? `${intro}\n\n${block}` : block;
}

/**
 * Build a reply plain-text body that quotes the original message, mirroring the
 * convention most mail clients use:
 *
 *   <reply text>
 *
 *   On <date>, <from> wrote:
 *   > <original line 1>
 *   > <original line 2>
 *
 * `replyText` is the caller-supplied new body (may be empty). `from`/`date` come
 * from the original message; `origBody` is its plain-text body (empty string is
 * tolerated — the attribution line is still emitted for context). Parity with
 * email_forward, which already quotes via buildForwardedTextBody.
 */
function buildReplyTextBody(
  replyText: string | undefined,
  from: string,
  date: string,
  origBody: string,
): string {
  const quoted = origBody
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
  const attribution = `On ${date}, ${from} wrote:`;
  const block = `${attribution}\n${quoted}`;
  return replyText ? `${replyText}\n\n${block}` : block;
}

/**
 * Prefix "Fwd: " on the subject if not already present.
 */
function makeForwardSubject(origSubject: string): string {
  return /^fwd:/i.test(origSubject.trim()) ? origSubject : `Fwd: ${origSubject}`;
}

// ---------------------------------------------------------------------------
// email_forward — IMAP provider
// ---------------------------------------------------------------------------

/**
 * Forwards an email via IMAP inboxes.
 *
 * Flow:
 *   1. Read the original message via `readImapMessage` (with attachments if requested).
 *   2. Build the forwarded plain-text body with the standard header block.
 *   3. Send via `sendImapMessage` (SMTP submission) with the composed body.
 */
async function forwardImapMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ForwardEmailParams,
): Promise<ForwardEmailResult> {
  // Sign the forward intro before the original is appended below
  // (buildForwardedTextBody places the forwarded block after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const original = await readImapMessage(
    inbox,
    originalMessageId,
    false,
    params.includeAttachments,
    false,
  );

  const fwdSubject = makeForwardSubject(original.subject);
  const origFromStr = original.from.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from.email;
  const origToStr = original.to
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

  const textBody = buildForwardedTextBody(
    params.body,
    origFromStr,
    original.date,
    original.subject,
    origToStr,
    original.body_text ?? "",
  );

  const attachments = params.includeAttachments
    ? original.attachments
        .filter((a) => a.data !== null)
        .map((a) => ({
          filename: a.filename,
          mime_type: a.mime_type,
          data: a.data as string,
        }))
    : [];

  const sendResult = await sendImapMessage(inbox, {
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: fwdSubject,
    textBody,
    htmlBody: params.htmlBody,
    attachments,
  });

  return {
    message_id: sendResult.message_id,
    thread_id: sendResult.thread_id,
    sent_at: sendResult.sent_at,
    forwarded_from: originalMessageId,
    to: sendResult.to,
    subject: fwdSubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_forward — Gmail provider
// ---------------------------------------------------------------------------

/**
 * Forwards an email via the Gmail REST API.
 *
 * Flow:
 *   1. Read the original message via `readGmailMessage` (with attachments if requested).
 *   2. Build the forwarded plain-text body with the standard header block.
 *   3. Send via `sendGmailMessage` using the composed body and collected attachments.
 */
async function forwardGmailMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ForwardEmailParams,
): Promise<ForwardEmailResult> {
  // Sign the forward intro before the original is appended below
  // (buildForwardedTextBody places the forwarded block after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const original = await readGmailMessage(
    inbox,
    originalMessageId,
    false,
    params.includeAttachments,
    false,
  );

  const fwdSubject = makeForwardSubject(original.subject);
  const origFromStr = original.from.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from.email;
  const origToStr = original.to
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

  const textBody = buildForwardedTextBody(
    params.body,
    origFromStr,
    original.date,
    original.subject,
    origToStr,
    original.body_text ?? "",
  );

  const attachments = params.includeAttachments
    ? original.attachments
        .filter((a) => a.data !== null)
        .map((a) => ({
          filename: a.filename,
          mime_type: a.mime_type,
          data: a.data as string,
        }))
    : [];

  const sendResult = await sendGmailMessage(inbox, {
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: fwdSubject,
    textBody,
    htmlBody: params.htmlBody,
    attachments,
  });

  return {
    message_id: sendResult.message_id,
    thread_id: sendResult.thread_id,
    sent_at: sendResult.sent_at,
    forwarded_from: originalMessageId,
    to: sendResult.to,
    subject: fwdSubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_forward — Outlook provider
// ---------------------------------------------------------------------------

/**
 * Forwards an email via Outlook / Microsoft 365 (Graph API).
 *
 * Flow:
 *   1. Read the original message via `readOutlookMessage` (with attachments if requested).
 *   2. Build the forwarded plain-text body with the standard header block.
 *   3. Send via `sendOutlookMessage` using Graph sendMail with the composed body.
 */
async function forwardOutlookMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ForwardEmailParams,
): Promise<ForwardEmailResult> {
  // Sign the forward intro before the original is appended below
  // (buildForwardedTextBody places the forwarded block after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const original = await readOutlookMessage(
    inbox,
    originalMessageId,
    false,
    params.includeAttachments,
    false,
  );

  const fwdSubject = makeForwardSubject(original.subject);
  const origFromStr = original.from.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from.email;
  const origToStr = original.to
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

  const textBody = buildForwardedTextBody(
    params.body,
    origFromStr,
    original.date,
    original.subject,
    origToStr,
    original.body_text ?? "",
  );

  const attachments = params.includeAttachments
    ? original.attachments
        .filter((a) => a.data !== null)
        .map((a) => ({
          filename: a.filename,
          mime_type: a.mime_type,
          data: a.data as string,
        }))
    : [];

  const sendResult = await sendOutlookMessage(inbox, {
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: fwdSubject,
    textBody,
    htmlBody: params.htmlBody,
    attachments,
  });

  return {
    message_id: sendResult.message_id,
    thread_id: sendResult.thread_id,
    sent_at: sendResult.sent_at,
    forwarded_from: originalMessageId,
    to: sendResult.to,
    subject: fwdSubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_forward — Fastmail provider (JMAP)
// ---------------------------------------------------------------------------

/**
 * Forwards an email via Fastmail JMAP.
 *
 * Flow:
 *   1. Read the original message via `readFastmailMessage` (with attachments if requested).
 *   2. Build the forwarded plain-text body with the standard header block.
 *   3. Send via `sendFastmailMessage` using the composed body and collected attachments.
 */
async function forwardFastmailMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ForwardEmailParams,
): Promise<ForwardEmailResult> {
  // Sign the forward intro before the original is appended below
  // (buildForwardedTextBody places the forwarded block after params.body).
  applyReplyForwardSignature(params, inbox, {
    include_signature: params.include_signature,
  });
  const original = await readFastmailMessage(
    inbox,
    originalMessageId,
    false,
    params.includeAttachments,
    false,
  );

  const fwdSubject = makeForwardSubject(original.subject);
  const origFromStr = original.from.name
    ? `${original.from.name} <${original.from.email}>`
    : original.from.email;
  const origToStr = original.to
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");

  const textBody = buildForwardedTextBody(
    params.body,
    origFromStr,
    original.date,
    original.subject,
    origToStr,
    original.body_text ?? "",
  );

  const attachments = params.includeAttachments
    ? original.attachments
        .filter((a) => a.data !== null)
        .map((a) => ({
          filename: a.filename,
          mime_type: a.mime_type,
          data: a.data as string,
        }))
    : [];

  const sendResult = await sendFastmailMessage(inbox, {
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: fwdSubject,
    textBody,
    htmlBody: params.htmlBody,
    attachments,
  });

  return {
    message_id: sendResult.message_id,
    thread_id: sendResult.thread_id,
    sent_at: sendResult.sent_at,
    forwarded_from: originalMessageId,
    to: sendResult.to,
    subject: fwdSubject,
    status: "sent",
  };
}

// ---------------------------------------------------------------------------
// email_forward — top-level handler
// ---------------------------------------------------------------------------

/**
 * Executes the `email_forward` tool end-to-end.
 *
 * Validates and normalises arguments, resolves the inbox, reads the original
 * message, builds the forwarded body with the standard header block, and
 * dispatches to the correct provider send path.
 *
 * Never throws — all errors are captured as structured ToolErrors.
 *
 * Security considerations:
 *  - Requires `send:email` scope (belt-and-suspenders check in addition to
 *    middleware enforcement).
 *  - Total recipient cap of 50 to prevent accidental mass forward.
 *  - Same provider_error / delivery_status caution as email_send applies.
 */
async function executeForwardEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_forward: arguments must be an object with inbox_id, message_id, and to.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // message_id (required)
  const messageId =
    typeof args["message_id"] === "string" && args["message_id"].length > 0
      ? args["message_id"]
      : null;
  if (!messageId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_forward: message_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // to (required, non-empty array, max 50)
  const toRaw = args["to"];
  if (!Array.isArray(toRaw) || toRaw.length === 0) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_forward: to is required and must be a non-empty array of email address strings.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  if (toRaw.length > 50) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_forward: to must not exceed 50 recipients.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const to = toRaw as string[];

  // cc (optional, default [])
  const ccRaw = args["cc"];
  const cc: string[] = Array.isArray(ccRaw) ? (ccRaw as string[]) : [];

  // bcc (optional, default [])
  const bccRaw = args["bcc"];
  const bcc: string[] = Array.isArray(bccRaw) ? (bccRaw as string[]) : [];

  // body (optional intro text)
  const body =
    typeof args["body"] === "string" && args["body"].trim().length > 0
      ? args["body"]
      : undefined;

  // html_body (optional)
  const htmlBody =
    typeof args["html_body"] === "string" ? args["html_body"] : undefined;

  // include_attachments (optional, default false)
  const includeAttachments = args["include_attachments"] === true;

  // include_signature (optional, default true) — explicit false suppresses the
  // inbox signature on this forward's intro.
  const includeSignature = args["include_signature"] === false ? false : undefined;

  // ── RFC 5322 email address validation ─────────────────────────────────────
  const addrChecks: Array<{ field: string; addr: unknown }> = [
    ...to.map((addr) => ({ field: "to", addr })),
    ...cc.map((addr) => ({ field: "cc", addr })),
    ...bcc.map((addr) => ({ field: "bcc", addr })),
  ];

  for (const { field, addr } of addrChecks) {
    if (typeof addr !== "string" || !isValidEmailAddress(addr)) {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `email_forward: invalid email address in '${field}': "${String(addr)}". ` +
              "All addresses must be valid RFC 5322 email addresses (e.g., user@example.com).",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "invalid_recipient",
      };
    }
  }

  // ── Scope check (belt-and-suspenders) ────────────────────────────────────
  if (!apiKey.scopes.includes("send:email")) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_forward: the 'send:email' scope is required to forward messages.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "scope_denied",
    };
  }

  // ── Inbox resolution + access control ────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_forward");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch ─────────────────────────────────────────────────────
  const fwdParams: ForwardEmailParams = {
    to,
    cc,
    bcc,
    body,
    htmlBody,
    includeAttachments,
    include_signature: includeSignature,
  };

  let fwdResult: ForwardEmailResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        fwdResult = await forwardGmailMessage(inbox, messageId, fwdParams);
        break;
      case "outlook":
        fwdResult = await forwardOutlookMessage(inbox, messageId, fwdParams);
        break;
      case "fastmail":
        fwdResult = await forwardFastmailMessage(inbox, messageId, fwdParams);
        break;
      case "imap":
        fwdResult = await forwardImapMessage(inbox, messageId, fwdParams);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_forward. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "message_not_found") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Message ${messageId} not found in inbox ${inboxId}. ` +
              "It may have been deleted or moved. Use email_list or email_search " +
              "to find the current message ID.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "message_not_found",
      };
    }

    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "forward via");
    }

    if (message === "quota_exceeded") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Forward not sent: the daily send quota for the ${inbox.provider} ` +
              "account has been reached. Please try again tomorrow.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "quota_exceeded",
      };
    }

    // Unknown provider error — do not include raw error detail.
    console.error("[mcp-server] email_forward: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text:
            `An error occurred while forwarding the message via ${inbox.provider}. ` +
            "The message may or may not have been delivered. " +
            "Do not retry automatically to avoid duplicate delivery.",
        }],
        isError: true,
        // @ts-ignore — delivery_status is an extension field per the MCP tool design doc.
        delivery_status: "unknown",
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(fwdResult as unknown as Record<string, unknown>),
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_reply — top-level handler
// ---------------------------------------------------------------------------

/**
 * Executes the `email_reply` tool end-to-end.
 *
 * Validates and normalises arguments, resolves the inbox, checks scope,
 * fetches the original message to derive threading headers and recipients,
 * and dispatches to the correct provider (Gmail / Outlook / Fastmail JMAP).
 *
 * Never throws — all errors are captured as structured ToolErrors.
 *
 * Security considerations:
 *  - Requires `send:email` scope (belt-and-suspenders check in addition to
 *    middleware enforcement).
 *  - Total recipient cap of 50 to prevent accidental mass reply-all.
 *  - Original message threading headers (In-Reply-To, References) are derived
 *    from the provider — callers cannot inject arbitrary headers.
 *  - Same provider_error / delivery_status caution as email_send applies.
 */
async function executeReplyToEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_reply: arguments must be an object with inbox_id, message_id, and body.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // message_id (required)
  const messageId =
    typeof args["message_id"] === "string" && args["message_id"].length > 0
      ? args["message_id"]
      : null;
  if (!messageId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_reply: message_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // body (required, non-empty)
  const body =
    typeof args["body"] === "string" && args["body"].trim().length > 0
      ? args["body"]
      : null;
  if (!body) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_reply: body is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // html_body (optional)
  const htmlBody =
    typeof args["html_body"] === "string" ? args["html_body"] : undefined;

  // reply_all (optional, default false)
  const replyAll = args["reply_all"] === true;

  // include_signature (optional, default true) — explicit false suppresses the
  // inbox signature for this reply (e.g. terse one-line replies).
  const includeSignature = args["include_signature"] === false ? false : undefined;

  // attachments (optional, default [])
  const attachmentsRaw = args["attachments"];
  const attachments: Array<{ filename: string; mime_type: string; data: string }> = [];

  if (attachmentsRaw !== undefined && attachmentsRaw !== null) {
    if (!Array.isArray(attachmentsRaw)) {
      return {
        result: {
          content: [{
            type: "text",
            text: "email_reply: attachments must be an array when provided.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      };
    }
    if (attachmentsRaw.length > 20) {
      return {
        result: {
          content: [{
            type: "text",
            text: "email_reply: attachments must not exceed 20 items per call.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      };
    }

    // Validate each attachment and compute total size.
    let totalBytes = 0;
    for (const att of attachmentsRaw) {
      if (
        typeof att !== "object" ||
        att === null ||
        typeof (att as Record<string, unknown>)["filename"] !== "string" ||
        typeof (att as Record<string, unknown>)["mime_type"] !== "string" ||
        typeof (att as Record<string, unknown>)["data"] !== "string"
      ) {
        return {
          result: {
            content: [{
              type: "text",
              text: "email_reply: each attachment must have filename (string), mime_type (string), and data (base64 string) fields.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "-32602",
        };
      }
      const a = att as { filename: string; mime_type: string; data: string };
      // Approximate decoded byte count from base64 length.
      totalBytes += Math.floor(a.data.replace(/\s/g, "").length * 0.75);
      if (totalBytes > SEND_MAX_ATTACHMENT_BYTES) {
        return {
          result: {
            content: [{
              type: "text",
              text:
                "email_reply: total attachment size exceeds the 10 MB limit. " +
                "Reduce attachment sizes or split into multiple messages.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "attachment_too_large",
        };
      }
      attachments.push(a);
    }
  }

  // ── Scope check (belt-and-suspenders) ────────────────────────────────────
  if (!apiKey.scopes.includes("send:email")) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_reply: the 'send:email' scope is required to send replies.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "scope_denied",
    };
  }

  // ── Inbox resolution + access control ────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_reply");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch ─────────────────────────────────────────────────────
  const replyParams: ReplyToEmailParams = {
    body,
    htmlBody,
    replyAll,
    attachments,
    include_signature: includeSignature,
  };

  let replyResult: ReplyToEmailResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        replyResult = await replyGmailMessage(inbox, messageId, replyParams);
        break;
      case "outlook":
        replyResult = await replyOutlookMessage(inbox, messageId, replyParams);
        break;
      case "fastmail":
        replyResult = await replyFastmailMessage(inbox, messageId, replyParams);
        break;
      case "imap":
        replyResult = await replyImapMessage(inbox, messageId, replyParams);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_reply. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "message_not_found") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Message ${messageId} not found in inbox ${inboxId}. ` +
              "It may have been deleted or moved. Use email_list or email_search " +
              "to find the current message ID.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "message_not_found",
      };
    }

    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "send reply via");
    }

    if (message === "quota_exceeded") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Reply not sent: the daily send quota for the ${inbox.provider} ` +
              "account has been reached. Please try again tomorrow.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "quota_exceeded",
      };
    }

    if (
      message.startsWith(
        "email_reply: could not determine reply recipients",
      )
    ) {
      return {
        result: {
          content: [{ type: "text", text: message }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "message_not_found",
      };
    }

    // Unknown provider error — do not include raw error detail.
    console.error("[mcp-server] email_reply: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text:
            `An error occurred while sending the reply via ${inbox.provider}. ` +
            "The message may or may not have been delivered. " +
            "Do not retry automatically to avoid duplicate delivery.",
        }],
        isError: true,
        // @ts-ignore — delivery_status is an extension field per the MCP tool design doc.
        delivery_status: "unknown",
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(replyResult as unknown as Record<string, unknown>),
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_send — top-level handler
// ---------------------------------------------------------------------------

/** Maximum total attachment size across all attachments in one send call. */
const SEND_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Executes the `email_send` tool end-to-end.
 *
 * Validates and normalises all arguments, checks email address syntax,
 * enforces attachment size limits, resolves the inbox, dispatches to the
 * correct provider (Gmail API / Microsoft Graph / Fastmail JMAP), and
 * returns a structured SendEmailResult.
 *
 * Never throws — all errors are captured as structured ToolErrors with an
 * appropriate errorCode so MCP clients receive a valid JSON-RPC response.
 *
 * Security considerations:
 *  - Every address in to/cc/bcc/reply_to is validated before any provider
 *    call. Invalid addresses return invalid_recipient before any I/O.
 *  - Subject and body are not parsed for recipient addresses (prevents header
 *    injection from agent-generated content).
 *  - html_body is NOT sanitized before sending (caller responsibility).
 *  - provider_error after a send attempt includes delivery_status: "unknown"
 *    — callers must not retry automatically to avoid duplicate delivery.
 */
async function executeSendEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: arguments must be an object with at least inbox_id, to, subject, and body.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // to (required, non-empty array, max 50)
  const toRaw = args["to"];
  if (!Array.isArray(toRaw) || toRaw.length === 0) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: to is required and must be a non-empty array of email address strings.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  if (toRaw.length > 50) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: to must not exceed 50 recipients per RFC 5322 / provider limits.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const to = toRaw as string[];

  // cc (optional, default [])
  const ccRaw = args["cc"];
  const cc: string[] = Array.isArray(ccRaw) ? (ccRaw as string[]) : [];

  // bcc (optional, default [])
  const bccRaw = args["bcc"];
  const bcc: string[] = Array.isArray(bccRaw) ? (bccRaw as string[]) : [];

  // subject (required, 1–998 chars)
  const subjectRaw = args["subject"];
  if (typeof subjectRaw !== "string" || subjectRaw.trim().length === 0) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: subject is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  if (subjectRaw.length > 998) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: subject must not exceed 998 characters (RFC 5322 limit).",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const subject = subjectRaw;

  // body (required, non-empty)
  const bodyRaw = args["body"];
  if (typeof bodyRaw !== "string" || bodyRaw.trim().length === 0) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_send: body is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const body = bodyRaw;

  // html_body (optional)
  const htmlBody = typeof args["html_body"] === "string"
    ? args["html_body"]
    : undefined;

  // attachments (optional, max 20, total ≤10 MB)
  const attachmentsRaw = args["attachments"];
  const attachments: Array<{ filename: string; mime_type: string; data: string }> = [];

  if (Array.isArray(attachmentsRaw)) {
    if (attachmentsRaw.length > 20) {
      return {
        result: {
          content: [{
            type: "text",
            text: "email_send: attachments must not exceed 20 items per call.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      };
    }

    let totalBytes = 0;
    for (const att of attachmentsRaw) {
      if (
        typeof att !== "object" ||
        att === null ||
        typeof (att as Record<string, unknown>)["filename"] !== "string" ||
        typeof (att as Record<string, unknown>)["mime_type"] !== "string" ||
        typeof (att as Record<string, unknown>)["data"] !== "string"
      ) {
        return {
          result: {
            content: [{
              type: "text",
              text: "email_send: each attachment must be an object with filename (string), mime_type (string), and data (base64 string) fields.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "-32602",
        };
      }
      const attObj = att as { filename: string; mime_type: string; data: string };
      // Estimate decoded byte size from base64 length (3 bytes per 4 chars).
      const cleanData = attObj.data.replace(/\s/g, "");
      const estimatedBytes = Math.ceil(cleanData.length * 3 / 4);
      totalBytes += estimatedBytes;
      if (totalBytes > SEND_MAX_ATTACHMENT_BYTES) {
        return {
          result: {
            content: [{
              type: "text",
              text:
                "email_send: total attachment size exceeds the 10 MB limit. " +
                "Reduce attachment sizes or split into multiple messages.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "attachment_too_large",
        };
      }
      attachments.push(attObj);
    }
  }

  // reply_to (optional)
  const replyTo = typeof args["reply_to"] === "string" ? args["reply_to"] : undefined;

  // ── RFC 5322 email address validation ─────────────────────────────────────
  // All recipient addresses (and reply_to) are validated before any provider
  // call. This prevents misaddressed emails caused by agent hallucination and
  // ensures errors are surfaced immediately rather than after a partial send.
  const addrChecks: Array<{ field: string; addr: unknown }> = [
    ...to.map((addr) => ({ field: "to", addr })),
    ...cc.map((addr) => ({ field: "cc", addr })),
    ...bcc.map((addr) => ({ field: "bcc", addr })),
    ...(replyTo !== undefined ? [{ field: "reply_to", addr: replyTo }] : []),
  ];

  for (const { field, addr } of addrChecks) {
    if (typeof addr !== "string" || !isValidEmailAddress(addr)) {
      return {
        result: {
          content: [{
            type: "text",
            text:
              `email_send: invalid email address in '${field}': "${String(addr)}". ` +
              "All addresses must be valid RFC 5322 email addresses (e.g., user@example.com).",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "invalid_recipient",
      };
    }
  }

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_send");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch ─────────────────────────────────────────────────────
  const sendParams: SendEmailParams = {
    to,
    cc,
    bcc,
    subject,
    textBody: body,
    htmlBody,
    attachments,
    replyTo,
  };

  // Append the per-inbox signature to this new message before it is serialized
  // by buildMimeMessage(). Single injection point for all four providers;
  // reply/forward placement is handled separately (their own execute fns).
  // include_signature: false (per-call override) suppresses it; omitting the
  // flag preserves the Phase 0 default of always signing.
  const includeSignature = args["include_signature"] === false ? false : undefined;
  applySignature(sendParams, inbox, { include_signature: includeSignature });

  let sendResult: SendEmailResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        sendResult = await sendGmailMessage(inbox, sendParams);
        break;
      case "outlook":
        sendResult = await sendOutlookMessage(inbox, sendParams);
        break;
      case "fastmail":
        sendResult = await sendFastmailMessage(inbox, sendParams);
        break;
      case "imap":
        sendResult = await sendImapMessage(inbox, sendParams);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_send. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "quota_exceeded") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              "Your email account has exceeded its sending quota. " +
              "Please try again tomorrow or check your account's daily send limits.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "quota_exceeded",
      };
    }

    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }

    // Unknown provider error — log it but do NOT include raw error detail
    // in the response (may contain provider internals or account info).
    console.error("[mcp-server] email_send: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });

    return {
      result: {
        content: [{
          type: "text",
          // Warn caller not to retry automatically — the message may have been delivered.
          text:
            `Provider error while sending email: ${message}. ` +
            "The message delivery status is unknown — do NOT retry automatically " +
            "as this may result in duplicate sends. Check your Sent folder to " +
            "confirm whether the message was delivered.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── Success ───────────────────────────────────────────────────────────────
  return {
    result: { ...jsonOk(sendResult as unknown as Record<string, unknown>), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_search — shared output types
// ---------------------------------------------------------------------------

/**
 * A single email summary in a `email_search` result.
 * Extends EmailSummary with an optional provider relevance score.
 */
interface SearchEmailSummary extends EmailSummary {
  /**
   * Provider relevance score, if available.
   * Outlook Graph may return a score for $search results; Gmail and IMAP/JMAP
   * providers do not expose one, so this is null for those providers.
   */
  relevance_score: number | null;
}

interface SearchEmailsResult {
  messages: SearchEmailSummary[];
  /**
   * Total number of messages matching the query. Exact for IMAP and Fastmail;
   * an estimate for Gmail (see `total_is_estimate`); `null` when the provider
   * cannot supply a count (Outlook without `@odata.count`).
   */
  total: number | null;
  /** True when `total` is a provider estimate rather than an exact count. */
  total_is_estimate?: boolean;
  has_more: boolean;
  next_offset: number;
  /** The query as received (providers do not expose a normalized form). */
  query_normalized: string;
}

// ---------------------------------------------------------------------------
// Gmail provider — email_search
// ---------------------------------------------------------------------------

/**
 * Implements `email_search` for Gmail.
 *
 * Uses the Gmail messages.list `q` parameter, which accepts the full Gmail
 * search operator syntax (from:, to:, subject:, after:, before:, has:, etc.).
 * Provider-native search executes server-side; only matching IDs are returned
 * in the first response, then metadata is fetched in parallel.
 *
 * Timeout is enforced by the caller (executeSearchEmails) via Promise.race.
 */
async function searchGmailMessages(
  inbox: InboxRow,
  search: NormalizedSearch,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  const accessToken = await withFreshGmailToken(inbox);

  const q = toGmailQuery(search);

  const fetchCount = Math.min(offset + limit, 100);
  const params = new URLSearchParams({
    q,
    maxResults: String(fetchCount),
  });

  // When include_folders contains exactly one folder, restrict to that label.
  // Multiple folders are not supported by Gmail's single-labelIds filter;
  // if more than one is given, fall back to full-inbox search (consistent with
  // the architecture doc: "Gmail searches the entire inbox regardless").
  if (includeFolders.length === 1) {
    params.set("labelIds", gmailFolderToLabel(includeFolders[0]));
  }

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!listResp.ok) {
    if (listResp.status === 401) throw new Error("gmail_auth_failed");
    const errBody = (await listResp.json()) as {
      error?: { message?: string };
    };
    throw new Error(
      `Gmail API error: ${errBody.error?.message ?? listResp.statusText}`,
    );
  }

  const listData = (await listResp.json()) as {
    messages?: { id: string; threadId: string }[];
    resultSizeEstimate?: number;
    nextPageToken?: string;
  };

  const allRefs = listData.messages ?? [];
  // Gmail's resultSizeEstimate is an approximation, not an exact count.
  const total = listData.resultSizeEstimate ?? allRefs.length;
  const hasMore =
    !!listData.nextPageToken || allRefs.length > offset + limit;

  const pageRefs = allRefs.slice(offset, offset + limit);

  if (pageRefs.length === 0) {
    return {
      messages: [],
      total,
      total_is_estimate: true,
      has_more: hasMore,
      next_offset: offset + limit,
      query_normalized: q,
    };
  }

  // Fetch message metadata in parallel.
  const metaResults = await Promise.all(
    pageRefs.map(({ id }) => {
      const mp = new URLSearchParams({ format: "metadata" });
      for (const h of ["From", "To", "Subject", "Date"]) {
        mp.append("metadataHeaders", h);
      }
      return fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${mp}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((r) => r.json() as Promise<GmailMessageMeta>);
    }),
  );

  const messages: SearchEmailSummary[] = metaResults.map((msg, i) => {
    const hdrs: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) {
      hdrs[h.name.toLowerCase()] = h.value;
    }
    // Determine which folder/label the message belongs to.
    const labelIds = msg.labelIds ?? [];
    const folder = includeFolders.length === 1
      ? includeFolders[0]
      : labelIds.includes("INBOX")
      ? "INBOX"
      : labelIds.find((l) =>
          ["SENT", "DRAFT", "TRASH", "SPAM"].includes(l)
        ) ?? "INBOX";
    return {
      id: msg.id ?? pageRefs[i].id,
      from: parseEmailAddress(hdrs["from"] ?? ""),
      to: parseAddressList(hdrs["to"] ?? ""),
      subject: hdrs["subject"] ?? "(no subject)",
      date: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
      preview: normalizePreview(msg.snippet ?? ""),
      is_read: !labelIds.includes("UNREAD"),
      has_attachments: gmailHasAttachments(msg),
      folder,
      thread_id: msg.threadId ?? pageRefs[i].threadId,
      relevance_score: null,
    };
  });

  return {
    messages,
    total,
    total_is_estimate: true,
    has_more: hasMore,
    next_offset: offset + limit,
    query_normalized: q,
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — email_search
// ---------------------------------------------------------------------------

/**
 * Implements `email_search` for Outlook using Microsoft Graph.
 *
 * Uses the `$search` OData operator which supports KQL (Keyword Query Language)
 * queries. KQL is a superset of simple keyword search and supports field-scoped
 * queries such as `from:alice@example.com` and `subject:report`.
 *
 * When `include_folders` is non-empty, the search is scoped per-folder by
 * issuing a request against `/me/mailFolders/{folder}/messages` for each
 * listed folder and merging the results. This increases API call count but
 * respects the folder constraint as faithfully as Graph allows.
 *
 * Note: Graph `$search` requires `ConsistencyLevel: eventual` and does NOT
 * support `$count=true` alongside `$search` on the messages resource (Graph
 * rejects the request). We therefore report `total: null` (unknown) rather
 * than fabricate a count.
 */
async function searchOutlookMessages(
  inbox: InboxRow,
  search: NormalizedSearch,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  const accessToken = await withFreshOutlookToken(inbox);

  const select =
    "id,conversationId,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments,parentFolderId";

  // Build the base URL. Scope to folder when include_folders has exactly one entry.
  let baseUrl: string;
  if (includeFolders.length === 1) {
    const folderName = outlookWellKnownFolder(includeFolders[0]);
    baseUrl =
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folderName}/messages`;
  } else {
    baseUrl = "https://graph.microsoft.com/v1.0/me/messages";
  }

  // Graph CANNOT combine $search and $filter on /messages, so pick exactly one
  // (per search-translate.ts policy): prefer $search when free-text criteria
  // exist, else fall back to $filter. $count works with $filter (yielding an
  // exact total) but NOT with $search.
  const { search: kql, filter } = toGraphSearch(search);

  // Graph rejects $skip when combined with $search, so page client-side: fetch
  // the first (offset + limit) matches and slice the requested window. Capped
  // at Graph's max page size for $search.
  const fetchTop = Math.min(offset + limit, 1000);
  const params = new URLSearchParams({
    $select: select,
    $top: String(fetchTop),
  });

  // Human-readable echo of what we actually sent to the provider.
  let queryNormalized = "";
  if (kql) {
    params.set("$search", `"${kql}"`);
    queryNormalized = kql;
  } else if (filter) {
    // $count works alongside $filter (but not $search), giving an exact total.
    params.set("$filter", filter);
    params.set("$count", "true");
    queryNormalized = filter;
  }
  // else: neither — list without $search/$filter (match all).

  const resp = await fetch(`${baseUrl}?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: "eventual",
    },
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    const errBody = (await resp.json()) as { error?: { message?: string } };
    const errMsg = errBody.error?.message ?? resp.statusText;
    // Graph returns 400 with "InequalityNotSupported" or similar when the
    // $search syntax is invalid — surface this as invalid_query.
    if (resp.status === 400) throw new Error(`outlook_invalid_query: ${errMsg}`);
    throw new Error(`Outlook Graph API error: ${errMsg}`);
  }

  const data = (await resp.json()) as {
    value?: OutlookMessage[];
    "@odata.count"?: number;
    "@odata.nextLink"?: string;
  };

  const rawMessages = data.value ?? [];
  const hasMore = !!data["@odata.nextLink"];
  // Graph's $search returns results in relevance order (and $orderby cannot be
  // combined with $search), so a recent message can rank below an older keyword
  // match. Sort the fetched window by received date descending before slicing
  // the page so results are newest-first, matching the other providers.
  const orderedMessages = rawMessages.slice().sort((a, b) => {
    const da = Date.parse(a.receivedDateTime ?? "");
    const db = Date.parse(b.receivedDateTime ?? "");
    const va = Number.isFinite(da) ? da : -Infinity;
    const vb = Number.isFinite(db) ? db : -Infinity;
    return vb - va;
  });
  const pageMessages = orderedMessages.slice(offset, offset + limit);
  // With $filter we requested $count=true and Graph returns an exact total via
  // @odata.count. With $search, Graph rejects $count, so total stays null
  // (unknown) rather than fabricated.
  const total = data["@odata.count"] ?? null;

  const folder = includeFolders.length === 1 ? includeFolders[0] : "INBOX";
  const messages: SearchEmailSummary[] = pageMessages.map((msg) => ({
    id: msg.id,
    from: {
      name: msg.from?.emailAddress?.name ?? "",
      email: msg.from?.emailAddress?.address ?? "",
    },
    to: (msg.toRecipients ?? []).map((r) => ({
      name: r.emailAddress?.name ?? "",
      email: r.emailAddress?.address ?? "",
    })),
    subject: msg.subject ?? "(no subject)",
    date: msg.receivedDateTime ?? new Date().toISOString(),
    preview: normalizePreview(msg.bodyPreview ?? ""),
    is_read: msg.isRead ?? true,
    has_attachments: msg.hasAttachments ?? false,
    folder,
    thread_id: msg.conversationId ?? msg.id,
    relevance_score: null,
  }));

  return {
    messages,
    total,
    // $filter+$count yields an exact total; otherwise total is null (unknown).
    total_is_estimate: false,
    has_more: hasMore,
    next_offset: offset + limit,
    query_normalized: queryNormalized,
  };
}

// ---------------------------------------------------------------------------
// Fastmail provider — email_search (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `email_search` for Fastmail using JMAP (RFC 8620/8621).
 *
 * JMAP's `Email/query` accepts a `filter` object with a `text` field that
 * performs a provider-native full-text search across subject, from, to, cc,
 * bcc, body, and attachment text simultaneously. Fastmail's search engine is
 * mature and handles the query as a whitespace-tokenised set of keywords.
 *
 * When `include_folders` is non-empty, additional mailbox ID filters are
 * resolved in a preliminary `Mailbox/query` call and passed as `inMailbox`
 * constraints. When empty, the search is inbox-wide.
 *
 * Auth: Bearer token (OAuth) or Basic (app-password), same as listFastmailMessages.
 */
async function searchFastmailMessages(
  inbox: InboxRow,
  search: NormalizedSearch,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  // Build auth header.
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Step 1: Discover JMAP session.
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }

  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };

  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";

  if (!accountId) {
    throw new Error("Fastmail JMAP: could not determine accountId from session.");
  }

  // JMAP role map (same as listFastmailMessages).
  const JMAP_ROLE_MAP: Record<string, string> = {
    INBOX: "inbox",
    SENT: "sent",
    DRAFTS: "drafts",
    DRAFT: "drafts",
    TRASH: "trash",
    SPAM: "junk",
    JUNK: "junk",
    ARCHIVE: "archive",
  };

  // Build the Email/query filter from the normalized search criteria.
  // toJmapFilter returns either {} (no criteria), a single FilterCondition, or
  // a { operator:"AND", conditions:[…] } FilterOperator. `raw` is ignored for
  // JMAP (no free-form query-string escape hatch).
  const translatedFilter = toJmapFilter(search);

  // Step 2: If include_folders is non-empty, resolve the first folder to a
  // mailbox ID and capture it as an `inMailbox` constraint.
  // We use only the first folder: JMAP's `inMailbox` takes a single ID, and
  // multi-folder union search would require `inMailboxOtherThan` plus a separate
  // query-merge, which is outside the scope of this tool.
  let mailboxConstraint: Record<string, unknown> | null = null;
  let resolvedFolder: string | null = null;
  if (includeFolders.length > 0) {
    resolvedFolder = includeFolders[0];
    const mailboxRole = JMAP_ROLE_MAP[resolvedFolder.toUpperCase()];

    const mailboxQueryBody = {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Mailbox/query",
          {
            accountId,
            filter: mailboxRole
              ? { role: mailboxRole }
              : { name: resolvedFolder },
            limit: 1,
          },
          "m",
        ],
      ],
    };

    const mbResp = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(mailboxQueryBody),
    });

    if (mbResp.ok) {
      const mbData = (await mbResp.json()) as {
        methodResponses?: [string, Record<string, unknown>, string][];
      };
      const mbResult = mbData.methodResponses?.find(([n]) => n === "Mailbox/query");
      const mbIds = (mbResult?.[1] as { ids?: string[] } | undefined)?.ids ?? [];
      if (mbIds.length > 0) {
        mailboxConstraint = { inMailbox: mbIds[0] };
      }
    }
    // If mailbox resolution fails, fall through to full-inbox search.
  }

  // AND-combine the translated filter with the mailbox constraint:
  //  - both present → { operator:"AND", conditions:[…translated…, mailbox] }
  //    (flatten when the translated filter is itself an AND operator)
  //  - only translated criteria → use them directly
  //  - only a mailbox constraint → use it directly
  //  - neither → omit the filter entirely (match all)
  const hasTranslated = Object.keys(translatedFilter).length > 0;
  let emailFilter: Record<string, unknown> | undefined;
  if (hasTranslated && mailboxConstraint) {
    const isAndOp = translatedFilter["operator"] === "AND" &&
      Array.isArray(translatedFilter["conditions"]);
    const baseConditions = isAndOp
      ? (translatedFilter["conditions"] as Record<string, unknown>[])
      : [translatedFilter];
    emailFilter = {
      operator: "AND",
      conditions: [...baseConditions, mailboxConstraint],
    };
  } else if (hasTranslated) {
    emailFilter = translatedFilter;
  } else if (mailboxConstraint) {
    emailFilter = mailboxConstraint;
  } else {
    emailFilter = undefined;
  }

  // Step 3: Run Email/query with text filter, then Email/get for metadata.
  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          // Omit `filter` (undefined) for a match-all query.
          ...(emailFilter ? { filter: emailFilter } : {}),
          sort: [{ property: "receivedAt", isAscending: false }],
          position: offset,
          limit,
          calculateTotal: true,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": {
            resultOf: "q",
            name: "Email/query",
            path: "/ids",
          },
          properties: [
            "id",
            "threadId",
            "subject",
            "from",
            "to",
            "receivedAt",
            "preview",
            "keywords",
            "hasAttachment",
          ],
        },
        "g",
      ],
    ],
  };

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });

  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP error: ${apiResp.statusText}`);
  }

  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };

  const responses = apiData.methodResponses ?? [];
  const queryResp = responses.find(([n]) => n === "Email/query");
  const getResp = responses.find(([n]) => n === "Email/get");

  if (!queryResp || !getResp) {
    throw new Error("Fastmail JMAP returned unexpected response structure.");
  }

  const queryResult = queryResp[1] as { total?: number };
  const getResult = getResp[1] as {
    list?: {
      id: string;
      threadId?: string;
      subject?: string;
      from?: { name?: string; email?: string }[];
      to?: { name?: string; email?: string }[];
      receivedAt?: string;
      preview?: string;
      keywords?: Record<string, boolean>;
      hasAttachment?: boolean;
    }[];
  };

  const total = queryResult.total ?? 0;
  const emailList = getResult.list ?? [];
  const hasMore = offset + limit < total;
  const folder = resolvedFolder ?? "INBOX";

  const messages: SearchEmailSummary[] = emailList.map((email) => ({
    id: email.id,
    from: email.from?.[0]
      ? { name: email.from[0].name ?? "", email: email.from[0].email ?? "" }
      : { name: "", email: "" },
    to: (email.to ?? []).map((r) => ({
      name: r.name ?? "",
      email: r.email ?? "",
    })),
    subject: email.subject ?? "(no subject)",
    date: email.receivedAt ?? new Date().toISOString(),
    preview: normalizePreview(email.preview ?? ""),
    is_read: !!(email.keywords?.["$seen"]),
    has_attachments: email.hasAttachment ?? false,
    folder,
    thread_id: email.threadId ?? email.id,
    relevance_score: null,
  }));

  return {
    messages,
    total,
    // JMAP calculateTotal:true yields an exact total.
    total_is_estimate: false,
    has_more: hasMore,
    next_offset: offset + limit,
    // Echo the JMAP filter we actually sent (or "all" when unfiltered).
    query_normalized: emailFilter ? JSON.stringify(emailFilter) : "all",
  };
}

// ---------------------------------------------------------------------------
// email_search — top-level handler
// ---------------------------------------------------------------------------

/** Search timeout: 30 seconds, matching the architecture doc specification. */
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Build a `NormalizedSearch` from a tool's raw arguments, shared by
 * email_search / email_search_and_move / email_search_and_delete.
 *
 * - String fields (from/to/cc/subject/body/text) are included when a non-empty
 *   string.
 * - `unread` is included when strictly `true` or `false`; `has_attachment` and
 *   `flagged` only when truthy (only `true` is meaningful).
 * - `since`/`before` ISO strings are validated via parseIsoDate; an invalid
 *   value yields an error.
 * - `query` (legacy) maps to `raw`.
 *
 * Returns either the built search, or a `{ field }` indicating which date arg
 * failed validation. The empty-criteria check is left to the caller (the error
 * text differs per tool only by name, but we centralise it here too).
 */
function buildNormalizedSearch(
  args: Record<string, unknown>,
):
  | { ok: true; search: NormalizedSearch; empty: boolean }
  | { ok: false; badDate: "since" | "before" } {
  const search: NormalizedSearch = {};

  const str = (k: string): string | undefined => {
    const v = args[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    return undefined;
  };

  const from = str("from");
  if (from) search.from = from;
  const to = str("to");
  if (to) search.to = to;
  const cc = str("cc");
  if (cc) search.cc = cc;
  const subject = str("subject");
  if (subject) search.subject = subject;
  const body = str("body");
  if (body) search.body = body;
  const text = str("text");
  if (text) search.text = text;

  if (args["unread"] === true) search.unread = true;
  else if (args["unread"] === false) search.unread = false;

  if (args["has_attachment"] === true) search.has_attachment = true;
  if (args["flagged"] === true) search.flagged = true;

  // Dates: validate by parsing; keep the raw ISO string on success.
  const since = str("since");
  if (since) {
    try {
      parseIsoDate(since);
    } catch {
      return { ok: false, badDate: "since" };
    }
    search.since = since;
  }
  const before = str("before");
  if (before) {
    try {
      parseIsoDate(before);
    } catch {
      return { ok: false, badDate: "before" };
    }
    search.before = before;
  }

  // Legacy free-text query → raw escape hatch.
  const raw = str("query");
  if (raw) search.raw = raw;

  const empty = Object.keys(search).length === 0;
  return { ok: true, search, empty };
}

/** Standard tool error for an invalid ISO date argument. */
function invalidSearchDateError(
  field: "since" | "before",
): {
  result: { content: { type: string; text: string }[]; isError: boolean };
  logStatus: "error";
  logErrorCode: string;
} {
  return {
    result: {
      content: [{
        type: "text",
        text: `Invalid date for '${field}': expected ISO 8601 (e.g. 2026-06-01).`,
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "-32602",
  };
}

/** Standard tool error when no search criterion was provided. */
function noSearchCriterionError(): {
  result: { content: { type: string; text: string }[]; isError: boolean };
  logStatus: "error";
  logErrorCode: string;
} {
  return {
    result: {
      content: [{
        type: "text",
        text:
          "Provide at least one search criterion (e.g. from, subject, since, unread) " +
          "or a raw query string.",
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "-32602",
  };
}

/**
 * Executes the `email_search` tool end-to-end.
 *
 * Validates and normalises arguments, resolves the inbox, dispatches to the
 * correct provider's search function (Gmail `q=`, Graph `$search`, Fastmail
 * JMAP `Email/query` with `text` filter), and returns up to 100 matching
 * email summaries.
 *
 * A 30-second timeout is enforced via Promise.race. If the provider does not
 * respond within the window, `search_timeout` is returned so MCP clients can
 * prompt the user to simplify their query.
 *
 * Never throws — all errors are captured as structured ToolErrors.
 *
 * Security notes:
 *  - `query` is passed to the provider as a parameter value, never
 *    interpolated into a URL path or SQL string. No injection risk.
 *  - Maximum `limit` is capped at 100 to prevent oversized payloads.
 *  - All results are plain metadata summaries — no body content is returned.
 *    Body content is only available via email_read.
 */
async function executeSearchEmails(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Input validation ──────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_search: arguments must be an object with structured search fields or a query.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // Build the normalized, provider-agnostic search from the args.
  const built = buildNormalizedSearch(args);
  if (!built.ok) return invalidSearchDateError(built.badDate);
  if (built.empty) return noSearchCriterionError();
  const search = built.search;

  const limit = Math.min(
    Math.max(
      1,
      typeof args["limit"] === "number" ? Math.floor(args["limit"]) : 20,
    ),
    100,
  );
  const offset = Math.max(
    0,
    typeof args["offset"] === "number" ? Math.floor(args["offset"]) : 0,
  );

  // include_folders: array of strings, empty by default
  const includeFolders: string[] = Array.isArray(args["include_folders"])
    ? (args["include_folders"] as unknown[])
        .filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_search");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Provider dispatch with 30-second timeout ──────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("search_timeout")), SEARCH_TIMEOUT_MS)
  );

  let searchResult: SearchEmailsResult;
  try {
    let searchPromise: Promise<SearchEmailsResult>;
    switch (inbox.provider) {
      case "gmail":
        searchPromise = searchGmailMessages(
          inbox,
          search,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(
          inbox,
          search,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(
          inbox,
          search,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "imap":
        searchPromise = searchImapMessages(
          inbox,
          search,
          limit,
          offset,
          includeFolders,
        );
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_search. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }

    searchResult = await Promise.race([searchPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Timeout
    if (message === "search_timeout") {
      return {
        result: {
          content: [{
            type: "text",
            text:
              "Search timed out after 30 seconds. Try a simpler or more specific query.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "search_timeout",
      };
    }

    // Auth failures
    const isAuthFailure =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";

    if (isAuthFailure) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }

    // Provider-signalled invalid query (Outlook 400 responses)
    if (message.startsWith("outlook_invalid_query:")) {
      return {
        result: {
          content: [{
            type: "text",
            text:
              "The search query was rejected by the provider as invalid. " +
              "For Outlook, use KQL syntax (e.g., 'from:alice@example.com subject:report'). " +
              `Provider detail: ${message.slice("outlook_invalid_query: ".length)}`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "invalid_query",
      };
    }

    // Raw `query` escape-hatch rejected by an IMAP-family provider. The `query`
    // field is passed through to the server's native search syntax (RFC 3501
    // for IMAP), so a typo or Gmail-style operator surfaces an opaque line like
    // "UID SEARCH: Unknown argument FROM:X". Translate that into actionable
    // guidance instead of leaking the raw IMAP error.
    if (
      search.raw &&
      (inbox.provider === "imap" || inbox.provider === "fastmail") &&
      /UID SEARCH|Unknown argument|SEARCH:/i.test(message)
    ) {
      return {
        result: {
          content: [{
            type: "text",
            text:
              "The `query` field is a raw, provider-native search expression " +
              "(IMAP RFC 3501 SEARCH syntax for this inbox) and was rejected by " +
              "the mail server. Prefer the structured search fields instead — " +
              "from, to, subject, body, text, unread, since, before — which are " +
              "translated to the correct syntax for every provider. For example, " +
              'use { "from": "alice", "subject": "report", "unread": true } ' +
              "rather than a raw `query` string.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "invalid_query",
      };
    }

    console.error("[mcp-server] email_search: provider_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });

    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error while searching emails: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── Success ───────────────────────────────────────────────────────────────
  return {
    result: { ...jsonOk(searchResult as unknown as Record<string, unknown>), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — Flags & state tools
//
// Tools: email_flag, email_archive
//
// All tools are scoped under `send:email` (state-change, non-destructive).
// Each follows the same pattern as executeReadEmail:
//   input validation → resolveInbox → capability check → provider dispatch →
//   structured result (activity_log written centrally by handleToolsCall).
// ---------------------------------------------------------------------------

/** Shared result shape returned by all flag/archive tools. */
interface FlagUpdateResult {
  success: boolean;
  message_id: string;
  operation: string;
  inbox_id: string;
}

// ---------------------------------------------------------------------------
// folder_list — provider helpers + handler
// ---------------------------------------------------------------------------

/** Normalized folder/label entry returned by folder_list. */
interface FolderEntry {
  /** Provider-native folder/label ID (IMAP: mailbox name; Gmail: label ID; Outlook: folder ID; Fastmail: mailbox JMAP ID). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** 'folder' for hierarchical providers (IMAP, Outlook, Fastmail); 'label' for Gmail. */
  type: "folder" | "label";
  /** Total number of messages; null when not available. */
  total_messages: number | null;
  /** Number of unread messages; null when not available. */
  unread_messages: number | null;
}

/**
 * Lists IMAP mailboxes with per-mailbox STATUS (message counts).
 *
 * STATUS is a separate IMAP round-trip per mailbox, and `ImapClient` runs every
 * command serialized over a single socket (see its command-chain mutex), so the
 * count enrichment is inherently sequential. We therefore list EVERY mailbox
 * (never drop a folder — a dropped folder makes a valid move target look
 * nonexistent) but only fetch counts for the first IMAP_FOLDER_COUNT_LIMIT of
 * them; the rest are returned with null counts (explicit "unknown", not a
 * dropped folder). The STATUS calls run sequentially via the mutex regardless
 * of how we await them — `Promise.allSettled` just queues them onto the chain —
 * and each is bounded by the per-command read timeout, so this can neither
 * corrupt the shared buffer nor hang.
 *
 * Throws "imap_auth_failed" on credential rejection.
 */
async function imapListFolders(inbox: InboxRow): Promise<FolderEntry[]> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    const mailboxes = await client.listMailboxes();
    // Cap only the COUNT enrichment (the expensive sequential STATUS fan-out);
    // every mailbox is still returned below.
    const IMAP_FOLDER_COUNT_LIMIT = 25;
    const enrichCount = Math.min(mailboxes.length, IMAP_FOLDER_COUNT_LIMIT);
    const statuses = await Promise.allSettled(
      mailboxes.slice(0, enrichCount).map((mb) => client!.mailboxStatus(mb.name)),
    );
    return mailboxes.map((mb, i) => {
      const st = i < enrichCount ? statuses[i] : undefined;
      return {
        id: mb.name,
        name: mb.name,
        type: "folder" as const,
        total_messages: st?.status === "fulfilled" ? st.value.messages : null,
        unread_messages: st?.status === "fulfilled" ? st.value.unseen : null,
      };
    });
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Lists Gmail labels with message counts (labels.list + parallel labels.get).
 * Caps detail fetches at 30 labels.
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailListFolders(inbox: InboxRow): Promise<FolderEntry[]> {
  const accessToken = await withFreshGmailToken(inbox);

  const listResp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!listResp.ok) {
    if (listResp.status === 401) throw new Error("gmail_auth_failed");
    throw new Error(`Gmail labels.list failed: ${listResp.statusText}`);
  }
  const listData = (await listResp.json()) as {
    labels?: { id: string; name: string; type?: string }[];
  };
  // Return EVERY label — never silently drop folders (a dropped label makes a
  // valid move/rename target look nonexistent). The per-label detail fan-out
  // (message counts) is the expensive part, so only the COUNT enrichment is
  // capped: the first GMAIL_LABEL_COUNT_LIMIT labels get counts; the rest are
  // listed with null counts (explicit, not a dropped folder).
  const labels = listData.labels ?? [];
  const GMAIL_LABEL_COUNT_LIMIT = 50;
  const enrichCount = Math.min(labels.length, GMAIL_LABEL_COUNT_LIMIT);

  const detailResults = await Promise.allSettled(
    labels.slice(0, enrichCount).map(async (lbl) => {
      const dr = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(lbl.id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!dr.ok) return null;
      return dr.json() as Promise<{ messagesTotal?: number; messagesUnread?: number } | null>;
    }),
  );

  return labels.map((lbl, i) => {
    const settled = i < enrichCount ? detailResults[i] : undefined;
    const detail =
      settled && settled.status === "fulfilled"
        ? (settled as PromiseFulfilledResult<{ messagesTotal?: number; messagesUnread?: number } | null>).value
        : null;
    return {
      id: lbl.id,
      name: lbl.name,
      type: "label" as const,
      total_messages: detail?.messagesTotal ?? null,
      unread_messages: detail?.messagesUnread ?? null,
    };
  });
}

/**
 * Lists Outlook mail folders via Graph mailFolders (includes message counts).
 * Throws "outlook_auth_failed" on 401.
 */
async function outlookListFolders(inbox: InboxRow): Promise<FolderEntry[]> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    "https://graph.microsoft.com/v1.0/me/mailFolders" +
      "?$top=100&$select=id,displayName,totalItemCount,unreadItemCount",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    throw new Error(`Graph mailFolders failed: ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    value?: {
      id: string;
      displayName: string;
      totalItemCount?: number;
      unreadItemCount?: number;
    }[];
  };
  return (data.value ?? []).map((f) => ({
    id: f.id,
    name: f.displayName,
    type: "folder" as const,
    total_messages: f.totalItemCount ?? null,
    unread_messages: f.unreadItemCount ?? null,
  }));
}

/**
 * Lists Fastmail mailboxes via JMAP Mailbox/get (includes message counts).
 * Throws "fastmail_auth_failed" on 401.
 */
async function fastmailListFolders(inbox: InboxRow): Promise<FolderEntry[]> {
  const authHeader = await buildFastmailAuthHeader(inbox);

  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/get", { accountId, ids: null }, "a"],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP mailbox error: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const mailboxGetResp = data.methodResponses?.find(([n]) => n === "Mailbox/get");
  interface JmapMailboxDetail {
    id: string;
    name: string;
    totalEmails?: number;
    unreadEmails?: number;
  }
  const list =
    (mailboxGetResp?.[1] as { list?: JmapMailboxDetail[] } | undefined)?.list ?? [];
  return list.map((m) => ({
    id: m.id,
    name: m.name,
    type: "folder" as const,
    total_messages: m.totalEmails ?? null,
    unread_messages: m.unreadEmails ?? null,
  }));
}

/** Dispatches to the provider folder lister for the given inbox. */
function listFoldersForProvider(inbox: InboxRow): Promise<FolderEntry[]> {
  switch (inbox.provider) {
    case "gmail":
      return gmailListFolders(inbox);
    case "outlook":
      return outlookListFolders(inbox);
    case "fastmail":
      return fastmailListFolders(inbox);
    default: // imap and all IMAP service variants
      return imapListFolders(inbox);
  }
}

/**
 * Resolves a user-supplied destination folder (a canonical alias like "inbox"/
 * "trash", a folder/label *name* like "Receipts", or an already-valid provider
 * folder id) to the provider-native folder/label id expected by the move/copy
 * helpers. Centralizes folder addressing so agents never need a folder_list
 * round-trip just to learn an opaque id.
 *
 * Resolution order:
 *   1. Empty input → throws Error("folder_required") (callers map to a tool error).
 *   2. Canonical alias hit → provider-native value with NO network call for
 *      Gmail/Outlook/IMAP (Gmail system label id / Outlook well-known name /
 *      IMAP common name, which is its own id). Fastmail has no static id, so its
 *      alias falls through to the listing step and matches by canonical name.
 *      The Gmail `archive` alias has no system label (null) and likewise falls
 *      through (archive-as-move is unsupported; email_archive handles it).
 *   3. Otherwise list folders once and match `nameOrId` case-insensitively
 *      against each FolderEntry.name (returning that entry's id), or return it
 *      immediately if it already exactly equals some FolderEntry.id.
 *   4. No match → return `nameOrId` unchanged (best-effort pass-through: it may
 *      already be a valid provider id we don't enumerate; if not, the provider
 *      rejects it and the existing "call folder_list" error guides the agent).
 */
async function resolveFolderId(inbox: InboxRow, nameOrId: string): Promise<string> {
  const trimmed = nameOrId.trim();
  if (!trimmed) throw new Error("folder_required");

  // ── Canonical alias hit ────────────────────────────────────────────────────
  const alias = lookupCanonicalAlias(trimmed);
  if (alias) {
    switch (inbox.provider) {
      case "gmail":
        // Gmail `archive` has no system label (null) → fall through to listing.
        if (alias.gmail) return alias.gmail;
        break;
      case "outlook":
        return alias.outlook;
      case "fastmail":
        // No static id; fall through and match the mailbox by canonical name.
        break;
      default: {
        // imap — resolve the alias against the server's REAL layout via IMAP
        // SPECIAL-USE flags (one LIST). A generic IMAP account may name its
        // archive/trash/etc differently from the hard-coded English names, so
        // we can't just return alias.imap verbatim (that caused move-to-archive
        // to fail with TRYCREATE for a non-existent "Archive").
        //
        // For "archive" specifically, auto-create the mailbox when missing so
        // moving into it behaves like email_archive (and never leaks the raw
        // TRYCREATE line). Other aliases fall back to the static name when
        // unmatched (the provider validates / the existing error guides).
        const isArchive = alias.aliases[0] === "archive";
        const resolvedName = await resolveImapAliasMailbox(
          inbox,
          alias,
          { createIfMissing: isArchive },
        );
        return resolvedName ?? alias.imap;
      }
    }
  }

  // ── List once and match by name (or accept an exact id) ─────────────────────
  const folders = await listFoldersForProvider(inbox);

  // If the input already is a valid provider id, accept it verbatim.
  const byId = folders.find((f) => f.id === trimmed);
  if (byId) return byId.id;

  const lower = trimmed.toLowerCase();

  // For a Fastmail (or fell-through) alias, also try matching the canonical
  // IMAP-style name (e.g. alias "trash" → mailbox named "Trash") so role-less
  // listings still resolve common folders.
  const aliasNames = alias
    ? new Set([alias.imap.toLowerCase(), ...alias.aliases.map((a) => a.toLowerCase())])
    : null;

  const byName = folders.find((f) => {
    const fn = f.name.toLowerCase();
    return fn === lower || (aliasNames?.has(fn) ?? false);
  });
  if (byName) return byName.id;

  // ── No match → best-effort pass-through (provider validates / rejects). ─────
  return trimmed;
}

/**
 * `folder_list` handler — dispatches to the appropriate provider helper.
 *
 * Scope: read:email
 * Capability gate: caps.folders || caps.labels (covers all four providers)
 */
async function executeListFolders(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  // ── Validate args ──────────────────────────────────────────────────────────
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      result: {
        content: [{
          type: "text",
          text: "folder_list: arguments must be an object with inbox_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "folder_list");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Capability gate ────────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.folders && !caps.labels) {
    return unsupportedFeatureError("folders", inbox.provider);
  }

  // ── Per-provider dispatch ──────────────────────────────────────────────────
  let folders: FolderEntry[];
  try {
    switch (inbox.provider) {
      case "gmail":
        folders = await gmailListFolders(inbox);
        break;
      case "outlook":
        folders = await outlookListFolders(inbox);
        break;
      case "fastmail":
        folders = await fastmailListFolders(inbox);
        break;
      default: // "imap" and all IMAP service variants
        folders = await imapListFolders(inbox);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuth =
      message === "gmail_auth_failed" ||
      message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" ||
      message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    console.error("[mcp-server] folder_list: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Failed to list folders for ${inbox.provider} inbox: ${message}`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  // ── activity_log written by handleToolsCall ────────────────────────────────
  return {
    result: { ...jsonOk({ inbox_id: inbox.id, folders }, true), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// folder_create / folder_rename / folder_delete — provider helpers + handlers
// ---------------------------------------------------------------------------

// ── folder_create helpers ──────────────────────────────────────────────────

async function imapCreateFolder(inbox: InboxRow, name: string): Promise<{ id: string; name: string }> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.createMailbox(name);
    return { id: name, name };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function gmailCreateFolder(inbox: InboxRow, name: string): Promise<{ id: string; name: string }> {
  const accessToken = await withFreshGmailToken(inbox);
  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    throw new Error(`Gmail labels.create failed: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

async function outlookCreateFolder(inbox: InboxRow, name: string): Promise<{ id: string; name: string }> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    "https://graph.microsoft.com/v1.0/me/mailFolders",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: name }),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    throw new Error(`Graph mailFolders create failed: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { id: string; displayName: string };
  return { id: data.id, name: data.displayName };
}

async function fastmailCreateFolder(inbox: InboxRow, name: string): Promise<{ id: string; name: string }> {
  const authHeader = await buildFastmailAuthHeader(inbox);
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/set", { accountId, create: { new1: { name } } }, "a"],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Mailbox/set create failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Mailbox/set");
  const created = (setResp?.[1] as { created?: Record<string, { id: string }> } | undefined)?.created;
  const newId = created?.["new1"]?.id;
  if (!newId) throw new Error("Fastmail JMAP: create did not return an ID.");
  return { id: newId, name };
}

// ── folder_rename helpers ──────────────────────────────────────────────────

async function imapRenameFolder(inbox: InboxRow, folderId: string, newName: string): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.renameMailbox(folderId, newName);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function gmailRenameFolder(inbox: InboxRow, folderId: string, newName: string): Promise<void> {
  const accessToken = await withFreshGmailToken(inbox);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(folderId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: newName }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("folder_not_found");
    throw new Error(`Gmail labels.patch failed: ${resp.statusText}`);
  }
}

async function outlookRenameFolder(inbox: InboxRow, folderId: string, newName: string): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: newName }),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("folder_not_found");
    throw new Error(`Graph mailFolders PATCH failed: ${resp.statusText}`);
  }
}

async function fastmailRenameFolder(inbox: InboxRow, folderId: string, newName: string): Promise<void> {
  const authHeader = await buildFastmailAuthHeader(inbox);
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/set", { accountId, update: { [folderId]: { name: newName } } }, "a"],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Mailbox/set update failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Mailbox/set");
  const notUpdated = (setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated;
  if (notUpdated?.[folderId]) throw new Error("folder_not_found");
}

// ── folder_delete helpers ──────────────────────────────────────────────────

async function imapDeleteFolder(inbox: InboxRow, folderId: string): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.deleteMailbox(folderId);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function gmailDeleteFolder(inbox: InboxRow, folderId: string): Promise<void> {
  const accessToken = await withFreshGmailToken(inbox);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(folderId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("folder_not_found");
    throw new Error(`Gmail labels.delete failed: ${resp.statusText}`);
  }
}

async function outlookDeleteFolder(inbox: InboxRow, folderId: string): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folderId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("folder_not_found");
    throw new Error(`Graph mailFolders delete failed: ${resp.statusText}`);
  }
}

async function fastmailDeleteFolder(inbox: InboxRow, folderId: string): Promise<void> {
  const authHeader = await buildFastmailAuthHeader(inbox);
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/set", { accountId, destroy: [folderId] }, "a"],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Mailbox/set destroy failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Mailbox/set");
  const notDestroyed = (setResp?.[1] as { notDestroyed?: Record<string, unknown> } | undefined)?.notDestroyed;
  if (notDestroyed?.[folderId]) throw new Error("folder_not_found");
}

// ── Shared arg validation helper ───────────────────────────────────────────

/** Resolves inbox + validates shared folder args (inbox_id, folder_id). */
async function resolveFolderArgs(
  rawArgs: unknown,
  toolName: string,
  apiKey: ApiKeyRow,
  requireFolderId = true,
): Promise<
  | { error: { result: { content: { type: string; text: string }[]; isError?: boolean }; logStatus: "error"; logErrorCode: string }; inbox?: undefined; args?: undefined }
  | { error?: undefined; inbox: InboxRow; args: Record<string, unknown> }
> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      error: {
        result: {
          content: [{ type: "text", text: `${toolName}: arguments must be an object.` }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }
  const args = rawArgs as Record<string, unknown>;
  if (requireFolderId) {
    const folderId = typeof args["folder_id"] === "string" ? args["folder_id"] : null;
    if (!folderId) {
      return {
        error: {
          result: {
            content: [{ type: "text", text: `${toolName}: folder_id is required and must be a string.` }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "-32602",
        },
      };
    }
  }
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) {
    return { error: inboxResolutionError(resolved, toolName) };
  }
  return { inbox: resolved.inbox, args };
}

/** Shared auth/provider error handler for folder management tools. */
function folderProviderError(
  toolName: string,
  provider: string,
  inboxId: string,
  err: unknown,
): { result: { content: { type: string; text: string }[]; isError: boolean }; logStatus: "error"; logErrorCode: string } {
  const message = err instanceof Error ? err.message : String(err);
  const isAuth =
    message === "gmail_auth_failed" ||
    message === "outlook_auth_failed" ||
    message === "fastmail_auth_failed" ||
    message === "imap_auth_failed";
  if (isAuth) {
    return authFailedResult(provider, inboxId, "access");
  }
  if (message === "folder_not_found") {
    return {
      result: {
        content: [{
          type: "text",
          text: `Folder not found. Call folder_list to get valid folder IDs.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "folder_not_found",
    };
  }
  console.error(`[mcp-server] ${toolName}: provider_error`, { provider, error: message });
  return {
    result: {
      content: [{
        type: "text",
        text: `Failed to ${toolName} for ${provider} inbox: ${message}`,
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "provider_error",
  };
}

// ── folder_create handler ──────────────────────────────────────────────────

/**
 * `folder_create` handler — creates a folder/label in an inbox.
 *
 * Scope: manage:folders
 * Capability gate: caps.folders || caps.labels
 */
async function executeCreateFolder(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFolderArgs(rawArgs, "folder_create", apiKey, false);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  if (!name) {
    return {
      result: {
        content: [{ type: "text", text: "folder_create: name is required and must be a non-empty string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.folders && !caps.labels) {
    return unsupportedFeatureError("folders", inbox.provider);
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  let created: { id: string; name: string };
  try {
    switch (inbox.provider) {
      case "gmail":
        created = await gmailCreateFolder(inbox, name);
        break;
      case "outlook":
        created = await outlookCreateFolder(inbox, name);
        break;
      case "fastmail":
        created = await fastmailCreateFolder(inbox, name);
        break;
      default: // imap and all service variants
        created = await imapCreateFolder(inbox, name);
        break;
    }
  } catch (err) {
    return folderProviderError("folder_create", inbox.provider, inbox.id, err);
  }

  return {
    result: { ...jsonOk({ inbox_id: inbox.id, created }, true), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── folder_rename handler ──────────────────────────────────────────────────

/**
 * `folder_rename` handler — renames a folder/label in an inbox.
 *
 * Scope: manage:folders
 * Capability gate: caps.folders || caps.labels
 */
async function executeRenameFolder(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFolderArgs(rawArgs, "folder_rename", apiKey, true);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  const folderId = args["folder_id"] as string;
  const newName = typeof args["new_name"] === "string" ? args["new_name"].trim() : "";
  if (!newName) {
    return {
      result: {
        content: [{ type: "text", text: "folder_rename: new_name is required and must be a non-empty string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.folders && !caps.labels) {
    return unsupportedFeatureError("folders", inbox.provider);
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailRenameFolder(inbox, folderId, newName);
        break;
      case "outlook":
        await outlookRenameFolder(inbox, folderId, newName);
        break;
      case "fastmail":
        await fastmailRenameFolder(inbox, folderId, newName);
        break;
      default: // imap and all service variants
        await imapRenameFolder(inbox, folderId, newName);
        break;
    }
  } catch (err) {
    return folderProviderError("folder_rename", inbox.provider, inbox.id, err);
  }

  return {
    result: {
      ...jsonOk({
        inbox_id: inbox.id,
        folder_id: folderId,
        new_name: newName,
        status: "renamed",
      }, true),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── folder_delete handler ──────────────────────────────────────────────────

/**
 * `folder_delete` handler — permanently deletes a folder/label from an inbox.
 *
 * Scope: manage:folders
 * Capability gate: caps.folders || caps.labels
 * Destructive — irreversible (client confirms via annotations.destructiveHint).
 */
async function executeDeleteFolder(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFolderArgs(rawArgs, "folder_delete", apiKey, true);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  const folderId = args["folder_id"] as string;

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.folders && !caps.labels) {
    return unsupportedFeatureError("folders", inbox.provider);
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailDeleteFolder(inbox, folderId);
        break;
      case "outlook":
        await outlookDeleteFolder(inbox, folderId);
        break;
      case "fastmail":
        await fastmailDeleteFolder(inbox, folderId);
        break;
      default: // imap and all service variants
        await imapDeleteFolder(inbox, folderId);
        break;
    }
  } catch (err) {
    return folderProviderError("folder_delete", inbox.provider, inbox.id, err);
  }

  return {
    result: {
      ...jsonOk({
        inbox_id: inbox.id,
        folder_id: folderId,
        status: "deleted",
      }, true),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── IMAP provider helpers ──────────────────────────────────────────────────

/**
 * Sets or removes IMAP system flags on a single message.
 * The message_id must be in "<folder>:<uid>" format (from encodeImapId).
 * Throws "imap_auth_failed" on credential rejection.
 */
async function imapUpdateFlags(
  inbox: InboxRow,
  messageId: string,
  imapFlags: string[],
  mode: "add" | "remove",
): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");

  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    await client.uidStore([uid], imapFlags, mode);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Archives a single IMAP message by moving it to the account's Archive mailbox.
 *
 * The destination is resolved against the server's REAL layout (one LIST):
 * the \\Archive SPECIAL-USE folder if advertised, else a mailbox literally
 * named "Archive". When the account has neither (common on generic IMAP), a
 * top-level "Archive" mailbox is CREATEd first — mirroring how the send path
 * auto-files Sent. This avoids hard-coding "Archive" and the resulting raw
 * "[TRYCREATE] Mailbox doesn't exist: Archive" leak. The move runs only after
 * the destination exists, so a failure never destroys the source message
 * (uidMove COPYs before it STOREs \\Deleted + EXPUNGEs).
 * Throws "imap_auth_failed" on credential rejection.
 */
async function imapArchiveEmail(
  inbox: InboxRow,
  messageId: string,
): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");

  const archiveAlias = lookupCanonicalAlias("archive")!;
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    // Resolve (or create) the Archive mailbox before touching the source.
    const mailboxes = await client.listMailboxes();
    let target = matchImapAliasMailbox(mailboxes, archiveAlias);
    if (!target) {
      target = archiveAlias.imap; // "Archive"
      await client.createMailbox(target);
    }
    await client.selectMailbox(imapFolderName(folder));
    // uidMove falls back internally if MOVE is unsupported (COPY + \\Deleted +
    // EXPUNGE); the COPY runs before the destructive steps.
    await client.uidMove([uid], target);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ── Gmail provider helpers ─────────────────────────────────────────────────

/**
 * Build a clean, sanitized error message from a non-OK Gmail API response,
 * WITHOUT leaking the raw upstream JSON body into the tool result. Parses the
 * standard `{ error: { code, message, status } }` shape and returns just the
 * human-readable `message` (e.g. "Cannot both add and remove the same label"),
 * prefixed with `verb`. Falls back to the HTTP status text when the body isn't
 * the expected shape. Callers translate 401/404/429 to their own sentinels
 * BEFORE calling this — this is for the remaining (mostly permanent 4xx) cases.
 * Note: no "try again in a moment" suffix — these are permanent errors.
 */
async function gmailErrorMessage(
  verb: string,
  resp: Response,
): Promise<string> {
  let detail = resp.statusText || `HTTP ${resp.status}`;
  try {
    const errBody = (await resp.json()) as {
      error?: { message?: string };
    };
    if (errBody.error?.message) detail = errBody.error.message;
  } catch {
    // Non-JSON / empty body — keep the status text, never echo the raw body.
  }
  return `${verb}: ${detail}`;
}

/**
 * Calls the Gmail messages.modify API to add/remove label IDs.
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailModifyLabels(
  inbox: InboxRow,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  const accessToken = await withFreshGmailToken(inbox);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    // 404 = nonexistent message id (a common mistake). Map to the same
    // "message_not_found" signal the other providers emit so handleFlagError /
    // the move/flag handlers return a clean message_not_found result instead of
    // a generic provider_error.
    if (resp.status === 404) throw new Error("message_not_found");
    throw new Error(await gmailErrorMessage("Gmail modify failed", resp));
  }
}

// ── Outlook provider helpers ───────────────────────────────────────────────

/**
 * PATCHes a single Graph message resource.
 * Throws "outlook_auth_failed" on 401.
 */
async function outlookPatchMessage(
  inbox: InboxRow,
  messageId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    const body = await resp.text();
    throw new Error(`Outlook PATCH failed: ${body}`);
  }
}

/**
 * Moves an Outlook message to its archive folder via Graph.
 * Uses the well-known name "archive" as the destination.
 * Throws "outlook_auth_failed" on 401.
 */
async function outlookArchiveEmail(
  inbox: InboxRow,
  messageId: string,
): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      // "archive" is the well-known folder name recognised by Graph.
      body: JSON.stringify({ destinationId: "archive" }),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    const body = await resp.text();
    throw new Error(`Outlook move to archive failed: ${body}`);
  }
}

// ── Fastmail (JMAP) provider helpers ──────────────────────────────────────

/**
 * Sets or removes JMAP email keywords on a single message.
 * - `addKeywords`: map of keyword → true (e.g. { "$seen": true })
 * - `removeKeywords`: map of keyword → null (e.g. { "$seen": null })
 * Throws "fastmail_auth_failed" on 401.
 */
async function fastmailSetKeywords(
  inbox: InboxRow,
  messageId: string,
  addKeywords: Record<string, true>,
  removeKeywords: Record<string, null>,
): Promise<void> {
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Discover session.
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  const updatePatch: Record<string, unknown> = {};
  for (const k of Object.keys(addKeywords)) {
    updatePatch[`keywords/${k}`] = true;
  }
  for (const k of Object.keys(removeKeywords)) {
    updatePatch[`keywords/${k}`] = null;
  }

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          {
            accountId,
            update: { [messageId]: updatePatch },
          },
          "a",
        ],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP error: ${apiResp.statusText}`);
  }
}

/**
 * Archives a single Fastmail message via JMAP Email/set.
 * Looks up the archive mailbox by role then updates mailboxIds.
 * Throws "fastmail_auth_failed" on 401.
 */
async function fastmailArchiveEmail(
  inbox: InboxRow,
  messageId: string,
): Promise<void> {
  const authHeader = await buildFastmailAuthHeader(inbox);

  // Discover session.
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");

  // One round-trip: Mailbox/get + Email/set. The Mailbox/get response is
  // needed to find the archive mailbox id before we can set mailboxIds.
  // We first fetch mailboxes, then archive the message.
  const mailboxResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/get", { accountId, ids: null }, "a"],
      ],
    }),
  });
  if (!mailboxResp.ok) {
    if (mailboxResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP mailbox error: ${mailboxResp.statusText}`);
  }
  const mailboxData = (await mailboxResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const mailboxGetResp = mailboxData.methodResponses?.find(([n]) => n === "Mailbox/get");
  interface JmapMailbox {
    id: string;
    role?: string;
    name?: string;
  }
  const mailboxList = (mailboxGetResp?.[1] as { list?: JmapMailbox[] } | undefined)?.list ?? [];
  const archiveMailbox = mailboxList.find(
    (m) => m.role === "archive" || m.name?.toLowerCase() === "archive",
  );
  if (!archiveMailbox) {
    throw new Error("Fastmail archive mailbox not found — cannot archive message.");
  }

  // Now fetch the current message to know its current mailboxIds (so we can
  // replace only the inbox entry rather than wiping all mailboxes).
  const msgFetchResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/get",
          { accountId, ids: [messageId], properties: ["mailboxIds"] },
          "a",
        ],
      ],
    }),
  });
  if (!msgFetchResp.ok) {
    if (msgFetchResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP fetch error: ${msgFetchResp.statusText}`);
  }
  const msgData = (await msgFetchResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const emailGetResp = msgData.methodResponses?.find(([n]) => n === "Email/get");
  const emailList = (emailGetResp?.[1] as { list?: { mailboxIds?: Record<string, boolean> }[] } | undefined)?.list ?? [];
  const currentMailboxIds = emailList[0]?.mailboxIds ?? {};

  // Build patch: null all current mailboxes, then add archive.
  const mailboxPatch: Record<string, boolean | null> = {};
  for (const mboxId of Object.keys(currentMailboxIds)) {
    mailboxPatch[`mailboxIds/${mboxId}`] = null;
  }
  mailboxPatch[`mailboxIds/${archiveMailbox.id}`] = true;

  const archiveResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          { accountId, update: { [messageId]: mailboxPatch } },
          "a",
        ],
      ],
    }),
  });
  if (!archiveResp.ok) {
    if (archiveResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP archive failed: ${archiveResp.statusText}`);
  }
}

// ── Shared execute helper ──────────────────────────────────────────────────

/**
 * Shared input validation and inbox resolution for all flag/archive tools.
 * Returns { inbox, messageId } on success, or a structured error result.
 */
async function resolveFlagArgs(
  rawArgs: unknown,
  toolName: string,
  apiKey: ApiKeyRow,
): Promise<
  | { inbox: InboxRow; messageId: string; error?: undefined }
  | {
      error: {
        result: { content: { type: string; text: string }[]; isError: boolean };
        logStatus: "error";
        logErrorCode: string;
      };
    }
> {
  if (
    typeof rawArgs !== "object" ||
    rawArgs === null ||
    Array.isArray(rawArgs)
  ) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: arguments must be an object with inbox_id and message_id.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const messageId =
    typeof args["message_id"] === "string" ? args["message_id"].trim() : null;
  if (!messageId) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: message_id is required and must be a non-empty string.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) {
    return { error: inboxResolutionError(resolved, toolName) };
  }
  const inbox = resolved.inbox;

  return { inbox, messageId };
}

/**
 * Common error handler for flag/archive provider calls.
 * Maps auth failures and message-not-found to structured results.
 */
function handleFlagError(
  err: unknown,
  toolName: string,
  inboxId: string,
  provider: string,
  messageId: string,
): {
  result: { content: { type: string; text: string }[]; isError: boolean };
  logStatus: "error";
  logErrorCode: string;
} {
  const message = err instanceof Error ? err.message : String(err);

  if (message === "message_not_found") {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Message ${messageId} not found in inbox ${inboxId}. ` +
            "The message may have been deleted or the ID is stale — " +
            "call email_list or email_search to get current message IDs.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "message_not_found",
    };
  }

  const isAuthFailure =
    message === "gmail_auth_failed" ||
    message === "outlook_auth_failed" ||
    message === "fastmail_auth_failed" ||
    message === "imap_auth_failed";

  if (isAuthFailure) {
    return authFailedResult(provider, inboxId, "access");
  }

  console.error(`[mcp-server] ${toolName}: provider_error`, {
    inbox_id: inboxId,
    provider,
    message_id: messageId,
    error: message,
  });

  return {
    result: {
      content: [{
        type: "text",
        text: `Provider error during ${toolName}: ${message}. Please try again in a moment.`,
      }],
      isError: true,
    },
    logStatus: "error",
    logErrorCode: "provider_error",
  };
}

// ── Top-level execute functions ────────────────────────────────────────────

/** Moves a message to the archive folder across all providers. */
async function executeArchiveEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "email_archive", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  try {
    switch (inbox.provider) {
      case "gmail":
        // Gmail archive = remove INBOX label; message stays accessible via All Mail.
        await gmailModifyLabels(inbox, messageId, [], ["INBOX"]);
        break;
      case "outlook":
        await outlookArchiveEmail(inbox, messageId);
        break;
      case "fastmail":
        await fastmailArchiveEmail(inbox, messageId);
        break;
      default:
        await imapArchiveEmail(inbox, messageId);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "email_archive", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "email_archive",
    inbox_id: inbox.id,
  };
  return {
    result: { ...jsonOk(flagResult as unknown as Record<string, unknown>), isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_move — provider helpers + handlers
// ---------------------------------------------------------------------------

// ── IMAP helpers ────────────────────────────────────────────────────────────

async function imapMoveEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");

  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    // uidMove falls back to COPY + \\Deleted + EXPUNGE when RFC 6851 MOVE is
    // unsupported by the server.
    await client.uidMove([uid], destinationFolderId);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ── Gmail helper ─────────────────────────────────────────────────────────────

/**
 * Gmail "move": add the destination label and remove INBOX.
 */
async function gmailMoveEmail(
  inbox: InboxRow,
  messageId: string,
  destinationLabelId: string,
): Promise<void> {
  // NOTE: This "move" assumes the message currently lives in INBOX — it adds the
  // destination label and removes the INBOX label. Gmail's flat label model has
  // no folders, so without a source-folder hint we cannot remove an arbitrary
  // source label; if the message is NOT in INBOX this effectively acts as a
  // copy (the destination label is added, but the original label remains). A
  // general source-folder move is impossible here without knowing the source.
  const addLabelIds = [destinationLabelId];
  // Gmail rejects requests that add and remove the same label ("Cannot both add
  // and remove the same label", HTTP 400). When moving back into the inbox the
  // destination IS "INBOX", so drop any id that appears in both lists.
  const removeLabelIds = ["INBOX"].filter((id) => !addLabelIds.includes(id));
  await gmailModifyLabels(inbox, messageId, addLabelIds, removeLabelIds);
}

// ── Outlook helpers ───────────────────────────────────────────────────────────

async function outlookMoveEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ destinationId: destinationFolderId }),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    const body = await resp.text();
    throw new Error(`Graph move failed: ${body}`);
  }
}

// ── Fastmail helpers ──────────────────────────────────────────────────────────

/**
 * Resolves the Fastmail JMAP session (accountId + apiUrl).
 * Throws "fastmail_auth_failed" on 401.
 */
async function resolveFastmailSession(inbox: InboxRow): Promise<{
  authHeader: string;
  accountId: string;
  apiUrl: string;
}> {
  const authHeader = await buildFastmailAuthHeader(inbox);
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");
  return { authHeader, accountId, apiUrl };
}

/**
 * Fastmail "move": Email/set to update mailboxIds.
 * Replaces existing mailbox membership with the destination folder.
 */
async function fastmailMoveEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          {
            accountId,
            update: {
              [messageId]: {
                mailboxIds: { [destinationFolderId]: true },
              },
            },
          },
          "a",
        ],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Email/set failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated = (setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated;
  if (notUpdated?.[messageId]) throw new Error("message_not_found");
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * `email_move` handler — moves a message to the specified folder/label.
 *
 * Scope: manage:folders
 * Capability gate: caps.move
 */
async function executeMoveEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "email_move", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  // ── Validate destination_folder_id ──────────────────────────────────────
  const args = rawArgs as Record<string, unknown>;
  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_move: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  // ── Resolve destination (alias / name / id) → provider-native id ──────────
  let resolvedDest: string;
  try {
    resolvedDest = await resolveFolderId(inbox, destinationFolderId);
  } catch (_err) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_move: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailMoveEmail(inbox, messageId, resolvedDest);
        break;
      case "outlook":
        await outlookMoveEmail(inbox, messageId, resolvedDest);
        break;
      case "fastmail":
        await fastmailMoveEmail(inbox, messageId, resolvedDest);
        break;
      default: // imap and all service variants
        await imapMoveEmail(inbox, messageId, resolvedDest);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "email_move", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      ...jsonOk({
        success: true,
        message_id: messageId,
        operation: "email_move",
        inbox_id: inbox.id,
        destination_folder_id: destinationFolderId,
      }),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// email_copy — provider helpers + handlers
// ---------------------------------------------------------------------------
// Copy duplicates a message into a destination folder while leaving the source
// message untouched (unlike move, which removes the original). Gated on
// caps.copy, which is true for IMAP/Outlook/Fastmail and false for Gmail (the
// flat-label model has no native duplicate).

/**
 * IMAP copy: UID COPY the message into the destination mailbox, source untouched.
 * Throws "imap_auth_failed" on credential rejection.
 */
async function imapCopyEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");

  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    await client.uidCopy([uid], destinationFolderId);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Outlook copy: Graph messages/{id}/copy — creates a copy in the destination
 * folder, leaving the original in place. Throws "outlook_auth_failed" on 401/403.
 */
async function outlookCopyEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/copy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ destinationId: destinationFolderId }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    const body = await resp.text();
    throw new Error(`Graph copy failed: ${body}`);
  }
}

/**
 * Fastmail copy: JMAP Email/set patch that ADDS the destination mailbox to the
 * message's mailboxIds without removing existing memberships, so the message
 * appears in both the source and the destination folder.
 */
async function fastmailCopyEmail(
  inbox: InboxRow,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          {
            accountId,
            update: {
              // Patch syntax: add one mailbox membership, leave the rest intact.
              [messageId]: { [`mailboxIds/${destinationFolderId}`]: true },
            },
          },
          "a",
        ],
      ],
    }),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP Email/set failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated = (setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated;
  if (notUpdated?.[messageId]) throw new Error("message_not_found");
}

/**
 * `email_copy` handler — copies a message into the specified folder, leaving the
 * original in place.
 *
 * Scope: manage:folders
 * Capability gate: caps.copy (false for Gmail → unsupportedFeatureError)
 */
async function executeCopyEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "email_copy", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  // ── Validate destination_folder_id ──────────────────────────────────────
  const args = rawArgs as Record<string, unknown>;
  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_copy: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.copy) return unsupportedFeatureError("copy", inbox.provider);

  // ── Resolve destination (alias / name / id) → provider-native id ──────────
  let resolvedDest: string;
  try {
    resolvedDest = await resolveFolderId(inbox, destinationFolderId);
  } catch (_err) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_copy: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "outlook":
        await outlookCopyEmail(inbox, messageId, resolvedDest);
        break;
      case "fastmail":
        await fastmailCopyEmail(inbox, messageId, resolvedDest);
        break;
      default: // imap and all service variants
        await imapCopyEmail(inbox, messageId, resolvedDest);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "email_copy", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      ...jsonOk({
        success: true,
        message_id: messageId,
        operation: "email_copy",
        inbox_id: inbox.id,
        destination_folder_id: destinationFolderId,
      }),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── email_delete provider helpers ──────────────────────────────────────────

/**
 * IMAP delete: move to "Trash" (soft) or \\Deleted + UID EXPUNGE (permanent).
 * Throws "imap_auth_failed" on credential rejection.
 */
async function imapDeleteEmail(
  inbox: InboxRow,
  messageId: string,
  permanent: boolean,
): Promise<void> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(messageId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("message_not_found");

  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    if (permanent) {
      // Hard-delete: flag \\Deleted then UID EXPUNGE
      await client.uidStore([uid], ["\\Deleted"], "add");
      await client.uidExpunge([uid]);
    } else {
      // Soft-delete: move to the resolved Trash mailbox (handles namespaced/
      // localized trash like INBOX.Trash via imapFolderName). uidMove falls
      // back to COPY+EXPUNGE if RFC 6851 MOVE is unsupported.
      await client.uidMove([uid], imapFolderName("TRASH"));
    }
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Gmail delete: trash (messages.trash) or permanent (messages.delete).
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailDeleteEmail(
  inbox: InboxRow,
  messageId: string,
  permanent: boolean,
): Promise<void> {
  const accessToken = await withFreshGmailToken(inbox);
  const endpoint = permanent
    ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`
    : `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`;
  const resp = await fetch(endpoint, {
    method: permanent ? "DELETE" : "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    throw new Error(await gmailErrorMessage("Gmail delete failed", resp));
  }
}

/**
 * Outlook delete: move to Deleted Items (Graph messages/{id}/move to deleteditems)
 * or permanent (Graph messages/{id}/permanentDelete).
 * Throws "outlook_auth_failed" on 401.
 */
async function outlookDeleteEmail(
  inbox: InboxRow,
  messageId: string,
  permanent: boolean,
): Promise<void> {
  const accessToken = await withFreshOutlookToken(inbox);
  const encodedId = encodeURIComponent(messageId);
  let resp: Response;
  if (permanent) {
    resp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodedId}/permanentDelete`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  } else {
    resp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodedId}/move`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ destinationId: "deleteditems" }),
      },
    );
  }
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    const body = await resp.text();
    throw new Error(`Graph delete failed: ${body}`);
  }
}

/**
 * Fastmail delete: move to Trash mailbox (soft) or Email/set destroy (permanent).
 * Throws "fastmail_auth_failed" on 401.
 */
async function fastmailDeleteEmail(
  inbox: InboxRow,
  messageId: string,
  permanent: boolean,
): Promise<void> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  if (permanent) {
    // Hard-delete via Email/set destroy
    const apiResp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          [
            "Email/set",
            { accountId, destroy: [messageId] },
            "a",
          ],
        ],
      }),
    });
    if (!apiResp.ok) {
      if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
      throw new Error(`Fastmail JMAP Email/set destroy failed: ${apiResp.statusText}`);
    }
    const data = (await apiResp.json()) as {
      methodResponses?: [string, Record<string, unknown>, string][];
    };
    const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
    const notDestroyed =
      (setResp?.[1] as { notDestroyed?: Record<string, unknown> } | undefined)?.notDestroyed;
    if (notDestroyed?.[messageId]) throw new Error("message_not_found");
  } else {
    // Soft-delete: find the Trash mailbox ID then update mailboxIds
    const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
      headers: { Authorization: authHeader },
    });
    if (!sessionResp.ok) throw new Error("fastmail_auth_failed");

    const trashResp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          [
            "Mailbox/query",
            { accountId, filter: { role: "trash" }, limit: 1 },
            "a",
          ],
          [
            "Mailbox/get",
            { accountId, "#ids": { resultOf: "a", name: "Mailbox/query", path: "/ids" } },
            "b",
          ],
        ],
      }),
    });
    if (!trashResp.ok) {
      if (trashResp.status === 401) throw new Error("fastmail_auth_failed");
      throw new Error(`Fastmail JMAP Mailbox/query failed: ${trashResp.statusText}`);
    }
    const trashData = (await trashResp.json()) as {
      methodResponses?: [string, Record<string, unknown>, string][];
    };
    const mbGet = trashData.methodResponses?.find(([n]) => n === "Mailbox/get");
    const trashMailboxes = (mbGet?.[1] as { list?: { id: string }[] } | undefined)?.list ?? [];
    const trashId = trashMailboxes[0]?.id;
    if (!trashId) throw new Error("Fastmail: could not locate Trash mailbox.");

    const moveResp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          [
            "Email/set",
            {
              accountId,
              update: { [messageId]: { mailboxIds: { [trashId]: true } } },
            },
            "a",
          ],
        ],
      }),
    });
    if (!moveResp.ok) {
      if (moveResp.status === 401) throw new Error("fastmail_auth_failed");
      throw new Error(`Fastmail JMAP Email/set failed: ${moveResp.statusText}`);
    }
    const moveData = (await moveResp.json()) as {
      methodResponses?: [string, Record<string, unknown>, string][];
    };
    const setResp = moveData.methodResponses?.find(([n]) => n === "Email/set");
    const notUpdated =
      (setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated;
    if (notUpdated?.[messageId]) throw new Error("message_not_found");
  }
}

// ── email_delete top-level handler ────────────────────────────────────────────

/**
 * `email_delete` handler — trashes or permanently expunges a single message.
 *
 * Scope: delete:email
 * Destructive (client confirms via annotations.destructiveHint).
 * Capability gate: caps.delete
 * Default behaviour: move to Trash (soft delete). Set permanent:true for hard delete.
 */
async function executeDeleteEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "email_delete", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  // rawArgs was validated as a non-null object by resolveFlagArgs above.
  const args = rawArgs as Record<string, unknown>;

  // ── Parse permanent flag ──────────────────────────────────────────────────
  const permanent = args["permanent"] === true;

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

  // Providers that only support trash (Gmail, Outlook) can't permanently expunge.
  // Reject permanent=true proactively rather than surfacing a confusing
  // provider_error (e.g. Gmail's "insufficient authentication scopes").
  if (permanent && caps.trash_vs_expunge === "trash") {
    return permanentDeleteUnsupportedError(inbox.provider);
  }

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailDeleteEmail(inbox, messageId, permanent);
        break;
      case "outlook":
        await outlookDeleteEmail(inbox, messageId, permanent);
        break;
      case "fastmail":
        await fastmailDeleteEmail(inbox, messageId, permanent);
        break;
      default: // imap and all IMAP service variants
        await imapDeleteEmail(inbox, messageId, permanent);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "email_delete", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      ...jsonOk({
        success: true,
        message_id: messageId,
        operation: "email_delete",
        inbox_id: inbox.id,
        permanent,
      }),
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Bulk operation helpers and execute functions
// (Task 11: email_move_batch, email_delete_batch, email_flag)
// ---------------------------------------------------------------------------

/** Shared return type for all per-provider bulk helpers. */
interface BulkOpResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/**
 * Resolves and validates arguments for bulk tools.
 * Validates that rawArgs is an object with a UUID inbox_id and a non-empty
 * string[] message_ids. Resolves the inbox row. Does NOT enforce MAX_BULK_IDS
 * (the execute function does that via bulkCapError).
 */
async function resolveBulkArgs(
  rawArgs: unknown,
  toolName: string,
  apiKey: ApiKeyRow,
): Promise<
  | { inbox: InboxRow; messageIds: string[]; error?: undefined }
  | {
      error: {
        result: { content: { type: string; text: string }[]; isError: boolean };
        logStatus: "error";
        logErrorCode: string;
      };
    }
> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: arguments must be an object with inbox_id and message_ids.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const rawIds = args["message_ids"];
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    !rawIds.every((x) => typeof x === "string" && (x as string).trim().length > 0)
  ) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: message_ids must be a non-empty array of non-empty strings.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

  const messageIds = (rawIds as string[]).map((id) => id.trim());

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) {
    return { error: inboxResolutionError(resolved, toolName) };
  }
  const inbox = resolved.inbox;

  return { inbox, messageIds };
}

/**
 * Builds the standard JSON-RPC result for a bulk operation.
 * logStatus is "success" when at least one message succeeded (partial success
 * is still success from the operator's perspective); "error" when all failed.
 */
function formatBulkResult(
  succeeded: string[],
  failed: { id: string; error: string }[],
  operation: string,
  inboxId: string,
  extra?: Record<string, unknown>,
): {
  result: { content: { type: string; text: string }[] };
  logStatus: "success" | "error";
  logErrorCode: string | null;
} {
  const results = [
    ...succeeded.map((id) => ({ message_id: id, success: true })),
    ...failed.map(({ id, error }) => ({ message_id: id, success: false, error })),
  ];
  return {
    result: jsonOk({
      succeeded: succeeded.length,
      failed: failed.length,
      operation,
      inbox_id: inboxId,
      ...extra,
      results,
    }),
    logStatus: succeeded.length > 0 || failed.length === 0 ? "success" : "error",
    logErrorCode: null,
  };
}

// ── IMAP bulk helpers ─────────────────────────────────────────────────────────

/** Groups IMAP message IDs by source folder and runs a bulk UID MOVE per group. */
async function imapBulkMove(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  const groups = new Map<string, { uid: number; messageId: string }[]>();
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const { folder, uid } = decodeImapId(messageId);
    if (!Number.isFinite(uid) || uid <= 0) {
      failed.push({ id: messageId, error: "invalid_message_id" });
      continue;
    }
    const g = groups.get(folder);
    if (g) g.push({ uid, messageId });
    else groups.set(folder, [{ uid, messageId }]);
  }

  const succeeded: string[] = [];

  let password: string;
  try {
    password = await decryptStoredToken(inbox.imap_password);
  } catch {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  for (const [folder, items] of groups) {
    let client: ImapClient | null = null;
    try {
      client = await ImapClient.connect({
        host: inbox.imap_host,
        port: inbox.imap_port,
        email: imapAuthUser(inbox),
        password,
      });
      await client.selectMailbox(imapFolderName(folder));
      await client.uidMove(items.map((i) => i.uid), destinationFolderId);
      for (const item of items) succeeded.push(item.messageId);
    } catch (err) {
      const msg = err instanceof ImapAuthError
        ? "imap_auth_failed"
        : err instanceof Error ? err.message : String(err);
      for (const item of items) failed.push({ id: item.messageId, error: msg });
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  return { succeeded, failed };
}

/**
 * Groups IMAP message IDs by source folder and runs a bulk UID COPY per group,
 * leaving the source messages in place.
 */
async function imapBulkCopy(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  const groups = new Map<string, { uid: number; messageId: string }[]>();
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const { folder, uid } = decodeImapId(messageId);
    if (!Number.isFinite(uid) || uid <= 0) {
      failed.push({ id: messageId, error: "invalid_message_id" });
      continue;
    }
    const g = groups.get(folder);
    if (g) g.push({ uid, messageId });
    else groups.set(folder, [{ uid, messageId }]);
  }

  const succeeded: string[] = [];

  let password: string;
  try {
    password = await decryptStoredToken(inbox.imap_password);
  } catch {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  for (const [folder, items] of groups) {
    let client: ImapClient | null = null;
    try {
      client = await ImapClient.connect({
        host: inbox.imap_host,
        port: inbox.imap_port,
        email: imapAuthUser(inbox),
        password,
      });
      await client.selectMailbox(imapFolderName(folder));
      await client.uidCopy(items.map((i) => i.uid), destinationFolderId);
      for (const item of items) succeeded.push(item.messageId);
    } catch (err) {
      const msg = err instanceof ImapAuthError
        ? "imap_auth_failed"
        : err instanceof Error ? err.message : String(err);
      for (const item of items) failed.push({ id: item.messageId, error: msg });
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  return { succeeded, failed };
}

/** Groups IMAP message IDs by source folder and runs bulk delete per group. */
async function imapBulkDelete(
  inbox: InboxRow,
  messageIds: string[],
  permanent: boolean,
): Promise<BulkOpResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  const groups = new Map<string, { uid: number; messageId: string }[]>();
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const { folder, uid } = decodeImapId(messageId);
    if (!Number.isFinite(uid) || uid <= 0) {
      failed.push({ id: messageId, error: "invalid_message_id" });
      continue;
    }
    const g = groups.get(folder);
    if (g) g.push({ uid, messageId });
    else groups.set(folder, [{ uid, messageId }]);
  }

  const succeeded: string[] = [];

  let password: string;
  try {
    password = await decryptStoredToken(inbox.imap_password);
  } catch {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  for (const [folder, items] of groups) {
    let client: ImapClient | null = null;
    try {
      client = await ImapClient.connect({
        host: inbox.imap_host,
        port: inbox.imap_port,
        email: imapAuthUser(inbox),
        password,
      });
      await client.selectMailbox(imapFolderName(folder));
      const uids = items.map((i) => i.uid);
      if (permanent) {
        await client.uidStore(uids, ["\\Deleted"], "add");
        await client.uidExpunge(uids);
      } else {
        // Resolve the trash mailbox via the same imapFolderName resolver the
        // single-message delete path uses for mailbox names, so servers with a
        // namespaced/localized trash (e.g. INBOX.Trash) work instead of failing
        // on a raw "Trash" literal. uidMove falls back to COPY+EXPUNGE if MOVE
        // is unsupported.
        await client.uidMove(uids, imapFolderName("TRASH"));
      }
      for (const item of items) succeeded.push(item.messageId);
    } catch (err) {
      const msg = err instanceof ImapAuthError
        ? "imap_auth_failed"
        : err instanceof Error ? err.message : String(err);
      for (const item of items) failed.push({ id: item.messageId, error: msg });
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  return { succeeded, failed };
}

/** Groups IMAP message IDs by source folder and runs a bulk UID STORE per group. */
async function imapBulkFlag(
  inbox: InboxRow,
  messageIds: string[],
  action: string,
): Promise<BulkOpResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  let imapFlags: string[];
  let mode: "add" | "remove";
  switch (action) {
    case "read":   imapFlags = ["\\Seen"];    mode = "add";    break;
    case "unread": imapFlags = ["\\Seen"];    mode = "remove"; break;
    case "flag":   imapFlags = ["\\Flagged"]; mode = "add";    break;
    case "unflag": imapFlags = ["\\Flagged"]; mode = "remove"; break;
    default:
      return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "invalid_action" })) };
  }

  const groups = new Map<string, { uid: number; messageId: string }[]>();
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const { folder, uid } = decodeImapId(messageId);
    if (!Number.isFinite(uid) || uid <= 0) {
      failed.push({ id: messageId, error: "invalid_message_id" });
      continue;
    }
    const g = groups.get(folder);
    if (g) g.push({ uid, messageId });
    else groups.set(folder, [{ uid, messageId }]);
  }

  const succeeded: string[] = [];

  let password: string;
  try {
    password = await decryptStoredToken(inbox.imap_password);
  } catch {
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "imap_auth_failed" })) };
  }

  for (const [folder, items] of groups) {
    let client: ImapClient | null = null;
    try {
      client = await ImapClient.connect({
        host: inbox.imap_host,
        port: inbox.imap_port,
        email: imapAuthUser(inbox),
        password,
      });
      await client.selectMailbox(imapFolderName(folder));
      await client.uidStore(items.map((i) => i.uid), imapFlags, mode);
      for (const item of items) succeeded.push(item.messageId);
    } catch (err) {
      const msg = err instanceof ImapAuthError
        ? "imap_auth_failed"
        : err instanceof Error ? err.message : String(err);
      for (const item of items) failed.push({ id: item.messageId, error: msg });
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  return { succeeded, failed };
}

// ── Gmail bulk helpers ────────────────────────────────────────────────────────

/**
 * Gmail bulk move: per-message messages.modify — adds destination label, removes INBOX.
 * batchModify returns 200 with no per-id body and silently skips invalid ids, so
 * we loop per message to report accurate succeeded/failed lists.
 * Maps 401 → "gmail_auth_failed".
 */
async function gmailBulkMove(
  inbox: InboxRow,
  messageIds: string[],
  destinationLabelId: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshGmailToken(inbox);
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          addLabelIds: [destinationLabelId],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "gmail_auth_failed"
          : r.status === 404 ? "message_not_found" : `Gmail modify failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

/**
 * Gmail bulk delete: messages.batchDelete (permanent) or individual trash (soft).
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailBulkDelete(
  inbox: InboxRow,
  messageIds: string[],
  permanent: boolean,
): Promise<BulkOpResult> {
  const accessToken = await withFreshGmailToken(inbox);

  if (permanent) {
    // Gmail messages.batchDelete returns 204 with no per-id body and silently
    // skips invalid ids, so we loop per message (messages.delete) to report
    // accurate succeeded/failed lists.
    const permSucceeded: string[] = [];
    const permFailed: { id: string; error: string }[] = [];
    for (const messageId of messageIds) {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (r.ok) {
        permSucceeded.push(messageId);
      } else {
        permFailed.push({
          id: messageId,
          error: r.status === 401
            ? "gmail_auth_failed"
            : r.status === 404 ? "message_not_found" : `Gmail delete failed: ${r.status}`,
        });
      }
    }
    return { succeeded: permSucceeded, failed: permFailed };
  }

  // Soft-delete: Gmail has no batch-trash endpoint; call /trash per message with shared token.
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/trash`,
      { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "gmail_auth_failed"
          : r.status === 404 ? "message_not_found" : `Gmail trash failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

/**
 * Gmail bulk flag: per-message messages.modify with appropriate label add/remove.
 * batchModify returns 200 with no per-id body and silently skips invalid ids, so
 * we loop per message to report accurate succeeded/failed lists.
 * Maps 401 → "gmail_auth_failed".
 */
async function gmailBulkFlag(
  inbox: InboxRow,
  messageIds: string[],
  action: string,
): Promise<BulkOpResult> {
  let addLabelIds: string[];
  let removeLabelIds: string[];
  switch (action) {
    case "read":   addLabelIds = [];           removeLabelIds = ["UNREAD"];  break;
    case "unread": addLabelIds = ["UNREAD"];   removeLabelIds = [];          break;
    case "flag":   addLabelIds = ["STARRED"];  removeLabelIds = [];          break;
    case "unflag": addLabelIds = [];           removeLabelIds = ["STARRED"]; break;
    default:
      return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "invalid_action" })) };
  }
  const accessToken = await withFreshGmailToken(inbox);
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "gmail_auth_failed"
          : r.status === 404 ? "message_not_found" : `Gmail modify failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

// ── Outlook bulk helpers ──────────────────────────────────────────────────────

/** Outlook bulk move: per-message Graph messages/{id}/move with a shared token. */
async function outlookBulkMove(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshOutlookToken(inbox);
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ destinationId: destinationFolderId }),
      },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "outlook_auth_failed"
          : r.status === 404 ? "message_not_found" : `Outlook move failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

/** Outlook bulk copy: per-message Graph messages/{id}/copy, source left in place. */
async function outlookBulkCopy(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshOutlookToken(inbox);
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/copy`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ destinationId: destinationFolderId }),
      },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "outlook_auth_failed"
          : r.status === 404 ? "message_not_found" : `Outlook copy failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

/** Outlook bulk delete: per-message Graph calls (move to Deleted Items or permanentDelete). */
async function outlookBulkDelete(
  inbox: InboxRow,
  messageIds: string[],
  permanent: boolean,
): Promise<BulkOpResult> {
  const accessToken = await withFreshOutlookToken(inbox);
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const encodedId = encodeURIComponent(messageId);
    let r: Response;
    if (permanent) {
      r = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodedId}/permanentDelete`,
        { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
      );
    } else {
      r = await fetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodedId}/move`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ destinationId: "deleteditems" }),
        },
      );
    }
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "outlook_auth_failed"
          : r.status === 404 ? "message_not_found" : `Outlook delete failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

/** Outlook bulk flag: per-message Graph PATCH with a shared token. */
async function outlookBulkFlag(
  inbox: InboxRow,
  messageIds: string[],
  action: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshOutlookToken(inbox);
  let patch: Record<string, unknown>;
  switch (action) {
    case "read":   patch = { isRead: true };                        break;
    case "unread": patch = { isRead: false };                       break;
    case "flag":   patch = { flag: { flagStatus: "flagged" } };    break;
    case "unflag": patch = { flag: { flagStatus: "notFlagged" } }; break;
    default:
      return { succeeded: [], failed: messageIds.map((id) => ({ id, error: "invalid_action" })) };
  }
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const messageId of messageIds) {
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (r.ok) {
      succeeded.push(messageId);
    } else {
      failed.push({
        id: messageId,
        error: r.status === 401
          ? "outlook_auth_failed"
          : r.status === 404 ? "message_not_found" : `Outlook PATCH failed: ${r.status}`,
      });
    }
  }
  return { succeeded, failed };
}

// ── Fastmail bulk helpers ─────────────────────────────────────────────────────

/** Fastmail bulk move: single JMAP Email/set update with all mailboxIds at once. */
async function fastmailBulkMove(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  const updateMap: Record<string, unknown> = {};
  for (const id of messageIds) {
    updateMap[id] = { mailboxIds: { [destinationFolderId]: true } };
  }

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", { accountId, update: updateMap }, "a"]],
    }),
  });
  if (!apiResp.ok) {
    const err = apiResp.status === 401
      ? "fastmail_auth_failed"
      : `Fastmail JMAP Email/set failed: ${apiResp.statusText}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }

  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated =
    ((setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated) ?? {};
  const succeeded = messageIds.filter((id) => !notUpdated[id]);
  const failed = messageIds
    .filter((id) => !!notUpdated[id])
    .map((id) => ({ id, error: "fastmail_update_failed" }));
  return { succeeded, failed };
}

/**
 * Fastmail bulk copy: single JMAP Email/set that patches each message to ADD the
 * destination mailbox membership without removing existing ones (message ends up
 * in both source and destination).
 */
async function fastmailBulkCopy(
  inbox: InboxRow,
  messageIds: string[],
  destinationFolderId: string,
): Promise<BulkOpResult> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  const updateMap: Record<string, unknown> = {};
  for (const id of messageIds) {
    updateMap[id] = { [`mailboxIds/${destinationFolderId}`]: true };
  }

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", { accountId, update: updateMap }, "a"]],
    }),
  });
  if (!apiResp.ok) {
    const err = apiResp.status === 401
      ? "fastmail_auth_failed"
      : `Fastmail JMAP Email/set failed: ${apiResp.statusText}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }

  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated =
    ((setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated) ?? {};
  const succeeded = messageIds.filter((id) => !notUpdated[id]);
  const failed = messageIds
    .filter((id) => !!notUpdated[id])
    .map((id) => ({ id, error: "fastmail_update_failed" }));
  return { succeeded, failed };
}

/** Fastmail bulk delete: JMAP Email/set destroy (permanent) or Trash mailboxId update (soft). */
async function fastmailBulkDelete(
  inbox: InboxRow,
  messageIds: string[],
  permanent: boolean,
): Promise<BulkOpResult> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  if (permanent) {
    const apiResp = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/set", { accountId, destroy: messageIds }, "a"]],
      }),
    });
    if (!apiResp.ok) {
      const err = apiResp.status === 401
        ? "fastmail_auth_failed"
        : `Fastmail JMAP Email/set destroy failed: ${apiResp.statusText}`;
      return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
    }
    const data = (await apiResp.json()) as {
      methodResponses?: [string, Record<string, unknown>, string][];
    };
    const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
    const notDestroyed =
      ((setResp?.[1] as { notDestroyed?: Record<string, unknown> } | undefined)?.notDestroyed) ?? {};
    const succeeded = messageIds.filter((id) => !notDestroyed[id]);
    const failed = messageIds
      .filter((id) => !!notDestroyed[id])
      .map((id) => ({ id, error: "fastmail_destroy_failed" }));
    return { succeeded, failed };
  }

  // Soft-delete: resolve Trash mailbox role, then update all messages' mailboxIds.
  const trashResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/query", { accountId, filter: { role: "trash" }, limit: 1 }, "a"],
        ["Mailbox/get", { accountId, "#ids": { resultOf: "a", name: "Mailbox/query", path: "/ids" } }, "b"],
      ],
    }),
  });
  if (!trashResp.ok) {
    const err = trashResp.status === 401
      ? "fastmail_auth_failed"
      : `Fastmail JMAP Mailbox/query failed: ${trashResp.statusText}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }
  const trashData = (await trashResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const mbGet = trashData.methodResponses?.find(([n]) => n === "Mailbox/get");
  const trashMailboxes =
    ((mbGet?.[1] as { list?: { id: string }[] } | undefined)?.list) ?? [];
  const trashId = trashMailboxes[0]?.id;
  if (!trashId) {
    return {
      succeeded: [],
      failed: messageIds.map((id) => ({ id, error: "fastmail_trash_mailbox_not_found" })),
    };
  }

  const updateMap: Record<string, unknown> = {};
  for (const id of messageIds) {
    updateMap[id] = { mailboxIds: { [trashId]: true } };
  }
  const moveResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", { accountId, update: updateMap }, "a"]],
    }),
  });
  if (!moveResp.ok) {
    const err = moveResp.status === 401
      ? "fastmail_auth_failed"
      : `Fastmail JMAP Email/set failed: ${moveResp.statusText}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }
  const moveData = (await moveResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp2 = moveData.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated =
    ((setResp2?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated) ?? {};
  const succeeded2 = messageIds.filter((id) => !notUpdated[id]);
  const failed2 = messageIds
    .filter((id) => !!notUpdated[id])
    .map((id) => ({ id, error: "fastmail_trash_failed" }));
  return { succeeded: succeeded2, failed: failed2 };
}

/** Fastmail bulk flag: single JMAP Email/set update for all messages. */
async function fastmailBulkFlag(
  inbox: InboxRow,
  messageIds: string[],
  action: string,
): Promise<BulkOpResult> {
  const { authHeader, accountId, apiUrl } = await resolveFastmailSession(inbox);

  const updateMap: Record<string, unknown> = {};
  for (const id of messageIds) {
    const patch: Record<string, unknown> = {};
    switch (action) {
      case "read":   patch["keywords/$seen"]    = true;  break;
      case "unread": patch["keywords/$seen"]    = null;  break;
      case "flag":   patch["keywords/$flagged"] = true;  break;
      case "unflag": patch["keywords/$flagged"] = null;  break;
      default:
        return {
          succeeded: [],
          failed: messageIds.map((mid) => ({ id: mid, error: "invalid_action" })),
        };
    }
    updateMap[id] = patch;
  }

  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [["Email/set", { accountId, update: updateMap }, "a"]],
    }),
  });
  if (!apiResp.ok) {
    const err = apiResp.status === 401
      ? "fastmail_auth_failed"
      : `Fastmail JMAP Email/set failed: ${apiResp.statusText}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const setResp = data.methodResponses?.find(([n]) => n === "Email/set");
  const notUpdated =
    ((setResp?.[1] as { notUpdated?: Record<string, unknown> } | undefined)?.notUpdated) ?? {};
  const succeeded = messageIds.filter((id) => !notUpdated[id]);
  const failed = messageIds
    .filter((id) => !!notUpdated[id])
    .map((id) => ({ id, error: "fastmail_update_failed" }));
  return { succeeded, failed };
}

// ── Bulk execute functions ────────────────────────────────────────────────────

/**
 * `email_move_batch` handler — moves multiple messages to a destination folder.
 *
 * Scope: manage:folders
 * Capability gate: caps.move
 * Cap: MAX_BULK_IDS (500)
 */
async function executeBulkMove(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveBulkArgs(rawArgs, "email_move_batch", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageIds } = resolved;

  if (messageIds.length > MAX_BULK_IDS) return bulkCapError(messageIds.length);

  const args = rawArgs as Record<string, unknown>;
  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_move_batch: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  // ── Resolve destination (alias / name / id) → provider-native id ──────────
  let resolvedDest: string;
  try {
    resolvedDest = await resolveFolderId(inbox, destinationFolderId);
  } catch (_err) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_move_batch: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkMove(inbox, messageIds, resolvedDest);
        break;
      case "outlook":
        bulkResult = await outlookBulkMove(inbox, messageIds, resolvedDest);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkMove(inbox, messageIds, resolvedDest);
        break;
      default: // imap and all IMAP service variants
        bulkResult = await imapBulkMove(inbox, messageIds, resolvedDest);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_move_batch: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during email_move_batch: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_move_batch",
    inbox.id,
    { destination_folder_id: destinationFolderId },
  );
}

/**
 * `email_copy_batch` handler — copies multiple messages into a destination folder,
 * leaving the originals in place.
 *
 * Scope: manage:folders
 * Capability gate: caps.copy (false for Gmail → unsupportedFeatureError)
 * Cap: MAX_BULK_IDS (500)
 */
async function executeBulkCopy(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveBulkArgs(rawArgs, "email_copy_batch", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageIds } = resolved;

  if (messageIds.length > MAX_BULK_IDS) return bulkCapError(messageIds.length);

  const args = rawArgs as Record<string, unknown>;
  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_copy_batch: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.copy) return unsupportedFeatureError("copy", inbox.provider);

  // ── Resolve destination (alias / name / id) → provider-native id ──────────
  let resolvedDest: string;
  try {
    resolvedDest = await resolveFolderId(inbox, destinationFolderId);
  } catch (_err) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_copy_batch: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "outlook":
        bulkResult = await outlookBulkCopy(inbox, messageIds, resolvedDest);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkCopy(inbox, messageIds, resolvedDest);
        break;
      default: // imap and all IMAP service variants
        bulkResult = await imapBulkCopy(inbox, messageIds, resolvedDest);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_copy_batch: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during email_copy_batch: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_copy_batch",
    inbox.id,
    { destination_folder_id: destinationFolderId },
  );
}

/**
 * `email_delete_batch` handler — trashes or permanently expunges multiple messages.
 *
 * Scope: delete:email
 * Destructive (client confirms via annotations.destructiveHint).
 * Capability gate: caps.delete
 * Cap: MAX_BULK_IDS (500)
 * Default behaviour: move to Trash. Set permanent:true for hard delete.
 */
async function executeBulkDelete(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveBulkArgs(rawArgs, "email_delete_batch", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageIds } = resolved;

  if (messageIds.length > MAX_BULK_IDS) return bulkCapError(messageIds.length);

  // rawArgs was validated as a non-null object by resolveBulkArgs above.
  const args = rawArgs as Record<string, unknown>;

  const permanent = args["permanent"] === true;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

  // Trash-only providers (Gmail/Outlook) can't permanently expunge — reject up
  // front so the whole batch fails clearly rather than per-message provider errors.
  if (permanent && caps.trash_vs_expunge === "trash") {
    return permanentDeleteUnsupportedError(inbox.provider);
  }

  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkDelete(inbox, messageIds, permanent);
        break;
      case "outlook":
        bulkResult = await outlookBulkDelete(inbox, messageIds, permanent);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkDelete(inbox, messageIds, permanent);
        break;
      default: // imap and all IMAP service variants
        bulkResult = await imapBulkDelete(inbox, messageIds, permanent);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_delete_batch: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during email_delete_batch: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_delete_batch",
    inbox.id,
    { permanent },
  );
}

/**
 * `email_flag` handler — applies a read/unread/flag/unflag action to one or more messages.
 *
 * Scope: send:email
 * Capability gate: caps.flags
 * Cap: MAX_BULK_IDS (500)
 */
async function executeBulkFlag(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveBulkArgs(rawArgs, "email_flag", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageIds } = resolved;

  if (messageIds.length > MAX_BULK_IDS) return bulkCapError(messageIds.length);

  const args = rawArgs as Record<string, unknown>;
  const action = typeof args["action"] === "string" ? args["action"] : "";
  if (!["read", "unread", "flag", "unflag"].includes(action)) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_flag: action must be one of: read, unread, flag, unflag.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.flags) return unsupportedFeatureError("flags", inbox.provider);

  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkFlag(inbox, messageIds, action);
        break;
      case "outlook":
        bulkResult = await outlookBulkFlag(inbox, messageIds, action);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkFlag(inbox, messageIds, action);
        break;
      default: // imap and all IMAP service variants
        bulkResult = await imapBulkFlag(inbox, messageIds, action);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_flag: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during email_flag: ${message}. Please try again in a moment.`,
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_flag",
    inbox.id,
    { action },
  );
}

// ---------------------------------------------------------------------------
// Phase 3 (cont.) — Search-and-act tools
//
// Tools: email_search_and_move, email_search_and_delete
//
// Both run the provider search on the server and apply the bulk operation to
// the results, avoiding stale IDs being passed by the agent.
// ---------------------------------------------------------------------------

/**
 * `email_search_and_move` handler — searches for messages and moves all matches to a folder.
 *
 * Scope: manage:folders
 * Capability gate: caps.move
 * Cap: MAX_BULK_IDS (500)
 */
async function executeSearchAndMove(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_search_and_move: arguments must be an object with search fields (or query) and destination_folder_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const built = buildNormalizedSearch(args);
  if (!built.ok) return invalidSearchDateError(built.badDate);
  if (built.empty) return noSearchCriterionError();
  const search = built.search;
  // Human-readable echo of the criteria for the result payload.
  const query = JSON.stringify(search);

  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_search_and_move: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const limit = Math.min(
    Math.max(1, typeof args["limit"] === "number" ? Math.floor(args["limit"]) : MAX_BULK_IDS),
    MAX_BULK_IDS,
  );

  const includeFolders: string[] = Array.isArray(args["include_folders"])
    ? (args["include_folders"] as unknown[])
        .filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_search_and_move");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  // ── Resolve destination (alias / name / id) → provider-native id ──────────
  // Done now (before the search) so an unresolvable destination fails fast.
  let resolvedDest: string;
  try {
    resolvedDest = await resolveFolderId(inbox, destinationFolderId);
  } catch (_err) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_search_and_move: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // ── Run search to collect message IDs ─────────────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("search_timeout")), SEARCH_TIMEOUT_MS)
  );

  let searchResult: SearchEmailsResult;
  try {
    let searchPromise: Promise<SearchEmailsResult>;
    switch (inbox.provider) {
      case "gmail":
        searchPromise = searchGmailMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "imap":
        searchPromise = searchImapMessages(inbox, search, limit, 0, includeFolders);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_search_and_move. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
    searchResult = await Promise.race([searchPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "search_timeout") {
      return {
        result: {
          content: [{ type: "text", text: "Search timed out after 30 seconds. Try a simpler or more specific query." }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "search_timeout",
      };
    }
    console.error("[mcp-server] email_search_and_move: search_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{ type: "text", text: `Provider error while searching: ${message}. Please try again in a moment.` }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  const messageIds = searchResult.messages.map((m) => m.id);

  if (messageIds.length === 0) {
    return {
      result: jsonOk({
        succeeded: 0,
        failed: 0,
        operation: "email_search_and_move",
        inbox_id: inboxId,
        destination_folder_id: destinationFolderId,
        query,
        results: [],
      }),
      logStatus: "success",
      logErrorCode: null,
    };
  }

  // ── Apply bulk move to search results ─────────────────────────────────────
  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkMove(inbox, messageIds, resolvedDest);
        break;
      case "outlook":
        bulkResult = await outlookBulkMove(inbox, messageIds, resolvedDest);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkMove(inbox, messageIds, resolvedDest);
        break;
      default: // imap
        bulkResult = await imapBulkMove(inbox, messageIds, resolvedDest);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_search_and_move: move_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{ type: "text", text: `Provider error during move: ${message}. Please try again in a moment.` }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_search_and_move",
    inbox.id,
    { destination_folder_id: destinationFolderId, query },
  );
}

/**
 * `email_search_and_delete` handler — searches for messages and deletes all matches.
 *
 * Scope: delete:email
 * Destructive (client confirms via annotations.destructiveHint).
 * Capability gate: caps.delete
 * Cap: MAX_BULK_IDS (500)
 * Default behaviour: move to Trash. Set permanent:true for hard delete.
 */
async function executeSearchAndDelete(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: {
        content: [{
          type: "text",
          text: "email_search_and_delete: arguments must be an object with search fields (or query).",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const built = buildNormalizedSearch(args);
  if (!built.ok) return invalidSearchDateError(built.badDate);
  if (built.empty) return noSearchCriterionError();
  const search = built.search;
  // Human-readable echo of the criteria for the result payload.
  const query = JSON.stringify(search);

  const permanent = args["permanent"] === true;
  const limit = Math.min(
    Math.max(1, typeof args["limit"] === "number" ? Math.floor(args["limit"]) : MAX_BULK_IDS),
    MAX_BULK_IDS,
  );
  const includeFolders: string[] = Array.isArray(args["include_folders"])
    ? (args["include_folders"] as unknown[])
        .filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "email_search_and_delete");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

  // Trash-only providers (Gmail/Outlook) can't permanently expunge — reject up
  // front before running the search so the caller gets a clear instruction.
  if (permanent && caps.trash_vs_expunge === "trash") {
    return permanentDeleteUnsupportedError(inbox.provider);
  }

  // ── Run search to collect message IDs ─────────────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("search_timeout")), SEARCH_TIMEOUT_MS)
  );

  let searchResult: SearchEmailsResult;
  try {
    let searchPromise: Promise<SearchEmailsResult>;
    switch (inbox.provider) {
      case "gmail":
        searchPromise = searchGmailMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(inbox, search, limit, 0, includeFolders);
        break;
      case "imap":
        searchPromise = searchImapMessages(inbox, search, limit, 0, includeFolders);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by email_search_and_delete. ` +
                "Supported providers: gmail, outlook, fastmail, imap.",
            }],
            isError: true,
          },
          logStatus: "error",
          logErrorCode: "provider_error",
        };
    }
    searchResult = await Promise.race([searchPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "search_timeout") {
      return {
        result: {
          content: [{ type: "text", text: "Search timed out after 30 seconds. Try a simpler or more specific query." }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "search_timeout",
      };
    }
    console.error("[mcp-server] email_search_and_delete: search_error", {
      inbox_id: inboxId,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{ type: "text", text: `Provider error while searching: ${message}. Please try again in a moment.` }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  const messageIds = searchResult.messages.map((m) => m.id);

  if (messageIds.length === 0) {
    return {
      result: jsonOk({
        succeeded: 0,
        failed: 0,
        operation: "email_search_and_delete",
        inbox_id: inboxId,
        permanent,
        query,
        results: [],
      }),
      logStatus: "success",
      logErrorCode: null,
    };
  }

  // ── Apply bulk delete to search results ───────────────────────────────────
  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkDelete(inbox, messageIds, permanent);
        break;
      case "outlook":
        bulkResult = await outlookBulkDelete(inbox, messageIds, permanent);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkDelete(inbox, messageIds, permanent);
        break;
      default: // imap
        bulkResult = await imapBulkDelete(inbox, messageIds, permanent);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] email_search_and_delete: delete_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{ type: "text", text: `Provider error during delete: ${message}. Please try again in a moment.` }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "provider_error",
    };
  }

  return formatBulkResult(
    bulkResult.succeeded,
    bulkResult.failed,
    "email_search_and_delete",
    inbox.id,
    { permanent, query },
  );
}

// ---------------------------------------------------------------------------
// draft_create / draft_update / draft_list / draft_send — types + helpers
// ---------------------------------------------------------------------------

/**
 * Provider-aware "draft not found" message.
 *
 * On IMAP-backed inboxes (the default/`imap` branch — Gmail/Outlook/Fastmail
 * have stable resource IDs) a draft is a message with an immutable UID, so
 * "updating" a draft = APPEND a new message (new UID) + EXPUNGE the old one.
 * Every successful draft_update therefore mints a NEW draft_id. A caller still
 * holding the draft_id from before an update will reference a UID that no
 * longer exists. Rather than a generic error, tell them the id changed and to
 * call draft_list to get the current one.
 */
function draftNotFoundMessage(
  provider: string,
  draftId: string,
  action: "update" | "send" | "delete",
): string {
  const isImap = provider !== "gmail" && provider !== "outlook" && provider !== "fastmail";
  if (isImap) {
    return `Draft ${draftId} no longer exists. On this inbox each draft_update rewrites the ` +
      `draft and returns a NEW draft_id, so an older draft_id becomes stale after an update. ` +
      `Call draft_list to get the current draft_id, then retry draft_${action} with it.`;
  }
  return `Draft ${draftId} not found. Use draft_list to see available draft IDs.`;
}

/** Common folder names for the Drafts mailbox across IMAP providers, tried in order. */
const DRAFT_FOLDER_CANDIDATES = ["Drafts", "Draft", "INBOX.Drafts", "INBOX.Draft"];

interface DraftSummary {
  draft_id: string;
  subject: string;
  to: EmailAddressEntry[];
  cc: EmailAddressEntry[];
  created_at: string;
}

interface DraftCreateResult {
  draft_id: string;
  subject: string;
  to: EmailAddressEntry[];
  created_at: string;
}

interface DraftUpdateResult {
  draft_id: string;
  subject: string;
  updated_at: string;
}

interface DraftSendResult {
  draft_id: string;
  message_id: string;
  sent_at: string;
}

interface DraftDeleteResult {
  draft_id: string;
  deleted: true;
}

interface DraftParams {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody?: string;
}

/**
 * Existing-draft fields recovered for a partial draft_update so omitted
 * properties can be preserved instead of blanked. Recipients are RFC 5322
 * address strings (see formatAddressEntry), ready to drop into DraftParams.
 * Unlike DraftSummary (a list-row projection that omits bcc and, for IMAP, cc),
 * this is a full single-draft fetch so to/cc/bcc are all recoverable.
 */
interface DraftContent {
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

// ── IMAP draft helpers ────────────────────────────────────────────────────────

async function imapListDrafts(
  inbox: InboxRow,
  limit: number,
): Promise<DraftSummary[]> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    let summaries: ImapMessageSummary[] = [];
    let draftFolder = DRAFT_FOLDER_CANDIDATES[0];
    for (const folder of DRAFT_FOLDER_CANDIDATES) {
      try {
        await client.selectMailbox(folder);
        draftFolder = folder;
        const uids = await client.uidSearch("ALL");
        if (uids.length === 0) break;
        const page = uids.slice(-limit).reverse();
        summaries = await client.fetchSummaries(page);
        break;
      } catch {
        // Try next candidate folder.
      }
    }
    return summaries.map((s) => ({
      draft_id: encodeImapId(draftFolder, s.uid),
      subject: decodeEnvelopeSubject(s.envelope.subject || "(no subject)"),
      to: s.envelope.to.map(decodeEnvelopeAddress),
      cc: [],
      created_at: imapDateToIso(s.envelope.date),
    }));
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Fetch a single IMAP draft's full headers (subject + to/cc/bcc) by parsing its
 * raw MIME. The list summary only carries `to` (cc is hard-coded empty, bcc is
 * absent), so a partial draft_update needs this fuller read to restore omitted
 * recipients. Returns null when the draft can't be found. Mirrors the
 * raw-fetch path used by imapSendDraft.
 */
async function imapGetDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftContent | null> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(draftId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const password = await decryptStoredToken(inbox.imap_password);
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    const msg = await client.fetchMessageRaw(uid);
    if (!msg) return null;
    const h = parseEmail(msg.raw).headers;
    return {
      subject: decodeEncodedWords(getHeader(h, "subject") ?? "(no subject)"),
      to: parseAddressList(decodeEncodedWords(getHeader(h, "to") ?? "")).map(formatAddressEntry),
      cc: parseAddressList(decodeEncodedWords(getHeader(h, "cc") ?? "")).map(formatAddressEntry),
      bcc: parseAddressList(decodeEncodedWords(getHeader(h, "bcc") ?? "")).map(formatAddressEntry),
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Remove every `Bcc:` header (including folded continuation lines) from a raw
 * RFC 5322 message, operating only on the header block (before the first blank
 * line). A persisted IMAP draft may legitimately contain a Bcc header (it's the
 * user's own copy), but the SENT copy MUST NOT — BCC may only affect the SMTP
 * envelope. The BCC addresses are read from the stored MIME for RCPT TO and
 * then this strips the header from the transmitted body.
 */
function stripBccHeader(rawMime: string): string {
  // Split header block from body on the first blank line (CRLF or LF).
  const sep = rawMime.search(/\r?\n\r?\n/);
  if (sep === -1) return rawMime; // No body separator — treat whole thing as headers below.
  const headerEnd = sep;
  const headerBlock = rawMime.slice(0, headerEnd);
  const rest = rawMime.slice(headerEnd); // includes the leading blank-line separator

  const headerLines = headerBlock.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of headerLines) {
    const isContinuation = /^[ \t]/.test(line);
    if (skipping) {
      // Folded continuation of a Bcc header — keep dropping it.
      if (isContinuation) continue;
      skipping = false;
    }
    if (/^bcc[ \t]*:/i.test(line)) {
      skipping = true; // Drop this header line and any folded continuations.
      continue;
    }
    kept.push(line);
  }
  return kept.join("\r\n") + rest;
}

async function imapCreateDraft(
  inbox: InboxRow,
  params: DraftParams,
): Promise<DraftCreateResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  const messageId = crypto.randomUUID();
  const from = inbox.display_name
    ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
    : inbox.email_address;

  const mime = buildMimeMessage({
    from,
    to: params.to.length ? params.to : [inbox.email_address],
    cc: params.cc.length ? params.cc : undefined,
    // Persist BCC into the draft MIME so imapSendDraft can recover the BCC
    // recipients later. Stripped from the transmitted copy at send time.
    bcc: params.bcc.length ? params.bcc : undefined,
    includeBccHeader: true,
    subject: params.subject,
    textBody: params.body,
    htmlBody: params.htmlBody,
    messageId,
  });

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });

    let draftFolder = DRAFT_FOLDER_CANDIDATES[0];
    let uid: number | undefined;
    for (const folder of DRAFT_FOLDER_CANDIDATES) {
      const res = await client.appendWithFlags(folder, mime, ["\\Draft", "\\Seen"]);
      if (res.ok) {
        draftFolder = folder;
        uid = res.uid;
        break;
      }
    }
    if (uid === undefined) {
      // APPENDUID not supported — find UID by Message-ID header search.
      await client.selectMailbox(draftFolder);
      const found = await client.uidSearch(
        `HEADER Message-ID "<${messageId}@mcpemails.com>"`,
      );
      uid = found.length > 0 ? found[found.length - 1] : 0;
    }

    return {
      draft_id: encodeImapId(draftFolder, uid ?? 0),
      subject: params.subject,
      to: params.to.map((e) => parseEmailAddress(e)),
      created_at: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function imapUpdateDraft(
  inbox: InboxRow,
  draftId: string,
  params: DraftParams,
): Promise<DraftUpdateResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const password = await decryptStoredToken(inbox.imap_password);
  const { folder, uid: oldUid } = decodeImapId(draftId);
  if (!Number.isFinite(oldUid) || oldUid <= 0) throw new Error("draft_not_found");
  const messageId = crypto.randomUUID();
  const from = inbox.display_name
    ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
    : inbox.email_address;

  const mime = buildMimeMessage({
    from,
    to: params.to.length ? params.to : [inbox.email_address],
    cc: params.cc.length ? params.cc : undefined,
    // Persist BCC into the draft MIME so imapSendDraft can recover the BCC
    // recipients later. Stripped from the transmitted copy at send time.
    bcc: params.bcc.length ? params.bcc : undefined,
    includeBccHeader: true,
    subject: params.subject,
    textBody: params.body,
    htmlBody: params.htmlBody,
    messageId,
  });

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });

    // The draft physically lives in `folder` (decoded from the draft_id). Use
    // that RAW name consistently for append, fallback search, AND expunge so
    // all three target the same mailbox — otherwise (e.g. folder "Draft" vs
    // imapFolderName("Draft")="Drafts") the old draft would be left orphaned.
    // Mirrors imapCreateDraft, which uses the folder name consistently.

    // IMAP "update" = APPEND new + EXPUNGE old, so each update mints a NEW UID
    // (a new draft_id). If the caller passed a stale draft_id whose UID was
    // already superseded by a prior update, the old message no longer exists.
    // Verify it is present BEFORE appending, otherwise we would silently create
    // a duplicate draft and the EXPUNGE below would no-op. Surface a clean
    // draft_not_found so the handler can tell the caller to re-fetch the id.
    await client.selectMailbox(folder);
    const existing = await client.uidSearch(`UID ${oldUid}`);
    if (!existing.includes(oldUid)) throw new Error("draft_not_found");

    let newUid: number | undefined;
    const res = await client.appendWithFlags(folder, mime, ["\\Draft", "\\Seen"]);
    if (res.ok) {
      newUid = res.uid;
    }
    if (newUid === undefined) {
      await client.selectMailbox(folder);
      const found = await client.uidSearch(
        `HEADER Message-ID "<${messageId}@mcpemails.com>"`,
      );
      newUid = found.length > 0 ? found[found.length - 1] : 0;
    }

    // Delete the old draft (same mailbox the new copy was appended to).
    await client.selectMailbox(folder);
    await client.uidStore([oldUid], ["\\Deleted"], "add");
    await client.uidExpunge([oldUid]);

    return {
      draft_id: encodeImapId(folder, newUid ?? 0),
      subject: params.subject,
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

async function imapSendDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftSendResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(draftId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("draft_not_found");
  const password = await decryptStoredToken(inbox.imap_password);

  // Step 1: Fetch the raw MIME from the Drafts folder.
  let rawMime: string | null = null;
  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    const msg = await client.fetchMessageRaw(uid);
    if (!msg) throw new Error("draft_not_found");
    rawMime = msg.raw;
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }

  if (!rawMime) throw new Error("draft_not_found");

  // Step 2: Parse recipients from headers.
  const parsed = parseEmail(rawMime);
  const h = parsed.headers;
  const toAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "to") ?? ""));
  const ccAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "cc") ?? ""));
  const bccAddrs = parseAddressList(decodeEncodedWords(getHeader(h, "bcc") ?? ""));
  const recipients = [...toAddrs, ...ccAddrs, ...bccAddrs]
    .map((a) => a.email)
    .filter(Boolean);

  if (recipients.length === 0) throw new Error("draft_has_no_recipients");

  // Step 3: Send via SMTP. The BCC addresses parsed above are included in the
  // envelope (RCPT TO via `recipients`), but the transmitted message body MUST
  // NOT contain a Bcc header — strip it so To/Cc recipients never see the BCC
  // addresses. (The draft still in the Drafts folder may keep its Bcc header;
  // that's the user's own copy.)
  const sentMime = stripBccHeader(rawMime);
  await imapSmtpSend(inbox, sentMime, recipients);

  // Step 4: Append to Sent folder (best-effort). Use the BCC-stripped copy so
  // the Sent record matches what was actually transmitted.
  await appendToSentFolder(inbox, sentMime);

  // Step 5: Delete the draft (best-effort — failure must not fail the send).
  client = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    await client.uidStore([uid], ["\\Deleted"], "add");
    await client.uidExpunge([uid]);
  } catch {
    // best-effort
  } finally {
    if (client) await client.logout().catch(() => {});
  }

  const origMsgId = decodeEncodedWords(getHeader(parsed.headers, "message-id") ?? "");
  return {
    draft_id: draftId,
    message_id: origMsgId || `<${draftId}@mcpemails.com>`,
    sent_at: new Date().toISOString(),
  };
}

/**
 * Permanently delete an IMAP draft: mark it \Deleted in the Drafts folder and
 * EXPUNGE. Mirrors the best-effort delete step in imapSendDraft, but here the
 * delete IS the operation, so a failure surfaces as an error. A bad/stale
 * draft_id (no such UID) maps to "draft_not_found".
 */
async function imapDeleteDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftDeleteResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const { folder, uid } = decodeImapId(draftId);
  if (!Number.isFinite(uid) || uid <= 0) throw new Error("draft_not_found");
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox(imapFolderName(folder));
    const msg = await client.fetchMessageRaw(uid);
    if (!msg) throw new Error("draft_not_found");
    await client.uidStore([uid], ["\\Deleted"], "add");
    await client.uidExpunge([uid]);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }

  return { draft_id: draftId, deleted: true };
}

// ── Gmail draft helpers ───────────────────────────────────────────────────────

async function gmailListDrafts(
  inbox: InboxRow,
  limit: number,
): Promise<DraftSummary[]> {
  const token = await withFreshGmailToken(inbox);
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listResp.ok) {
    if (listResp.status === 401) throw new Error("gmail_auth_failed");
    throw new Error(`Gmail drafts.list error: ${listResp.statusText}`);
  }
  const listData = (await listResp.json()) as {
    drafts?: { id: string; message: { id: string } }[];
  };
  const drafts = listData.drafts ?? [];

  const summaries: DraftSummary[] = [];
  for (const d of drafts) {
    try {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${d.message.id}` +
        `?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgResp.ok) continue;
      const msgData = (await msgResp.json()) as {
        payload?: { headers?: { name: string; value: string }[] };
        internalDate?: string;
      };
      const hdr = msgData.payload?.headers ?? [];
      const subject = hdr.find((h) => h.name === "Subject")?.value ?? "(no subject)";
      const toRaw = hdr.find((h) => h.name === "To")?.value ?? "";
      const ccRaw = hdr.find((h) => h.name === "Cc")?.value ?? "";
      const internalDate = msgData.internalDate
        ? new Date(parseInt(msgData.internalDate, 10)).toISOString()
        : new Date().toISOString();
      summaries.push({
        draft_id: d.id,
        subject,
        to: parseAddressList(toRaw),
        cc: parseAddressList(ccRaw),
        created_at: internalDate,
      });
    } catch {
      // Skip drafts that fail to fetch metadata.
    }
  }
  return summaries;
}

/**
 * Fetch a single Gmail draft's subject + to/cc/bcc headers. Used to preserve
 * fields omitted from a partial draft_update (Gmail's update is a full-replace
 * PUT, so an omitted recipient field would otherwise blank the draft). Returns
 * null when the draft can't be read. (Note: gmailUpdateDraft does not currently
 * emit a Bcc header, so Gmail drafts never carry bcc to begin with — bcc here is
 * recovered for completeness but is effectively always empty.)
 */
async function gmailGetDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftContent | null> {
  const token = await withFreshGmailToken(inbox);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}` +
    `?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    return null;
  }
  const data = (await resp.json()) as {
    message?: { payload?: { headers?: { name: string; value: string }[] } };
  };
  const hdr = data.message?.payload?.headers ?? [];
  const header = (name: string) =>
    hdr.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return {
    subject: header("subject") || "(no subject)",
    to: parseAddressList(header("to")).map(formatAddressEntry),
    cc: parseAddressList(header("cc")).map(formatAddressEntry),
    bcc: parseAddressList(header("bcc")).map(formatAddressEntry),
  };
}

async function gmailCreateDraft(
  inbox: InboxRow,
  params: DraftParams,
): Promise<DraftCreateResult> {
  const token = await withFreshGmailToken(inbox);
  const messageId = crypto.randomUUID();
  const from = inbox.display_name
    ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
    : inbox.email_address;

  const mime = buildMimeMessage({
    from,
    to: params.to.length ? params.to : [inbox.email_address],
    cc: params.cc.length ? params.cc : undefined,
    subject: params.subject,
    textBody: params.body,
    htmlBody: params.htmlBody,
    messageId,
  });

  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw: mimeMessageToBase64url(mime) } }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    throw new Error(`Gmail drafts.create error: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { id: string };
  return {
    draft_id: data.id,
    subject: params.subject,
    to: params.to.map((e) => parseEmailAddress(e)),
    created_at: new Date().toISOString(),
  };
}

async function gmailUpdateDraft(
  inbox: InboxRow,
  draftId: string,
  params: DraftParams,
): Promise<DraftUpdateResult> {
  const token = await withFreshGmailToken(inbox);
  const messageId = crypto.randomUUID();
  const from = inbox.display_name
    ? `${encodeMimeHeaderValue(inbox.display_name)} <${inbox.email_address}>`
    : inbox.email_address;

  const mime = buildMimeMessage({
    from,
    to: params.to.length ? params.to : [inbox.email_address],
    cc: params.cc.length ? params.cc : undefined,
    subject: params.subject,
    textBody: params.body,
    htmlBody: params.htmlBody,
    messageId,
  });

  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw: mimeMessageToBase64url(mime) } }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    throw new Error(`Gmail drafts.update error: ${resp.statusText}`);
  }
  return {
    draft_id: draftId,
    subject: params.subject,
    updated_at: new Date().toISOString(),
  };
}

async function gmailSendDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftSendResult> {
  const token = await withFreshGmailToken(inbox);
  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: draftId }),
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    if (resp.status === 429) throw new Error("quota_exceeded");
    throw new Error(`Gmail drafts.send error: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { id?: string };
  return {
    draft_id: draftId,
    message_id: data.id ?? draftId,
    sent_at: new Date().toISOString(),
  };
}

/**
 * Permanently delete a Gmail draft via drafts.delete. 404 → "draft_not_found".
 */
async function gmailDeleteDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftDeleteResult> {
  const token = await withFreshGmailToken(inbox);
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("gmail_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    if (resp.status === 429) throw new Error("quota_exceeded");
    throw new Error(await gmailErrorMessage("Gmail drafts.delete error", resp));
  }
  return { draft_id: draftId, deleted: true };
}

// ── Outlook draft helpers ─────────────────────────────────────────────────────

async function outlookListDrafts(
  inbox: InboxRow,
  limit: number,
): Promise<DraftSummary[]> {
  const token = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/Drafts/messages` +
    `?$select=id,subject,toRecipients,ccRecipients,createdDateTime` +
    `&$top=${limit}&$orderby=createdDateTime%20desc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    throw new Error(`Outlook draft list error: ${resp.statusText}`);
  }
  const data = (await resp.json()) as {
    value?: {
      id: string;
      subject?: string;
      toRecipients?: { emailAddress: { address: string; name?: string } }[];
      ccRecipients?: { emailAddress: { address: string; name?: string } }[];
      createdDateTime?: string;
    }[];
  };
  return (data.value ?? []).map((m) => ({
    draft_id: m.id,
    subject: m.subject ?? "(no subject)",
    to: (m.toRecipients ?? []).map((r) => ({
      name: r.emailAddress.name ?? "",
      email: r.emailAddress.address,
    })),
    cc: (m.ccRecipients ?? []).map((r) => ({
      name: r.emailAddress.name ?? "",
      email: r.emailAddress.address,
    })),
    created_at: m.createdDateTime ?? new Date().toISOString(),
  }));
}

/**
 * Fetch a single Outlook draft's subject + to/cc/bcc recipients. Outlook's
 * update is already a partial PATCH (omitted recipient fields are preserved),
 * but executeUpdateDraft merges uniformly across providers, so this supplies the
 * existing values when a field is omitted. Returns null when the draft can't be
 * read.
 */
async function outlookGetDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftContent | null> {
  const token = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}` +
    `?$select=subject,toRecipients,ccRecipients,bccRecipients`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    return null;
  }
  const data = (await resp.json()) as {
    subject?: string;
    toRecipients?: { emailAddress: { address: string; name?: string } }[];
    ccRecipients?: { emailAddress: { address: string; name?: string } }[];
    bccRecipients?: { emailAddress: { address: string; name?: string } }[];
  };
  const map = (arr?: { emailAddress: { address: string; name?: string } }[]) =>
    (arr ?? []).map((r) =>
      formatAddressEntry({ name: r.emailAddress.name ?? "", email: r.emailAddress.address }));
  return {
    subject: data.subject ?? "(no subject)",
    to: map(data.toRecipients),
    cc: map(data.ccRecipients),
    bcc: map(data.bccRecipients),
  };
}

async function outlookCreateDraft(
  inbox: InboxRow,
  params: DraftParams,
): Promise<DraftCreateResult> {
  const token = await withFreshOutlookToken(inbox);
  const mapRecip = (e: string) => {
    const p = parseEmailAddress(e);
    return { emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) } };
  };
  const body: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: params.htmlBody ? "html" : "text",
      content: params.htmlBody ?? params.body,
    },
    ...(params.to.length ? { toRecipients: params.to.map(mapRecip) } : {}),
    ...(params.cc.length ? { ccRecipients: params.cc.map(mapRecip) } : {}),
    ...(params.bcc.length ? { bccRecipients: params.bcc.map(mapRecip) } : {}),
  };
  const resp = await fetch(
    "https://graph.microsoft.com/v1.0/me/mailFolders/Drafts/messages",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    throw new Error(`Outlook create draft error: ${resp.statusText}`);
  }
  const data = (await resp.json()) as { id: string; createdDateTime?: string };
  return {
    draft_id: data.id,
    subject: params.subject,
    to: params.to.map((e) => parseEmailAddress(e)),
    created_at: data.createdDateTime ?? new Date().toISOString(),
  };
}

async function outlookUpdateDraft(
  inbox: InboxRow,
  draftId: string,
  params: DraftParams,
): Promise<DraftUpdateResult> {
  const token = await withFreshOutlookToken(inbox);
  const mapRecip = (e: string) => {
    const p = parseEmailAddress(e);
    return { emailAddress: { address: p.email, ...(p.name ? { name: p.name } : {}) } };
  };
  const patch: Record<string, unknown> = {
    subject: params.subject,
    body: {
      contentType: params.htmlBody ? "html" : "text",
      content: params.htmlBody ?? params.body,
    },
    ...(params.to.length ? { toRecipients: params.to.map(mapRecip) } : {}),
    ...(params.cc.length ? { ccRecipients: params.cc.map(mapRecip) } : {}),
    ...(params.bcc.length ? { bccRecipients: params.bcc.map(mapRecip) } : {}),
  };
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    throw new Error(`Outlook update draft error: ${resp.statusText}`);
  }
  return {
    draft_id: draftId,
    subject: params.subject,
    updated_at: new Date().toISOString(),
  };
}

async function outlookSendDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftSendResult> {
  const token = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Length": "0",
      },
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope (e.g. inbox consented before Mail.ReadWrite was added); treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    throw new Error(`Outlook send draft error: ${resp.statusText}`);
  }
  return {
    draft_id: draftId,
    message_id: draftId,
    sent_at: new Date().toISOString(),
  };
}

/**
 * Permanently delete an Outlook draft. Drafts are regular messages, so
 * DELETE /me/messages/{id} removes it. 404 → "draft_not_found".
 */
async function outlookDeleteDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftDeleteResult> {
  const token = await withFreshOutlookToken(inbox);
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!resp.ok) {
    // 403 = insufficient scope; treat like 401 so the user is told to reconnect.
    if (resp.status === 401 || resp.status === 403) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    throw new Error(`Outlook delete draft error: ${resp.statusText}`);
  }
  return { draft_id: draftId, deleted: true };
}

// ── Fastmail draft helpers ────────────────────────────────────────────────────

/** Shared session discovery for Fastmail JMAP draft operations. */
async function getFastmailSession(inbox: InboxRow): Promise<{
  accountId: string;
  apiUrl: string;
  authHeader: string;
}> {
  const authHeader = await buildFastmailAuthHeader(inbox);
  const sessionResp = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { Authorization: authHeader },
  });
  if (!sessionResp.ok) {
    if (sessionResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail session error: ${sessionResp.statusText}`);
  }
  const session = (await sessionResp.json()) as {
    primaryAccounts?: Record<string, string>;
    apiUrl?: string;
  };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  const apiUrl = session.apiUrl ?? "https://api.fastmail.com/jmap/api/";
  if (!accountId) throw new Error("Fastmail JMAP: could not determine accountId.");
  return { accountId, apiUrl, authHeader };
}

async function fastmailListDrafts(
  inbox: InboxRow,
  limit: number,
): Promise<DraftSummary[]> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      ["Email/query", {
        accountId,
        filter: { hasKeyword: "$draft" },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      }, "q1"],
      ["Email/get", {
        accountId,
        "#ids": { resultOf: "q1", name: "Email/query", path: "/ids" },
        properties: ["id", "subject", "to", "cc", "receivedAt"],
      }, "g1"],
    ],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP list drafts error: ${apiResp.statusText}`);
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, {
      list?: {
        id: string;
        subject?: string;
        to?: { name?: string; email: string }[];
        cc?: { name?: string; email: string }[];
        receivedAt?: string;
      }[];
    }, string][];
  };
  const emails = apiData.methodResponses
    ?.find(([name]) => name === "Email/get")?.[1]?.list ?? [];
  return emails.map((e) => ({
    draft_id: e.id,
    subject: e.subject ?? "(no subject)",
    to: (e.to ?? []).map((a) => ({ name: a.name ?? "", email: a.email })),
    cc: (e.cc ?? []).map((a) => ({ name: a.name ?? "", email: a.email })),
    created_at: e.receivedAt ?? new Date().toISOString(),
  }));
}

/**
 * Fetch a single Fastmail draft's subject + to/cc/bcc via JMAP Email/get.
 * Fastmail's update (Email/set) is a partial patch — omitted recipient fields
 * are preserved — but executeUpdateDraft merges uniformly across providers, so
 * this supplies the existing values when a field is omitted. Returns null when
 * the draft can't be read.
 */
async function fastmailGetDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftContent | null> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      ["Email/get", {
        accountId,
        ids: [draftId],
        properties: ["id", "subject", "to", "cc", "bcc"],
      }, "g1"],
    ],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    return null;
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, {
      list?: {
        id: string;
        subject?: string;
        to?: { name?: string; email: string }[];
        cc?: { name?: string; email: string }[];
        bcc?: { name?: string; email: string }[];
      }[];
    }, string][];
  };
  const e = apiData.methodResponses
    ?.find(([name]) => name === "Email/get")?.[1]?.list?.[0];
  if (!e) return null;
  const map = (arr?: { name?: string; email: string }[]) =>
    (arr ?? []).map((a) => formatAddressEntry({ name: a.name ?? "", email: a.email }));
  return {
    subject: e.subject ?? "(no subject)",
    to: map(e.to),
    cc: map(e.cc),
    bcc: map(e.bcc),
  };
}

async function fastmailCreateDraft(
  inbox: InboxRow,
  params: DraftParams,
): Promise<DraftCreateResult> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const { draftsId } = await resolveFastmailRoleMailboxes(apiUrl, authHeader, accountId);
  if (!draftsId) throw new Error("Fastmail JMAP: could not resolve Drafts mailbox.");

  const fromAddress = inbox.display_name
    ? { name: inbox.display_name, email: inbox.email_address }
    : { email: inbox.email_address };
  const mapAddr = (e: string) => {
    const p = parseEmailAddress(e);
    return p.name ? { name: p.name, email: p.email } : { email: p.email };
  };

  const bodyValues: Record<string, unknown> = {
    textPart: { value: params.body, charset: "utf-8" },
  };
  if (params.htmlBody) bodyValues["htmlPart"] = { value: params.htmlBody, charset: "utf-8" };

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsId]: true },
    from: [fromAddress],
    ...(params.to.length ? { to: params.to.map(mapAddr) } : {}),
    ...(params.cc.length ? { cc: params.cc.map(mapAddr) } : {}),
    ...(params.bcc.length ? { bcc: params.bcc.map(mapAddr) } : {}),
    subject: params.subject,
    bodyValues,
    textBody: [{ partId: "textPart", type: "text/plain" }],
    ...(params.htmlBody ? { htmlBody: [{ partId: "htmlPart", type: "text/html" }] } : {}),
    keywords: { "$draft": true },
  };

  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Email/set", { accountId, create: { draft: emailCreate } }, "e1"]],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP create draft error: ${apiResp.statusText}`);
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, { created?: Record<string, { id?: string }> }, string][];
  };
  const created = apiData.methodResponses?.find(([n]) => n === "Email/set")?.[1]?.created;
  const draftId = created?.["draft"]?.id;
  if (!draftId) throw new Error("Fastmail JMAP: draft creation returned no id.");
  return {
    draft_id: draftId,
    subject: params.subject,
    to: params.to.map((e) => parseEmailAddress(e)),
    created_at: new Date().toISOString(),
  };
}

async function fastmailUpdateDraft(
  inbox: InboxRow,
  draftId: string,
  params: DraftParams,
): Promise<DraftUpdateResult> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const mapAddr = (e: string) => {
    const p = parseEmailAddress(e);
    return p.name ? { name: p.name, email: p.email } : { email: p.email };
  };

  const bodyValues: Record<string, unknown> = {
    textPart: { value: params.body, charset: "utf-8" },
  };
  if (params.htmlBody) bodyValues["htmlPart"] = { value: params.htmlBody, charset: "utf-8" };

  const update: Record<string, unknown> = {
    subject: params.subject,
    bodyValues,
    textBody: [{ partId: "textPart", type: "text/plain" }],
    ...(params.htmlBody ? { htmlBody: [{ partId: "htmlPart", type: "text/html" }] } : {}),
    ...(params.to.length ? { to: params.to.map(mapAddr) } : {}),
    ...(params.cc.length ? { cc: params.cc.map(mapAddr) } : {}),
    ...(params.bcc.length ? { bcc: params.bcc.map(mapAddr) } : {}),
  };

  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [["Email/set", { accountId, update: { [draftId]: update } }, "e1"]],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP update draft error: ${apiResp.statusText}`);
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, {
      notUpdated?: Record<string, { type: string; description?: string }>;
    }, string][];
  };
  const notUpdated = apiData.methodResponses?.find(([n]) => n === "Email/set")?.[1]?.notUpdated;
  if (notUpdated?.[draftId]) {
    const errObj = notUpdated[draftId];
    if (errObj.type === "notFound") throw new Error("draft_not_found");
    throw new Error(`Fastmail JMAP update draft failed: ${errObj.description ?? errObj.type}`);
  }
  return {
    draft_id: draftId,
    subject: params.subject,
    updated_at: new Date().toISOString(),
  };
}

async function fastmailSendDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftSendResult> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const { sentId } = await resolveFastmailRoleMailboxes(apiUrl, authHeader, accountId);

  const successUpdate: Record<string, unknown> = {
    "keywords/$draft": null,
    "keywords/$seen": true,
  };
  if (sentId) successUpdate[`mailboxIds/${sentId}`] = true;

  const submissionSet: Record<string, unknown> = {
    accountId,
    create: {
      sub1: {
        emailId: draftId,
        envelope: { mailFrom: { email: inbox.email_address } },
      },
    },
    onSuccessUpdateEmail: { sub1: successUpdate },
  };

  const jmapBody = {
    using: [
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ],
    methodCalls: [["EmailSubmission/set", submissionSet, "s1"]],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP send draft error: ${apiResp.statusText}`);
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, {
      notCreated?: Record<string, { type: string; description?: string }>;
    }, string][];
  };
  const subResp = apiData.methodResponses?.find(([n]) => n === "EmailSubmission/set")?.[1];
  if (subResp?.notCreated?.["sub1"]) {
    const errObj = subResp.notCreated["sub1"];
    if (errObj.type === "emailNotFound") throw new Error("draft_not_found");
    throw new Error(`Fastmail JMAP submission failed: ${errObj.description ?? errObj.type}`);
  }
  return {
    draft_id: draftId,
    message_id: draftId,
    sent_at: new Date().toISOString(),
  };
}

/**
 * Permanently delete a Fastmail draft via JMAP Email/set { destroy }.
 * A destroyed-id that isn't found (notDestroyed) maps to "draft_not_found".
 */
async function fastmailDeleteDraft(
  inbox: InboxRow,
  draftId: string,
): Promise<DraftDeleteResult> {
  const { accountId, apiUrl, authHeader } = await getFastmailSession(inbox);
  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      ["Email/set", { accountId, destroy: [draftId] }, "d1"],
    ],
  };
  const apiResp = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(jmapBody),
  });
  if (!apiResp.ok) {
    if (apiResp.status === 401) throw new Error("fastmail_auth_failed");
    throw new Error(`Fastmail JMAP delete draft error: ${apiResp.statusText}`);
  }
  const apiData = (await apiResp.json()) as {
    methodResponses?: [string, {
      destroyed?: string[];
      notDestroyed?: Record<string, { type: string; description?: string }>;
    }, string][];
  };
  const setResp = apiData.methodResponses?.find(([n]) => n === "Email/set")?.[1];
  if (setResp?.notDestroyed?.[draftId]) {
    const errObj = setResp.notDestroyed[draftId];
    if (errObj.type === "notFound") throw new Error("draft_not_found");
    throw new Error(`Fastmail JMAP delete failed: ${errObj.description ?? errObj.type}`);
  }
  return { draft_id: draftId, deleted: true };
}

// ── Drafts execute functions ──────────────────────────────────────────────────

async function executeListDrafts(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "draft_list: arguments must be an object with inbox_id." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const limit = typeof args["limit"] === "number"
    ? Math.min(50, Math.max(1, Math.floor(args["limit"])))
    : 20;

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "draft_list");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  let drafts: DraftSummary[];
  try {
    switch (inbox.provider) {
      case "gmail":    drafts = await gmailListDrafts(inbox, limit);    break;
      case "outlook":  drafts = await outlookListDrafts(inbox, limit);  break;
      case "fastmail": drafts = await fastmailListDrafts(inbox, limit); break;
      default:         drafts = await imapListDrafts(inbox, limit);     break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    console.error("[mcp-server] draft_list: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to list drafts for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk({ inbox_id: inbox.id, drafts }, true),
    logStatus: "success", logErrorCode: null,
  };
}

async function executeCreateDraft(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "draft_create: arguments must be an object with inbox_id, subject, and body." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const subject = typeof args["subject"] === "string" && args["subject"].length > 0
    ? args["subject"] : null;
  if (!subject) {
    return {
      result: { content: [{ type: "text", text: "draft_create: subject is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const body = typeof args["body"] === "string" && args["body"].length > 0
    ? args["body"] : null;
  if (!body) {
    return {
      result: { content: [{ type: "text", text: "draft_create: body is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const to: string[] = Array.isArray(args["to"]) ? (args["to"] as string[]) : [];
  const cc: string[] = Array.isArray(args["cc"]) ? (args["cc"] as string[]) : [];
  const bcc: string[] = Array.isArray(args["bcc"]) ? (args["bcc"] as string[]) : [];
  const htmlBody = typeof args["html_body"] === "string" ? args["html_body"] : undefined;

  for (const addr of [...to, ...cc, ...bcc]) {
    if (typeof addr !== "string" || !isValidEmailAddress(addr)) {
      return {
        result: { content: [{ type: "text", text: `draft_create: invalid email address: "${String(addr)}".` }], isError: true },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "draft_create");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  // Embed the inbox signature into the draft body so the stored draft (visible
  // in the provider's Drafts folder) already contains it. draft_send must NOT
  // re-append (see executeSendDraft) or the signature would double. Drafts are
  // new-message-shaped, so reuse applySignature (single source of signature
  // strings). include_signature: false suppresses it for this draft.
  const includeSignature = args["include_signature"] === false ? false : undefined;
  const signed = applySignature(
    { textBody: body, htmlBody },
    inbox,
    { include_signature: includeSignature },
  );

  const draftParams: DraftParams = {
    to,
    cc,
    bcc,
    subject,
    body: signed.textBody,
    htmlBody: signed.htmlBody,
  };
  let draftResult: DraftCreateResult;
  try {
    switch (inbox.provider) {
      case "gmail":    draftResult = await gmailCreateDraft(inbox, draftParams);    break;
      case "outlook":  draftResult = await outlookCreateDraft(inbox, draftParams);  break;
      case "fastmail": draftResult = await fastmailCreateDraft(inbox, draftParams); break;
      default:         draftResult = await imapCreateDraft(inbox, draftParams);     break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    console.error("[mcp-server] draft_create: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to create draft for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(draftResult as unknown as Record<string, unknown>),
    logStatus: "success", logErrorCode: null,
  };
}

async function executeUpdateDraft(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "draft_update: arguments must be an object with inbox_id, draft_id, and body (subject is optional)." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const draftId = typeof args["draft_id"] === "string" && args["draft_id"].length > 0
    ? args["draft_id"] : null;
  if (!draftId) {
    return {
      result: { content: [{ type: "text", text: "draft_update: draft_id is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  // `subject` is OPTIONAL on update: omit it to keep the draft's current subject.
  // (A caller changing only the body shouldn't have to resend the subject.) When
  // omitted we resolve the existing subject below, after the inbox is resolved.
  const subjectProvided = typeof args["subject"] === "string";
  const subject = subjectProvided ? (args["subject"] as string) : null;
  // `body` is REQUIRED on every update — there is nothing to preserve because the
  // caller must always supply the full body. `html_body` is optional; omitting it
  // sends a plain-text body, which is the intended behaviour (a body is always
  // provided in full, so neither needs the merge-from-existing treatment below).
  const body = typeof args["body"] === "string" && args["body"].length > 0
    ? args["body"] : null;
  if (!body) {
    return {
      result: { content: [{ type: "text", text: "draft_update: body is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  // `to`/`cc`/`bcc` are OPTIONAL on update, mirroring `subject`: omit a field to
  // keep the draft's current recipients, or pass an explicit (possibly empty)
  // array to set/clear it. Array.isArray distinguishes "omitted" (preserve) from
  // an explicit `[]` (clear). Omitted fields are restored from the existing draft
  // below, after the inbox is resolved — without this, full-replace providers
  // (Gmail/IMAP) would blank the draft's recipients when only the body changes.
  const toProvided = Array.isArray(args["to"]);
  const ccProvided = Array.isArray(args["cc"]);
  const bccProvided = Array.isArray(args["bcc"]);
  const to: string[] = toProvided ? (args["to"] as string[]) : [];
  const cc: string[] = ccProvided ? (args["cc"] as string[]) : [];
  const bcc: string[] = bccProvided ? (args["bcc"] as string[]) : [];
  const htmlBody = typeof args["html_body"] === "string" ? args["html_body"] : undefined;

  for (const addr of [...to, ...cc, ...bcc]) {
    if (typeof addr !== "string" || !isValidEmailAddress(addr)) {
      return {
        result: { content: [{ type: "text", text: `draft_update: invalid email address: "${String(addr)}".` }], isError: true },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "draft_update");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  // When any of subject/to/cc/bcc was omitted, preserve the draft's existing
  // value rather than blanking it (Gmail/IMAP updates are full-replace; Outlook/
  // Fastmail are partial patches that already preserve, but merging uniformly is
  // harmless and keeps one code path). Fetch the current draft ONCE and fill the
  // omitted fields. Non-fatal: if the fetch fails we proceed with the provided
  // values (empty subject / empty recipients), and the provider update will
  // surface draft_not_found on its own if the id is bad.
  let effectiveSubject = subject ?? "";
  let effectiveTo = to;
  let effectiveCc = cc;
  let effectiveBcc = bcc;
  if (!subjectProvided || !toProvided || !ccProvided || !bccProvided) {
    try {
      let existing: DraftContent | null;
      switch (inbox.provider) {
        case "gmail":    existing = await gmailGetDraft(inbox, draftId);    break;
        case "outlook":  existing = await outlookGetDraft(inbox, draftId);  break;
        case "fastmail": existing = await fastmailGetDraft(inbox, draftId); break;
        default:         existing = await imapGetDraft(inbox, draftId);     break;
      }
      if (existing) {
        if (!subjectProvided) effectiveSubject = existing.subject;
        if (!toProvided) effectiveTo = existing.to;
        if (!ccProvided) effectiveCc = existing.cc;
        if (!bccProvided) effectiveBcc = existing.bcc;
      }
    } catch {
      // Non-fatal: if we can't read the current draft, proceed with what we have.
    }
  }

  // Re-embed the inbox signature on update. draft_update always supplies the
  // full body, so we sign the new body just like draft_create (single source:
  // applySignature). draft_send sends the stored body as-is and never re-appends
  // (see executeSendDraft). include_signature: false suppresses it.
  const includeSignature = args["include_signature"] === false ? false : undefined;
  const signed = applySignature(
    { textBody: body, htmlBody },
    inbox,
    { include_signature: includeSignature },
  );

  const draftParams: DraftParams = {
    to: effectiveTo, cc: effectiveCc, bcc: effectiveBcc,
    subject: effectiveSubject, body: signed.textBody, htmlBody: signed.htmlBody,
  };
  let updateResult: DraftUpdateResult;
  try {
    switch (inbox.provider) {
      case "gmail":    updateResult = await gmailUpdateDraft(inbox, draftId, draftParams);    break;
      case "outlook":  updateResult = await outlookUpdateDraft(inbox, draftId, draftParams);  break;
      case "fastmail": updateResult = await fastmailUpdateDraft(inbox, draftId, draftParams); break;
      default:         updateResult = await imapUpdateDraft(inbox, draftId, draftParams);     break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "draft_not_found") {
      return {
        result: { content: [{ type: "text", text: draftNotFoundMessage(inbox.provider, draftId, "update") }], isError: true },
        logStatus: "error", logErrorCode: "draft_not_found",
      };
    }
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    console.error("[mcp-server] draft_update: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to update draft for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(updateResult as unknown as Record<string, unknown>),
    logStatus: "success", logErrorCode: null,
  };
}

async function executeSendDraft(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "draft_send: arguments must be an object with inbox_id and draft_id." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const draftId = typeof args["draft_id"] === "string" && args["draft_id"].length > 0
    ? args["draft_id"] : null;
  if (!draftId) {
    return {
      result: { content: [{ type: "text", text: "draft_send: draft_id is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  // ── Scope check (belt-and-suspenders) ────────────────────────────────────
  // Sending a draft transmits mail and therefore requires send:email, exactly
  // like email_send / email_reply / email_forward. The dispatch-layer scope
  // gate already enforces this, but repeat it here so the check survives any
  // future refactor of the action→scope mapping. manage:drafts alone must NOT
  // be able to send.
  if (!apiKey.scopes.includes("send:email")) {
    return {
      result: {
        content: [{ type: "text", text: "draft_send: the 'send:email' scope is required to send a draft." }],
        isError: true,
      },
      logStatus: "error", logErrorCode: "scope_denied",
    };
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "draft_send");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  // SIGNATURE RULE: draft_send sends the STORED draft body verbatim and never
  // re-applies the signature here. The signature was already embedded at
  // draft_create / draft_update time (see those functions), so re-appending
  // would double it. Do NOT call applySignature in this path.
  let sendResult: DraftSendResult;
  try {
    switch (inbox.provider) {
      case "gmail":    sendResult = await gmailSendDraft(inbox, draftId);    break;
      case "outlook":  sendResult = await outlookSendDraft(inbox, draftId);  break;
      case "fastmail": sendResult = await fastmailSendDraft(inbox, draftId); break;
      default:         sendResult = await imapSendDraft(inbox, draftId);     break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "draft_not_found") {
      return {
        result: { content: [{ type: "text", text: draftNotFoundMessage(inbox.provider, draftId, "send") }], isError: true },
        logStatus: "error", logErrorCode: "draft_not_found",
      };
    }
    if (message === "draft_has_no_recipients") {
      return {
        result: { content: [{ type: "text", text: "draft_send: the draft has no recipients. Add at least one To address via draft_update before sending." }], isError: true },
        logStatus: "error", logErrorCode: "draft_has_no_recipients",
      };
    }
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    if (message === "quota_exceeded") {
      return {
        result: { content: [{ type: "text", text: "Your email account has exceeded its sending quota. Please try again later." }], isError: true },
        logStatus: "error", logErrorCode: "quota_exceeded",
      };
    }
    console.error("[mcp-server] draft_send: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: {
        content: [{ type: "text", text: `An error occurred while sending the draft via ${inbox.provider}. The message may or may not have been delivered. Do not retry automatically to avoid duplicate delivery.` }],
        isError: true,
      },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(sendResult as unknown as Record<string, unknown>),
    logStatus: "success", logErrorCode: null,
  };
}

async function executeDeleteDraft(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "draft_delete: arguments must be an object with inbox_id and draft_id." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const draftId = typeof args["draft_id"] === "string" && args["draft_id"].length > 0
    ? args["draft_id"] : null;
  if (!draftId) {
    return {
      result: { content: [{ type: "text", text: "draft_delete: draft_id is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "draft_delete");
  const inbox = resolved.inbox;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  let deleteResult: DraftDeleteResult;
  try {
    switch (inbox.provider) {
      case "gmail":    deleteResult = await gmailDeleteDraft(inbox, draftId);    break;
      case "outlook":  deleteResult = await outlookDeleteDraft(inbox, draftId);  break;
      case "fastmail": deleteResult = await fastmailDeleteDraft(inbox, draftId); break;
      default:         deleteResult = await imapDeleteDraft(inbox, draftId);     break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "draft_not_found") {
      return {
        result: { content: [{ type: "text", text: draftNotFoundMessage(inbox.provider, draftId, "delete") }], isError: true },
        logStatus: "error", logErrorCode: "draft_not_found",
      };
    }
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return authFailedResult(inbox.provider, inbox.id, "access");
    }
    if (message === "quota_exceeded") {
      return {
        result: { content: [{ type: "text", text: "Your email account has exceeded its quota. Please try again later." }], isError: true },
        logStatus: "error", logErrorCode: "quota_exceeded",
      };
    }
    console.error("[mcp-server] draft_delete: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to delete draft for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: jsonOk(deleteResult as unknown as Record<string, unknown>),
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Contacts tools — Phase 6
//
// `contact_search` aggregates correspondents directly from LIVE mail. There is
// NO stored contacts table: every call performs a bounded, header-only scan of
// recent matching messages across the target inbox(es) and tallies the people
// who match the query. This honours the product's "we store no email data"
// promise — nothing is persisted between calls.
// ---------------------------------------------------------------------------

/** A single aggregated correspondent within ONE inbox's scan window. */
interface ContactHit {
  email_address: string;
  display_name: string | null;
  /** Number of matched messages (within the capped window) this address was in. */
  message_count: number;
  /** ISO 8601 timestamp of the most recent matched message. */
  last_contacted_at: string;
}

/** Max inboxes scanned per call when inbox_id is omitted (bounds fan-out cost). */
const CONTACT_SEARCH_MAX_INBOXES = 10;
/** Max messages inspected per inbox (bounds the per-provider scan window). */
const CONTACT_SEARCH_PER_INBOX_CAP = 80;

/**
 * Fold a single message's address entries into a running ContactHit map.
 *
 * Only addresses whose email OR display name contains the (lower-cased) query
 * are kept — this is the critical client-side filter: a message that matched
 * "alice" on the server also carries every other participant (e.g. bob), and we
 * must NOT report those non-matching people. For each kept address we bump the
 * count once per message, advance last_contacted_at to the newest date seen,
 * and prefer the most-recent non-empty display name.
 *
 * @param acc      Accumulator keyed by lower-cased email address.
 * @param entries  All address entries seen on this one message (from/to/cc).
 * @param dateIso  The message's ISO 8601 date.
 * @param queryLc  The lower-cased search query.
 */
function foldContactEntries(
  acc: Map<string, ContactHit & { _newestDate: string }>,
  entries: EmailAddressEntry[],
  dateIso: string,
  queryLc: string,
): void {
  // Dedupe addresses within a single message so one message counts at most once
  // per correspondent (a person on both To and Cc still counts as one message).
  const seenThisMessage = new Set<string>();
  for (const entry of entries) {
    const email = (entry.email ?? "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    const name = (entry.name ?? "").trim();
    // Client-side query filter: keep only people who actually match the query.
    if (!key.includes(queryLc) && !name.toLowerCase().includes(queryLc)) {
      continue;
    }
    if (seenThisMessage.has(key)) continue;
    seenThisMessage.add(key);

    const existing = acc.get(key);
    if (!existing) {
      acc.set(key, {
        email_address: email,
        display_name: name || null,
        message_count: 1,
        last_contacted_at: dateIso,
        _newestDate: dateIso,
      });
      continue;
    }
    existing.message_count += 1;
    if (dateIso > existing.last_contacted_at) {
      existing.last_contacted_at = dateIso;
    }
    // Prefer the most-recent non-empty display name seen for this address.
    if (name && dateIso >= existing._newestDate) {
      existing.display_name = name;
      existing._newestDate = dateIso;
    }
  }
}

/** Materialise the fold accumulator into plain ContactHit[] (drops _newestDate). */
function finalizeContactHits(
  acc: Map<string, ContactHit & { _newestDate: string }>,
): ContactHit[] {
  return Array.from(acc.values()).map(({ _newestDate: _drop, ...hit }) => ({
    ...hit,
    // Never emit a null display_name: fall back to the email's local-part
    // (or the full address if there's no local-part) so callers always have a label.
    display_name: hit.display_name ??
      (hit.email_address.split("@")[0] || hit.email_address),
  }));
}

/**
 * Gmail contact aggregator. Searches address headers with
 * `from:Q OR to:Q OR cc:Q`, fetches up to `cap` matched messages' metadata
 * headers (From/To/Cc/Date), and folds them through the shared query filter.
 */
async function gmailSearchContacts(
  inbox: InboxRow,
  query: string,
  cap: number,
): Promise<ContactHit[]> {
  const accessToken = await withFreshGmailToken(inbox);
  // Gmail's `q` grammar: quote the term and escape embedded quotes/backslashes
  // so a value like  a" OR is:starred  cannot break out of the quoted operand.
  const q = `"${query.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const listParams = new URLSearchParams({
    q: `from:${q} OR to:${q} OR cc:${q}`,
    maxResults: String(cap),
  });

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!listResp.ok) {
    if (listResp.status === 401) throw new Error("gmail_auth_failed");
    const errBody = (await listResp.json()) as { error?: { message?: string } };
    throw new Error(`Gmail API error: ${errBody.error?.message ?? listResp.statusText}`);
  }
  const listData = (await listResp.json()) as {
    messages?: { id: string }[];
  };
  const refs = (listData.messages ?? []).slice(0, cap);

  // Fetch From/To/Cc/Date headers in parallel (no body download).
  const metas = await Promise.all(
    refs.map(({ id }) => {
      const mp = new URLSearchParams({ format: "metadata" });
      for (const h of ["From", "To", "Cc", "Date"]) mp.append("metadataHeaders", h);
      return fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${mp}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ).then((r) => r.json() as Promise<GmailMessageMeta>);
    }),
  );

  const queryLc = query.toLowerCase();
  const acc = new Map<string, ContactHit & { _newestDate: string }>();
  for (const msg of metas) {
    const hdrs: Record<string, string> = {};
    for (const h of msg.payload?.headers ?? []) hdrs[h.name.toLowerCase()] = h.value;
    const dateIso = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString();
    const entries = [
      parseEmailAddress(hdrs["from"] ?? ""),
      ...parseAddressList(hdrs["to"] ?? ""),
      ...parseAddressList(hdrs["cc"] ?? ""),
    ];
    foldContactEntries(acc, entries, dateIso, queryLc);
  }
  return finalizeContactHits(acc);
}

/**
 * Outlook contact aggregator. Uses Graph `$search="participants:Q"` (which
 * requires `ConsistencyLevel: eventual`) to find up to `cap` messages, selects
 * only the address fields, and folds from/toRecipients/ccRecipients.
 */
async function outlookSearchContacts(
  inbox: InboxRow,
  query: string,
  cap: number,
): Promise<ContactHit[]> {
  const accessToken = await withFreshOutlookToken(inbox);
  // $search uses a KQL-quoted string; escape backslash + double-quote so the
  // term cannot break out of the participants:"…" operand.
  const escaped = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const params = new URLSearchParams({
    $search: `"participants:${escaped}"`,
    $select: "from,toRecipients,ccRecipients,receivedDateTime",
    $top: String(cap),
  });

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ConsistencyLevel: "eventual",
      },
    },
  );
  if (!resp.ok) {
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    const errBody = (await resp.json()) as { error?: { message?: string } };
    throw new Error(`Outlook Graph API error: ${errBody.error?.message ?? resp.statusText}`);
  }
  const data = (await resp.json()) as { value?: OutlookMessage[] };
  const rawMessages = (data.value ?? []).slice(0, cap);

  const mapAddr = (
    r: { emailAddress?: { name?: string; address?: string } },
  ): EmailAddressEntry => ({
    name: r.emailAddress?.name ?? "",
    email: r.emailAddress?.address ?? "",
  });

  const queryLc = query.toLowerCase();
  const acc = new Map<string, ContactHit & { _newestDate: string }>();
  for (const msg of rawMessages) {
    const dateIso = msg.receivedDateTime ?? new Date().toISOString();
    const entries: EmailAddressEntry[] = [];
    if (msg.from) entries.push(mapAddr(msg.from));
    for (const r of msg.toRecipients ?? []) entries.push(mapAddr(r));
    for (const r of msg.ccRecipients ?? []) entries.push(mapAddr(r));
    foldContactEntries(acc, entries, dateIso, queryLc);
  }
  return finalizeContactHits(acc);
}

/**
 * IMAP contact aggregator. SELECTs INBOX and runs an address-header OR search
 * (`OR OR FROM "Q" TO "Q" CC "Q"`), takes the newest `cap` UIDs, fetches their
 * envelope summaries, and folds the from/to addresses through the query filter.
 *
 * INBOX-only is acceptable for v1. The query is sanitised (control chars + the
 * IMAP quoting metacharacters `"`/`\` stripped) before being embedded in the
 * raw search command, so it cannot break out of the quoted operands or inject
 * additional IMAP commands via CR/LF.
 */
async function imapSearchContacts(
  inbox: InboxRow,
  query: string,
  cap: number,
): Promise<ContactHit[]> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  // Strip characters that would corrupt the quoted IMAP astring (backslash,
  // double-quote) or break the command line (CR/LF + other control chars).
  // deno-lint-ignore no-control-regex
  const safe = query.replace(/["\\\x00-\x1F\x7F]+/g, " ").trim().slice(0, 200);
  if (!safe) return [];
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: imapAuthUser(inbox),
      password,
    });
    await client.selectMailbox("INBOX");

    // Address-header OR search: matches messages where Q appears in From, To,
    // or Cc. RFC 3501 OR is binary, so two ORs chain three FROM/TO/CC terms.
    const uids = await client.uidSearch(
      `OR OR FROM "${safe}" TO "${safe}" CC "${safe}"`,
    );
    // Newest first, bounded to the per-inbox cap.
    const pageUids = uids.slice().sort((a, b) => b - a).slice(0, cap);
    if (pageUids.length === 0) return [];

    const summaries = await client.fetchSummaries(pageUids);

    const queryLc = query.toLowerCase();
    const acc = new Map<string, ContactHit & { _newestDate: string }>();
    for (const s of summaries) {
      // ImapMessageSummary.envelope exposes from[] and to[] address arrays.
      const entries: EmailAddressEntry[] = [
        ...s.envelope.from,
        ...s.envelope.to,
      ];
      foldContactEntries(acc, entries, s.envelope.date, queryLc);
    }
    return finalizeContactHits(acc);
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

/**
 * Dispatch a single inbox to its provider-specific contact aggregator and tag
 * every hit with the inbox_id. Fastmail routes through the IMAP path (the live
 * JMAP code is dead per project notes; service='fastmail' connections store an
 * app password and run over IMAP), mirroring how the other tools treat it.
 */
async function searchContactsForInbox(
  inbox: InboxRow,
  query: string,
  cap: number,
): Promise<(ContactHit & { inbox_id: string })[]> {
  let hits: ContactHit[];
  switch (inbox.provider) {
    case "gmail":
      hits = await gmailSearchContacts(inbox, query, cap);
      break;
    case "outlook":
      hits = await outlookSearchContacts(inbox, query, cap);
      break;
    case "fastmail":
    default:
      hits = await imapSearchContacts(inbox, query, cap);
      break;
  }
  return hits.map((h) => ({ inbox_id: inbox.id, ...h }));
}

/**
 * `contact_search` — find correspondents matching a name/email fragment by
 * scanning LIVE mail. No data is stored.
 *
 * Scope: manage:contacts
 * Required params: query (string)
 * Optional params: inbox_id (UUID), limit (integer 1–50, default 20)
 *
 * When inbox_id is provided the scan is scoped to that inbox; otherwise it
 * spans up to CONTACT_SEARCH_MAX_INBOXES of the workspace's active, accessible
 * inboxes. Each inbox is scanned for at most CONTACT_SEARCH_PER_INBOX_CAP recent
 * matching messages. Per-inbox failures are swallowed (best-effort); if EVERY
 * inbox errors the tool returns a clean error. Results are merged and sorted by
 * last_contacted_at DESC, then truncated to `limit`.
 *
 * Counts reflect matched messages WITHIN the scan window — not an all-time
 * history.
 */
async function executeSearchContacts(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "contact_search: arguments must be an object with a query field." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const query = typeof args["query"] === "string" && args["query"].length > 0
    ? args["query"] : null;
  if (!query) {
    return {
      result: { content: [{ type: "text", text: "contact_search: query is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  const limit = typeof args["limit"] === "number"
    ? Math.min(50, Math.max(1, Math.floor(args["limit"])))
    : 20;

  // Resolve the target inbox set. With inbox_id we validate accessibility and
  // scan just that inbox; without it we enumerate the workspace's active,
  // accessible inboxes (capped) — mirroring executeListInboxes' query but
  // selecting the full credentialed row (INBOX_SELECT_COLUMNS) so the provider
  // aggregators have everything they need.
  let targets: InboxRow[];
  if (inboxId) {
    const inbox = await resolveInbox(inboxId, apiKey);
    if (!inbox) {
      return {
        result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key.` }], isError: true },
        logStatus: "error", logErrorCode: "inbox_not_found",
      };
    }
    targets = [inbox];
  } else {
    let q = supabase
      .from("inboxes")
      .select(INBOX_SELECT_COLUMNS)
      .eq("workspace_id", apiKey.workspace_id)
      .is("deleted_at", null)
      .eq("status", "active")
      .order("created_at", { ascending: true });
    if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
      q = q.in("id", apiKey.inbox_ids);
    }
    const { data, error } = await q;
    if (error) {
      console.error("[mcp-server] contact_search: inbox_enumeration_failed", {
        workspace_id: apiKey.workspace_id,
        error: error.message,
      });
      return {
        result: { content: [{ type: "text", text: "contact_search: failed to enumerate inboxes." }], isError: true },
        logStatus: "error", logErrorCode: "db_error",
      };
    }
    targets = ((data ?? []) as unknown as InboxRow[]).slice(0, CONTACT_SEARCH_MAX_INBOXES);
  }

  if (targets.length === 0) {
    // No accessible inbox — return an empty (but successful) result set.
    return {
      result: jsonOk({ query, contacts: [], total: 0 }, true),
      logStatus: "success", logErrorCode: null,
    };
  }

  // Scan each target inbox in parallel; tolerate per-inbox failures so one bad
  // credential / provider hiccup doesn't sink the whole search.
  const settled = await Promise.allSettled(
    targets.map((inbox) =>
      searchContactsForInbox(inbox, query, CONTACT_SEARCH_PER_INBOX_CAP)
    ),
  );

  const allHits: (ContactHit & { inbox_id: string })[] = [];
  let anySucceeded = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      anySucceeded = true;
      allHits.push(...r.value);
    } else {
      console.error("[mcp-server] contact_search: inbox_scan_failed", {
        workspace_id: apiKey.workspace_id,
        inbox_id: targets[i].id,
        provider: targets[i].provider,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // Only fail outright when EVERY inbox errored — otherwise return partials.
  if (!anySucceeded) {
    return {
      result: { content: [{ type: "text", text: "contact_search: unable to scan any inbox for matching contacts. Please try again in a moment." }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  // Merge, sort newest-first, and truncate. (Each inbox aggregates its own
  // window independently; the same address in two inboxes yields two hits,
  // distinguished by inbox_id — consistent with the per-inbox model.)
  const contacts = allHits
    .sort((a, b) => (a.last_contacted_at < b.last_contacted_at ? 1 : -1))
    .slice(0, limit);

  return {
    result: jsonOk({ query, contacts, total: contacts.length }, true),
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Scheduling tools — Phase 7
// ---------------------------------------------------------------------------

/**
 * `schedule_create` — insert a future-delivery row into scheduled_sends.
 *
 * Scope: schedule:email
 * Required params: inbox_id (UUID), to (string[]), subject, body, send_at (ISO 8601)
 * Optional params: cc, bcc, html_body, attachments, reply_to
 *
 * Validates all inputs using the same rules as email_send, then inserts a
 * scheduled_sends row with the full email_send payload stored as JSONB.
 * The dispatcher (handleScheduledDispatch / pg_cron every minute) picks it
 * up when send_at <= now().
 */
async function executeScheduleSend(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  // to (required, non-empty array, max 50)
  const toRaw = args["to"];
  if (!Array.isArray(toRaw) || toRaw.length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: to is required and must be a non-empty array of email address strings." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (toRaw.length > 50) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: to must not exceed 50 recipients." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const to = toRaw as string[];

  // cc / bcc (optional)
  const cc: string[] = Array.isArray(args["cc"]) ? (args["cc"] as string[]) : [];
  const bcc: string[] = Array.isArray(args["bcc"]) ? (args["bcc"] as string[]) : [];

  // subject (required, 1–998 chars)
  const subjectRaw = args["subject"];
  if (typeof subjectRaw !== "string" || subjectRaw.trim().length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: subject is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (subjectRaw.length > 998) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: subject must not exceed 998 characters." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const subject = subjectRaw;

  // body (required)
  const bodyRaw = args["body"];
  if (typeof bodyRaw !== "string" || bodyRaw.trim().length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: body is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const body = bodyRaw;

  // html_body (optional)
  const htmlBody = typeof args["html_body"] === "string" ? args["html_body"] : undefined;

  // attachments (optional, max 20)
  const attachmentsRaw = args["attachments"];
  const attachments: Array<{ filename: string; mime_type: string; data: string }> = [];
  if (Array.isArray(attachmentsRaw)) {
    if (attachmentsRaw.length > 20) {
      return {
        result: { content: [{ type: "text", text: "schedule_create: attachments must not exceed 20 items." }], isError: true },
        logStatus: "error", logErrorCode: "-32602",
      };
    }
    for (const att of attachmentsRaw) {
      if (
        typeof att !== "object" || att === null ||
        typeof (att as Record<string, unknown>)["filename"] !== "string" ||
        typeof (att as Record<string, unknown>)["mime_type"] !== "string" ||
        typeof (att as Record<string, unknown>)["data"] !== "string"
      ) {
        return {
          result: { content: [{ type: "text", text: "schedule_create: each attachment must have filename, mime_type, and data fields." }], isError: true },
          logStatus: "error", logErrorCode: "-32602",
        };
      }
      attachments.push(att as { filename: string; mime_type: string; data: string });
    }
  }

  // reply_to (optional)
  const replyTo = typeof args["reply_to"] === "string" ? args["reply_to"] : undefined;

  // send_at (required — ISO 8601, must be in the future)
  const sendAtRaw = args["send_at"];
  if (typeof sendAtRaw !== "string" || sendAtRaw.trim().length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: send_at is required and must be an ISO 8601 datetime string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const sendAtMs = Date.parse(sendAtRaw);
  if (isNaN(sendAtMs)) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: send_at is not a valid ISO 8601 datetime string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (sendAtMs <= Date.now()) {
    return {
      result: { content: [{ type: "text", text: "schedule_create: send_at must be in the future." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const sendAt = new Date(sendAtMs).toISOString();

  // ── RFC 5322 address validation ────────────────────────────────────────────
  const addrChecks: Array<{ field: string; addr: unknown }> = [
    ...to.map((addr) => ({ field: "to", addr })),
    ...cc.map((addr) => ({ field: "cc", addr })),
    ...bcc.map((addr) => ({ field: "bcc", addr })),
    ...(replyTo !== undefined ? [{ field: "reply_to", addr: replyTo }] : []),
  ];
  for (const { field, addr } of addrChecks) {
    if (typeof addr !== "string" || !isValidEmailAddress(addr)) {
      return {
        result: {
          content: [{ type: "text", text: `schedule_create: invalid email address in '${field}': "${String(addr)}".` }],
          isError: true,
        },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  // ── Inbox resolution + access control ─────────────────────────────────────
  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "schedule_create");
  const inbox = resolved.inbox;
  const inboxId = inbox.id;

  // ── Capability check ───────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.scheduling) {
    return unsupportedFeatureError("scheduling", inbox.provider);
  }

  // ── Build payload (mirrors email_send args, stored as JSONB for dispatcher) ─
  const payload: Record<string, unknown> = { to, cc, bcc, subject, body };
  if (htmlBody !== undefined) payload["html_body"] = htmlBody;
  if (attachments.length > 0) payload["attachments"] = attachments;
  if (replyTo !== undefined) payload["reply_to"] = replyTo;

  // ── Encrypt payload at rest (AES-256-GCM) ──────────────────────────────────
  // The payload can contain recipients, message body and attachment bytes, so
  // it is encrypted before storage. Stored as a small jsonb wrapper so the
  // column stays jsonb; payload_encrypted=true marks the new format. Legacy
  // plaintext rows (payload_encrypted=false) are still read by the dispatcher.
  const ciphertext = await encryptForStorage(JSON.stringify(payload));

  // ── Insert into scheduled_sends ────────────────────────────────────────────
  const { data: row, error: insertErr } = await supabase
    .from("scheduled_sends")
    .insert({
      workspace_id: apiKey.workspace_id,
      inbox_id: inbox.id,
      payload: { v: 1, data: ciphertext },
      payload_encrypted: true,
      send_at: sendAt,
      status: "pending",
    })
    .select("id, inbox_id, send_at, status, created_at")
    .single();

  if (insertErr) {
    console.error("[mcp-server] schedule_create: insert_error", {
      workspace_id: apiKey.workspace_id,
      inbox_id: inbox.id,
      error: insertErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "schedule_create: database error while scheduling the send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  const created = row as { id: string; inbox_id: string; send_at: string; status: string; created_at: string };
  return {
    result: jsonOk({
      scheduled: true,
      id: created.id,
      inbox_id: created.inbox_id,
      to,
      subject,
      send_at: created.send_at,
      status: created.status,
      created_at: created.created_at,
    }, true),
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `schedule_list` — list pending scheduled sends for the workspace.
 *
 * Scope: schedule:email
 * Optional params: inbox_id (UUID), limit (integer 1–100, default 20)
 *
 * Returns rows with status IN ('pending', 'sending'), ordered by send_at ASC.
 * Each row includes a payload summary (to, subject) without the full body or
 * attachments to keep the response compact.
 */
async function executeListScheduled(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "schedule_list: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  const limit = typeof args["limit"] === "number"
    ? Math.min(100, Math.max(1, Math.floor(args["limit"])))
    : 20;

  // If inbox_id provided, validate accessibility.
  if (inboxId) {
    const inbox = await resolveInbox(inboxId, apiKey);
    if (!inbox) {
      return {
        result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key.` }], isError: true },
        logStatus: "error", logErrorCode: "inbox_not_found",
      };
    }
  }

  // Build query — workspace-scoped, pending/sending only.
  let dbQuery = supabase
    .from("scheduled_sends")
    .select("id, inbox_id, payload, payload_encrypted, send_at, status, created_at")
    .eq("workspace_id", apiKey.workspace_id)
    .in("status", ["pending", "sending"]);

  if (inboxId) {
    dbQuery = dbQuery.eq("inbox_id", inboxId);
  } else if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
    // API key scoped to specific inboxes — honour the restriction.
    dbQuery = dbQuery.in("inbox_id", apiKey.inbox_ids);
  }

  const { data, error } = await dbQuery
    .order("send_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[mcp-server] schedule_list: db_error", {
      workspace_id: apiKey.workspace_id,
      error: error.message,
    });
    return {
      result: { content: [{ type: "text", text: "schedule_list: database error while listing scheduled sends." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  const rows = await Promise.all((data ?? []).map(async (row: {
    id: string;
    inbox_id: string;
    payload: Record<string, unknown>;
    payload_encrypted?: boolean | null;
    send_at: string;
    status: string;
    created_at: string;
  }) => {
    // Dual-mode: decrypts encrypted rows, passes legacy plaintext through.
    const payload = await resolveScheduledPayload(row);
    return {
      id: row.id,
      inbox_id: row.inbox_id,
      send_at: row.send_at,
      status: row.status,
      created_at: row.created_at,
      // Payload summary: expose to + subject without the full body/attachments.
      to: Array.isArray(payload["to"]) ? payload["to"] : [],
      subject: typeof payload["subject"] === "string" ? payload["subject"] : "",
    };
  }));

  return {
    result: jsonOk({ scheduled_sends: rows, total: rows.length }, true),
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `schedule_cancel` — set status='cancelled' on a pending scheduled send.
 *
 * Scope: schedule:email
 * Required params: scheduled_send_id (UUID)
 *
 * Only rows with status 'pending' can be cancelled.  The UPDATE uses an
 * optimistic `.eq("status", "pending")` guard so a row that is already
 * being dispatched (status='sending') is not accidentally cancelled.
 * Returns the cancelled row's id, inbox_id, and send_at.
 */
async function executeCancelScheduled(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "schedule_cancel: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  // Accept either `id` (as returned by schedule_create / schedule_list) or its
  // alias `scheduled_send_id`, so a caller can round-trip the id field directly.
  const scheduledSendId =
    (typeof args["scheduled_send_id"] === "string" && args["scheduled_send_id"]) ||
    (typeof args["id"] === "string" && args["id"]) ||
    null;
  if (!scheduledSendId) {
    return {
      result: { content: [{ type: "text", text: "schedule_cancel: an id is required and must be a UUID string. Provide either `id` or `scheduled_send_id`." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  // Fetch the row (workspace-scoped) to confirm existence and current status.
  const { data: existing, error: fetchErr } = await supabase
    .from("scheduled_sends")
    .select("id, inbox_id, status, send_at")
    .eq("id", scheduledSendId)
    .eq("workspace_id", apiKey.workspace_id)
    .maybeSingle();

  if (fetchErr) {
    console.error("[mcp-server] schedule_cancel: db_error", {
      id: scheduledSendId,
      error: fetchErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "schedule_cancel: database error while fetching the scheduled send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  if (!existing) {
    return {
      result: { content: [{ type: "text", text: `schedule_cancel: scheduled send ${scheduledSendId} not found or not accessible.` }], isError: true },
      logStatus: "error", logErrorCode: "not_found",
    };
  }

  const row = existing as { id: string; inbox_id: string; status: string; send_at: string };

  // Honour API key inbox restriction BEFORE revealing any status/existence.
  // A key scoped to specific inboxes must not learn the status (or existence)
  // of a same-workspace scheduled send belonging to an inbox outside its scope,
  // so this check runs ahead of the status check below.
  if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0 && !apiKey.inbox_ids.includes(row.inbox_id)) {
    return {
      result: { content: [{ type: "text", text: `schedule_cancel: scheduled send ${scheduledSendId} not found or not accessible.` }], isError: true },
      logStatus: "error", logErrorCode: "not_found",
    };
  }

  if (row.status !== "pending") {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `schedule_cancel: cannot cancel scheduled send ${scheduledSendId} — ` +
            `current status is '${row.status}'. Only 'pending' sends can be cancelled.`,
        }],
        isError: true,
      },
      logStatus: "error", logErrorCode: "not_cancellable",
    };
  }

  // Update to 'cancelled' with optimistic status guard against dispatcher race.
  const { error: updateErr } = await supabase
    .from("scheduled_sends")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", scheduledSendId)
    .eq("workspace_id", apiKey.workspace_id)
    .eq("status", "pending");

  if (updateErr) {
    console.error("[mcp-server] schedule_cancel: update_error", {
      id: scheduledSendId,
      error: updateErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "schedule_cancel: database error while cancelling the scheduled send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  return {
    result: jsonOk({
      cancelled: true,
      id: row.id,
      inbox_id: row.inbox_id,
      send_at: row.send_at,
      previous_status: "pending",
    }, true),
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Signature tools — Phase 3
//
// `signature_get` / `signature_set` let the agent read and configure the
// per-inbox signature that the send paths append (see composeSignatureBlocks /
// applySignature). Setting marks `signature_source = 'manual'`, which the
// Gmail auto-import gate (maybeImportGmailSignature) treats as a permanent
// user override. Both resolve the target inbox via resolveInboxArg, exactly
// like every other inbox-bound tool.
// ---------------------------------------------------------------------------

/**
 * `signature_get` — return the inbox's configured signature.
 *
 * Scope: read:email. Read-only; returns signature_html/text, the enabled flag,
 * reply_mode, source, and updated_at for the resolved inbox.
 */
async function executeGetSignature(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "signature_get: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "signature_get");
  const inbox = resolved.inbox;

  return {
    result: jsonOk({
      inbox_id: inbox.id,
      email_address: inbox.email_address,
      signature_html: inbox.signature_html,
      signature_text: inbox.signature_text,
      signature_enabled: inbox.signature_enabled,
      signature_reply_mode: inbox.signature_reply_mode,
      signature_source: inbox.signature_source,
      signature_updated_at: inbox.signature_updated_at,
    }, true),
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `signature_set` — write the inbox's signature and stamp it as a manual edit.
 *
 * Scope: send:email. Writes whichever of signature_text / signature_html the
 * caller supplied (the send path derives the missing half), plus optional
 * signature_enabled and signature_reply_mode. Always sets
 * signature_source = 'manual' and signature_updated_at = now() so a later
 * Gmail import never overwrites the user's choice.
 */
async function executeSetSignature(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "signature_set: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  // Collect the writable fields. A field omitted entirely is left unchanged; an
  // explicitly-provided value (including an empty string, to clear) is written.
  const update: Record<string, unknown> = {};

  if ("signature_text" in args) {
    if (typeof args["signature_text"] !== "string" || args["signature_text"].length > 10000) {
      return {
        result: { content: [{ type: "text", text: "signature_set: signature_text must be a string of at most 10000 characters." }], isError: true },
        logStatus: "error", logErrorCode: "-32602",
      };
    }
    update["signature_text"] = args["signature_text"];
  }

  if ("signature_html" in args) {
    if (typeof args["signature_html"] !== "string" || args["signature_html"].length > 50000) {
      return {
        result: { content: [{ type: "text", text: "signature_set: signature_html must be a string of at most 50000 characters." }], isError: true },
        logStatus: "error", logErrorCode: "-32602",
      };
    }
    // Sanitize before persisting (defense in depth alongside the web app's
    // DOMPurify pass). Keeps https images + formatting, strips scripts/handlers.
    update["signature_html"] = sanitizeSignatureHtml(args["signature_html"] as string);
  }

  if ("signature_enabled" in args) {
    if (typeof args["signature_enabled"] !== "boolean") {
      return {
        result: { content: [{ type: "text", text: "signature_set: signature_enabled must be a boolean." }], isError: true },
        logStatus: "error", logErrorCode: "-32602",
      };
    }
    update["signature_enabled"] = args["signature_enabled"];
  }

  if ("signature_reply_mode" in args) {
    const mode = args["signature_reply_mode"];
    if (mode !== "always" && mode !== "first_only" && mode !== "never") {
      return {
        result: { content: [{ type: "text", text: "signature_set: signature_reply_mode must be one of 'always', 'first_only', 'never'." }], isError: true },
        logStatus: "error", logErrorCode: "-32602",
      };
    }
    update["signature_reply_mode"] = mode;
  }

  if (Object.keys(update).length === 0) {
    return {
      result: { content: [{ type: "text", text: "signature_set: provide at least one of signature_text, signature_html, signature_enabled, signature_reply_mode." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const resolved = await resolveInboxArg(args, apiKey);
  if (!resolved.ok) return inboxResolutionError(resolved, "signature_set");
  const inbox = resolved.inbox;

  // Any manual write pins the signature as user-owned so Gmail auto-import
  // (maybeImportGmailSignature) never overwrites it on a later send.
  const now = new Date().toISOString();
  update["signature_source"] = "manual";
  update["signature_updated_at"] = now;

  const { error: updateErr } = await supabase
    .from("inboxes")
    .update(update)
    .eq("id", inbox.id)
    .eq("workspace_id", apiKey.workspace_id);

  if (updateErr) {
    console.error("[mcp-server] signature_set: db_error", {
      inbox_id: inbox.id,
      error: updateErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "signature_set: database error while saving the signature." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  // Reflect the new state in the response so the caller sees the resolved row.
  const merged = { ...inbox, ...update } as InboxRow;
  return {
    result: jsonOk({
      saved: true,
      inbox_id: inbox.id,
      email_address: inbox.email_address,
      signature_html: merged.signature_html,
      signature_text: merged.signature_text,
      signature_enabled: merged.signature_enabled,
      signature_reply_mode: merged.signature_reply_mode,
      signature_source: "manual",
      signature_updated_at: now,
    }, true),
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

/**
 * `initialize` — MCP capability negotiation handshake.
 *
 * Validates the client's `protocolVersion` and returns the server's supported
 * protocol version and full capability set.
 *
 * Per the MCP specification:
 * - The server always responds with `SUPPORTED_PROTOCOL_VERSION` ("2025-06-18")
 *   regardless of what the client requests. Clients that strictly require a
 *   different version must handle the mismatch on their side.
 * - `protocolVersion` is required in the client params; an absent or non-string
 *   value is rejected with an invalid-params error.
 * - Client capabilities (elicitation, sampling, roots) are read and logged for
 *   diagnostics but not acted on in the initial version.
 * - This call does not require any scope and does not write to activity_log.
 *   Every MCP client must call initialize first; logging it would pollute the
 *   activity feed with non-operational noise.
 *
 * @see Documents/Architecture/mcp-server-architecture.md §5 (Capability Negotiation)
 */
function handleInitialize(
  req: JsonRpcRequest,
  id: string | number | null,
): JsonRpcSuccessResponse | JsonRpcErrorResponse {
  // ── Validate and extract params ──────────────────────────────────────────
  // `params` is required for initialize; an absent params object is treated as
  // an invalid request rather than defaulted, because protocolVersion is a
  // required field per the MCP specification.
  const params = req.params as Record<string, unknown> | undefined;

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return jsonRpcErrorBody(
      id,
      -32602, // Invalid params
      "initialize requires a params object containing protocolVersion.",
    );
  }

  // protocolVersion is required and must be a non-empty string.
  const clientProtocolVersion = params["protocolVersion"];
  if (
    typeof clientProtocolVersion !== "string" ||
    clientProtocolVersion.trim().length === 0
  ) {
    return jsonRpcErrorBody(
      id,
      -32602, // Invalid params
      "initialize params.protocolVersion must be a non-empty string.",
      {
        received: clientProtocolVersion,
        supported: SUPPORTED_PROTOCOL_VERSION,
      },
    );
  }

  // ── Log client info for diagnostics ─────────────────────────────────────
  // Never log API keys, tokens, or any credential material — only the client
  // identity fields from the handshake params.
  const clientInfo = params["clientInfo"] as InitializeParams["clientInfo"] | undefined;
  const clientCapabilities = params["capabilities"] as InitializeParams["capabilities"] | undefined;

  if (clientProtocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    // The server accepts any protocol version string from the client and
    // responds with its own version. Log a diagnostic when versions differ
    // so operators can track client version distribution.
    console.log("[mcp-server] initialize: protocol_version_mismatch", {
      client_protocol_version: clientProtocolVersion,
      server_protocol_version: SUPPORTED_PROTOCOL_VERSION,
      client_name: clientInfo?.name ?? "(unknown)",
      client_version: clientInfo?.version ?? "(unknown)",
    });
  } else {
    console.log("[mcp-server] initialize", {
      protocol_version: clientProtocolVersion,
      client_name: clientInfo?.name ?? "(unknown)",
      client_version: clientInfo?.version ?? "(unknown)",
      client_capabilities: Object.keys(clientCapabilities ?? {}).join(",") || "(none)",
    });
  }

  // ── Build and return the capability declaration ──────────────────────────
  // The server responds with its own supported protocol version regardless of
  // what the client requested. Clients must handle version negotiation on
  // their side.
  const result: InitializeResult = {
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    capabilities: {
      tools: {
        // false: the tool list is a fixed, versioned set. Clients must not
        // subscribe to notifications/tools/list_changed — none will be emitted.
        listChanged: false,
      },
    },
    serverInfo: {
      name: "mcpemails",
      version: "1.0.0",
    },
    instructions: SERVER_INSTRUCTIONS,
  };

  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

/**
 * `tools/list` — returns the scope-filtered catalogue of available MCP tools.
 *
 * Only tools whose `requiredScope` is present in the API key's `scopes` array
 * are included in the response. This prevents AI agents from discovering tools
 * they are not authorised to call, reducing noise in the agent's reasoning and
 * preventing scope-violation errors at call time.
 *
 * The returned shape matches the MCP specification:
 *   { tools: Array<{ name, title, description, inputSchema }> }
 *
 * `tools/list` is always permitted (no scope required to call the method
 * itself) — the scope filtering applies only to which tools appear in the list.
 *
 * @see Documents/Architecture/mcp-server-architecture.md §6 (Tool Registry)
 * @see Documents/Architecture/mcp-tool-design.md §3 (Input Schemas)
 */
function handleToolsList(
  _req: JsonRpcRequest,
  id: string | number | null,
  apiKey: ApiKeyRow,
): JsonRpcSuccessResponse {
  // Filter the registry to only tools the API key's scopes allow.
  // An API key with only read:email will see email_list, email_read, email_search.
  // An API key with send:email (in addition or alone) will also see email_send, email_reply.
  const visibleTools = TOOL_REGISTRY
    .filter((tool) => isToolAuthorized(tool, apiKey.scopes))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Only include the optional spec fields when present, to keep output clean.
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }));

  console.log("[mcp-server] tools/list", {
    key_id: apiKey.id,
    scopes: apiKey.scopes,
    visible_tool_count: visibleTools.length,
    visible_tools: visibleTools.map((t) => t.name).join(","),
  });

  return {
    jsonrpc: "2.0",
    id,
    result: {
      tools: visibleTools,
    },
  };
}

/**
 * `tools/call` — executes a named tool with the supplied arguments.
 *
 * This handler is the central dispatch point for all MCP tool invocations.
 * It is responsible for:
 *   1. Extracting and validating `name` and `arguments` from `params`.
 *   2. Checking the API key has the required scope for the requested tool.
 *   3. Executing the tool (placeholder until MCP Tools tasks are complete).
 *   4. Timing the full execution path.
 *   5. Writing an `activity_log` entry regardless of outcome (success or error).
 *
 * The `activity_log` insert is awaited before the response is returned so that
 * the audit trail is guaranteed to be complete even if the client disconnects.
 *
 * **Scope checking** is enforced before the tool runs: a key without the
 * required scope receives a -32001 error and the attempt is still logged with
 * status "error" and error_code "-32001". This ensures the audit log captures
 * all access-control violations.
 *
 * **Inbox ID** is extracted from the tool arguments when present. All current
 * MCPEmails tools include an `inbox_id` argument. If the argument is absent or
 * not a string, `inbox_id` is logged as null (covers future tools that may
 * operate without an explicit inbox).
 *
 * @see Documents/Architecture/mcp-server-architecture.md §3 Steps 5–7
 * @see Documents/Architecture/mcp-server-architecture.md §6 Tool Registry
 */
async function handleToolsCall(
  req: JsonRpcRequest,
  id: string | number | null,
  apiKey: ApiKeyRow,
  ctx: RequestContext,
): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse> {
  // ── Extract params ────────────────────────────────────────────────────────
  const params = req.params as Record<string, unknown> | undefined;

  // `name` is required per MCP spec; reject without logging if missing.
  const toolName =
    typeof params?.["name"] === "string" ? params["name"] : null;

  if (!toolName) {
    return jsonRpcErrorBody(
      id,
      -32602, // Invalid params
      "tools/call requires params.name (string)",
    );
  }

  // `inbox_id` is the standard first argument for all MCPEmails tools.
  // Extracted here for activity logging; tools also validate it internally.
  const rawArgs = params?.["arguments"];
  const inboxId =
    rawArgs !== null &&
    typeof rawArgs === "object" &&
    !Array.isArray(rawArgs) &&
    typeof (rawArgs as Record<string, unknown>)["inbox_id"] === "string"
      ? (rawArgs as Record<string, unknown>)["inbox_id"] as string
      : null;

  // ── Look up the tool in the registry ─────────────────────────────────────
  const tool = TOOL_REGISTRY.find((t) => t.name === toolName);

  if (!tool) {
    // Unknown tool — log the attempt so operators can see invalid tool names
    // being sent by misconfigured or outdated MCP clients.
    await writeActivityLog({
      workspaceId: apiKey.workspace_id,
      apiKeyId: apiKey.id,
      inboxId,
      toolName,
      status: "error",
      errorCode: String(-32602),
      durationMs: null,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    console.warn("[mcp-server] tools/call: unknown_tool", {
      key_id: apiKey.id,
      tool_name: toolName,
    });

    return jsonRpcErrorBody(
      id,
      -32602, // Invalid params — unknown tool name
      `Unknown tool: ${toolName}`,
      {
        available_tools: TOOL_REGISTRY
          .filter((t) => isToolAuthorized(t, apiKey.scopes))
          .map((t) => t.name),
      },
    );
  }

  // ── Resolve consolidated action → legacy dispatch target ──────────────────
  // Consolidated tools (email_read, email_organize, …) carry an `action` arg
  // selecting which legacy handler runs and which scope it needs. Kept tools
  // (inbox_list, contact_search) dispatch under their own name and scope.
  let dispatchName = toolName;
  let effectiveScope: string = tool.requiredScope;
  let effectiveAltScopes: string[] | undefined = tool.altScopes;
  const consolidated = CONSOLIDATED_BY_NAME[toolName];
  if (consolidated) {
    const argsObj =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};
    const action = typeof argsObj["action"] === "string"
      ? argsObj["action"] as string
      : null;
    const actionSpec = action ? consolidated.actions[action] : undefined;
    if (!actionSpec) {
      const valid = Object.keys(consolidated.actions).join(", ");
      await writeActivityLog({
        workspaceId: apiKey.workspace_id,
        apiKeyId: apiKey.id,
        inboxId,
        toolName,
        status: "error",
        errorCode: String(-32602),
        durationMs: null,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return jsonRpcErrorBody(
        id,
        -32602,
        action
          ? `Unknown action '${action}' for ${toolName}. Valid actions: ${valid}.`
          : `${toolName} requires an 'action' argument (one of: ${valid}).`,
        { tool: toolName, valid_actions: Object.keys(consolidated.actions) },
      );
    }
    dispatchName = actionSpec.legacy;
    effectiveScope = actionSpec.scope;
    effectiveAltScopes = actionSpec.altScopes;
    // Reverse schema renames so the legacy handler sees its original param names
    // (e.g. email_flag reads `action`, exposed as `flag_action` to avoid clashing
    // with the action selector). Mutating argsObj also mutates rawArgs (same ref),
    // which is what the dispatch chain passes to the handler.
    if (actionSpec.renames) {
      for (const [legacyKey, exposedKey] of Object.entries(actionSpec.renames)) {
        if (exposedKey in argsObj) argsObj[legacyKey] = argsObj[exposedKey];
      }
    }
  }

  // ── Scope check ───────────────────────────────────────────────────────────
  // Run before any I/O or credential loading so unauthorised calls are rejected
  // with minimal resource consumption. All scope violations are logged. For a
  // consolidated tool the scope checked is the resolved action's scope.
  const scopeAuthorized = apiKey.scopes.includes(effectiveScope) ||
    (effectiveAltScopes?.some((s) => apiKey.scopes.includes(s)) ?? false);
  if (!scopeAuthorized) {
    await writeActivityLog({
      workspaceId: apiKey.workspace_id,
      apiKeyId: apiKey.id,
      inboxId,
      toolName: dispatchName,
      status: "error",
      errorCode: String(RPC_INVALID_API_KEY),
      durationMs: null,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    console.warn("[mcp-server] tools/call: insufficient_scope", {
      key_id: apiKey.id,
      tool_name: toolName,
      dispatch_name: dispatchName,
      required_scope: effectiveScope,
      alt_scopes: effectiveAltScopes ?? [],
      key_scopes: apiKey.scopes,
    });

    const acceptedScopes = [effectiveScope, ...(effectiveAltScopes ?? [])];
    const scopeList = acceptedScopes.length > 1
      ? `one of the '${acceptedScopes.join("', '")}' scopes is`
      : `the '${effectiveScope}' scope is`;

    return jsonRpcErrorBody(
      id,
      RPC_INVALID_API_KEY,
      `Insufficient scope: ${scopeList} required to call ${toolName}.`,
      {
        required_scope: effectiveScope,
        accepted_scopes: acceptedScopes,
        key_scopes: apiKey.scopes,
      },
    );
  }

  // ── Execute the tool ──────────────────────────────────────────────────────
  // Tool implementations (email_list, email_read, etc.) are added in the
  // "MCP Tools — Implementation" checklist tasks. Until each tool is
  // implemented, this handler returns a structured error so the MCP client
  // receives a valid JSON-RPC response rather than HTTP 5xx.
  //
  // The timing clock starts here — it covers everything from the moment the
  // tool begins executing to the moment the result is ready, excluding the
  // log write itself (which is infrastructure overhead, not tool latency).
  const startMs = Date.now();

  let toolResult!: JsonRpcSuccessResponse | JsonRpcErrorResponse;
  let logStatus: "success" | "error" = "error";
  let logErrorCode: string | null = String(-32601); // Method not found

  // Captures the inbox resolved during dispatch (inside resolveInboxArg) so the
  // activity log records the real inbox even for alias- or auto-resolved calls.
  const logCtx: { inboxId: string | null } = { inboxId: null };

  try {
    await activityInboxStore.run(logCtx, async () => {
    // ── Dispatch to the implemented tool handler ───────────────────────────
    if (dispatchName === "inbox_list") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListInboxes(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_list") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListInbox(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_read") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReadEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_read_batch") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReadEmails(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_attachment") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReadAttachment(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_send") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSendEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_reply") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReplyToEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_search") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchEmails(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_archive") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeArchiveEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "folder_list") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListFolders(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "folder_create") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCreateFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "folder_rename") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeRenameFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "folder_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeDeleteFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_move") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeMoveEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_copy") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCopyEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeDeleteEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_move_batch") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkMove(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_copy_batch") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkCopy(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_delete_batch") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkDelete(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_flag") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkFlag(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_search_and_move") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchAndMove(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_search_and_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchAndDelete(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "email_forward") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeForwardEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "draft_list") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListDrafts(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "draft_create") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCreateDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "draft_update") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeUpdateDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "draft_send") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSendDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "draft_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeDeleteDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "contact_search") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchContacts(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "schedule_create") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeScheduleSend(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "schedule_list") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListScheduled(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "schedule_cancel") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCancelScheduled(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "signature_get") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeGetSignature(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (dispatchName === "signature_set") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSetSignature(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else {
      // Tool is registered in TOOL_REGISTRY but not yet implemented.
      // Returns a structured error so MCP clients receive a valid JSON-RPC
      // response rather than HTTP 5xx.
      toolResult = jsonRpcErrorBody(
        id,
        -32601,
        `Tool '${toolName}' is registered but not yet implemented. ` +
          `Check back after the MCP Tools implementation tasks are complete.`,
      );
      logStatus = "error";
      logErrorCode = String(-32601);
    }
    });
  } catch (err) {
    // Unhandled exception inside tool dispatch — this should not happen once
    // tools are implemented with proper error handling, but guards against
    // unexpected runtime errors.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] tools/call: unhandled_exception", {
      key_id: apiKey.id,
      tool_name: toolName,
      error: message,
    });
    toolResult = jsonRpcErrorBody(
      id,
      -32603, // Internal error
      `Internal error executing tool '${toolName}'. Please try again.`,
    );
    logStatus = "error";
    logErrorCode = String(-32603);
  }

  const durationMs = Date.now() - startMs;

  // Prefer the inbox the tool actually resolved (handles email aliases and
  // single-inbox auto-resolution); fall back to an explicit inbox_id UUID from
  // the raw request arguments when no tool resolution occurred.
  const resolvedInboxId = logCtx.inboxId ?? inboxId;

  // ── Write activity log ────────────────────────────────────────────────────
  // Awaited intentionally — the audit trail must be complete before the
  // response leaves the Edge Function. A logging failure is non-fatal.
  // Log the resolved (legacy) operation name so per-action analytics survive
  // consolidation — e.g. an email_compose/forward call logs as "email_forward".
  await writeActivityLog({
    workspaceId: apiKey.workspace_id,
    apiKeyId: apiKey.id,
    inboxId: resolvedInboxId,
    toolName: dispatchName,
    status: logStatus,
    errorCode: logErrorCode,
    durationMs,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  console.log("[mcp-server] tools/call", {
    key_id: apiKey.id,
    tool_name: toolName,
    dispatch_name: dispatchName,
    inbox_id: resolvedInboxId,
    status: logStatus,
    duration_ms: durationMs,
  });

  return toolResult;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scheduled-send dispatcher
// ---------------------------------------------------------------------------
//
// Entry point: POST /dispatch (mcp-server edge function, path suffix)
// Caller:      pg_cron → dispatch_scheduled_sends() SQL function → net.http_post
// Auth:        X-Dispatch-Secret header matched against DISPATCH_SECRET env var
//
// Picks up to MAX_DISPATCH_BATCH pending scheduled_sends rows with
// send_at <= now(), sends each via the existing per-provider send path
// (sendGmailMessage / sendOutlookMessage / sendFastmailMessage / sendImapMessage),
// and transitions status to 'sent' or 'error'.
//
// Status lifecycle enforced here:
//   pending → sending  (optimistic lock before send attempt)
//   sending → sent     (on success, sent_at populated)
//   sending → error    (on failure, error_detail populated)
//   sending → error    (stale reclaim: row stuck in 'sending' past
//                        STALE_SENDING_MS — failed, never retried, to avoid
//                        a possible double-send after a mid-flight crash)
//
// See migration 20260603000001_create_scheduled_sends.sql for table schema,
// RLS policies, and pg_cron setup instructions.
// ---------------------------------------------------------------------------

const MAX_DISPATCH_BATCH = 50;

// A row that has been in 'sending' longer than this is considered stale: the
// dispatch invocation that claimed it crashed mid-flight.  We do NOT reset it
// to 'pending' — the email may already have been (partially) sent before the
// crash, and re-dispatching would risk a double-send.  Instead we move it to
// the terminal 'error' status so it stops being silently stuck and becomes
// queryable, accepting that the operator must verify/resend manually if needed.
const STALE_SENDING_MS = 15 * 60 * 1000;

/**
 * Resolve a scheduled_sends `payload` column into the plaintext payload object,
 * transparently handling both formats:
 *   • encrypted (payload_encrypted=true): payload is { v, data: ciphertext };
 *     decrypt `data` and JSON.parse it.
 *   • legacy plaintext (payload_encrypted=false / null): payload is the object.
 * Always returns a plain object so callers can apply the existing defensive
 * type checks unchanged.
 */
async function resolveScheduledPayload(row: {
  payload: unknown;
  payload_encrypted?: boolean | null;
}): Promise<Record<string, unknown>> {
  if (row.payload_encrypted) {
    const wrapper = (row.payload ?? {}) as Record<string, unknown>;
    const json = await decryptStoredToken(String(wrapper["data"] ?? ""));
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ? (parsed as Record<string, unknown>)
      : {};
  }
  // Legacy plaintext row.
  const legacy = row.payload ?? {};
  return (legacy && typeof legacy === "object" && !Array.isArray(legacy))
    ? (legacy as Record<string, unknown>)
    : {};
}

async function handleScheduledDispatch(): Promise<Response> {
  const now = new Date().toISOString();

  // ── Reclaim stale 'sending' rows ──────────────────────────────────────────
  // Mark rows stuck in 'sending' past the threshold as failed (terminal).  We
  // intentionally fail (never reset to 'pending') to avoid re-sending an email
  // that may already have gone out before the previous invocation crashed.
  // Runs globally across all workspaces — correct for a cron dispatcher.
  const staleCutoff = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const { error: reclaimErr } = await supabase
    .from("scheduled_sends")
    .update({
      status: "error",
      error_detail: "dispatch interrupted; marked failed to avoid double-send",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "sending")
    .lt("updated_at", staleCutoff);
  if (reclaimErr) {
    // Non-fatal: log and continue with the pending dispatch below.
    console.warn("[dispatch] Failed to reclaim stale sending rows:", reclaimErr.message);
  }

  // Fetch pending rows due for sending, ordered by send_at ASC so the
  // oldest-due messages are dispatched first.
  const { data: rows, error: fetchErr } = await supabase
    .from("scheduled_sends")
    .select("id, inbox_id, payload, payload_encrypted")
    .eq("status", "pending")
    .lte("send_at", now)
    .order("send_at", { ascending: true })
    .limit(MAX_DISPATCH_BATCH);

  if (fetchErr) {
    console.error("[dispatch] Failed to fetch pending rows:", fetchErr.message);
    return new Response(
      JSON.stringify({ error: "db_error", detail: fetchErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const pending = rows ?? [];
  if (pending.length === 0) {
    return new Response(
      JSON.stringify({ dispatched: 0, errored: 0, total: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  let dispatched = 0;
  let errored = 0;

  for (const row of pending) {
    // Optimistic lock: atomically transition pending → sending so a
    // concurrent cron invocation cannot pick up the same row.
    const { data: claimed, error: lockErr } = await supabase
      .from("scheduled_sends")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending") // only transitions from pending
      .select("id");

    if (lockErr) {
      // Genuine DB error — log and skip.
      console.warn(`[dispatch] Could not lock row ${row.id}:`, lockErr.message);
      continue;
    }

    if (!claimed || claimed.length === 0) {
      // A zero-row update means another worker already transitioned this row
      // out of "pending" (PostgREST returns error:null on a 0-row match).
      // Skip — do NOT send, do NOT count toward dispatched/errored.
      continue;
    }

    try {
      // ── Look up the inbox ──────────────────────────────────────────────
      const { data: inbox, error: inboxErr } = await supabase
        .from("inboxes")
        .select(INBOX_SELECT_COLUMNS)
        .eq("id", row.inbox_id)
        .single<InboxRow>();

      if (inboxErr || !inbox) {
        throw new Error(
          `Inbox ${row.inbox_id} not found: ${inboxErr?.message ?? "no data"}`,
        );
      }

      // ── Build SendEmailParams from stored payload ───────────────────────
      // Dual-mode: decrypts encrypted rows, passes legacy plaintext through.
      const payload = await resolveScheduledPayload(row);
      const sendParams: SendEmailParams = {
        to: Array.isArray(payload["to"]) ? (payload["to"] as string[]) : [],
        cc: Array.isArray(payload["cc"]) ? (payload["cc"] as string[]) : [],
        bcc: Array.isArray(payload["bcc"]) ? (payload["bcc"] as string[]) : [],
        subject:
          typeof payload["subject"] === "string" ? payload["subject"] : "",
        textBody:
          typeof payload["body"] === "string" ? payload["body"] : "",
        htmlBody:
          typeof payload["html_body"] === "string"
            ? payload["html_body"]
            : undefined,
        attachments: Array.isArray(payload["attachments"])
          ? (payload["attachments"] as Array<{
              filename: string;
              mime_type: string;
              data: string;
            }>)
          : [],
        replyTo:
          typeof payload["reply_to"] === "string"
            ? payload["reply_to"]
            : undefined,
      };

      // Apply the signature at SEND/DRAIN time (not enqueue time) so signature
      // edits made after scheduling take effect. Same single helper as the
      // interactive send path.
      applySignature(sendParams, inbox);

      // ── Per-provider send (mirrors executeSendEmail dispatch) ──────────
      let sendResult: SendEmailResult;
      switch (inbox.provider) {
        case "gmail":
          sendResult = await sendGmailMessage(inbox, sendParams);
          break;
        case "outlook":
          sendResult = await sendOutlookMessage(inbox, sendParams);
          break;
        case "fastmail":
          sendResult = await sendFastmailMessage(inbox, sendParams);
          break;
        case "imap":
          sendResult = await sendImapMessage(inbox, sendParams);
          break;
        default:
          throw new Error(
            `Provider '${inbox.provider}' is not supported by the scheduled-send dispatcher.`,
          );
      }

      // ── Mark sent ──────────────────────────────────────────────────────
      await supabase
        .from("scheduled_sends")
        .update({
          status: "sent",
          sent_at: sendResult.sent_at,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      dispatched++;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[dispatch] scheduled_send ${row.id} failed:`,
        detail,
      );

      // Truncate error_detail to 1 000 chars to match column convention.
      await supabase
        .from("scheduled_sends")
        .update({
          status: "error",
          error_detail: detail.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      errored++;
    }
  }

  console.log(
    `[dispatch] Done: dispatched=${dispatched} errored=${errored} total=${pending.length}`,
  );
  return new Response(
    JSON.stringify({ dispatched, errored, total: pending.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function handleRequest(req: Request): Promise<Response> {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Scheduled-send dispatcher route ───────────────────────────────────────
  // Called every minute by pg_cron via net.http_post.  Secured with
  // DISPATCH_SECRET env var — no API key required.
  // See handleScheduledDispatch() and migration 20260603000001 for details.
  const reqUrl = new URL(req.url);
  if (reqUrl.pathname.endsWith("/dispatch")) {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed — use HTTP POST" }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }
    const dispatchSecret = Deno.env.get("DISPATCH_SECRET");
    const providedSecret = req.headers.get("x-dispatch-secret");
    if (
      !dispatchSecret ||
      !providedSecret ||
      providedSecret !== dispatchSecret
    ) {
      return new Response(
        JSON.stringify({ error: "Unauthorized — invalid or missing X-Dispatch-Secret" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
    return handleScheduledDispatch();
  }

  // ── HTTP method guard ─────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed — use HTTP POST" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          Allow: "POST, OPTIONS",
          ...CORS_HEADERS,
        },
      },
    );
  }

  // ── Extract request context ───────────────────────────────────────────────
  // IP and User-Agent are extracted once here and threaded through to the
  // activity log. X-Forwarded-For is the standard header set by Supabase's
  // edge proxy; fall back to X-Real-IP for other proxy configurations.
  const forwardedFor = req.headers.get("x-forwarded-for");
  const ipAddress = forwardedFor
    ? forwardedFor.split(",")[0].trim()
    : req.headers.get("x-real-ip");

  const ctx: RequestContext = {
    ipAddress: ipAddress ?? null,
    userAgent: req.headers.get("user-agent"),
  };

  // ── Parse JSON body ───────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    const text = await req.text();
    if (text.length === 0) {
      throw new SyntaxError("Empty body");
    }
    rawBody = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ error: "Request body is not valid JSON" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }

  // ── Validate JSON-RPC 2.0 envelope ───────────────────────────────────────
  if (!isValidJsonRpcEnvelope(rawBody)) {
    const id =
      typeof rawBody === "object" &&
      rawBody !== null &&
      "id" in rawBody
        ? ((rawBody as Record<string, unknown>)["id"] as
            | string
            | number
            | null)
        : null;

    return jsonResponse(
      jsonRpcErrorBody(
        id ?? null,
        rawBody !== null &&
          typeof rawBody === "object" &&
          (rawBody as Record<string, unknown>)["jsonrpc"] !== undefined
          ? RPC_INVALID_REQUEST
          : RPC_PARSE_ERROR,
        "Invalid Request — body must be a JSON-RPC 2.0 object",
      ),
    );
  }

  const rpcRequest = rawBody;

  // Extract request ID early — needed for auth error responses.
  const requestId = rpcRequest.id ?? null;

  // ── Notifications (no id) ─────────────────────────────────────────────────
  // MCP notifications are fire-and-forget: acknowledge with HTTP 204 and no body.
  // Notifications are still authenticated — an unauthenticated sender should not
  // receive a 204 that implies the notification was accepted.
  if (isNotification(rpcRequest)) {
    const authResult = await authenticateRequest(req, null);
    if (authResult instanceof Response) {
      return authResult;
    }
    console.log(`[mcp-server] notification received: ${rpcRequest.method}`);
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Authenticate API key ──────────────────────────────────────────────────
  // Every non-notification request must carry a valid, active API key.
  // Returns { apiKey } on success, or an HTTP error Response on failure.
  const authResult = await authenticateRequest(req, requestId);
  if (authResult instanceof Response) {
    // Authentication failed — return the error response directly.
    return authResult;
  }

  const { apiKey } = authResult;

  // ── Cheap-method rate limit ───────────────────────────────────────────────
  // Every method EXCEPT `tools/call` is cheap and never writes to activity_log,
  // so the activity_log-based checkRateLimit() below cannot see it. That covers
  // `initialize`, `tools/list`, and any other/unknown method (`ping`,
  // `resources/list`, the "Method not found" default branch — all of which
  // still return HTTP 200). Without this guard a client looping any such method
  // hammers the endpoint unbounded (observed in prod: one key looping a
  // 42-byte `ping`-sized request at ~2 req/s, ~168k requests/day, zero 429s).
  // Guard them with a dedicated per-key sliding-window limiter (rate_limit_check
  // RPC), independent of activity_log. Fail-open on DB errors. `tools/call` is
  // throttled by the activity_log limiter below and is not double-counted here.
  // `ping` is exempt: it is a near-zero no-op (returns `{}`) and MUST succeed
  // promptly per the MCP spec. Rate-limiting it to a 429 makes buggy clients
  // treat the connection as dead and retry harder, amplifying load rather than
  // shedding it. tools/call has its own activity_log limiter.
  if (rpcRequest.method !== "tools/call" && rpcRequest.method !== "ping") {
    const cheapMethodResult = await checkDiscoveryRateLimit(apiKey.id);
    if (!cheapMethodResult.allowed) {
      console.warn("[mcp-server] cheap_method_rate_limit_exceeded", {
        key_id: apiKey.id,
        method: rpcRequest.method,
        window: cheapMethodResult.windowLabel,
        limit: cheapMethodResult.limit,
        retry_after_seconds: cheapMethodResult.retryAfterSeconds,
      });
      return buildRateLimitResponse(requestId, cheapMethodResult);
    }
  }

  // ── Per-key rate limit check ──────────────────────────────────────────────
  // Runs after authentication and before routing to any tool handler. This
  // limiter counts completed `tools/call` rows in activity_log; the cheap
  // discovery methods are throttled separately above.
  // Fail-open: if the DB is unavailable, checkRateLimit returns allowed=true.
  const rateLimitResult = await checkRateLimit(apiKey.id);
  if (!rateLimitResult.allowed) {
    console.warn("[mcp-server] rate_limit_exceeded", {
      key_id: apiKey.id,
      window: rateLimitResult.windowLabel,
      limit: rateLimitResult.limit,
      used: rateLimitResult.used,
      retry_after_seconds: rateLimitResult.retryAfterSeconds,
    });

    // Log rate-limited `tools/call` attempts to `activity_log` so the
    // rate-limit enforcement queries have accurate counts and operators can
    // see which keys are being throttled. Only `tools/call` is logged; noise
    // from `initialize` / `tools/list` rate-limit hits is not useful.
    if (rpcRequest.method === "tools/call") {
      const callParams = rpcRequest.params as Record<string, unknown> | undefined;
      const rateLimitedToolName =
        typeof callParams?.["name"] === "string"
          ? callParams["name"]
          : "(unknown)";
      const rateLimitedArgs = callParams?.["arguments"];
      const rateLimitedInboxId =
        rateLimitedArgs !== null &&
        typeof rateLimitedArgs === "object" &&
        !Array.isArray(rateLimitedArgs) &&
        typeof (rateLimitedArgs as Record<string, unknown>)["inbox_id"] === "string"
          ? (rateLimitedArgs as Record<string, unknown>)["inbox_id"] as string
          : null;

      // Fire-and-forget: logging a rate-limited call must not delay the 429.
      writeActivityLog({
        workspaceId: apiKey.workspace_id,
        apiKeyId: apiKey.id,
        inboxId: rateLimitedInboxId,
        toolName: rateLimitedToolName,
        status: "rate_limited",
        errorCode: String(RPC_RATE_LIMIT_EXCEEDED),
        durationMs: null,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      }).catch((logErr) => {
        console.error("[mcp-server] rate_limited_log_write_failed", {
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      });
    }

    return buildRateLimitResponse(requestId, rateLimitResult);
  }

  // ── Plan quota check ─────────────────────────────────────────────────────
  // Usage is unlimited; this enforces the workspace plan's burst ceiling
  // (requests per minute, aggregated across the workspace's API keys).
  // Runs after the per-key rolling-window guard. Fail-open on DB errors.
  const quotaResult = await checkPlanQuota(apiKey.workspace_id);
  if (!quotaResult.allowed) {
    console.warn("[mcp-server] plan_rate_limit_exceeded", {
      workspace_id: apiKey.workspace_id,
      plan: quotaResult.plan,
      per_minute_limit: quotaResult.perMinuteLimit,
      used_this_minute: quotaResult.usedThisMinute,
      retry_after_seconds: quotaResult.retryAfterSeconds,
    });

    // Log quota-exceeded tool/call attempts the same way rate-limited calls
    // are logged — only for tools/call, not initialize/tools/list.
    if (rpcRequest.method === "tools/call") {
      const callParams = rpcRequest.params as Record<string, unknown> | undefined;
      const quotaToolName =
        typeof callParams?.["name"] === "string"
          ? callParams["name"]
          : "(unknown)";
      const quotaArgs = callParams?.["arguments"];
      const quotaInboxId =
        quotaArgs !== null &&
        typeof quotaArgs === "object" &&
        !Array.isArray(quotaArgs) &&
        typeof (quotaArgs as Record<string, unknown>)["inbox_id"] === "string"
          ? (quotaArgs as Record<string, unknown>)["inbox_id"] as string
          : null;

      writeActivityLog({
        workspaceId: apiKey.workspace_id,
        apiKeyId: apiKey.id,
        inboxId: quotaInboxId,
        toolName: quotaToolName,
        status: "rate_limited",
        errorCode: "rate_limit_exceeded",
        durationMs: null,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      }).catch((logErr) => {
        console.error("[mcp-server] quota_exceeded_log_write_failed", {
          error: logErr instanceof Error ? logErr.message : String(logErr),
        });
      });
    }

    return buildQuotaExceededResponse(requestId, quotaResult);
  }

  // ── Route to method handler ───────────────────────────────────────────────
  const response = await routeMethod(rpcRequest, apiKey, ctx);
  return jsonResponse(response);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(handleRequest);
