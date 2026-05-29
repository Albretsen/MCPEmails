import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ImapAuthError, ImapClient } from "./imap-client.ts";
import { decodeEncodedWords, getHeader, parseEmail } from "./mime.ts";
import { sendViaSmtp, SmtpAuthError } from "./smtp-client.ts";

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
}

/** The single protocol version this server supports. */
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

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
    .select("plan")
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
  const perMinuteLimit =
    PLAN_REQUESTS_PER_MINUTE[plan] ?? DEFAULT_REQUESTS_PER_MINUTE;

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
  /** The name of the MCP tool that was called (e.g. "list_inbox"). */
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
// ---------------------------------------------------------------------------

interface ToolDefinition {
  /** Unique tool name used in tools/list and tools/call */
  name: string;
  /** Human-readable label shown in MCP client UIs */
  title: string;
  /** Detailed description for the AI agent */
  description: string;
  /** Which api_keys.scopes[] value is required to call this tool */
  requiredScope: "read:email" | "send:email";
  /** JSON Schema (Draft 7) for argument validation */
  inputSchema: Record<string, unknown>;
}

/** All tools available in MCPEmails, in canonical display order. */
const TOOL_REGISTRY: ToolDefinition[] = [
  // ── read:email scope ────────────────────────────────────────────────────────

  {
    name: "list_inbox",
    title: "List Inbox",
    description:
      "List email messages in an inbox. Returns message summaries " +
      "(sender, subject, date, preview, read status, attachment flag) ordered " +
      "newest first. Supports filtering by folder, unread status, and pagination. " +
      "Use read_email to fetch the full content of a specific message.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox to list. Must be an inbox in the current workspace " +
            "that the API key is permitted to access. Obtain inbox UUIDs from the " +
            "MCPEmails dashboard or from the API key creation flow.",
        },
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
      required: ["inbox_id"],
      additionalProperties: false,
    },
  },

  {
    name: "read_email",
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
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that contains the email.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier. For Gmail this is the message ID " +
            "string returned by the Gmail API (e.g., '18a3c2d7f9b1e4a0'). For Outlook " +
            "it is the Graph API item ID. For IMAP providers it is the UID as a string. " +
            "Always obtained from a previous call to list_inbox or search_emails.",
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
            "When true, each attachment is included in the response as a base64-encoded " +
            "data field. Attachments increase response size significantly; request only " +
            "when the agent needs to process attachment content. Total size limit: 10 MB.",
        },
        mark_as_read: {
          type: "boolean",
          default: false,
          description:
            "When true, marks the message as read at the provider after successfully " +
            "fetching its content. Defaults to false to avoid unintended state changes.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "search_emails",
    title: "Search Emails",
    description:
      "Full-text search across an inbox using the provider's native search engine. " +
      "For Gmail, use Gmail search operators (e.g., 'from:alice@example.com subject:report'). " +
      "For Outlook/Graph, the query is passed as a $search parameter. " +
      "For IMAP providers (Fastmail), a subset of IMAP SEARCH criteria is supported. " +
      "Returns message summaries ordered by relevance or date depending on the provider.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox to search.",
        },
        query: {
          type: "string",
          minLength: 1,
          description:
            "Search query string. The query syntax is provider-specific — see the " +
            "description above for per-provider guidance.",
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
      required: ["inbox_id", "query"],
      additionalProperties: false,
    },
  },

  // ── send:email scope ────────────────────────────────────────────────────────

  {
    name: "send_email",
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
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox to send from. The email will appear to the recipient " +
            "as being sent from the email address associated with this inbox.",
        },
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
      },
      required: ["inbox_id", "to", "subject", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "reply_to_email",
    title: "Reply to Email",
    description:
      "Reply to an existing email, maintaining correct thread headers (In-Reply-To, References). " +
      "The recipient, subject (prefixed with 'Re:'), and threading headers are derived from " +
      "the original message — only the reply body is required. Optionally reply to all " +
      "recipients of the original message using reply_all.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox that contains the original message and from which the " +
            "reply will be sent.",
        },
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
      },
      required: ["inbox_id", "message_id", "body"],
      additionalProperties: false,
    },
  },

  // ── No scope beyond read:email ───────────────────────────────────────────

  {
    name: "list_inboxes",
    title: "List Inboxes",
    description:
      "Returns all email inboxes the current API key is permitted to access. " +
      "Call this first to discover inbox_id values required by the other tools. " +
      "Each result includes the inbox UUID, email address, display name, and provider.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

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
  /** AES-256-GCM ciphertext encoded as base64url text. */
  imap_password: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_tls: boolean;
  status: string;
}

const INBOX_SELECT_COLUMNS =
  "id, workspace_id, provider, email_address, display_name, " +
  "oauth_access_token, oauth_refresh_token, oauth_token_expires_at, " +
  "imap_host, imap_port, imap_tls, imap_password, " +
  "smtp_host, smtp_port, smtp_tls, status";

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
 * list_inboxes — returns all inboxes the API key may access.
 *
 * If the key has a non-null inbox_ids allowlist, only those inboxes are
 * returned. Otherwise all active inboxes in the workspace are returned.
 * Credential columns are never included in the output.
 */
async function executeListInboxes(apiKey: ApiKeyRow): Promise<{
  result: { content: { type: string; text: string }[] };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  let query = supabase
    .from("inboxes")
    .select("id, email_address, display_name, provider, status")
    .eq("workspace_id", apiKey.workspace_id)
    .is("deleted_at", null)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
    query = query.in("id", apiKey.inbox_ids);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[mcp-server] list_inboxes: db_error", { error: error.message });
    return {
      result: { content: [{ type: "text", text: "Failed to retrieve inboxes." }] },
      logStatus: "error",
      logErrorCode: String(-32603),
    };
  }

  const inboxes = (data ?? []).map((row: { id: string; email_address: string; display_name: string | null; provider: string }) => ({
    inbox_id: row.id,
    email_address: row.email_address,
    display_name: row.display_name ?? row.email_address,
    provider: row.provider,
  }));

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ inboxes }, null, 2),
      }],
    },
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
          "https://graph.microsoft.com/Mail.Read " +
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
// Email summary types (shared across list_inbox and search_emails tools)
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
  total: number;
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

/** Collapses whitespace and trims the input to ≤200 characters. */
function normalizePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Gmail provider — list_inbox
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
 * Implements `list_inbox` for Gmail.
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

  const fetchCount = Math.min(offset + limit, 100);
  const params = new URLSearchParams({
    labelIds: label,
    maxResults: String(fetchCount),
  });
  if (unreadOnly) params.set("q", "is:unread");

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
  const total = listData.resultSizeEstimate ?? allRefs.length;
  const hasMore =
    !!listData.nextPageToken || allRefs.length > offset + limit;

  const pageRefs = allRefs.slice(offset, offset + limit);

  if (pageRefs.length === 0) {
    return {
      messages: [],
      total,
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

  return { messages, total, has_more: hasMore, next_offset: offset + limit };
}

// ---------------------------------------------------------------------------
// Outlook provider — list_inbox
// ---------------------------------------------------------------------------

/**
 * Maps MCPEmails canonical folder names to Microsoft Graph well-known
 * folder names. Unknown names are passed through as displayName filters.
 */
function outlookWellKnownFolder(folder: string): string {
  const MAP: Record<string, string> = {
    INBOX: "inbox",
    SENT: "sentitems",
    DRAFTS: "drafts",
    DRAFT: "drafts",
    TRASH: "deleteditems",
    DELETED: "deleteditems",
    SPAM: "junkemail",
    JUNK: "junkemail",
    ARCHIVE: "archive",
  };
  return MAP[folder.toUpperCase()] ?? folder;
}

interface OutlookMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
}

/**
 * Implements `list_inbox` for Outlook using Microsoft Graph.
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
  const total = data["@odata.count"] ?? rawMessages.length;
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

  return { messages, total, has_more: hasMore, next_offset: offset + limit };
}

// ---------------------------------------------------------------------------
// Fastmail provider — list_inbox (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `list_inbox` for Fastmail using JMAP (RFC 8620/8621).
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

  return { messages, total, has_more: hasMore, next_offset: offset + limit };
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — shared helpers (iCloud, Yahoo, Zoho, Yandex, generic)
// ---------------------------------------------------------------------------

/**
 * IMAP UIDs are unique only within a mailbox, so the message id exposed to MCP
 * clients encodes the folder: "<folder>:<uid>". read_email/reply_to_email decode
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

/** Per-attachment inclusion budget (bytes). Larger attachments return data: null. */
const ATTACHMENT_DATA_BUDGET = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Generic IMAP provider — list_inbox
// ---------------------------------------------------------------------------

/**
 * Maps MCPEmails canonical folder names to common IMAP folder names.
 * Unknown values are passed through unchanged. Folder naming varies by provider
 * (e.g. iCloud uses "Sent Messages"); INBOX is universal.
 */
function imapFolderName(folder: string): string {
  const MAP: Record<string, string> = {
    INBOX: "INBOX",
    SENT: "Sent",
    DRAFTS: "Drafts",
    DRAFT: "Drafts",
    TRASH: "Trash",
    SPAM: "Junk",
    JUNK: "Junk",
    ARCHIVE: "Archive",
  };
  return MAP[folder.toUpperCase()] ?? folder;
}

/**
 * Implements `list_inbox` for IMAP inboxes connected with an app password.
 *
 * Opens a TLS IMAP session, selects the folder, UID-searches (ALL or UNSEEN),
 * takes the newest `limit` UIDs at `offset`, and fetches ENVELOPE + FLAGS +
 * BODYSTRUCTURE. Body preview is not fetched during listing (deferred to
 * read_email), so `preview` is empty here.
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
      email: inbox.email_address,
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
        from: s.envelope.from[0] ?? { name: "", email: "" },
        to: s.envelope.to,
        subject: s.envelope.subject,
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
// Generic IMAP provider — read_email
// ---------------------------------------------------------------------------

/**
 * Implements `read_email` for IMAP inboxes. The message id is "<folder>:<uid>"
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
      email: inbox.email_address,
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

    const attachments: ReadEmailAttachmentMeta[] = parsed.attachments.map((a) => ({
      filename: a.filename,
      mime_type: a.mimeType,
      size_bytes: a.size,
      data: includeAttachments && a.size <= ATTACHMENT_DATA_BUDGET
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
      body_html: parsed.html ? sanitizeEmailHtml(parsed.html) : null,
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
// Generic IMAP provider — search_emails
// ---------------------------------------------------------------------------

/**
 * Implements `search_emails` for IMAP inboxes using IMAP SEARCH TEXT (matches
 * headers + body). Searches the first folder in includeFolders (default INBOX);
 * IMAP SEARCH is single-mailbox. Newest UIDs first; no relevance score.
 */
async function searchImapMessages(
  inbox: InboxRow,
  query: string,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
  const folder = includeFolders[0] ?? "INBOX";
  const password = await decryptStoredToken(inbox.imap_password);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect({
      host: inbox.imap_host,
      port: inbox.imap_port,
      email: inbox.email_address,
      password,
    });
    await client.selectMailbox(imapFolderName(folder));

    const quoted = `"${query.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const allUids = await client.uidSearch(`TEXT ${quoted}`);
    const total = allUids.length;

    const ordered = allUids.slice().sort((a, b) => b - a);
    const pageUids = ordered.slice(offset, offset + limit);

    const summaries = await client.fetchSummaries(pageUids);
    const byUid = new Map(summaries.map((s) => [s.uid, s]));

    const messages: SearchEmailSummary[] = [];
    for (const uid of pageUids) {
      const s = byUid.get(uid);
      if (!s) continue;
      messages.push({
        id: encodeImapId(folder, s.uid),
        from: s.envelope.from[0] ?? { name: "", email: "" },
        to: s.envelope.to,
        subject: s.envelope.subject,
        date: s.envelope.date,
        preview: s.preview,
        is_read: s.flags.includes("\\Seen"),
        has_attachments: s.hasAttachments,
        folder,
        thread_id: String(s.uid),
        relevance_score: null,
      });
    }

    return {
      messages,
      total,
      has_more: offset + limit < total,
      next_offset: offset + limit,
      query_normalized: query,
    };
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Generic IMAP provider — send_email / reply_to_email (SMTP)
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
        email: inbox.email_address,
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
      email: inbox.email_address,
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

/** Implements `send_email` for IMAP inboxes via SMTP submission. */
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

/** Implements `reply_to_email` for IMAP inboxes: read original, then SMTP send. */
async function replyImapMessage(
  inbox: InboxRow,
  originalMessageId: string,
  params: ReplyToEmailParams,
): Promise<ReplyToEmailResult> {
  if (!inbox.imap_host || !inbox.imap_port || !inbox.imap_password) {
    throw new Error("imap_auth_failed");
  }
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
      email: inbox.email_address,
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
      "reply_to_email: could not determine reply recipients from original message.",
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
    textBody: params.body,
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
// list_inbox — top-level handler
// ---------------------------------------------------------------------------

interface ListInboxArgs {
  inbox_id: string;
  limit?: number;
  offset?: number;
  folder?: string;
  unread_only?: boolean;
}

/**
 * Executes the `list_inbox` tool end-to-end.
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
          text: "list_inbox: arguments must be an object with at least inbox_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;
  const inboxId =
    typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;

  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "list_inbox: inbox_id is required and must be a UUID string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

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
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Inbox ${inboxId} not found or not accessible to this API key. ` +
            "Verify the inbox UUID in the MCPEmails dashboard.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "inbox_not_found",
    };
  }

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
                `Provider '${inbox.provider}' is not yet supported by list_inbox. ` +
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
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Unable to access ${inbox.provider} inbox: OAuth token has been ` +
              "revoked or expired. The user must reconnect their inbox at " +
              "https://mcpemails.com/dashboard/inboxes. " +
              "Inbox status has been updated to 'error'.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "auth_failed",
      };
    }

    console.error("[mcp-server] list_inbox: provider_error", {
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
    result: {
      content: [{ type: "text", text: JSON.stringify(listResult) }],
      isError: false,
    },
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

// ---------------------------------------------------------------------------
// read_email — shared output types
// ---------------------------------------------------------------------------

interface ReadEmailAttachmentMeta {
  /** Sanitised filename. */
  filename: string;
  /** MIME type string. */
  mime_type: string;
  /** Decoded byte size. */
  size_bytes: number;
  /**
   * Base64-encoded binary content.
   * Only populated when `include_attachments: true` was requested and
   * the attachment's byte count is within the 10 MB per-call budget.
   */
  data: string | null;
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
   * Attachment list. Empty unless `include_attachments: true`.
   * Each attachment's `data` field is base64-encoded binary.
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
// Gmail provider — read_email
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
 * Implements `read_email` for Gmail.
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
): Promise<ReadEmailResult> {
  const accessToken = await withFreshGmailToken(inbox);

  // Step 1: Fetch the full message.
  const msgResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!msgResp.ok) {
    if (msgResp.status === 401) throw new Error("gmail_auth_failed");
    if (msgResp.status === 404) throw new Error("message_not_found");
    const errBody = (await msgResp.json()) as { error?: { message?: string } };
    throw new Error(
      `Gmail API error: ${errBody.error?.message ?? msgResp.statusText}`,
    );
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

  // Step 4: Fetch attachment content if requested.
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB total budget
  let budgetRemaining = MAX_ATTACHMENT_BYTES;

  const attachments: ReadEmailAttachmentMeta[] = await Promise.all(
    attachmentRefs.map(async (ref) => {
      if (!includeAttachments) {
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
    body_html: textHtml ? sanitizeEmailHtml(textHtml) : null,
    attachments,
    is_read: markAsRead ? true : isRead,
    labels: labelIds,
    in_reply_to: hdrs["in-reply-to"] ?? null,
    references,
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — read_email
// ---------------------------------------------------------------------------

/**
 * Implements `read_email` for Outlook via Microsoft Graph.
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

  // Fetch attachments if requested.
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  let budgetRemaining = MAX_ATTACHMENT_BYTES;
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
        const sizeBytes = att.size ?? 0;
        let data: string | null = null;
        if (includeAttachments && sizeBytes <= budgetRemaining) {
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
    body_html: bodyHtml ? sanitizeEmailHtml(bodyHtml) : null,
    attachments,
    is_read: markAsRead ? true : (msg.isRead ?? true),
    labels: msg.categories ?? [],
    in_reply_to: iHeaders["in-reply-to"] ?? null,
    references,
  };
}

// ---------------------------------------------------------------------------
// Fastmail provider — read_email (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `read_email` for Fastmail using JMAP (RFC 8621).
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
  // We don't fetch blob content here (would require a separate JMAP Blob/get
  // call), so data is always null even when include_attachments is true.
  // This is an accepted limitation for Fastmail until blob fetching is added.
  const attachments: ReadEmailAttachmentMeta[] = (email.attachments ?? [])
    .filter(
      (p) =>
        p.disposition === "attachment" ||
        (p.name && p.name.length > 0 && p.disposition !== "inline"),
    )
    .map((p) => ({
      filename: p.name ?? "attachment",
      mime_type: p.type ?? "application/octet-stream",
      size_bytes: p.size ?? 0,
      data: null, // Blob fetch not implemented yet
    }));

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
    body_html: bodyHtml ? sanitizeEmailHtml(bodyHtml) : null,
    attachments,
    is_read: markAsRead ? true : !!(email.keywords?.["$seen"]),
    labels: [], // Fastmail uses mailboxIds, not labels — omitted for simplicity
    in_reply_to: email.inReplyTo?.[0] ?? null,
    references: email.references ?? [],
  };
}

// ---------------------------------------------------------------------------
// read_email — top-level handler
// ---------------------------------------------------------------------------

interface ReadEmailArgs {
  inbox_id: string;
  message_id: string;
  include_html?: boolean;
  include_attachments?: boolean;
  mark_as_read?: boolean;
}

/**
 * Executes the `read_email` tool end-to-end.
 *
 * Validates arguments, resolves the inbox, dispatches to the correct provider
 * implementation, and returns a fully assembled ReadEmailResult.
 * Never throws — all errors are captured as structured tool execution errors.
 */
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
          text: "read_email: arguments must be an object with inbox_id and message_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const inboxId =
    typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "read_email: inbox_id is required and must be a UUID string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const messageId =
    typeof args["message_id"] === "string" ? args["message_id"].trim() : null;
  if (!messageId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "read_email: message_id is required and must be a non-empty string.",
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
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Inbox ${inboxId} not found or not accessible to this API key. ` +
            "Verify the inbox UUID in the MCPEmails dashboard.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "inbox_not_found",
    };
  }

  // ── Provider dispatch ─────────────────────────────────────────────────────
  let readResult: ReadEmailResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        readResult = await readGmailMessage(
          inbox,
          messageId,
          includeHtml,
          includeAttachments,
          markAsRead,
        );
        break;
      case "outlook":
        readResult = await readOutlookMessage(
          inbox,
          messageId,
          includeHtml,
          includeAttachments,
          markAsRead,
        );
        break;
      case "fastmail":
        readResult = await readFastmailMessage(
          inbox,
          messageId,
          includeHtml,
          includeAttachments,
          markAsRead,
        );
        break;
      case "imap":
        readResult = await readImapMessage(
          inbox,
          messageId,
          includeHtml,
          includeAttachments,
          markAsRead,
        );
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by read_email. ` +
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
              "The message may have been deleted or the ID is incorrect.",
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
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Unable to access ${inbox.provider} inbox: OAuth token has been ` +
              "revoked or expired. The user must reconnect their inbox at " +
              "https://mcpemails.com/dashboard/inboxes.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "auth_failed",
      };
    }

    console.error("[mcp-server] read_email: provider_error", {
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
    result: {
      content: [{ type: "text", text: JSON.stringify(readResult) }],
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
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }
  const bytes = new TextEncoder().encode(value);
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
  /** BCC recipients are passed to send APIs but omitted from MIME headers */
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
 * BCC addresses are intentionally NOT written to any MIME header; they are
 * handled at the send-API level (RCPT TO / toRecipients etc.) only.
 */
function buildMimeMessage(params: MimeMessageParams): string {
  const boundary = `mcpe_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines: string[] = [];

  // ── Required headers ──────────────────────────────────────────────────────
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to.join(", ")}`);
  if (params.cc?.length) lines.push(`Cc: ${params.cc.join(", ")}`);
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
        `Content-Type: ${att.mimeType}; name="${encodeMimeHeaderValue(att.filename)}"`,
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
// send_email — output and parameter types
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
// Gmail provider — send_email
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
// Outlook provider — send_email
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
// Fastmail provider — send_email (JMAP)
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
// reply_to_email — types
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
  /** Attachments to include with the reply (same shape as send_email). */
  attachments: Array<{ filename: string; mime_type: string; data: string }>;
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
// reply_to_email — Gmail provider
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
  const accessToken = await withFreshGmailToken(inbox);

  // ── Step 1: Fetch original message metadata ───────────────────────────────
  const mp = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Cc", "Subject", "Message-ID", "References"]) {
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
      "reply_to_email: could not determine reply recipients from original message headers.",
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
    textBody: params.body,
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
// reply_to_email — Outlook provider
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
  };

  const origSubject = origMsg.subject ?? "(no subject)";
  const replySubject = /^re:/i.test(origSubject.trim())
    ? origSubject
    : `Re: ${origSubject}`;

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
      "reply_to_email: could not determine reply recipients from original message.",
    );
  }

  // ── Step 3: Build and send the reply ─────────────────────────────────────
  const body = params.htmlBody
    ? { contentType: "HTML", content: params.htmlBody }
    : { contentType: "Text", content: params.body };

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
    if (sendResp.status === 401) throw new Error("outlook_auth_failed");
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
// reply_to_email — Fastmail provider (JMAP)
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
      "reply_to_email: could not determine reply recipients from original message.",
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
// reply_to_email — top-level handler
// ---------------------------------------------------------------------------

/**
 * Executes the `reply_to_email` tool end-to-end.
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
 *  - Same provider_error / delivery_status caution as send_email applies.
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
          text: "reply_to_email: arguments must be an object with inbox_id, message_id, and body.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // inbox_id (required)
  const inboxId =
    typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "reply_to_email: inbox_id is required and must be a UUID string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

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
          text: "reply_to_email: message_id is required and must be a non-empty string.",
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
          text: "reply_to_email: body is required and must be a non-empty string.",
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

  // attachments (optional, default [])
  const attachmentsRaw = args["attachments"];
  const attachments: Array<{ filename: string; mime_type: string; data: string }> = [];

  if (attachmentsRaw !== undefined && attachmentsRaw !== null) {
    if (!Array.isArray(attachmentsRaw)) {
      return {
        result: {
          content: [{
            type: "text",
            text: "reply_to_email: attachments must be an array when provided.",
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
            text: "reply_to_email: attachments must not exceed 20 items per call.",
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
              text: "reply_to_email: each attachment must have filename (string), mime_type (string), and data (base64 string) fields.",
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
                "reply_to_email: total attachment size exceeds the 10 MB limit. " +
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
          text: "reply_to_email: the 'send:email' scope is required to send replies.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "scope_denied",
    };
  }

  // ── Inbox resolution + access control ────────────────────────────────────
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Inbox ${inboxId} not found or not accessible to this API key. ` +
            "Verify the inbox UUID in the MCPEmails dashboard.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "inbox_not_found",
    };
  }

  // ── Provider dispatch ─────────────────────────────────────────────────────
  const replyParams: ReplyToEmailParams = { body, htmlBody, replyAll, attachments };

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
                `Provider '${inbox.provider}' is not yet supported by reply_to_email. ` +
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
              "It may have been deleted or moved. Use list_inbox or search_emails " +
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
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Unable to send reply via ${inbox.provider}: OAuth token has been ` +
              "revoked or expired. The user must reconnect their inbox at " +
              "https://mcpemails.com/dashboard/inboxes. " +
              "Inbox status has been updated to 'error'.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "auth_failed",
      };
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
        "reply_to_email: could not determine reply recipients",
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
    console.error("[mcp-server] reply_to_email: provider_error", {
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
    result: {
      content: [{
        type: "text",
        text: JSON.stringify(replyResult),
      }],
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// send_email — top-level handler
// ---------------------------------------------------------------------------

/** Maximum total attachment size across all attachments in one send call. */
const SEND_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Executes the `send_email` tool end-to-end.
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
          text: "send_email: arguments must be an object with at least inbox_id, to, subject, and body.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // inbox_id (required)
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "send_email: inbox_id is required and must be a UUID string.",
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
          text: "send_email: to is required and must be a non-empty array of email address strings.",
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
          text: "send_email: to must not exceed 50 recipients per RFC 5322 / provider limits.",
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
          text: "send_email: subject is required and must be a non-empty string.",
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
          text: "send_email: subject must not exceed 998 characters (RFC 5322 limit).",
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
          text: "send_email: body is required and must be a non-empty string.",
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
            text: "send_email: attachments must not exceed 20 items per call.",
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
              text: "send_email: each attachment must be an object with filename (string), mime_type (string), and data (base64 string) fields.",
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
                "send_email: total attachment size exceeds the 10 MB limit. " +
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
              `send_email: invalid email address in '${field}': "${String(addr)}". ` +
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
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Inbox ${inboxId} not found or not accessible to this API key. ` +
            "Verify the inbox UUID in the MCPEmails dashboard.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "inbox_not_found",
    };
  }

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
                `Provider '${inbox.provider}' is not yet supported by send_email. ` +
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
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Unable to access ${inbox.provider} inbox: OAuth token has been ` +
              "revoked or expired. The user must reconnect their inbox at " +
              "https://mcpemails.com/dashboard/inboxes. " +
              "Inbox status has been updated to 'error'.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "auth_failed",
      };
    }

    // Unknown provider error — log it but do NOT include raw error detail
    // in the response (may contain provider internals or account info).
    console.error("[mcp-server] send_email: provider_error", {
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
    result: {
      content: [{ type: "text", text: JSON.stringify(sendResult) }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// search_emails — shared output types
// ---------------------------------------------------------------------------

/**
 * A single email summary in a `search_emails` result.
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
  total: number;
  has_more: boolean;
  next_offset: number;
  /** The query as received (providers do not expose a normalized form). */
  query_normalized: string;
}

// ---------------------------------------------------------------------------
// Gmail provider — search_emails
// ---------------------------------------------------------------------------

/**
 * Implements `search_emails` for Gmail.
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
  query: string,
  limit: number,
  offset: number,
  includeFolders: string[],
): Promise<SearchEmailsResult> {
  const accessToken = await withFreshGmailToken(inbox);

  const fetchCount = Math.min(offset + limit, 100);
  const params = new URLSearchParams({
    q: query,
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
  const total = listData.resultSizeEstimate ?? allRefs.length;
  const hasMore =
    !!listData.nextPageToken || allRefs.length > offset + limit;

  const pageRefs = allRefs.slice(offset, offset + limit);

  if (pageRefs.length === 0) {
    return {
      messages: [],
      total,
      has_more: hasMore,
      next_offset: offset + limit,
      query_normalized: query,
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
    has_more: hasMore,
    next_offset: offset + limit,
    query_normalized: query,
  };
}

// ---------------------------------------------------------------------------
// Outlook provider — search_emails
// ---------------------------------------------------------------------------

/**
 * Implements `search_emails` for Outlook using Microsoft Graph.
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
 * Note: Graph `$search` requires `ConsistencyLevel: eventual` and does not
 * support `$count=true` alongside `$search`.
 */
async function searchOutlookMessages(
  inbox: InboxRow,
  query: string,
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

  // Graph rejects $skip when combined with $search, so page client-side: fetch
  // the first (offset + limit) matches and slice the requested window. Capped
  // at Graph's max page size for $search.
  const fetchTop = Math.min(offset + limit, 1000);
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $select: select,
    $top: String(fetchTop),
  });

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
    "@odata.nextLink"?: string;
  };

  const rawMessages = data.value ?? [];
  const hasMore = !!data["@odata.nextLink"];
  const pageMessages = rawMessages.slice(offset, offset + limit);
  // Graph does not return a total count for $search; use the fetched count as a
  // lower-bound estimate.
  const total = hasMore ? rawMessages.length + 1 : rawMessages.length;

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
    has_more: hasMore,
    next_offset: offset + limit,
    query_normalized: query,
  };
}

// ---------------------------------------------------------------------------
// Fastmail provider — search_emails (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `search_emails` for Fastmail using JMAP (RFC 8620/8621).
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
  query: string,
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

  // Build the Email/query filter.
  // `text` is JMAP's full-text search operator (searches subject, body, from, to, etc.)
  const emailFilter: Record<string, unknown> = { text: query };

  // Step 2: If include_folders is non-empty, resolve the first folder to a
  // mailbox ID and add it as an `inMailbox` constraint.
  // We use only the first folder: JMAP's `inMailbox` takes a single ID, and
  // multi-folder union search would require `inMailboxOtherThan` plus a separate
  // query-merge, which is outside the scope of this tool.
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
        emailFilter["inMailbox"] = mbIds[0];
      }
    }
    // If mailbox resolution fails, fall through to full-inbox search.
  }

  // Step 3: Run Email/query with text filter, then Email/get for metadata.
  const jmapBody = {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          filter: emailFilter,
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
    has_more: hasMore,
    next_offset: offset + limit,
    query_normalized: query,
  };
}

// ---------------------------------------------------------------------------
// search_emails — top-level handler
// ---------------------------------------------------------------------------

/** Search timeout: 30 seconds, matching the architecture doc specification. */
const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Executes the `search_emails` tool end-to-end.
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
 *    Body content is only available via read_email.
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
          text: "search_emails: arguments must be an object with at least inbox_id and query.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  // inbox_id (required)
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "search_emails: inbox_id is required and must be a UUID string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  // query (required, non-empty)
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (!query) {
    return {
      result: {
        content: [{
          type: "text",
          text: "search_emails: query is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

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
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Inbox ${inboxId} not found or not accessible to this API key. ` +
            "Verify the inbox UUID in the MCPEmails dashboard.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "inbox_not_found",
    };
  }

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
          query,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(
          inbox,
          query,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(
          inbox,
          query,
          limit,
          offset,
          includeFolders,
        );
        break;
      case "imap":
        searchPromise = searchImapMessages(
          inbox,
          query,
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
                `Provider '${inbox.provider}' is not yet supported by search_emails. ` +
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
      return {
        result: {
          content: [{
            type: "text",
            text:
              `Unable to access ${inbox.provider} inbox: OAuth token has been ` +
              "revoked or expired. The user must reconnect their inbox at " +
              "https://mcpemails.com/dashboard/inboxes. " +
              "Inbox status has been updated to 'error'.",
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "auth_failed",
      };
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

    console.error("[mcp-server] search_emails: provider_error", {
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
    result: {
      content: [{ type: "text", text: JSON.stringify(searchResult) }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
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
  // An API key with only read:email will see list_inbox, read_email, search_emails.
  // An API key with send:email (in addition or alone) will also see send_email, reply_to_email.
  const visibleTools = TOOL_REGISTRY
    .filter((tool) => apiKey.scopes.includes(tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
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
          .filter((t) => apiKey.scopes.includes(t.requiredScope))
          .map((t) => t.name),
      },
    );
  }

  // ── Scope check ───────────────────────────────────────────────────────────
  // Run before any I/O or credential loading so unauthorised calls are rejected
  // with minimal resource consumption. All scope violations are logged.
  if (!apiKey.scopes.includes(tool.requiredScope)) {
    await writeActivityLog({
      workspaceId: apiKey.workspace_id,
      apiKeyId: apiKey.id,
      inboxId,
      toolName,
      status: "error",
      errorCode: String(RPC_INVALID_API_KEY),
      durationMs: null,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    console.warn("[mcp-server] tools/call: insufficient_scope", {
      key_id: apiKey.id,
      tool_name: toolName,
      required_scope: tool.requiredScope,
      key_scopes: apiKey.scopes,
    });

    return jsonRpcErrorBody(
      id,
      RPC_INVALID_API_KEY,
      `Insufficient scope: the '${tool.requiredScope}' scope is required to call ${toolName}.`,
      { required_scope: tool.requiredScope, key_scopes: apiKey.scopes },
    );
  }

  // ── Execute the tool ──────────────────────────────────────────────────────
  // Tool implementations (list_inbox, read_email, etc.) are added in the
  // "MCP Tools — Implementation" checklist tasks. Until each tool is
  // implemented, this handler returns a structured error so the MCP client
  // receives a valid JSON-RPC response rather than HTTP 5xx.
  //
  // The timing clock starts here — it covers everything from the moment the
  // tool begins executing to the moment the result is ready, excluding the
  // log write itself (which is infrastructure overhead, not tool latency).
  const startMs = Date.now();

  let toolResult: JsonRpcSuccessResponse | JsonRpcErrorResponse;
  let logStatus: "success" | "error" = "error";
  let logErrorCode: string | null = String(-32601); // Method not found

  try {
    // ── Dispatch to the implemented tool handler ───────────────────────────
    if (toolName === "list_inboxes") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListInboxes(apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "list_inbox") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListInbox(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "read_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReadEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "send_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSendEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "reply_to_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeReplyToEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "search_emails") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchEmails(rawArgs, apiKey);
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

  // ── Write activity log ────────────────────────────────────────────────────
  // Awaited intentionally — the audit trail must be complete before the
  // response leaves the Edge Function. A logging failure is non-fatal.
  await writeActivityLog({
    workspaceId: apiKey.workspace_id,
    apiKeyId: apiKey.id,
    inboxId,
    toolName,
    status: logStatus,
    errorCode: logErrorCode,
    durationMs,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  console.log("[mcp-server] tools/call", {
    key_id: apiKey.id,
    tool_name: toolName,
    inbox_id: inboxId,
    status: logStatus,
    duration_ms: durationMs,
  });

  return toolResult;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
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

  // ── Per-key rate limit check ──────────────────────────────────────────────
  // Runs after authentication and before routing to any tool handler.
  // `initialize` and `tools/list` are counted against the rate limit like any
  // other call — they consume the same Edge Function slot and DB resources.
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
