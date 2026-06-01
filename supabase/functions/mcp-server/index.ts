import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ImapAuthError, ImapClient, ImapMessageSummary } from "./imap-client.ts";
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
  /** The name of the MCP tool that was called (e.g. "list_messages"). */
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
// Contacts derivation — upsertContacts
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget upsert of contact rows derived from email message headers.
 *
 * Called on every successful read_email, search_emails, and send_email.
 * Silently skips invalid addresses and swallows DB errors so a contacts
 * failure never blocks a tool response.
 *
 * Each address that isn't the inbox's own address is upserted into
 * `public.contacts` keyed by (inbox_id, lower(email_address)), incrementing
 * message_count and refreshing last_contacted_at and display_name.
 *
 * Idempotency: ON CONFLICT on the unique index (inbox_id, lower(email_address))
 * ensures duplicate calls for the same address are collapsed into one row.
 *
 * @param inbox   Resolved InboxRow — provides workspace_id and inbox_id.
 * @param entries Raw EmailAddressEntry list from message headers.
 * @param seenAt  ISO 8601 timestamp of the message (for last_contacted_at).
 */
async function upsertContacts(
  inbox: InboxRow,
  entries: EmailAddressEntry[],
  seenAt: string,
): Promise<void> {
  // Normalise and deduplicate; exclude the inbox's own address.
  const own = (inbox.email_address ?? "").toLowerCase().trim();
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const entry of entries) {
    const addr = (entry.email ?? "").toLowerCase().trim();
    if (!addr || addr === own || seen.has(addr)) continue;
    seen.add(addr);
    rows.push({
      workspace_id: inbox.workspace_id,
      inbox_id: inbox.id,
      email_address: addr,
      display_name: entry.name?.trim() || null,
      message_count: 1,
      last_contacted_at: seenAt,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) return;

  // Upsert in a single statement; conflict target is the partial unique index.
  const { error } = await supabase.from("contacts").upsert(rows, {
    onConflict: "inbox_id,email_address",
    ignoreDuplicates: false,
  });

  if (error) {
    // Non-fatal — log and continue.
    console.error("[mcp-server] upsertContacts_failed", {
      inbox_id: inbox.id,
      workspace_id: inbox.workspace_id,
      count: rows.length,
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
//
// ── Destructive-action convention ────────────────────────────────────────────
// Every tool that deletes, permanently modifies, or bulk-affects messages MUST:
//   1. Include a `confirm` boolean property (required, no default) in its
//      inputSchema.  Description: "Must be true to confirm the operation."
//   2. Call `requireConfirm(input)` at the top of its handler and return the
//      result immediately if non-null.
//   3. For bulk tools: enforce the `MAX_BULK_IDS` cap (500) before processing
//      and return a structured error if exceeded.
// This ensures a uniform `confirm=true` gate and error shape across all
// destructive tools.  See `requireConfirm` and `MAX_BULK_IDS` below.
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
  /** JSON Schema (Draft 7) for argument validation */
  inputSchema: Record<string, unknown>;
}

/** All tools available in MCPEmails, in canonical display order. */
const TOOL_REGISTRY: ToolDefinition[] = [
  // ── read:email scope ────────────────────────────────────────────────────────

  {
    name: "list_messages",
    title: "List Messages",
    description:
      "List email messages inside an inbox. Returns message summaries " +
      "(sender, subject, date, preview, read status, attachment flag) ordered " +
      "newest first. Supports filtering by folder, unread status, and pagination. " +
      "Use read_email to fetch the full content of a specific message. " +
      "Note: this lists the MESSAGES within one inbox — to discover which inboxes " +
      "exist and obtain their inbox_id, call list_inboxes first.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox to list. Must be an inbox in the current workspace " +
            "that the API key is permitted to access. Call list_inboxes to discover " +
            "the available inbox_id values.",
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
            "Always obtained from a previous call to list_messages or search_emails.",
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

  {
    name: "list_folders",
    title: "List Folders",
    description:
      "List all folders (or labels, for Gmail) for an inbox. " +
      "Returns each folder's provider-native ID, display name, type " +
      "('folder' for hierarchical providers, 'label' for Gmail), and " +
      "message counts (total and unread). " +
      "IMAP providers use LIST + STATUS; Gmail uses labels.list + labels.get; " +
      "Outlook uses Graph mailFolders; Fastmail uses JMAP Mailbox/get. " +
      "Use the returned folder names/IDs as the 'folder' argument for list_messages, " +
      "and as source/destination for move_email and copy_email.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox whose folders to list.",
        },
      },
      required: ["inbox_id"],
      additionalProperties: false,
    },
  },

  // ── manage:folders scope ─────────────────────────────────────────────────────

  {
    name: "create_folder",
    title: "Create Folder",
    description:
      "Create a new folder (or label, for Gmail) in an inbox. " +
      "IMAP providers use the IMAP CREATE command; Gmail uses labels.create; " +
      "Outlook uses Graph mailFolders create; Fastmail uses JMAP Mailbox/set create. " +
      "Returns the provider-native folder/label ID and display name of the created item.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox to create the folder/label in.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Name of the new folder or label.",
        },
      },
      required: ["inbox_id", "name"],
      additionalProperties: false,
    },
  },

  {
    name: "rename_folder",
    title: "Rename Folder",
    description:
      "Rename an existing folder or label. " +
      "IMAP providers use the IMAP RENAME command; Gmail uses labels.patch; " +
      "Outlook uses Graph mailFolders PATCH; Fastmail uses JMAP Mailbox/set update. " +
      "Use list_folders to obtain the folder_id before calling this tool.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the folder/label.",
        },
        folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID as returned by list_folders. " +
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
      required: ["inbox_id", "folder_id", "new_name"],
      additionalProperties: false,
    },
  },

  {
    name: "delete_folder",
    title: "Delete Folder",
    description:
      "Permanently delete a folder (or label, for Gmail). " +
      "THIS ACTION IS IRREVERSIBLE — all messages inside the folder may be lost " +
      "depending on the provider. Requires confirm=true. " +
      "IMAP providers use the IMAP DELETE command; Gmail uses labels.delete; " +
      "Outlook uses Graph mailFolders delete; Fastmail uses JMAP Mailbox/set destroy. " +
      "Use list_folders to obtain the folder_id before calling this tool.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the folder/label.",
        },
        folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID as returned by list_folders.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the destructive delete operation.",
        },
      },
      required: ["inbox_id", "folder_id", "confirm"],
      additionalProperties: false,
    },
  },

  {
    name: "move_email",
    title: "Move Email",
    description:
      "Move an email message to a different folder (or label, for Gmail). " +
      "IMAP providers use UID MOVE (with COPY+\\\\Deleted+EXPUNGE fallback); " +
      "Gmail simulates move by adding the destination label and removing the INBOX label; " +
      "Outlook uses Graph messages/{id}/move; Fastmail uses JMAP Email/set to update mailboxIds. " +
      "Use list_folders to obtain the destination_folder_id before calling this tool. " +
      "Gmail does not support copy_email — use move_email instead.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by list_messages, read_email, or search_emails.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID of the destination, as returned by list_folders. " +
            "For IMAP this is the mailbox name (e.g. 'Archive'); " +
            "for Gmail the label ID to add (INBOX label is removed automatically); " +
            "for Outlook/Fastmail the opaque folder ID.",
        },
      },
      required: ["inbox_id", "message_id", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "copy_email",
    title: "Copy Email",
    description:
      "Copy an email message to a different folder, leaving the original in place. " +
      "IMAP providers use UID COPY; " +
      "Outlook uses Graph messages/{id}/copy; Fastmail uses JMAP Email/copy. " +
      "Gmail does not support copy — use move_email for Gmail inboxes. " +
      "Use list_folders to obtain the destination_folder_id before calling this tool.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by list_messages, read_email, or search_emails.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Provider-native folder ID of the destination, as returned by list_folders. " +
            "For IMAP this is the mailbox name; for Outlook/Fastmail the opaque folder ID.",
        },
      },
      required: ["inbox_id", "message_id", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  // ── delete:email scope ─────────────────────────────────────────────────────

  {
    name: "delete_email",
    title: "Delete Email",
    description:
      "Delete (trash or permanently expunge) a single email message. " +
      "By default the message is moved to the provider's Trash folder (safer). " +
      "Set permanent:true to hard-delete: IMAP uses \\\\Deleted + UID EXPUNGE; " +
      "Gmail calls messages.delete (bypasses Trash); " +
      "Outlook calls Graph messages/{id}/permanentDelete; " +
      "Fastmail uses JMAP Email/set destroy. " +
      "This action requires confirm:true and may be irreversible when permanent:true is set.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message ID as returned by list_messages, read_email, or search_emails.",
        },
        permanent: {
          type: "boolean",
          description:
            "When true, hard-deletes the message (bypasses Trash). " +
            "When false or omitted, moves the message to Trash. " +
            "Default: false.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the destructive delete operation.",
        },
      },
      required: ["inbox_id", "message_id", "confirm"],
      additionalProperties: false,
    },
  },

  // ── bulk operations ─────────────────────────────────────────────────────────

  {
    name: "bulk_move",
    title: "Bulk Move",
    description:
      "Move up to 500 email messages to a destination folder in one call. " +
      "IMAP: UID MOVE per source-folder group (falls back to COPY+EXPUNGE if MOVE unsupported); " +
      "Gmail: messages.batchModify (label swap — removes INBOX, adds destination label); " +
      "Outlook: per-message Graph move; " +
      "Fastmail: single JMAP Email/set update for all messages. " +
      "Returns succeeded/failed counts and per-message results. " +
      "Use list_folders to obtain destination_folder_id.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the messages.",
        },
        message_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description:
            "Provider-native message IDs to move (from list_messages, read_email, or search_emails). " +
            "Maximum 500 IDs per call.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID of the destination, as returned by list_folders. " +
            "For IMAP: mailbox name (e.g. 'Archive'); Gmail: label ID to add; " +
            "Outlook/Fastmail: opaque folder ID.",
        },
      },
      required: ["inbox_id", "message_ids", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "bulk_delete",
    title: "Bulk Delete",
    description:
      "Delete up to 500 email messages in one call. Requires confirm:true. " +
      "By default moves messages to Trash (safer). Set permanent:true for hard delete. " +
      "IMAP: UID MOVE to Trash or \\\\Deleted+UID EXPUNGE per source-folder group; " +
      "Gmail: messages.batchDelete (permanent) or per-message trash (soft); " +
      "Outlook: per-message Graph calls; " +
      "Fastmail: JMAP Email/set destroy (permanent) or Trash mailbox update (soft). " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the messages.",
        },
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
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the destructive bulk delete operation.",
        },
      },
      required: ["inbox_id", "message_ids", "confirm"],
      additionalProperties: false,
    },
  },

  {
    name: "bulk_flag",
    title: "Bulk Flag",
    description:
      "Apply a read/unread/flag/unflag action to up to 500 messages in one call. " +
      "IMAP: single UID STORE command per source-folder group; " +
      "Gmail: messages.batchModify; " +
      "Outlook: per-message Graph PATCH; " +
      "Fastmail: single JMAP Email/set update for all messages. " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the messages.",
        },
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
      required: ["inbox_id", "message_ids", "action"],
      additionalProperties: false,
    },
  },

  // ── search-and-act (Phase 3 cont.) ───────────────────────────────────────────

  {
    name: "search_and_move",
    title: "Search and Move",
    description:
      "Run a search and move all matching messages to a destination folder in one " +
      "server-side operation — avoids stale message IDs. " +
      "Capped at 500 results per call. " +
      "IMAP: UID MOVE per source-folder group; " +
      "Gmail: messages.batchModify (label swap); " +
      "Outlook: per-message Graph move; " +
      "Fastmail: JMAP Email/set update for all matches. " +
      "Returns succeeded/failed counts and per-message results. " +
      "Use list_folders to obtain destination_folder_id.",
    requiredScope: "manage:folders",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox to search and operate on.",
        },
        query: {
          type: "string",
          minLength: 1,
          description:
            "Search query string. Gmail: Gmail search syntax (from:, subject:, etc.); " +
            "Outlook: KQL syntax; Fastmail: JMAP filter string; IMAP: IMAP SEARCH criteria.",
        },
        destination_folder_id: {
          type: "string",
          description:
            "Provider-native folder/label ID of the destination, as returned by list_folders. " +
            "For IMAP: mailbox name (e.g. 'Archive'); Gmail: label ID to add; " +
            "Outlook/Fastmail: opaque folder ID.",
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
      required: ["inbox_id", "query", "destination_folder_id"],
      additionalProperties: false,
    },
  },

  {
    name: "search_and_delete",
    title: "Search and Delete",
    description:
      "Run a search and delete all matching messages in one server-side operation — " +
      "avoids stale message IDs. Requires confirm:true. " +
      "Capped at 500 results per call. " +
      "Default: move matches to Trash (safer). Set permanent:true for hard delete. " +
      "IMAP: UID MOVE to Trash or \\\\Deleted+UID EXPUNGE per source-folder group; " +
      "Gmail: trash or messages.delete; Outlook: Graph delete or permanentDelete; " +
      "Fastmail: JMAP Email/set destroy or Trash mailbox update. " +
      "Returns succeeded/failed counts and per-message results.",
    requiredScope: "delete:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox to search and operate on.",
        },
        query: {
          type: "string",
          minLength: 1,
          description:
            "Search query string. Gmail: Gmail search syntax; " +
            "Outlook: KQL syntax; Fastmail: JMAP filter string; IMAP: IMAP SEARCH criteria.",
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
        confirm: {
          type: "boolean",
          description: "Must be true to confirm the destructive search-and-delete operation.",
        },
      },
      required: ["inbox_id", "query", "confirm"],
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

  {
    name: "forward_email",
    title: "Forward Email",
    description:
      "Forward an existing email to one or more new recipients. Fetches the original " +
      "message and prepends an optional introductory note followed by the standard " +
      "'---------- Forwarded message ----------' header block (From, Date, Subject, To) " +
      "and the original body. Optionally re-attaches original attachments. " +
      "IMAP, Gmail, and Fastmail construct a new MIME message via their respective send " +
      "paths; Outlook fetches the original and uses Graph sendMail. " +
      "The forward subject is prefixed with 'Fwd:' if not already present. " +
      "This action is irreversible — use carefully.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox that contains the original message and from which " +
            "the forward will be sent.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier of the email to forward, as returned " +
            "by list_messages, read_email, or search_emails.",
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
      },
      required: ["inbox_id", "message_id", "to"],
      additionalProperties: false,
    },
  },

  // ── send:email scope — state changes (non-destructive) ─────────────────────

  {
    name: "mark_read",
    title: "Mark Email as Read",
    description:
      "Mark a single email message as read. Non-destructive. " +
      "Provider dispatch: IMAP sets \\\\Seen flag; Gmail removes the UNREAD label; " +
      "Outlook sets isRead=true via Graph; Fastmail sets $seen keyword via JMAP.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox containing the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by list_messages or search_emails.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "mark_unread",
    title: "Mark Email as Unread",
    description:
      "Mark a single email message as unread. Non-destructive. " +
      "Provider dispatch: IMAP removes \\\\Seen flag; Gmail adds the UNREAD label; " +
      "Outlook sets isRead=false via Graph; Fastmail removes $seen keyword via JMAP.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox containing the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by list_messages or search_emails.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "flag_email",
    title: "Flag Email",
    description:
      "Flag (star / mark for follow-up) a single email message. Non-destructive. " +
      "Provider dispatch: IMAP sets \\\\Flagged; Gmail adds STARRED label; " +
      "Outlook sets flag.flagStatus=flagged via Graph; Fastmail sets $flagged keyword via JMAP.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox containing the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by list_messages or search_emails.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "unflag_email",
    title: "Unflag Email",
    description:
      "Remove the flag (star / follow-up mark) from a single email message. Non-destructive. " +
      "Provider dispatch: IMAP removes \\\\Flagged; Gmail removes STARRED label; " +
      "Outlook sets flag.flagStatus=notFlagged via Graph; Fastmail removes $flagged keyword via JMAP.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox containing the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by list_messages or search_emails.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  {
    name: "archive_email",
    title: "Archive Email",
    description:
      "Move a message out of the Inbox to the archive location. Non-destructive — message is " +
      "preserved, not deleted. Provider dispatch: IMAP moves to 'Archive' mailbox via uidMove " +
      "(falls back to COPY+DELETE if MOVE unsupported); Gmail removes the INBOX label; " +
      "Outlook moves to the archive mail folder via Graph; Fastmail moves to the archive " +
      "mailbox via JMAP Email/set.",
    requiredScope: "send:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox containing the message.",
        },
        message_id: {
          type: "string",
          description:
            "Provider-native message identifier as returned by list_messages or search_emails.",
        },
      },
      required: ["inbox_id", "message_id"],
      additionalProperties: false,
    },
  },

  // ── manage:drafts scope ──────────────────────────────────────────────────────

  {
    name: "list_drafts",
    title: "List Drafts",
    description:
      "Return draft messages saved in the inbox's Drafts folder. " +
      "Each result includes the draft_id, subject, recipients, and created timestamp. " +
      "IMAP: UID SEARCH in the Drafts mailbox; Gmail: drafts.list API; " +
      "Outlook: Graph mailFolders/Drafts/messages; Fastmail: JMAP Email/query with $draft keyword. " +
      "Use the returned draft_id with update_draft or send_draft.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox whose drafts to list.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 20,
          description: "Maximum number of drafts to return. Defaults to 20.",
        },
      },
      required: ["inbox_id"],
      additionalProperties: false,
    },
  },

  {
    name: "create_draft",
    title: "Create Draft",
    description:
      "Save a new email draft in the inbox's Drafts folder without sending it. " +
      "Returns a draft_id that can be used with update_draft or send_draft. " +
      "IMAP: APPEND to Drafts with \\\\Draft flag; Gmail: drafts.create; " +
      "Outlook: create message in Drafts folder via Graph; Fastmail: JMAP Email/set with $draft keyword. " +
      "At minimum, subject and body are required; to/cc/bcc are optional (drafts may be incomplete).",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox to save the draft in.",
        },
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
      },
      required: ["inbox_id", "subject", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "update_draft",
    title: "Update Draft",
    description:
      "Replace the content of an existing draft. All supplied fields overwrite the stored draft. " +
      "IMAP: appends updated message to Drafts then expunges the old UID; " +
      "Gmail: drafts.update; Outlook: PATCH message via Graph; Fastmail: JMAP Email/set update. " +
      "Use list_drafts to obtain draft_id values.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that owns the draft.",
        },
        draft_id: {
          type: "string",
          description: "Provider-native draft identifier as returned by create_draft or list_drafts.",
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
          description: "Updated subject line.",
        },
        body: {
          type: "string",
          description: "Updated plain-text body.",
        },
        html_body: {
          type: "string",
          description: "Updated HTML body.",
        },
      },
      required: ["inbox_id", "draft_id", "subject", "body"],
      additionalProperties: false,
    },
  },

  {
    name: "send_draft",
    title: "Send Draft",
    description:
      "Send a previously saved draft. The draft is removed from the Drafts folder after sending. " +
      "IMAP: reads the draft MIME, submits via SMTP, then expunges the draft UID; " +
      "Gmail: drafts.send; Outlook: POST /messages/{id}/send via Graph; " +
      "Fastmail: JMAP EmailSubmission/set then removes $draft keyword. " +
      "This action is irreversible — use carefully.",
    requiredScope: "manage:drafts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox that contains the draft.",
        },
        draft_id: {
          type: "string",
          description: "Provider-native draft identifier as returned by create_draft or list_drafts.",
        },
      },
      required: ["inbox_id", "draft_id"],
      additionalProperties: false,
    },
  },

  // ── manage:contacts scope ────────────────────────────────────────────────────

  {
    name: "search_contacts",
    title: "Search Contacts",
    description:
      "Search the derived contact list by name or email address. " +
      "Contacts are automatically populated from message headers seen during " +
      "read_email, search_emails, and send_email — no manual setup is needed. " +
      "Returns matching contacts sorted by most-recently-contacted first, " +
      "each with their display name, email address, message count, and " +
      "last-contacted timestamp. Optionally restrict to a specific inbox; " +
      "if inbox_id is omitted, searches across all inboxes in the workspace.",
    requiredScope: "manage:contacts",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Name or email address fragment to search for. " +
            "Matched case-insensitively against both display_name and email_address. " +
            "Must be at least 1 character. Example: 'alice' matches 'Alice Smith' " +
            "and 'alice@example.com'.",
        },
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "Optional. When provided, restricts results to contacts seen " +
            "from that specific inbox. When omitted, searches across all " +
            "inboxes the API key is permitted to access within the workspace.",
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

  {
    name: "get_contact",
    title: "Get Contact",
    description:
      "Retrieve the full contact record for a single email address within a " +
      "specific inbox. Returns the contact's display name, email address, " +
      "cumulative message count (how many times this address has appeared in " +
      "message headers), and the timestamp of the most-recently-seen message. " +
      "Contacts are automatically populated from message traffic — call " +
      "search_contacts first to discover which addresses are known.",
    requiredScope: "manage:contacts",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the inbox associated with the contact.",
        },
        email_address: {
          type: "string",
          description:
            "The email address to look up. Matched case-insensitively " +
            "(the address is normalised to lowercase before querying).",
        },
      },
      required: ["inbox_id", "email_address"],
      additionalProperties: false,
    },
  },

  // ── schedule:email scope ─────────────────────────────────────────────────────

  {
    name: "schedule_send",
    title: "Schedule Send",
    description:
      "Schedule an email to be sent at a future date and time. " +
      "The message is stored in a pending queue and dispatched automatically " +
      "by the server when send_at is reached. All recipient addresses and the " +
      "message body are validated immediately at schedule time — if validation " +
      "fails the message will not be queued. Use list_scheduled to view pending " +
      "scheduled sends and cancel_scheduled to cancel before they are sent.",
    requiredScope: "schedule:email",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: {
          type: "string",
          format: "uuid",
          description:
            "UUID of the inbox to send from. The email will appear to the " +
            "recipient as being sent from the email address of this inbox.",
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
      required: ["inbox_id", "to", "subject", "body", "send_at"],
      additionalProperties: false,
    },
  },

  {
    name: "list_scheduled",
    title: "List Scheduled Sends",
    description:
      "List pending scheduled email sends for the workspace. Returns all messages " +
      "with status 'pending' or 'sending', ordered by scheduled send time (earliest first). " +
      "Optionally filter by inbox. Use cancel_scheduled to cancel a pending send before " +
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
    name: "cancel_scheduled",
    title: "Cancel Scheduled Send",
    description:
      "Cancel a pending scheduled email send. Sets the status to 'cancelled' so the " +
      "dispatcher will not send the message. Only messages with status 'pending' can be " +
      "cancelled — messages already in 'sending', 'sent', or 'error' state cannot be " +
      "cancelled. Use list_scheduled to find the scheduled_send_id.",
    requiredScope: "schedule:email",
    inputSchema: {
      type: "object",
      properties: {
        scheduled_send_id: {
          type: "string",
          format: "uuid",
          description: "UUID of the scheduled send to cancel.",
        },
      },
      required: ["scheduled_send_id"],
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
      "Each result includes the inbox UUID, email address, display name, provider, " +
      "optional service brand (icloud/yahoo/zoho/yandex/generic), and a capabilities " +
      "object describing which features (flags, folders, labels, move, copy, delete, " +
      "forward, drafts, contacts_api, scheduling) are supported for that inbox.",
    requiredScope: "read:email",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
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
   * DB-synced contacts derived from message headers (search_contacts /
   * get_contact tools — Task 15-16).  True for all providers because the
   * contacts table is populated from email metadata regardless of protocol.
   */
  contacts_db: boolean;
  /** Server-side scheduled send (via scheduled_sends queue — Task 17-18) */
  scheduling: boolean;
  /**
   * Query syntax accepted by search_emails for this provider.
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
    contacts_db: true,   // DB-synced from message headers
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
    contacts_db: true,   // DB-synced from message headers
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
    contacts_db: true,   // DB-synced from message headers
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
    contacts_db: true,   // DB-synced from message headers
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

// ---------------------------------------------------------------------------
// Destructive-action plumbing
//
// requireConfirm — gate for every destructive / irreversible tool.
// MAX_BULK_IDS   — hard cap on bulk-UID operations to prevent runaway calls.
//
// Usage (in any destructive handler):
//
//   const guard = requireConfirm(input);
//   if (guard) return guard;
//
//   if (Array.isArray(input.message_ids) && input.message_ids.length > MAX_BULK_IDS) {
//     return bulkCapError(input.message_ids.length);
//   }
// ---------------------------------------------------------------------------

/** Maximum number of message UIDs accepted by any bulk tool in a single call. */
const MAX_BULK_IDS = 500;

/**
 * Returns a structured error result when `input.confirm` is not exactly `true`.
 * Returns `null` when the caller may proceed.
 *
 * Every destructive tool MUST call this and short-circuit on a non-null return:
 *
 *   const guard = requireConfirm(input);
 *   if (guard) return guard;
 */
function requireConfirm(
  input: Record<string, unknown>,
): {
  result: { content: { type: string; text: string }[] };
  logStatus: "error";
  logErrorCode: string;
} | null {
  if (input["confirm"] !== true) {
    return {
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "confirmation_required",
            message:
              "This operation requires confirm=true. Set confirm to true to proceed.",
          }),
        }],
      },
      logStatus: "error",
      logErrorCode: String(-32600),
    };
  }
  return null;
}

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
}

const INBOX_SELECT_COLUMNS =
  "id, workspace_id, provider, email_address, display_name, " +
  "oauth_access_token, oauth_refresh_token, oauth_token_expires_at, " +
  "imap_host, imap_port, imap_tls, imap_username, imap_password, " +
  "smtp_host, smtp_port, smtp_tls, status";

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
    .select("id, email_address, display_name, provider, service, status")
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
    capabilities: getProviderCapabilities(row.provider),
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
// Email summary types (shared across list_messages and search_emails tools)
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
// Gmail provider — list_messages
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
 * Implements `list_messages` for Gmail.
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
// Outlook provider — list_messages
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
 * Implements `list_messages` for Outlook using Microsoft Graph.
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
// Fastmail provider — list_messages (JMAP)
// ---------------------------------------------------------------------------

/**
 * Implements `list_messages` for Fastmail using JMAP (RFC 8620/8621).
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
// Generic IMAP provider — list_messages
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
 * Implements `list_messages` for IMAP inboxes connected with an app password.
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
      email: imapAuthUser(inbox),
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
// list_messages — top-level handler
// ---------------------------------------------------------------------------

interface ListInboxArgs {
  inbox_id: string;
  limit?: number;
  offset?: number;
  folder?: string;
  unread_only?: boolean;
}

/**
 * Executes the `list_messages` tool end-to-end.
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
          text: "list_messages: arguments must be an object with at least inbox_id.",
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
          text: "list_messages: inbox_id is required and must be a UUID string.",
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
                `Provider '${inbox.provider}' is not yet supported by list_messages. ` +
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

    console.error("[mcp-server] list_messages: provider_error", {
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
  // Derive contacts from headers (fire-and-forget; never blocks the response).
  upsertContacts(
    inbox,
    [readResult.from, ...readResult.to, ...readResult.cc],
    readResult.date,
  ).catch(() => { /* already logged inside upsertContacts */ });

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
// forward_email — types
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
// forward_email — shared helpers
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
 * Prefix "Fwd: " on the subject if not already present.
 */
function makeForwardSubject(origSubject: string): string {
  return /^fwd:/i.test(origSubject.trim()) ? origSubject : `Fwd: ${origSubject}`;
}

// ---------------------------------------------------------------------------
// forward_email — IMAP provider
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
// forward_email — Gmail provider
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
// forward_email — Outlook provider
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
// forward_email — Fastmail provider (JMAP)
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
// forward_email — top-level handler
// ---------------------------------------------------------------------------

/**
 * Executes the `forward_email` tool end-to-end.
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
 *  - Same provider_error / delivery_status caution as send_email applies.
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
          text: "forward_email: arguments must be an object with inbox_id, message_id, and to.",
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
          text: "forward_email: inbox_id is required and must be a UUID string.",
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
          text: "forward_email: message_id is required and must be a non-empty string.",
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
          text: "forward_email: to is required and must be a non-empty array of email address strings.",
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
          text: "forward_email: to must not exceed 50 recipients.",
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
              `forward_email: invalid email address in '${field}': "${String(addr)}". ` +
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
          text: "forward_email: the 'send:email' scope is required to forward messages.",
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
  const fwdParams: ForwardEmailParams = {
    to,
    cc,
    bcc,
    body,
    htmlBody,
    includeAttachments,
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
                `Provider '${inbox.provider}' is not yet supported by forward_email. ` +
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
              "It may have been deleted or moved. Use list_messages or search_emails " +
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
              `Unable to forward via ${inbox.provider}: OAuth token has been ` +
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
    console.error("[mcp-server] forward_email: provider_error", {
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
    result: {
      content: [{ type: "text", text: JSON.stringify(fwdResult) }],
    },
    logStatus: "success",
    logErrorCode: null,
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
              "It may have been deleted or moved. Use list_messages or search_emails " +
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
  // Derive contacts from recipients (fire-and-forget; never blocks the response).
  upsertContacts(
    inbox,
    [...sendResult.to, ...sendResult.cc, ...sendResult.bcc],
    sendResult.sent_at,
  ).catch(() => { /* already logged inside upsertContacts */ });

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
  // Derive contacts from message summaries (fire-and-forget).
  // Each summary carries from + to; use the most-recent date seen per message.
  if (searchResult.messages.length > 0) {
    const allEntries: EmailAddressEntry[] = [];
    for (const msg of searchResult.messages) {
      allEntries.push(msg.from, ...msg.to);
    }
    const latestDate = searchResult.messages.reduce<string>((best, msg) =>
      msg.date > best ? msg.date : best, searchResult.messages[0].date);
    upsertContacts(inbox, allEntries, latestDate)
      .catch(() => { /* already logged inside upsertContacts */ });
  }

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
// Phase 1 — Flags & state tools
//
// Tools: mark_read, mark_unread, flag_email, unflag_email, archive_email
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
// list_folders — provider helpers + handler
// ---------------------------------------------------------------------------

/** Normalized folder/label entry returned by list_folders. */
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
 * Caps STATUS fetches at 50 to prevent timeouts on large accounts.
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
    const toStatus = mailboxes.slice(0, 50);
    const statuses = await Promise.allSettled(
      toStatus.map((mb) => client!.mailboxStatus(mb.name)),
    );
    return toStatus.map((mb, i) => {
      const st = statuses[i];
      return {
        id: mb.name,
        name: mb.name,
        type: "folder" as const,
        total_messages: st.status === "fulfilled" ? st.value.messages : null,
        unread_messages: st.status === "fulfilled" ? st.value.unseen : null,
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
  const labels = (listData.labels ?? []).slice(0, 30);

  const detailResults = await Promise.allSettled(
    labels.map(async (lbl) => {
      const dr = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(lbl.id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!dr.ok) return null;
      return dr.json() as Promise<{ messagesTotal?: number; messagesUnread?: number } | null>;
    }),
  );

  return labels.map((lbl, i) => {
    const detail =
      detailResults[i].status === "fulfilled"
        ? (detailResults[i] as PromiseFulfilledResult<{ messagesTotal?: number; messagesUnread?: number } | null>).value
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

/**
 * `list_folders` handler — dispatches to the appropriate provider helper.
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
          text: "list_folders: arguments must be an object with inbox_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "list_folders: inbox_id is required and must be a UUID string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

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
    console.error("[mcp-server] list_folders: provider_error", {
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
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ inbox_id: inbox.id, folders }, null, 2),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// create_folder / rename_folder / delete_folder — provider helpers + handlers
// ---------------------------------------------------------------------------

// ── create_folder helpers ──────────────────────────────────────────────────

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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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

// ── rename_folder helpers ──────────────────────────────────────────────────

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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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

// ── delete_folder helpers ──────────────────────────────────────────────────

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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      error: {
        result: {
          content: [{ type: "text", text: `${toolName}: inbox_id is required and must be a UUID string.` }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }
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
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      error: {
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
      },
    };
  }
  return { inbox, args };
}

/** Shared auth/provider error handler for folder management tools. */
function folderProviderError(
  toolName: string,
  provider: string,
  err: unknown,
): { result: { content: { type: string; text: string }[]; isError: boolean }; logStatus: "error"; logErrorCode: string } {
  const message = err instanceof Error ? err.message : String(err);
  const isAuth =
    message === "gmail_auth_failed" ||
    message === "outlook_auth_failed" ||
    message === "fastmail_auth_failed" ||
    message === "imap_auth_failed";
  if (isAuth) {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `Unable to access ${provider} inbox: OAuth token has been ` +
            "revoked or expired. The user must reconnect their inbox at " +
            "https://mcpemails.com/dashboard/inboxes.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "auth_failed",
    };
  }
  if (message === "folder_not_found") {
    return {
      result: {
        content: [{
          type: "text",
          text: `Folder not found. Use list_folders to verify the folder_id.`,
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

// ── create_folder handler ──────────────────────────────────────────────────

/**
 * `create_folder` handler — creates a folder/label in an inbox.
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
  const resolved = await resolveFolderArgs(rawArgs, "create_folder", apiKey, false);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  if (!name) {
    return {
      result: {
        content: [{ type: "text", text: "create_folder: name is required and must be a non-empty string." }],
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
    return folderProviderError("create_folder", inbox.provider, err);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({ inbox_id: inbox.id, created }, null, 2),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── rename_folder handler ──────────────────────────────────────────────────

/**
 * `rename_folder` handler — renames a folder/label in an inbox.
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
  const resolved = await resolveFolderArgs(rawArgs, "rename_folder", apiKey, true);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  const folderId = args["folder_id"] as string;
  const newName = typeof args["new_name"] === "string" ? args["new_name"].trim() : "";
  if (!newName) {
    return {
      result: {
        content: [{ type: "text", text: "rename_folder: new_name is required and must be a non-empty string." }],
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
    return folderProviderError("rename_folder", inbox.provider, err);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          inbox_id: inbox.id,
          folder_id: folderId,
          new_name: newName,
          status: "renamed",
        }, null, 2),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── delete_folder handler ──────────────────────────────────────────────────

/**
 * `delete_folder` handler — permanently deletes a folder/label from an inbox.
 *
 * Scope: manage:folders
 * Capability gate: caps.folders || caps.labels
 * Confirm gate: requireConfirm (destructive — irreversible)
 */
async function executeDeleteFolder(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFolderArgs(rawArgs, "delete_folder", apiKey, true);
  if (resolved.error) return resolved.error;
  const { inbox, args } = resolved;

  // ── Confirm gate (destructive) ───────────────────────────────────────────
  const guard = requireConfirm(args);
  if (guard) return guard;

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
    return folderProviderError("delete_folder", inbox.provider, err);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          inbox_id: inbox.id,
          folder_id: folderId,
          status: "deleted",
        }, null, 2),
      }],
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
 * Archives a single IMAP message by moving it to the "Archive" mailbox.
 * Falls back gracefully via uidMove's internal COPY+DELETE fallback.
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
    // "Archive" is the conventional name; uidMove falls back internally if MOVE
    // is unsupported (COPY + \\Deleted + EXPUNGE).
    await client.uidMove([uid], "Archive");
  } catch (err) {
    if (err instanceof ImapAuthError) throw new Error("imap_auth_failed");
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

// ── Gmail provider helpers ─────────────────────────────────────────────────

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
    const body = await resp.text();
    throw new Error(`Gmail modify failed: ${body}`);
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
  const inboxId =
    typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: inbox_id is required and must be a UUID string.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

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

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      error: {
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
      },
    };
  }

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
            `Unable to access ${provider} inbox: OAuth token has been ` +
            "revoked or expired. The user must reconnect their inbox at " +
            "https://mcpemails.com/dashboard/inboxes.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "auth_failed",
    };
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

/** Marks a message as read across all providers. */
async function executeMarkRead(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "mark_read", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.flags) return unsupportedFeatureError("flags", inbox.provider);

  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailModifyLabels(inbox, messageId, [], ["UNREAD"]);
        break;
      case "outlook":
        await outlookPatchMessage(inbox, messageId, { isRead: true });
        break;
      case "fastmail":
        await fastmailSetKeywords(inbox, messageId, { "$seen": true }, {});
        break;
      default: // "imap" and all IMAP service variants
        await imapUpdateFlags(inbox, messageId, ["\\Seen"], "add");
        break;
    }
  } catch (err) {
    return handleFlagError(err, "mark_read", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "mark_read",
    inbox_id: inbox.id,
  };
  return {
    result: { content: [{ type: "text", text: JSON.stringify(flagResult) }], isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

/** Marks a message as unread across all providers. */
async function executeMarkUnread(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "mark_unread", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.flags) return unsupportedFeatureError("flags", inbox.provider);

  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailModifyLabels(inbox, messageId, ["UNREAD"], []);
        break;
      case "outlook":
        await outlookPatchMessage(inbox, messageId, { isRead: false });
        break;
      case "fastmail":
        await fastmailSetKeywords(inbox, messageId, {}, { "$seen": null });
        break;
      default:
        await imapUpdateFlags(inbox, messageId, ["\\Seen"], "remove");
        break;
    }
  } catch (err) {
    return handleFlagError(err, "mark_unread", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "mark_unread",
    inbox_id: inbox.id,
  };
  return {
    result: { content: [{ type: "text", text: JSON.stringify(flagResult) }], isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

/** Flags (stars) a message across all providers. */
async function executeFlagEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "flag_email", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.flags) return unsupportedFeatureError("flags", inbox.provider);

  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailModifyLabels(inbox, messageId, ["STARRED"], []);
        break;
      case "outlook":
        await outlookPatchMessage(inbox, messageId, {
          flag: { flagStatus: "flagged" },
        });
        break;
      case "fastmail":
        await fastmailSetKeywords(inbox, messageId, { "$flagged": true }, {});
        break;
      default:
        await imapUpdateFlags(inbox, messageId, ["\\Flagged"], "add");
        break;
    }
  } catch (err) {
    return handleFlagError(err, "flag_email", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "flag_email",
    inbox_id: inbox.id,
  };
  return {
    result: { content: [{ type: "text", text: JSON.stringify(flagResult) }], isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

/** Removes the flag (star) from a message across all providers. */
async function executeUnflagEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "unflag_email", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.flags) return unsupportedFeatureError("flags", inbox.provider);

  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailModifyLabels(inbox, messageId, [], ["STARRED"]);
        break;
      case "outlook":
        await outlookPatchMessage(inbox, messageId, {
          flag: { flagStatus: "notFlagged" },
        });
        break;
      case "fastmail":
        await fastmailSetKeywords(inbox, messageId, {}, { "$flagged": null });
        break;
      default:
        await imapUpdateFlags(inbox, messageId, ["\\Flagged"], "remove");
        break;
    }
  } catch (err) {
    return handleFlagError(err, "unflag_email", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "unflag_email",
    inbox_id: inbox.id,
  };
  return {
    result: { content: [{ type: "text", text: JSON.stringify(flagResult) }], isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

/** Moves a message to the archive folder across all providers. */
async function executeArchiveEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "archive_email", apiKey);
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
    return handleFlagError(err, "archive_email", inbox.id, inbox.provider, messageId);
  }

  const flagResult: FlagUpdateResult = {
    success: true,
    message_id: messageId,
    operation: "archive_email",
    inbox_id: inbox.id,
  };
  return {
    result: { content: [{ type: "text", text: JSON.stringify(flagResult) }], isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// move_email / copy_email — provider helpers + handlers
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

// ── Gmail helper ─────────────────────────────────────────────────────────────

/**
 * Gmail "move": add the destination label and remove INBOX.
 * Gmail has no native copy operation; copy_email gates on caps.copy=false.
 */
async function gmailMoveEmail(
  inbox: InboxRow,
  messageId: string,
  destinationLabelId: string,
): Promise<void> {
  await gmailModifyLabels(inbox, messageId, [destinationLabelId], ["INBOX"]);
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    const body = await resp.text();
    throw new Error(`Graph move failed: ${body}`);
  }
}

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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("message_not_found");
    const body = await resp.text();
    throw new Error(`Graph copy failed: ${body}`);
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

/**
 * Fastmail "copy": Email/copy JMAP method.
 * Copies the message into the destination mailbox; original is unchanged.
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
          "Email/copy",
          {
            fromAccountId: accountId,
            accountId,
            create: {
              copy1: {
                id: messageId,
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
    throw new Error(`Fastmail JMAP Email/copy failed: ${apiResp.statusText}`);
  }
  const data = (await apiResp.json()) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  };
  const copyResp = data.methodResponses?.find(([n]) => n === "Email/copy");
  const notCreated = (copyResp?.[1] as { notCreated?: Record<string, unknown> } | undefined)?.notCreated;
  if (notCreated?.["copy1"]) throw new Error("message_not_found");
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * `move_email` handler — moves a message to the specified folder/label.
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
  const resolved = await resolveFlagArgs(rawArgs, "move_email", apiKey);
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
          text: "move_email: destination_folder_id is required and must be a non-empty string.",
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

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "gmail":
        await gmailMoveEmail(inbox, messageId, destinationFolderId);
        break;
      case "outlook":
        await outlookMoveEmail(inbox, messageId, destinationFolderId);
        break;
      case "fastmail":
        await fastmailMoveEmail(inbox, messageId, destinationFolderId);
        break;
      default: // imap and all service variants
        await imapMoveEmail(inbox, messageId, destinationFolderId);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "move_email", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message_id: messageId,
          operation: "move_email",
          inbox_id: inbox.id,
          destination_folder_id: destinationFolderId,
        }),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

/**
 * `copy_email` handler — copies a message to the specified folder.
 *
 * Scope: manage:folders
 * Capability gate: caps.copy
 */
async function executeCopyEmail(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  const resolved = await resolveFlagArgs(rawArgs, "copy_email", apiKey);
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
          text: "copy_email: destination_folder_id is required and must be a non-empty string.",
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

  // ── Per-provider dispatch ────────────────────────────────────────────────
  try {
    switch (inbox.provider) {
      case "outlook":
        await outlookCopyEmail(inbox, messageId, destinationFolderId);
        break;
      case "fastmail":
        await fastmailCopyEmail(inbox, messageId, destinationFolderId);
        break;
      default: // imap and all service variants (gmail is gated out by caps.copy=false)
        await imapCopyEmail(inbox, messageId, destinationFolderId);
        break;
    }
  } catch (err) {
    return handleFlagError(err, "copy_email", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message_id: messageId,
          operation: "copy_email",
          inbox_id: inbox.id,
          destination_folder_id: destinationFolderId,
        }),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ── delete_email provider helpers ──────────────────────────────────────────

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
      // Soft-delete: move to Trash (uidMove falls back to COPY+EXPUNGE if needed)
      await client.uidMove([uid], "Trash");
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
    const body = await resp.text();
    throw new Error(`Gmail delete failed: ${body}`);
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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

// ── delete_email top-level handler ────────────────────────────────────────────

/**
 * `delete_email` handler — trashes or permanently expunges a single message.
 *
 * Scope: delete:email
 * Confirm gate: requireConfirm (destructive)
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
  const resolved = await resolveFlagArgs(rawArgs, "delete_email", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageId } = resolved;

  // ── Confirm gate (destructive) ───────────────────────────────────────────
  // rawArgs was validated as a non-null object by resolveFlagArgs above.
  const args = rawArgs as Record<string, unknown>;
  const guard = requireConfirm(args);
  if (guard) return guard;

  // ── Parse permanent flag ──────────────────────────────────────────────────
  const permanent = args["permanent"] === true;

  // ── Capability gate ──────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

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
    return handleFlagError(err, "delete_email", inbox.id, inbox.provider, messageId);
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          message_id: messageId,
          operation: "delete_email",
          inbox_id: inbox.id,
          permanent,
        }),
      }],
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Bulk operation helpers and execute functions
// (Task 11: bulk_move, bulk_delete, bulk_flag)
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

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      error: {
        result: {
          content: [{
            type: "text",
            text: `${toolName}: inbox_id is required and must be a UUID string.`,
          }],
          isError: true,
        },
        logStatus: "error",
        logErrorCode: "-32602",
      },
    };
  }

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

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      error: {
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
      },
    };
  }

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
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          succeeded: succeeded.length,
          failed: failed.length,
          operation,
          inbox_id: inboxId,
          ...extra,
          results,
        }),
      }],
    },
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
        await client.uidMove(uids, "Trash");
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
 * Gmail bulk move: messages.batchModify — adds destination label, removes INBOX.
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailBulkMove(
  inbox: InboxRow,
  messageIds: string[],
  destinationLabelId: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshGmailToken(inbox);
  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: messageIds,
        addLabelIds: [destinationLabelId],
        removeLabelIds: ["INBOX"],
      }),
    },
  );
  if (!resp.ok) {
    const err = resp.status === 401
      ? "gmail_auth_failed"
      : `Gmail batchModify failed: ${resp.status}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }
  return { succeeded: [...messageIds], failed: [] };
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
    // Gmail messages.batchDelete permanently removes all listed messages.
    const resp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchDelete",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: messageIds }),
      },
    );
    if (!resp.ok) {
      const err = resp.status === 401
        ? "gmail_auth_failed"
        : `Gmail batchDelete failed: ${resp.status}`;
      return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
    }
    return { succeeded: [...messageIds], failed: [] };
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
 * Gmail bulk flag: messages.batchModify with appropriate label add/remove.
 * Throws "gmail_auth_failed" on 401.
 */
async function gmailBulkFlag(
  inbox: InboxRow,
  messageIds: string[],
  action: string,
): Promise<BulkOpResult> {
  const accessToken = await withFreshGmailToken(inbox);
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
  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: messageIds, addLabelIds, removeLabelIds }),
    },
  );
  if (!resp.ok) {
    const err = resp.status === 401
      ? "gmail_auth_failed"
      : `Gmail batchModify failed: ${resp.status}`;
    return { succeeded: [], failed: messageIds.map((id) => ({ id, error: err })) };
  }
  return { succeeded: [...messageIds], failed: [] };
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
 * `bulk_move` handler — moves multiple messages to a destination folder.
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
  const resolved = await resolveBulkArgs(rawArgs, "bulk_move", apiKey);
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
          text: "bulk_move: destination_folder_id is required and must be a non-empty string.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkMove(inbox, messageIds, destinationFolderId);
        break;
      case "outlook":
        bulkResult = await outlookBulkMove(inbox, messageIds, destinationFolderId);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkMove(inbox, messageIds, destinationFolderId);
        break;
      default: // imap and all IMAP service variants
        bulkResult = await imapBulkMove(inbox, messageIds, destinationFolderId);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] bulk_move: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during bulk_move: ${message}. Please try again in a moment.`,
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
    "bulk_move",
    inbox.id,
    { destination_folder_id: destinationFolderId },
  );
}

/**
 * `bulk_delete` handler — trashes or permanently expunges multiple messages.
 *
 * Scope: delete:email
 * Confirm gate: requireConfirm (destructive)
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
  const resolved = await resolveBulkArgs(rawArgs, "bulk_delete", apiKey);
  if (resolved.error) return resolved.error;
  const { inbox, messageIds } = resolved;

  if (messageIds.length > MAX_BULK_IDS) return bulkCapError(messageIds.length);

  // rawArgs was validated as a non-null object by resolveBulkArgs above.
  const args = rawArgs as Record<string, unknown>;
  const guard = requireConfirm(args);
  if (guard) return guard;

  const permanent = args["permanent"] === true;

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

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
    console.error("[mcp-server] bulk_delete: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during bulk_delete: ${message}. Please try again in a moment.`,
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
    "bulk_delete",
    inbox.id,
    { permanent },
  );
}

/**
 * `bulk_flag` handler — applies a read/unread/flag/unflag action to multiple messages.
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
  const resolved = await resolveBulkArgs(rawArgs, "bulk_flag", apiKey);
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
          text: "bulk_flag: action must be one of: read, unread, flag, unflag.",
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
    console.error("[mcp-server] bulk_flag: provider_error", {
      inbox_id: inbox.id,
      provider: inbox.provider,
      error: message,
    });
    return {
      result: {
        content: [{
          type: "text",
          text: `Provider error during bulk_flag: ${message}. Please try again in a moment.`,
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
    "bulk_flag",
    inbox.id,
    { action },
  );
}

// ---------------------------------------------------------------------------
// Phase 3 (cont.) — Search-and-act tools
//
// Tools: search_and_move, search_and_delete
//
// Both run the provider search on the server and apply the bulk operation to
// the results, avoiding stale IDs being passed by the agent.
// ---------------------------------------------------------------------------

/**
 * `search_and_move` handler — searches for messages and moves all matches to a folder.
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
          text: "search_and_move: arguments must be an object with inbox_id, query, and destination_folder_id.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{ type: "text", text: "search_and_move: inbox_id is required and must be a UUID string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (!query) {
    return {
      result: {
        content: [{ type: "text", text: "search_and_move: query is required and must be a non-empty string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const destinationFolderId =
    typeof args["destination_folder_id"] === "string"
      ? args["destination_folder_id"].trim()
      : "";
  if (!destinationFolderId) {
    return {
      result: {
        content: [{
          type: "text",
          text: "search_and_move: destination_folder_id is required and must be a non-empty string.",
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

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.move) return unsupportedFeatureError("move", inbox.provider);

  // ── Run search to collect message IDs ─────────────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("search_timeout")), SEARCH_TIMEOUT_MS)
  );

  let searchResult: SearchEmailsResult;
  try {
    let searchPromise: Promise<SearchEmailsResult>;
    switch (inbox.provider) {
      case "gmail":
        searchPromise = searchGmailMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "imap":
        searchPromise = searchImapMessages(inbox, query, limit, 0, includeFolders);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by search_and_move. ` +
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
    console.error("[mcp-server] search_and_move: search_error", {
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
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            succeeded: 0,
            failed: 0,
            operation: "search_and_move",
            inbox_id: inboxId,
            destination_folder_id: destinationFolderId,
            query,
            results: [],
          }),
        }],
      },
      logStatus: "success",
      logErrorCode: null,
    };
  }

  // ── Apply bulk move to search results ─────────────────────────────────────
  let bulkResult: BulkOpResult;
  try {
    switch (inbox.provider) {
      case "gmail":
        bulkResult = await gmailBulkMove(inbox, messageIds, destinationFolderId);
        break;
      case "outlook":
        bulkResult = await outlookBulkMove(inbox, messageIds, destinationFolderId);
        break;
      case "fastmail":
        bulkResult = await fastmailBulkMove(inbox, messageIds, destinationFolderId);
        break;
      default: // imap
        bulkResult = await imapBulkMove(inbox, messageIds, destinationFolderId);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mcp-server] search_and_move: move_error", {
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
    "search_and_move",
    inbox.id,
    { destination_folder_id: destinationFolderId, query },
  );
}

/**
 * `search_and_delete` handler — searches for messages and deletes all matches.
 *
 * Scope: delete:email
 * Confirm gate: requireConfirm (destructive)
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
          text: "search_and_delete: arguments must be an object with inbox_id, query, and confirm.",
        }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const args = rawArgs as Record<string, unknown>;

  const guard = requireConfirm(args);
  if (guard) return guard;

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: {
        content: [{ type: "text", text: "search_and_delete: inbox_id is required and must be a UUID string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (!query) {
    return {
      result: {
        content: [{ type: "text", text: "search_and_delete: query is required and must be a non-empty string." }],
        isError: true,
      },
      logStatus: "error",
      logErrorCode: "-32602",
    };
  }

  const permanent = args["permanent"] === true;
  const limit = Math.min(
    Math.max(1, typeof args["limit"] === "number" ? Math.floor(args["limit"]) : MAX_BULK_IDS),
    MAX_BULK_IDS,
  );
  const includeFolders: string[] = Array.isArray(args["include_folders"])
    ? (args["include_folders"] as unknown[])
        .filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

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

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.delete) return unsupportedFeatureError("delete", inbox.provider);

  // ── Run search to collect message IDs ─────────────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("search_timeout")), SEARCH_TIMEOUT_MS)
  );

  let searchResult: SearchEmailsResult;
  try {
    let searchPromise: Promise<SearchEmailsResult>;
    switch (inbox.provider) {
      case "gmail":
        searchPromise = searchGmailMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "outlook":
        searchPromise = searchOutlookMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "fastmail":
        searchPromise = searchFastmailMessages(inbox, query, limit, 0, includeFolders);
        break;
      case "imap":
        searchPromise = searchImapMessages(inbox, query, limit, 0, includeFolders);
        break;
      default:
        return {
          result: {
            content: [{
              type: "text",
              text:
                `Provider '${inbox.provider}' is not yet supported by search_and_delete. ` +
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
    console.error("[mcp-server] search_and_delete: search_error", {
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
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            succeeded: 0,
            failed: 0,
            operation: "search_and_delete",
            inbox_id: inboxId,
            permanent,
            query,
            results: [],
          }),
        }],
      },
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
    console.error("[mcp-server] search_and_delete: delete_error", {
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
    "search_and_delete",
    inbox.id,
    { permanent, query },
  );
}

// ---------------------------------------------------------------------------
// create_draft / update_draft / list_drafts / send_draft — types + helpers
// ---------------------------------------------------------------------------

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

interface DraftParams {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody?: string;
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
      subject: s.envelope.subject || "(no subject)",
      to: s.envelope.to.map((a) => ({ name: a.name, email: a.email })),
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

    // Append the updated draft.
    let newUid: number | undefined;
    const res = await client.appendWithFlags(folder, mime, ["\\Draft", "\\Seen"]);
    if (res.ok) {
      newUid = res.uid;
    }
    if (newUid === undefined) {
      await client.selectMailbox(imapFolderName(folder));
      const found = await client.uidSearch(
        `HEADER Message-ID "<${messageId}@mcpemails.com>"`,
      );
      newUid = found.length > 0 ? found[found.length - 1] : 0;
    }

    // Delete the old draft.
    await client.selectMailbox(imapFolderName(folder));
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

  // Step 3: Send via SMTP.
  await imapSmtpSend(inbox, rawMime, recipients);

  // Step 4: Append to Sent folder (best-effort).
  await appendToSentFolder(inbox, rawMime);

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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
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
    if (resp.status === 401) throw new Error("outlook_auth_failed");
    if (resp.status === 404) throw new Error("draft_not_found");
    throw new Error(`Outlook send draft error: ${resp.statusText}`);
  }
  return {
    draft_id: draftId,
    message_id: draftId,
    sent_at: new Date().toISOString(),
  };
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
      result: { content: [{ type: "text", text: "list_drafts: arguments must be an object with inbox_id." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "list_drafts: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const limit = typeof args["limit"] === "number"
    ? Math.min(50, Math.max(1, Math.floor(args["limit"])))
    : 20;

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key. Verify the inbox UUID in the MCPEmails dashboard.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

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
      return {
        result: { content: [{ type: "text", text: `Unable to access ${inbox.provider} inbox: OAuth token has been revoked or expired. The user must reconnect their inbox at https://mcpemails.com/dashboard/inboxes.` }], isError: true },
        logStatus: "error", logErrorCode: "auth_failed",
      };
    }
    console.error("[mcp-server] list_drafts: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to list drafts for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: { content: [{ type: "text", text: JSON.stringify({ inbox_id: inbox.id, drafts }, null, 2) }] },
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
      result: { content: [{ type: "text", text: "create_draft: arguments must be an object with inbox_id, subject, and body." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "create_draft: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const subject = typeof args["subject"] === "string" && args["subject"].length > 0
    ? args["subject"] : null;
  if (!subject) {
    return {
      result: { content: [{ type: "text", text: "create_draft: subject is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const body = typeof args["body"] === "string" && args["body"].length > 0
    ? args["body"] : null;
  if (!body) {
    return {
      result: { content: [{ type: "text", text: "create_draft: body is required and must be a non-empty string." }], isError: true },
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
        result: { content: [{ type: "text", text: `create_draft: invalid email address: "${String(addr)}".` }], isError: true },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key. Verify the inbox UUID in the MCPEmails dashboard.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  const draftParams: DraftParams = { to, cc, bcc, subject, body, htmlBody };
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
      return {
        result: { content: [{ type: "text", text: `Unable to access ${inbox.provider} inbox: OAuth token has been revoked or expired. The user must reconnect their inbox at https://mcpemails.com/dashboard/inboxes.` }], isError: true },
        logStatus: "error", logErrorCode: "auth_failed",
      };
    }
    console.error("[mcp-server] create_draft: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to create draft for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: { content: [{ type: "text", text: JSON.stringify(draftResult) }] },
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
      result: { content: [{ type: "text", text: "update_draft: arguments must be an object with inbox_id, draft_id, subject, and body." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "update_draft: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const draftId = typeof args["draft_id"] === "string" && args["draft_id"].length > 0
    ? args["draft_id"] : null;
  if (!draftId) {
    return {
      result: { content: [{ type: "text", text: "update_draft: draft_id is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const subject = typeof args["subject"] === "string" && args["subject"].length > 0
    ? args["subject"] : null;
  if (!subject) {
    return {
      result: { content: [{ type: "text", text: "update_draft: subject is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const body = typeof args["body"] === "string" && args["body"].length > 0
    ? args["body"] : null;
  if (!body) {
    return {
      result: { content: [{ type: "text", text: "update_draft: body is required and must be a non-empty string." }], isError: true },
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
        result: { content: [{ type: "text", text: `update_draft: invalid email address: "${String(addr)}".` }], isError: true },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key. Verify the inbox UUID in the MCPEmails dashboard.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

  const draftParams: DraftParams = { to, cc, bcc, subject, body, htmlBody };
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
        result: { content: [{ type: "text", text: `Draft ${draftId} not found. Use list_drafts to see available draft IDs.` }], isError: true },
        logStatus: "error", logErrorCode: "draft_not_found",
      };
    }
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return {
        result: { content: [{ type: "text", text: `Unable to access ${inbox.provider} inbox: OAuth token has been revoked or expired. The user must reconnect their inbox at https://mcpemails.com/dashboard/inboxes.` }], isError: true },
        logStatus: "error", logErrorCode: "auth_failed",
      };
    }
    console.error("[mcp-server] update_draft: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: { content: [{ type: "text", text: `Failed to update draft for ${inbox.provider} inbox: ${message}` }], isError: true },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: { content: [{ type: "text", text: JSON.stringify(updateResult) }] },
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
      result: { content: [{ type: "text", text: "send_draft: arguments must be an object with inbox_id and draft_id." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "send_draft: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const draftId = typeof args["draft_id"] === "string" && args["draft_id"].length > 0
    ? args["draft_id"] : null;
  if (!draftId) {
    return {
      result: { content: [{ type: "text", text: "send_draft: draft_id is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key. Verify the inbox UUID in the MCPEmails dashboard.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

  const caps = getProviderCapabilities(inbox.provider);
  if (!caps.drafts) return unsupportedFeatureError("drafts", inbox.provider);

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
        result: { content: [{ type: "text", text: `Draft ${draftId} not found. Use list_drafts to see available draft IDs.` }], isError: true },
        logStatus: "error", logErrorCode: "draft_not_found",
      };
    }
    if (message === "draft_has_no_recipients") {
      return {
        result: { content: [{ type: "text", text: "send_draft: the draft has no recipients. Add at least one To address via update_draft before sending." }], isError: true },
        logStatus: "error", logErrorCode: "draft_has_no_recipients",
      };
    }
    const isAuth = message === "gmail_auth_failed" || message === "outlook_auth_failed" ||
      message === "fastmail_auth_failed" || message === "imap_auth_failed";
    if (isAuth) {
      return {
        result: { content: [{ type: "text", text: `Unable to access ${inbox.provider} inbox: OAuth token has been revoked or expired. The user must reconnect their inbox at https://mcpemails.com/dashboard/inboxes.` }], isError: true },
        logStatus: "error", logErrorCode: "auth_failed",
      };
    }
    if (message === "quota_exceeded") {
      return {
        result: { content: [{ type: "text", text: "Your email account has exceeded its sending quota. Please try again later." }], isError: true },
        logStatus: "error", logErrorCode: "quota_exceeded",
      };
    }
    console.error("[mcp-server] send_draft: provider_error", { inbox_id: inbox.id, provider: inbox.provider, error: message });
    return {
      result: {
        content: [{ type: "text", text: `An error occurred while sending the draft via ${inbox.provider}. The message may or may not have been delivered. Do not retry automatically to avoid duplicate delivery.` }],
        isError: true,
      },
      logStatus: "error", logErrorCode: "provider_error",
    };
  }

  return {
    result: { content: [{ type: "text", text: JSON.stringify(sendResult) }] },
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Contacts tools — Phase 6
// ---------------------------------------------------------------------------

/**
 * `search_contacts` — search the derived contacts table by name or email.
 *
 * Scope: manage:contacts
 * Required params: query (string)
 * Optional params: inbox_id (UUID), limit (integer 1–50, default 20)
 *
 * Searches both email_address and display_name case-insensitively.
 * When inbox_id is provided the search is scoped to that inbox; otherwise
 * it spans all inboxes the API key can access within the workspace.
 * Results are sorted by last_contacted_at DESC (most-recently-seen first).
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
      result: { content: [{ type: "text", text: "search_contacts: arguments must be an object with a query field." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const query = typeof args["query"] === "string" && args["query"].length > 0
    ? args["query"] : null;
  if (!query) {
    return {
      result: { content: [{ type: "text", text: "search_contacts: query is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  const limit = typeof args["limit"] === "number"
    ? Math.min(50, Math.max(1, Math.floor(args["limit"])))
    : 20;

  // If an inbox_id was supplied, validate it is accessible to this API key.
  if (inboxId) {
    const inbox = await resolveInbox(inboxId, apiKey);
    if (!inbox) {
      return {
        result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key.` }], isError: true },
        logStatus: "error", logErrorCode: "inbox_not_found",
      };
    }
  }

  // Build the Supabase query.  Both email_address and display_name are searched
  // with ILIKE so the match is case-insensitive on the DB side.
  // Filters are applied before transforms (.order, .limit) to stay within
  // PostgrestFilterBuilder's type surface.
  const pattern = `%${query}%`;
  let dbQuery = supabase
    .from("contacts")
    .select("id, inbox_id, email_address, display_name, message_count, last_contacted_at")
    .eq("workspace_id", apiKey.workspace_id)
    .is("deleted_at", null)
    .or(`email_address.ilike.${pattern},display_name.ilike.${pattern}`);

  // Narrow to a specific inbox when one was requested.
  if (inboxId) {
    dbQuery = dbQuery.eq("inbox_id", inboxId);
  } else if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0) {
    // API key scoped to specific inboxes — honour that restriction.
    dbQuery = dbQuery.in("inbox_id", apiKey.inbox_ids);
  }

  const { data, error } = await dbQuery
    .order("last_contacted_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[mcp-server] search_contacts: db_error", {
      workspace_id: apiKey.workspace_id,
      error: error.message,
    });
    return {
      result: { content: [{ type: "text", text: "search_contacts: database error while querying contacts." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  const contacts = (data ?? []).map((row: {
    id: string;
    inbox_id: string;
    email_address: string;
    display_name: string | null;
    message_count: number;
    last_contacted_at: string;
  }) => ({
    id: row.id,
    inbox_id: row.inbox_id,
    email_address: row.email_address,
    display_name: row.display_name ?? null,
    message_count: row.message_count,
    last_contacted_at: row.last_contacted_at,
  }));

  return {
    result: { content: [{ type: "text", text: JSON.stringify({ query, contacts, total: contacts.length }, null, 2) }] },
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `get_contact` — retrieve a single contact record by inbox + email address.
 *
 * Scope: manage:contacts
 * Required params: inbox_id (UUID), email_address (string)
 *
 * Returns the contact's full record including message_count and
 * last_contacted_at.  The email_address is normalised to lowercase before
 * querying so matches are case-insensitive.
 */
async function executeGetContact(
  rawArgs: unknown,
  apiKey: ApiKeyRow,
): Promise<{
  result: { content: { type: string; text: string }[]; isError?: boolean };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return {
      result: { content: [{ type: "text", text: "get_contact: arguments must be an object with inbox_id and email_address." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "get_contact: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  const rawEmail = typeof args["email_address"] === "string" ? args["email_address"].trim() : null;
  if (!rawEmail) {
    return {
      result: { content: [{ type: "text", text: "get_contact: email_address is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const emailAddress = rawEmail.toLowerCase();

  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

  const { data, error } = await supabase
    .from("contacts")
    .select("id, inbox_id, email_address, display_name, message_count, last_contacted_at, created_at, updated_at")
    .eq("inbox_id", inbox.id)
    .eq("email_address", emailAddress)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error("[mcp-server] get_contact: db_error", {
      inbox_id: inbox.id,
      email_address: emailAddress,
      error: error.message,
    });
    return {
      result: { content: [{ type: "text", text: "get_contact: database error while querying contacts." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  if (!data) {
    return {
      result: { content: [{ type: "text", text: JSON.stringify({ found: false, inbox_id: inbox.id, email_address: emailAddress }) }] },
      logStatus: "success", logErrorCode: null,
    };
  }

  const contact = data as {
    id: string;
    inbox_id: string;
    email_address: string;
    display_name: string | null;
    message_count: number;
    last_contacted_at: string;
    created_at: string;
    updated_at: string;
  };

  return {
    result: { content: [{ type: "text", text: JSON.stringify({ found: true, contact }, null, 2) }] },
    logStatus: "success", logErrorCode: null,
  };
}

// ---------------------------------------------------------------------------
// Scheduling tools — Phase 7
// ---------------------------------------------------------------------------

/**
 * `schedule_send` — insert a future-delivery row into scheduled_sends.
 *
 * Scope: schedule:email
 * Required params: inbox_id (UUID), to (string[]), subject, body, send_at (ISO 8601)
 * Optional params: cc, bcc, html_body, attachments, reply_to
 *
 * Validates all inputs using the same rules as send_email, then inserts a
 * scheduled_sends row with the full send_email payload stored as JSONB.
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
      result: { content: [{ type: "text", text: "schedule_send: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  // inbox_id (required)
  const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
  if (!inboxId) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: inbox_id is required and must be a UUID string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }

  // to (required, non-empty array, max 50)
  const toRaw = args["to"];
  if (!Array.isArray(toRaw) || toRaw.length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: to is required and must be a non-empty array of email address strings." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (toRaw.length > 50) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: to must not exceed 50 recipients." }], isError: true },
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
      result: { content: [{ type: "text", text: "schedule_send: subject is required and must be a non-empty string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (subjectRaw.length > 998) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: subject must not exceed 998 characters." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const subject = subjectRaw;

  // body (required)
  const bodyRaw = args["body"];
  if (typeof bodyRaw !== "string" || bodyRaw.trim().length === 0) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: body is required and must be a non-empty string." }], isError: true },
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
        result: { content: [{ type: "text", text: "schedule_send: attachments must not exceed 20 items." }], isError: true },
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
          result: { content: [{ type: "text", text: "schedule_send: each attachment must have filename, mime_type, and data fields." }], isError: true },
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
      result: { content: [{ type: "text", text: "schedule_send: send_at is required and must be an ISO 8601 datetime string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const sendAtMs = Date.parse(sendAtRaw);
  if (isNaN(sendAtMs)) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: send_at is not a valid ISO 8601 datetime string." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  if (sendAtMs <= Date.now()) {
    return {
      result: { content: [{ type: "text", text: "schedule_send: send_at must be in the future." }], isError: true },
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
          content: [{ type: "text", text: `schedule_send: invalid email address in '${field}': "${String(addr)}".` }],
          isError: true,
        },
        logStatus: "error", logErrorCode: "invalid_recipient",
      };
    }
  }

  // ── Inbox resolution + access control ─────────────────────────────────────
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return {
      result: { content: [{ type: "text", text: `Inbox ${inboxId} not found or not accessible to this API key.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
    };
  }

  // ── Capability check ───────────────────────────────────────────────────────
  const caps = getProviderCapabilities(inbox.provider, inbox.service ?? undefined);
  if (!caps.scheduling) {
    return unsupportedFeatureError("scheduling", inbox.provider);
  }

  // ── Build payload (mirrors send_email args, stored as JSONB for dispatcher) ─
  const payload: Record<string, unknown> = { to, cc, bcc, subject, body };
  if (htmlBody !== undefined) payload["html_body"] = htmlBody;
  if (attachments.length > 0) payload["attachments"] = attachments;
  if (replyTo !== undefined) payload["reply_to"] = replyTo;

  // ── Insert into scheduled_sends ────────────────────────────────────────────
  const { data: row, error: insertErr } = await supabase
    .from("scheduled_sends")
    .insert({
      workspace_id: apiKey.workspace_id,
      inbox_id: inbox.id,
      payload,
      send_at: sendAt,
      status: "pending",
    })
    .select("id, inbox_id, send_at, status, created_at")
    .single();

  if (insertErr) {
    console.error("[mcp-server] schedule_send: insert_error", {
      workspace_id: apiKey.workspace_id,
      inbox_id: inbox.id,
      error: insertErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "schedule_send: database error while scheduling the send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  const created = row as { id: string; inbox_id: string; send_at: string; status: string; created_at: string };
  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          scheduled: true,
          id: created.id,
          inbox_id: created.inbox_id,
          to,
          subject,
          send_at: created.send_at,
          status: created.status,
          created_at: created.created_at,
        }, null, 2),
      }],
    },
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `list_scheduled` — list pending scheduled sends for the workspace.
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
      result: { content: [{ type: "text", text: "list_scheduled: arguments must be an object." }], isError: true },
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
    .select("id, inbox_id, payload, send_at, status, created_at")
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
    console.error("[mcp-server] list_scheduled: db_error", {
      workspace_id: apiKey.workspace_id,
      error: error.message,
    });
    return {
      result: { content: [{ type: "text", text: "list_scheduled: database error while listing scheduled sends." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  const rows = (data ?? []).map((row: {
    id: string;
    inbox_id: string;
    payload: Record<string, unknown>;
    send_at: string;
    status: string;
    created_at: string;
  }) => ({
    id: row.id,
    inbox_id: row.inbox_id,
    send_at: row.send_at,
    status: row.status,
    created_at: row.created_at,
    // Payload summary: expose to + subject without the full body/attachments.
    to: Array.isArray(row.payload["to"]) ? row.payload["to"] : [],
    subject: typeof row.payload["subject"] === "string" ? row.payload["subject"] : "",
  }));

  return {
    result: {
      content: [{ type: "text", text: JSON.stringify({ scheduled_sends: rows, total: rows.length }, null, 2) }],
    },
    logStatus: "success", logErrorCode: null,
  };
}

/**
 * `cancel_scheduled` — set status='cancelled' on a pending scheduled send.
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
      result: { content: [{ type: "text", text: "cancel_scheduled: arguments must be an object." }], isError: true },
      logStatus: "error", logErrorCode: "-32602",
    };
  }
  const args = rawArgs as Record<string, unknown>;

  const scheduledSendId = typeof args["scheduled_send_id"] === "string" ? args["scheduled_send_id"] : null;
  if (!scheduledSendId) {
    return {
      result: { content: [{ type: "text", text: "cancel_scheduled: scheduled_send_id is required and must be a UUID string." }], isError: true },
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
    console.error("[mcp-server] cancel_scheduled: db_error", {
      id: scheduledSendId,
      error: fetchErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "cancel_scheduled: database error while fetching the scheduled send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  if (!existing) {
    return {
      result: { content: [{ type: "text", text: `cancel_scheduled: scheduled send ${scheduledSendId} not found or not accessible.` }], isError: true },
      logStatus: "error", logErrorCode: "not_found",
    };
  }

  const row = existing as { id: string; inbox_id: string; status: string; send_at: string };

  if (row.status !== "pending") {
    return {
      result: {
        content: [{
          type: "text",
          text:
            `cancel_scheduled: cannot cancel scheduled send ${scheduledSendId} — ` +
            `current status is '${row.status}'. Only 'pending' sends can be cancelled.`,
        }],
        isError: true,
      },
      logStatus: "error", logErrorCode: "not_cancellable",
    };
  }

  // Honour API key inbox restriction.
  if (apiKey.inbox_ids !== null && apiKey.inbox_ids.length > 0 && !apiKey.inbox_ids.includes(row.inbox_id)) {
    return {
      result: { content: [{ type: "text", text: `cancel_scheduled: scheduled send ${scheduledSendId} is not accessible to this API key.` }], isError: true },
      logStatus: "error", logErrorCode: "inbox_not_found",
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
    console.error("[mcp-server] cancel_scheduled: update_error", {
      id: scheduledSendId,
      error: updateErr.message,
    });
    return {
      result: { content: [{ type: "text", text: "cancel_scheduled: database error while cancelling the scheduled send." }], isError: true },
      logStatus: "error", logErrorCode: "db_error",
    };
  }

  return {
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          cancelled: true,
          id: row.id,
          inbox_id: row.inbox_id,
          send_at: row.send_at,
          previous_status: "pending",
        }, null, 2),
      }],
    },
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
  // An API key with only read:email will see list_messages, read_email, search_emails.
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
  // Tool implementations (list_messages, read_email, etc.) are added in the
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
    } else if (toolName === "list_messages") {
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
    } else if (toolName === "mark_read") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeMarkRead(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "mark_unread") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeMarkUnread(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "flag_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeFlagEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "unflag_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeUnflagEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "archive_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeArchiveEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "list_folders") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListFolders(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "create_folder") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCreateFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "rename_folder") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeRenameFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "delete_folder") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeDeleteFolder(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "move_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeMoveEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "copy_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCopyEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "delete_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeDeleteEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "bulk_move") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkMove(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "bulk_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkDelete(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "bulk_flag") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeBulkFlag(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "search_and_move") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchAndMove(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "search_and_delete") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchAndDelete(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "forward_email") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeForwardEmail(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "list_drafts") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListDrafts(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "create_draft") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCreateDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "update_draft") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeUpdateDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "send_draft") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSendDraft(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "search_contacts") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeSearchContacts(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "get_contact") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeGetContact(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "schedule_send") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeScheduleSend(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "list_scheduled") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeListScheduled(rawArgs, apiKey);
      logStatus = ls;
      logErrorCode = lec;
      toolResult = { jsonrpc: "2.0", id, result };
    } else if (toolName === "cancel_scheduled") {
      const { result, logStatus: ls, logErrorCode: lec } =
        await executeCancelScheduled(rawArgs, apiKey);
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
//
// See migration 20260603000001_create_scheduled_sends.sql for table schema,
// RLS policies, and pg_cron setup instructions.
// ---------------------------------------------------------------------------

const MAX_DISPATCH_BATCH = 50;

async function handleScheduledDispatch(): Promise<Response> {
  const now = new Date().toISOString();

  // Fetch pending rows due for sending, ordered by send_at ASC so the
  // oldest-due messages are dispatched first.
  const { data: rows, error: fetchErr } = await supabase
    .from("scheduled_sends")
    .select("id, inbox_id, payload")
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
    const { error: lockErr } = await supabase
      .from("scheduled_sends")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending"); // only transitions from pending

    if (lockErr) {
      // Another worker beat us to it — skip silently.
      console.warn(`[dispatch] Could not lock row ${row.id}:`, lockErr.message);
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
      const payload = (row.payload ?? {}) as Record<string, unknown>;
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
