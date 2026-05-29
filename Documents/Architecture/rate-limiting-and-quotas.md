# Rate Limiting and Quotas

## 1. Overview

MCPEmails operates two independent layers of rate limiting. Understanding both is essential for building reliable integrations.

**Layer 1 — MCPEmails own limits.** Every API key is subject to per-minute, per-hour, and per-day call quotas enforced inside the MCP Edge Function before any provider request is made. A request that exceeds these limits never reaches Gmail, Outlook, or Fastmail. This protects the platform from abuse and ensures fair resource distribution across tenants.

**Layer 2 — Upstream provider limits.** Even when a request clears MCPEmails own limits, the underlying email provider enforces its own quotas. Gmail, Outlook Graph, and Fastmail all have distinct rate limit regimes. MCPEmails shields callers from most upstream 429s through transparent retry-with-backoff, but callers may still see provider errors when limits are sustained over a long period.

The two layers are additive: a caller must stay within MCPEmails limits *and* within provider limits. MCPEmails limits are generally loose enough that a well-behaved agent will hit provider limits first only in pathological scenarios (e.g., bulk-reading an entire inbox in a tight loop).

---

## 2. MCPEmails Per-Key Limits

Limits apply independently to each API key. A user with two keys gets two independent budgets; keys do not share a pool.

| Window | Limit | Enforcement point |
|--------|-------|-------------------|
| 1 minute (rolling) | 100 calls | Edge Function middleware |
| 1 hour (rolling) | 1,000 calls | Edge Function middleware |
| 1 day (rolling) | 10,000 calls | Edge Function middleware |

Additional resource limits that count against call budget:

| Resource | Limit | Reason |
|----------|-------|--------|
| Message payload size | 10 MB | Memory safety in Edge runtime |
| Attachments per email | 20 | Performance |
| Search results per page | 100 | Prevents oversized responses |

All three time-window checks run in sequence on every inbound request. The most restrictive window that is currently saturated determines the `Retry-After` value returned to the caller.

---

## 3. Rate Limit Implementation

Rate limiting runs inside the Supabase Edge Function that handles MCP traffic. The implementation uses the existing `usage_logs` table, which is written on every successful tool call for audit purposes, as the source of truth for counting recent calls.

### Why the `usage_logs` table, not a dedicated counter table

A dedicated `rate_limit_counters` table with pre-aggregated sliding window buckets would have lower query latency (~1 ms vs ~5 ms), but it introduces a dual-write problem: the counter and the log must be updated atomically, or a crash between the two leaves them inconsistent. Because MCPEmails already writes `usage_logs` as the audit record, a count query against that table is the single-write approach. The latency difference is acceptable in the Edge Function context (total request budget is ~500 ms).

A migration path to a Redis-based counter is described in Section 10.

### Edge Function middleware order

```
Inbound request
  │
  ▼
1. Parse Authorization header → resolve api_key_id
2. Validate API key (signature check, revoked flag)          ← fail fast: 401
3. Rate limit check (rolling window counts)                  ← fail fast: 429
4. Per-plan per-minute ceiling (fair-use burst limit)        ← fail fast: 429
5. Route to tool handler (list_inbox, send_email, etc.)
6. Write usage_log row (async, after response sent)
```

Step 6 is fire-and-forget after the response is already flushed. This keeps the log write off the critical path but means the count for the current request is not reflected until the *next* request. In practice this allows a brief overshoot of 1 call per concurrent request; this is an accepted trade-off. Under sustained load the window fills up correctly.

---

## 4. Rolling Window Algorithm

Each window (1 min, 1 hr, 1 day) is checked with a single parameterized query against `usage_logs`. The "rolling" semantics mean the window is always anchored to `now() - interval`, not to a fixed clock boundary (e.g., top-of-the-minute). This avoids the thundering-herd problem where all keys reset simultaneously at :00.

```typescript
// src/lib/rate-limit.ts

interface WindowDefinition {
  label: string;
  intervalMs: number;
  limit: number;
}

const WINDOWS: WindowDefinition[] = [
  { label: "per_minute", intervalMs: 60_000,       limit: 100   },
  { label: "per_hour",   intervalMs: 3_600_000,    limit: 1_000 },
  { label: "per_day",    intervalMs: 86_400_000,   limit: 10_000 },
];

interface RateLimitResult {
  allowed: boolean;
  windowLabel: string;
  limit: number;
  used: number;
  retryAfterSeconds: number;
}

async function checkRateLimit(
  supabase: SupabaseClient,
  apiKeyId: string
): Promise<RateLimitResult> {
  for (const window of WINDOWS) {
    const windowStart = new Date(Date.now() - window.intervalMs).toISOString();

    const { count, error } = await supabase
      .from("usage_logs")
      .select("*", { count: "exact", head: true })
      .eq("api_key_id", apiKeyId)
      .gte("created_at", windowStart);

    if (error) {
      // Fail open: if we cannot count, let the request through.
      // Monitoring alerts on repeated DB errors separately.
      console.error("rate_limit_db_error", { window: window.label, error });
      continue;
    }

    const used = count ?? 0;

    if (used >= window.limit) {
      // Find the oldest log in this window to compute exact retry delay.
      const { data: oldest } = await supabase
        .from("usage_logs")
        .select("created_at")
        .eq("api_key_id", apiKeyId)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: true })
        .limit(1)
        .single();

      const oldestTs = oldest?.created_at
        ? new Date(oldest.created_at).getTime()
        : Date.now() - window.intervalMs;

      // The window will have room again when the oldest entry falls out.
      const windowExpiresAt = oldestTs + window.intervalMs;
      const retryAfterSeconds = Math.ceil((windowExpiresAt - Date.now()) / 1000);

      return {
        allowed: false,
        windowLabel: window.label,
        limit: window.limit,
        used,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
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
```

The `head: true` flag tells PostgREST to run a `COUNT(*)` query and return only the count, not rows. This keeps the payload tiny and avoids transferring log data across the wire.

---

## 5. Plan-Based Rate Ceiling

Usage is **unlimited on every tier** — there is no daily or monthly call cap, and no cap on connected inboxes, API keys, or team members. The only plan-based usage lever is a per-plan **per-minute request ceiling**: a fair-use burst limit checked after the per-key rolling-window guard (Section 4).

| Plan | Per-minute ceiling | Notes |
|------|--------------------|-------|
| Free | 60 req/min | Generous enough that virtually no legitimate user hits it |
| Solo | 300 req/min | For power users running agents around the clock |
| Team | 1,000 req/min | Practically limitless for businesses |

The ceiling is enforced **per workspace** (aggregated across all of the workspace's API keys), so adding keys does not multiply throughput. A removed legacy `enterprise` plan value is treated as the Team ceiling.

### How the ceiling is resolved

The Edge Function reads `workspaces.plan` for the request's workspace and looks up the ceiling in `PLAN_REQUESTS_PER_MINUTE` (keyed by `free` / `solo` / `pro`). Unknown plan values fall back to the Free ceiling.

```typescript
const { data: workspace } = await supabase
  .from("workspaces")
  .select("plan")
  .eq("id", workspaceId)
  .maybeSingle();

const plan = (workspace?.plan as string) ?? "free";
const perMinuteLimit =
  PLAN_REQUESTS_PER_MINUTE[plan] ?? DEFAULT_REQUESTS_PER_MINUTE;
```

The ceiling uses a rolling 60-second window: the Edge Function counts the workspace's `activity_log` rows in the trailing minute and rejects the request (HTTP 429, `error_code: "rate_limit_exceeded"`, `window: "per_minute"`) once the count reaches the ceiling. `Retry-After` is computed from when the oldest call in the window expires. Fail-open: any DB error allows the request through.

---

## 6. 429 Response Format

When a rate limit or quota check fails, the Edge Function returns an HTTP 429 with:

- A JSON-RPC 2.0 error body (MCPEmails uses JSON-RPC framing for all MCP responses)
- A `Retry-After` header set to the exact number of seconds the caller should wait
- A `X-RateLimit-Limit` and `X-RateLimit-Remaining` header pair for the tightest window

```typescript
// src/lib/rate-limit-response.ts

function buildRateLimitResponse(result: RateLimitResult): Response {
  const body = {
    jsonrpc: "2.0",
    id: null,               // populated from request id by caller
    error: {
      code: -32029,         // JSON-RPC application-level error code for rate limit
      message: "Rate limit exceeded",
      data: {
        error_code: "rate_limit_exceeded",
        window: result.windowLabel,
        limit: result.limit,
        used: result.used,
        retry_after: result.retryAfterSeconds,
        human_message: `You have exceeded the ${result.windowLabel.replace("_", " ")} limit of ${result.limit} calls. ` +
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
    },
  });
}
```

The JSON-RPC error code `-32029` is in the application-defined range (`-32099` to `-32000`). Callers should branch on `data.error_code === "rate_limit_exceeded"` rather than the numeric code, which may change.

When the per-plan per-minute ceiling is hit, the `error_code` is `rate_limit_exceeded` with `window: "per_minute"`, and the `human_message` explains the ceiling and links to the upgrade page:

```json
{
  "jsonrpc": "2.0",
  "id": "call_abc123",
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "error_code": "rate_limit_exceeded",
      "window": "per_minute",
      "plan": "free",
      "limit": 60,
      "used": 60,
      "retry_after": 12,
      "human_message": "Your Free plan allows 60 requests per minute, and that ceiling has been reached. Please wait 12 seconds before retrying. Usage is unlimited — upgrade for a higher burst ceiling: https://www.mcpemails.com/pricing"
    }
  }
}
```

---

## 7. Upstream Provider Rate Limits

The following limits are enforced by the email providers themselves, independent of MCPEmails. The MCP server handles provider 429 responses transparently where possible (see Section 8), but callers may observe increased latency during backoff.

### Gmail API

| Metric | Limit | Window |
|--------|-------|--------|
| Requests | 500 | Per user per second |
| Total quota | 5 billion | Per Google Cloud project per day |
| Concurrent connections | 100 | Per user |

Gmail returns HTTP 429 or HTTP 403 with `reason: rateLimitExceeded` in the JSON body. The project-level daily quota (5 billion units) is shared across all MCPEmails users, not per-user — exhausting it would be a platform-level incident. Gmail Batch API is used for bulk operations (fetching message details for list results) to reduce unit cost.

### Microsoft Graph (Outlook)

| Metric | Limit | Window |
|--------|-------|--------|
| Requests | 2,000 | Per user per 60 seconds |
| Throttling signal | HTTP 429 | With `Retry-After` header |

Microsoft Graph includes throttling headers that MCPEmails reads directly:

```
Retry-After: 120
X-RateLimit-Limit: 2000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2026-05-24T10:45:00Z
```

When Graph returns 429, the `Retry-After` header value is used as the floor for the backoff delay rather than a computed value.

### Fastmail (IMAP)

| Metric | Limit |
|--------|-------|
| Concurrent IMAP connections | 20 per account |
| Requests per second | No strict limit |
| Max IMAP command size | 8 KB |

Fastmail does not return HTTP 429s; the connection limit is enforced at the TCP level. MCPEmails maintains a connection pool per Fastmail account (capped at 5 concurrent connections, well within the 20-connection limit) using IMAP IDLE for real-time updates. If a connection attempt fails with a capacity error, the retry strategy in Section 8 applies with a longer base delay (30 seconds).

---

## 8. Exponential Backoff for Upstream 429s

When a provider returns a rate limit error, the MCP tool handler retries transparently rather than propagating the error to the caller. The algorithm:

- Maximum 5 retries per request
- Base delay doubles on each attempt: 1 s, 2 s, 4 s, 8 s, 16 s
- Cap: 30 seconds (to avoid a single request holding an Edge Function slot too long)
- Jitter: ±20% random jitter added to each delay to prevent thundering-herd across concurrent requests
- If a `Retry-After` header is present (Outlook Graph), the header value replaces the computed delay if it is larger

```typescript
// src/lib/provider-retry.ts

interface ProviderResponse<T> {
  data?: T;
  status: number;
  headers: Headers;
}

async function withProviderRetry<T>(
  fn: () => Promise<ProviderResponse<T>>,
  providerName: string
): Promise<T> {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 1_000;
  const MAX_DELAY_MS = 30_000;
  const JITTER_FACTOR = 0.2;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fn();

    if (response.status !== 429) {
      if (!response.data) {
        throw new ProviderError(providerName, response.status);
      }
      return response.data;
    }

    if (attempt === MAX_RETRIES - 1) {
      throw new ProviderRateLimitError(providerName, "max retries exceeded");
    }

    // Compute base exponential delay
    const exponentialMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);

    // Respect provider Retry-After header if present and larger
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader) * 1_000 : 0;
    const baseDelayMs = Math.max(exponentialMs, retryAfterMs);

    // Apply jitter: delay * (1 ± JITTER_FACTOR)
    const jitter = baseDelayMs * JITTER_FACTOR * (Math.random() * 2 - 1);
    const delayMs = Math.round(baseDelayMs + jitter);

    console.warn("provider_rate_limited", {
      provider: providerName,
      attempt: attempt + 1,
      delayMs,
      retryAfterHeader,
    });

    await sleep(delayMs);
  }

  // Unreachable, but satisfies TypeScript
  throw new ProviderRateLimitError(providerName, "unexpected exit");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Fastmail connection limit variant.** When an IMAP connection attempt fails due to the connection limit, the base delay is 30 seconds (not 1 second) because Fastmail does not shed connections quickly. The `withProviderRetry` function is called with a pre-configured `BASE_DELAY_MS` of 30,000 for IMAP connection errors.

**When backoff is not transparent.** If the total accumulated delay would exceed 25 seconds (leaving 5 seconds of Edge Function headroom), the handler stops retrying and returns a `provider_rate_limited` error to the caller with a `Retry-After` value equal to the next computed delay. The caller is then responsible for the retry. This avoids Edge Function timeout errors, which are harder for callers to distinguish from server errors.

---

## 9. Quota Visibility in the Dashboard

Users see their rate limit and quota status in the Dashboard under **Settings > API Keys** and **Settings > Usage**.

### Per-key usage panel (Settings > API Keys)

Each API key row expands to show:

- Calls in the last minute (of the per-key 100/min guard)
- Calls in the last hour (of 1,000)
- Calls today (no cap — usage is unlimited)
- Last used timestamp
- A sparkline of calls per hour for the last 7 days

These figures are computed by querying `usage_logs` grouped by `api_key_id` and time bucket. The dashboard query runs on page load and refreshes every 60 seconds. It does not use real-time subscriptions because `usage_logs` is append-only and high-volume; Supabase Realtime is not appropriate for this table.

### Account-level usage (Settings > Usage)

The usage page shows:

- Total calls today across all keys (usage is unlimited — shown for visibility, not as a cap)
- A bar chart of calls per day for the last 30 days
- A breakdown by tool name (list_inbox, send_email, search_emails, etc.)
- The workspace's per-plan per-minute ceiling (60 / 300 / 1,000) and recent peak usage against it

### Rate limit alerts

When a key exceeds 80% of its per-hour limit, a yellow warning banner appears on the API Keys page. When a key hits 100%, the banner turns red and shows the `Retry-After` countdown. These thresholds are computed server-side in the usage aggregation query; no client-side polling of the MCP endpoint is used.

### Dashboard query example

```typescript
// src/app/api/usage/route.ts

async function getDailyUsage(userId: string): Promise<DailyUsage> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("usage_logs")
    .select("api_key_id, tool_name, created_at")
    .eq("user_id", userId)
    .gte("created_at", today.toISOString());

  if (error) throw error;

  return {
    totalCalls: data.length,
    byTool: groupBy(data, "tool_name"),
    byKey: groupBy(data, "api_key_id"),
  };
}
```

---

## 10. Future: Redis-Based Rate Limiting

The current DB-based implementation trades ~3–5 ms of extra latency (three `COUNT(*)` queries) for operational simplicity. This is acceptable at current scale. When per-key request volume grows or Edge Function cold-start latency becomes a concern, the migration path is:

### Target architecture

Replace the three `usage_logs` count queries with atomic Redis `INCR` + `EXPIRE` operations on a Upstash Redis instance (Upstash is the Vercel-native serverless Redis; it works inside Edge Functions without a persistent TCP connection).

### Rolling window with Redis

```typescript
// Future implementation — not yet active
async function checkRateLimitRedis(
  redis: Redis,
  apiKeyId: string
): Promise<RateLimitResult> {
  const now = Date.now();

  for (const window of WINDOWS) {
    const bucketKey = `rl:${apiKeyId}:${window.label}`;

    // Sorted set approach: score = timestamp, member = unique call id
    // ZREMRANGEBYSCORE removes expired entries; ZCARD counts remaining
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(bucketKey, 0, now - window.intervalMs);
    pipeline.zadd(bucketKey, { score: now, member: `${now}-${crypto.randomUUID()}` });
    pipeline.zcard(bucketKey);
    pipeline.expire(bucketKey, Math.ceil(window.intervalMs / 1000) + 1);

    const results = await pipeline.exec();
    const count = results[2] as number;

    if (count > window.limit) {
      // ZRANGE with BYSCORE to find oldest entry for Retry-After
      const oldest = await redis.zrange(bucketKey, 0, 0, { withScores: true });
      const oldestTs = oldest[0]?.score ?? now - window.intervalMs;
      const retryAfterSeconds = Math.ceil(
        (oldestTs + window.intervalMs - now) / 1000
      );

      return {
        allowed: false,
        windowLabel: window.label,
        limit: window.limit,
        used: count,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }
  }

  return { allowed: true, windowLabel: "none", limit: 0, used: 0, retryAfterSeconds: 0 };
}
```

### Migration steps

1. Provision Upstash Redis via the Vercel Marketplace integration. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to Edge Function environment variables.
2. Deploy a dual-write version: write to both `usage_logs` (audit) and Redis (rate limit check). Run Redis checks in shadow mode (log disagreements; don't enforce Redis result yet).
3. After one week of shadow mode with zero disagreements above a 1% threshold, switch enforcement to Redis. Remove the three `usage_logs` count queries from the hot path.
4. Retain `usage_logs` writes for audit and dashboard queries. The dashboard never reads Redis; it always reads Postgres.

### Expected latency improvement

| Implementation | Rate limit check latency |
|----------------|--------------------------|
| Current (Postgres COUNT) | 3–8 ms per window, 9–24 ms total |
| Redis pipeline (all 3 windows) | 1–3 ms total (single round trip) |

The Redis approach also allows atomic increment-and-check, eliminating the ~1-call overshoot window described in Section 3.
