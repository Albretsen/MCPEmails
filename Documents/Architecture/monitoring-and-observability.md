# Monitoring and Observability

## Purpose

This document defines the complete monitoring and observability strategy for MCPEmails — how the system emits telemetry, how that telemetry is collected and stored, and how on-call engineers use it to diagnose problems. It is a binding architectural decision, not aspirational guidance. Every new Edge Function, Route Handler, and database migration must conform to the conventions described here.

---

## 1. Overview: Three Pillars

MCPEmails observability is built on three independent pillars that together provide full visibility from the browser to the database.

**Structured logs** are the primary diagnostic instrument. Every meaningful event — MCP tool call, token refresh, OAuth callback, rate-limit enforcement — is emitted as a newline-delimited JSON object written to stdout. On Vercel, these logs are captured by the runtime and surfaced in the Vercel Logs dashboard and forwarded to Sentry's log ingestion endpoint. On Supabase Edge Functions, logs appear in the Supabase project logs dashboard.

**Metrics** are derived from two sources: (1) Vercel Analytics, which measures Web Vitals and request-level performance for Next.js pages and API routes, and (2) SQL aggregates computed over the `activity_log` table in Supabase. There is no separate metrics push pipeline at this stage. Prometheus, Grafana, and DataDog are explicitly out of scope for the MVP; the investment is not justified until sustained traffic exceeds 100k tool calls/day.

**Alerting** is handled by Sentry for application-level errors and by Vercel deployment notifications for infrastructure events. Supabase sends email alerts for database health warnings (high connection count, disk usage, replication lag). Alert thresholds are specified in Section 8.

### Tools at a glance

| Concern | Tool | Access |
|---|---|---|
| Web Vitals (CLS, LCP, INP) | Vercel Analytics | Vercel dashboard |
| Edge Function logs | Vercel Logs + Supabase Logs | Vercel / Supabase dashboards |
| Application errors | Sentry | sentry.io project |
| Query performance | Supabase Dashboard / `pg_stat_statements` | Supabase dashboard |
| Usage graphs | SQL over `activity_log` | MCPEmails dashboard |
| Deployment failures | Vercel email + GitHub checks | Vercel / GitHub |

---

## 2. Structured Logging

### Log Format

All log lines are written as a single JSON object followed by a newline (`\n`). No multi-line logs. No log-level-dependent format variations. The schema is:

```typescript
interface McpEmailsLog {
  // Required on every log line
  timestamp: string;        // ISO 8601 with milliseconds, UTC — e.g. "2026-05-24T10:31:45.123Z"
  level: "debug" | "info" | "warn" | "error";
  service: string;          // The emitting service — see values below
  request_id: string;       // UUID v4; threads through the entire request lifecycle

  // Required when the request is authenticated (omit on public/health endpoints)
  user_id?: string;         // Supabase auth.users.id — UUID
  key_id?: string;          // api_keys.id — UUID; present on MCP tool calls

  // Required on terminal log lines (the line that closes a request or operation)
  duration_ms?: number;     // Wall clock ms from request start to response sent

  // Required on error log lines
  error?: {
    code: string;           // MCPEmails error code, e.g. "auth_failed", "rate_limit_exceeded"
    message: string;        // Human-readable, safe to log — no secrets, no email content
    provider?: string;      // "gmail" | "outlook" | "fastmail" | "imap" when provider-originated
    http_status?: number;   // Upstream HTTP status if applicable
  };

  // Optional context — include when meaningful
  tool_name?: string;       // MCP tool name, e.g. "read_email"
  inbox_id?: string;        // inboxes.id — UUID
  provider?: string;        // "gmail" | "outlook" | "fastmail" | "imap"
  workspace_id?: string;    // workspaces.id — UUID
  event?: string;           // Named event type for non-request logs, e.g. "token_refresh_success"

  // Any additional context fields are allowed but must not contain PII (see Section 4)
  [key: string]: unknown;
}
```

**Service values:**

| Value | Emitted by |
|---|---|
| `mcp-edge` | MCP Edge Function (Supabase) |
| `token-refresh-edge` | Token refresh Edge Function (Supabase) |
| `partition-manager-edge` | Monthly partition creation Edge Function |
| `next-api` | Next.js Route Handlers (`/api/*`) |
| `next-middleware` | Next.js Middleware |

### Emitting Logs from Next.js

Next.js Route Handlers write logs using a thin wrapper that adds required fields automatically. The logger is instantiated once per request using the `request_id` from an incoming header (or generated fresh on the first call):

```typescript
// lib/logger.ts
export function createLogger(requestId: string, context: Partial<McpEmailsLog> = {}) {
  return {
    info: (event: string, extra?: Record<string, unknown>) =>
      emit("info", event, requestId, context, extra),
    warn: (event: string, extra?: Record<string, unknown>) =>
      emit("warn", event, requestId, context, extra),
    error: (event: string, err: unknown, extra?: Record<string, unknown>) =>
      emit("error", event, requestId, context, { ...extra, error: normalizeError(err) }),
  };
}

function emit(
  level: McpEmailsLog["level"],
  event: string,
  requestId: string,
  base: Partial<McpEmailsLog>,
  extra?: Record<string, unknown>
) {
  const line: McpEmailsLog = {
    timestamp: new Date().toISOString(),
    level,
    service: "next-api",
    request_id: requestId,
    event,
    ...base,
    ...extra,
  };
  // In production, console.log goes to stdout which Vercel captures.
  // In test environments, suppress to avoid noise.
  if (process.env.NODE_ENV !== "test") {
    console.log(JSON.stringify(line));
  }
}
```

The `request_id` is propagated by generating it in middleware if absent, then passing it in a `X-Request-Id` response header and in the `request_id` field of every log line emitted during that request lifecycle.

### Emitting Logs from Edge Functions

Supabase Edge Functions run Deno. The same JSON schema applies. The `service` field is set to `mcp-edge` or `token-refresh-edge` as appropriate. Deno's `console.log` goes to stdout and appears in the Supabase project's Edge Function logs tab (filterable by function name and time range).

---

## 3. MCP Request Tracing

Every MCP tool call must be traceable from the HTTP request arriving at the Edge Function, through the `activity_log` database row, and into any associated Sentry event.

### Trace Thread

1. **Client sends** an HTTP POST to the MCP endpoint with an `Authorization: Bearer <key>` header. The client may optionally send an `X-Request-Id` header with its own correlation ID; if absent, the Edge Function generates a UUID v4.

2. **Edge Function logs** the first log line immediately on request receipt:
   ```json
   {
     "timestamp": "2026-05-24T10:31:45.001Z",
     "level": "info",
     "service": "mcp-edge",
     "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
     "event": "mcp_request_received",
     "tool_name": "read_email"
   }
   ```
   Note: `key_id` and `user_id` are not yet populated — the key has not been authenticated.

3. **After key authentication succeeds**, `key_id` and `workspace_id` are added to all subsequent log lines by binding them to a logger instance.

4. **The `activity_log` row** is inserted with `id` set to the same `request_id` UUID. This creates a direct join between logs and database records:
   ```sql
   INSERT INTO public.activity_log
     (id, workspace_id, api_key_id, inbox_id, tool_name, status, duration_ms, ip_address, created_at)
   VALUES
     ($request_id, $workspace_id, $key_id, $inbox_id, $tool_name, $status, $duration_ms, $ip, now());
   ```
   Using the `request_id` as the primary key of the `activity_log` row eliminates a separate ID generation step and makes log correlation O(1): look up the UUID in either system to find the other.

5. **The terminal log line** emits `duration_ms` and the final status:
   ```json
   {
     "timestamp": "2026-05-24T10:31:45.312Z",
     "level": "info",
     "service": "mcp-edge",
     "request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
     "event": "mcp_request_completed",
     "tool_name": "read_email",
     "key_id": "3d1b0c6a-...",
     "workspace_id": "7e4f2a1b-...",
     "inbox_id": "9c8b7a6d-...",
     "duration_ms": 311,
     "provider": "gmail"
   }
   ```

6. **If an error occurs**, a Sentry event is captured (see Section 4) with `request_id` attached as a tag so the Sentry event links directly to both the log lines and the `activity_log` row.

### Auth Log Row

For any authentication event (key auth failure, token refresh, OAuth callback), an additional row is inserted into `auth_logs` with `metadata.request_id` set to the same UUID, providing a three-way join: Edge Function log ↔ `activity_log` ↔ `auth_logs`.

---

## 4. Sentry Integration

### Decision

Sentry is used because it provides source-mapped stack traces, structured context on every error event, and a direct integration with Next.js and Deno-compatible fetch instrumentation. It also has a Vercel integration that automatically tags errors with deployment SHA and environment.

### Next.js SDK Setup

Install `@sentry/nextjs`. The init call lives in `instrumentation.ts` (the Next.js instrumentation hook, not `next.config.js`) so it runs on both Node.js and Edge runtimes:

```typescript
// instrumentation.ts
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? "development",
      // Tag every event with the git SHA so errors map to a specific deploy
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      // Trace 5% of requests in production; 100% in preview
      tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.05 : 1.0,
      // Never send PII to Sentry — see PII scrubbing section below
      beforeSend(event) {
        return scrubPii(event);
      },
      // Ignore expected non-actionable errors
      ignoreErrors: [
        "rate_limit_exceeded",
        "invalid_token",     // Auth failures are logged; not Sentry events
        "insufficient_scope",
      ],
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      tracesSampleRate: 0,  // No transaction tracing on edge runtime (cost)
      beforeSend(event) {
        return scrubPii(event);
      },
    });
  }
}
```

### Edge Function Error Capture

The Supabase Edge Function (Deno) uses `@sentry/deno`. The init call is at module load time:

```typescript
// supabase/functions/mcp/index.ts
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("SUPABASE_ENV") ?? "development",
  release: Deno.env.get("DEPLOY_SHA"),
  beforeSend: scrubPii,
});

Deno.serve(async (req) => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  return Sentry.withScope(async (scope) => {
    scope.setTag("request_id", requestId);
    scope.setTag("service", "mcp-edge");
    try {
      return await handleMcpRequest(req, requestId);
    } catch (err) {
      Sentry.captureException(err);
      throw err;
    }
  });
});
```

Every Sentry event from the Edge Function carries a `request_id` tag, enabling a direct link from the Sentry issue to the `activity_log` row.

### Source Maps

Source maps are uploaded to Sentry at deploy time via `@sentry/nextjs`'s Webpack plugin (configured in `next.config.ts`). For Supabase Edge Functions, source maps are generated by the Deno bundler and uploaded via `sentry-cli` as a step in the GitHub Actions deployment workflow.

The `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are stored as Vercel environment variables (production only) and as GitHub Actions secrets. They are never committed to the repository.

### Environment Tagging

| Vercel environment | `VERCEL_ENV` value | Sentry environment tag |
|---|---|---|
| Production deployment | `production` | `production` |
| Preview deployment (PR) | `preview` | `preview` |
| Local development | unset | `development` |

Errors in `preview` are visible in Sentry but do not page anyone. Only `production` errors trigger alert rules (Section 8).

### PII Scrubbing

The `scrubPii` function runs in the `beforeSend` hook on every event before it leaves the process. Its contract is:

- Remove `request.headers.authorization` entirely (never send API keys to Sentry).
- Remove `request.headers.cookie` entirely (never send session tokens).
- Remove `request.data` and `request.body` entirely (may contain email content).
- Strip any extra context keys whose name contains `token`, `password`, `secret`, `key`, or `credential` (case-insensitive).
- Do not redact `request.url`, `request.method`, or any tag.

```typescript
function scrubPii(event: Sentry.Event): Sentry.Event | null {
  if (event.request) {
    delete event.request.data;
    if (event.request.headers) {
      delete event.request.headers["authorization"];
      delete event.request.headers["cookie"];
    }
  }
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (/token|password|secret|key|credential/i.test(key)) {
        delete event.extra[key];
      }
    }
  }
  return event;
}
```

**Email content is never logged or sent to Sentry.** Email subjects, bodies, and recipient addresses must not appear in log lines, Sentry breadcrumbs, or Sentry event data. If an error occurs while processing an email, the error log includes the `message_id` (an opaque ID assigned by the provider) and the `inbox_id`, never the content itself.

---

## 5. Key Metrics to Track

These are the metrics that matter for operational health and capacity planning. Each is sourced either from Vercel Analytics, from SQL queries over `activity_log`, or from Sentry.

### MCP Tool Call Volume

**What**: Total tool calls per tool per hour, plotted as a time series.
**Source**: `activity_log` — `COUNT(*) GROUP BY tool_name, date_trunc('hour', created_at)`.
**Why it matters**: Sudden spikes indicate runaway agent scripts; sudden drops indicate an outage or broken integration.
**Dashboard**: MCPEmails workspace dashboard, "Usage" tab.

### p50 / p95 / p99 Latency per Tool

**What**: Response time percentiles broken out by `tool_name`.
**Source**: `activity_log.duration_ms` — `percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)`.
**Target SLOs**: p50 < 400ms, p95 < 1500ms, p99 < 3000ms for all read tools. Send tools have a looser SLO (p95 < 3000ms) because SMTP submission adds variable latency.
**Why it matters**: p95 degradation before p50 degradation indicates provider throttling. p99 spikes indicate timeouts.

### Error Rate per Tool

**What**: `(error rows / total rows) * 100` per tool, rolling 5-minute window.
**Source**: `activity_log` — `COUNT(*) FILTER (WHERE status = 'error') / COUNT(*) * 100`.
**Alert threshold**: > 1% sustained for 5 minutes triggers a page (Section 8).

### Token Refresh Failure Rate

**What**: Count of `token_refresh_failed` events in `auth_logs` per hour.
**Source**: `auth_logs WHERE event_type = 'token_refresh_failed'`.
**Why it matters**: A spike here means OAuth tokens are being revoked by users or by the provider — inboxes will start returning `auth_failed` errors within the hour if not resolved. A rate above 5 failures/hour should be investigated.

### Rate Limit Hit Rate

**What**: `(rate_limited rows / total rows) * 100` in `activity_log`, per API key and globally.
**Source**: `activity_log WHERE status = 'rate_limited'`.
**Alert threshold**: > 10% of traffic hitting MCPEmails-level rate limits in any 5-minute window.
**Why it matters**: Sustained rate-limit hits suggest either a misconfigured agent (infinite loop) or a legitimate need to raise plan limits.

### Active Inbox Count

**What**: Count of inboxes where `status = 'active'` and `deleted_at IS NULL`, broken out by `provider`.
**Source**: `inboxes` table — queried by the dashboard on page load.
**Why it matters**: A drop in active inbox count without a corresponding drop in user count indicates a mass token-expiry or provider outage.

---

## 6. Supabase Observability

### Supabase Logs Dashboard

The Supabase project dashboard (app.supabase.com → project → Logs) surfaces four log streams:

- **Edge Function logs**: Each invocation of `mcp` and `token-refresh` with stdout, stderr, and invocation duration. Filter by function name and time range. Useful for first-line triage.
- **PostgREST logs**: All queries routed through the REST API (used by Next.js server-side clients). Filter by response code to find 4xx/5xx errors.
- **Auth logs**: Supabase Auth events (sign-in, OTP sent, token refresh). Separate from the application-level `auth_logs` table.
- **Database logs**: PostgreSQL logs including slow queries (see below).

### Slow Query Log

Supabase enables `log_min_duration_statement = 1000` by default (queries taking longer than 1 second appear in database logs). In the Supabase dashboard, navigate to Logs → Database and filter for `duration` to surface slow queries. Any query taking > 500ms in the `activity_log` table is a red flag — the partitioned indexes should keep aggregation queries under 100ms on the current data volume.

### `pg_stat_statements`

The `pg_stat_statements` extension is enabled on all Supabase projects. Query it directly from the Supabase SQL editor when investigating query performance:

```sql
-- Top 10 slowest queries by mean execution time
SELECT
  query,
  calls,
  round(mean_exec_time::numeric, 2)   AS mean_ms,
  round(total_exec_time::numeric, 2)  AS total_ms,
  round(stddev_exec_time::numeric, 2) AS stddev_ms,
  rows
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Reset statistics after a major schema or index change to get a clean baseline:

```sql
SELECT pg_stat_statements_reset();
```

### Connection Pool Monitoring

Supabase exposes `pg_stat_activity` for live connection inspection. If connection timeouts are observed, check active connections:

```sql
SELECT
  state,
  wait_event_type,
  wait_event,
  count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state, wait_event_type, wait_event
ORDER BY count DESC;
```

PgBouncer is in transaction-mode pooling. Edge Functions should never open long-lived connections. If the `active` count consistently exceeds 80 (out of a typical 100-connection pool), the rate limit on MCP tool calls needs tightening.

---

## 7. Vercel Observability

### Vercel Analytics: Web Vitals

Vercel Analytics is enabled for the `apps/web` Next.js app. It captures Core Web Vitals (LCP, CLS, INP, TTFB, FCP) broken out by route, device type, and country. No additional instrumentation code is required; the `@vercel/analytics` package instruments Next.js page transitions automatically.

**Target thresholds** (aligned with Google's "Good" thresholds):
- LCP < 2.5s
- CLS < 0.1
- INP < 200ms
- TTFB < 800ms

A degradation in TTFB on dashboard routes (`/dashboard/*`) correlates with Supabase query latency and should be checked against `pg_stat_statements` first.

### Edge Function Logs on Vercel

Next.js Edge Middleware and Vercel Edge Functions emit logs visible in the Vercel project → Logs tab. Filter by `source=edge` to isolate Edge Middleware logs. The Vercel Log Drain integration can forward these logs to external destinations (Datadog, Logtail, etc.) when volume justifies it.

### Deployment Failure Alerts

Vercel sends email notifications on deployment failure to the project owner. Additionally, GitHub Actions CI (lint, type-check, test) runs on every PR and blocks deployment on failure. The GitHub status check is the first line of defence; Vercel's deployment log is the second.

For production deployments, the deployment is gated on the `vitest` test suite and the TypeScript compiler passing. If a deployment to production fails, Vercel automatically rolls back to the previous successful deployment, maintaining zero-downtime for users.

---

## 8. Alerting Rules

All production alert rules are configured in Sentry (for application-level conditions) and in Vercel (for infrastructure-level conditions). No external PagerDuty or OpsGenie account is used at this stage — Sentry's built-in notification targets (email + Slack webhook) are sufficient for the current team size.

### Rule 1: Error Rate > 1% for 5 Minutes

**Condition**: The ratio of `activity_log` rows with `status = 'error'` to total rows exceeds 1% in any rolling 5-minute window, computed by the monitoring SQL query (Section 9) running on a 1-minute schedule as a Supabase Edge Function cron.

**Notification**: Sentry alert → Slack `#incidents` channel.

**Severity**: High. At 1% error rate, roughly 1 in 100 MCP tool calls is failing. This is visible to end users.

**First action**: Check Sentry for the specific error codes driving the spike. Distinguish between `provider_error` (external, possibly transient) and `auth_failed` (indicates token expiry wave).

### Rule 2: Edge Function p95 Latency > 2 Seconds

**Condition**: The 95th percentile of `activity_log.duration_ms` for any single tool exceeds 2000ms in a 10-minute rolling window.

**Notification**: Sentry alert → Slack `#incidents` channel.

**Severity**: Medium. Users will not immediately notice, but AI agents with short timeouts will start seeing failures.

**First action**: Check which tool is slow. If `send_email`, check SMTP provider status. If `read_email` or `list_inbox`, check Gmail API / Microsoft Graph status pages. If all tools, check Supabase Edge Function execution time in the Supabase logs dashboard.

### Rule 3: Token Refresh Failure Spike

**Condition**: More than 10 `token_refresh_failed` events in `auth_logs` within any 60-minute window. Baseline is 0–2 per hour (expected churn from users revoking access manually).

**Notification**: Sentry alert → Slack `#incidents` channel.

**Severity**: High. If refresh tokens are being rejected en masse, connected inboxes will begin failing within the hour as access tokens expire.

**First action**: Check `auth_logs.metadata` for the failing provider. A Google or Microsoft platform incident will cause this. Check provider status pages (status.google.com, status.azure.com). If provider is healthy, a configuration change (OAuth client ID, redirect URI) may be the cause.

### Rule 4: Rate Limit Hit Rate > 10% of Traffic

**Condition**: More than 10% of rows in `activity_log` have `status = 'rate_limited'` in any 5-minute window.

**Notification**: Sentry alert → Slack `#incidents` channel.

**Severity**: Medium. Usually caused by a misconfigured agent in an infinite loop. Self-resolves if the agent stops; requires key revocation if it continues.

**First action**: Identify the `api_key_id` driving the most `rate_limited` rows (`SELECT api_key_id, COUNT(*) FROM activity_log WHERE status = 'rate_limited' AND created_at > now() - interval '15 minutes' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`). Contact the key owner or revoke the key if abuse is confirmed.

### Rule 5: Deployment Failure

**Condition**: A Vercel deployment to the `production` environment fails.

**Notification**: Vercel email to project owner. Additionally, the GitHub commit status is marked failed, which is visible on the PR.

**Severity**: Medium. The previous deployment is still live; there is no user impact unless the failure is blocking a critical hotfix.

---

## 9. Dashboard Queries

These SQL queries power the usage graphs on the MCPEmails workspace dashboard. They run against `activity_log` using the Supabase server client with the workspace's `service_role` context (RLS is bypassed; the application enforces `workspace_id` filtering in the query itself).

### Daily Call Volume (Last 30 Days)

```sql
-- Powers the "Call volume" time-series chart on the dashboard overview
SELECT
  date_trunc('day', created_at)::date  AS day,
  COUNT(*)                             AS total_calls,
  COUNT(*) FILTER (WHERE status = 'success')      AS successful_calls,
  COUNT(*) FILTER (WHERE status = 'error')        AS error_calls,
  COUNT(*) FILTER (WHERE status = 'rate_limited') AS rate_limited_calls
FROM public.activity_log
WHERE
  workspace_id = $1
  AND created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
```

This query hits the `idx_activity_log_workspace_id_created_at` index on the current and previous monthly partitions. At typical scale (< 1M rows/month), it runs in under 50ms.

### Per-Tool Breakdown (Last 7 Days)

```sql
-- Powers the "By tool" bar chart showing which tools are used most
SELECT
  tool_name,
  COUNT(*)                                               AS total_calls,
  COUNT(*) FILTER (WHERE status = 'error')               AS error_calls,
  ROUND(
    COUNT(*) FILTER (WHERE status = 'error')::numeric
    / NULLIF(COUNT(*), 0) * 100,
    2
  )                                                      AS error_rate_pct,
  ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 0)
                                                         AS p50_ms,
  ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 0)
                                                         AS p95_ms
FROM public.activity_log
WHERE
  workspace_id = $1
  AND created_at >= now() - interval '7 days'
  AND status != 'rate_limited'      -- Exclude rate-limited calls from latency stats
GROUP BY tool_name
ORDER BY total_calls DESC;
```

### Per-Key Usage (Current Month)

```sql
-- Powers the API key usage table in Dashboard > API Keys
SELECT
  ak.id          AS key_id,
  ak.name        AS key_name,
  ak.key_prefix,
  COUNT(al.id)   AS call_count,
  COUNT(al.id) FILTER (WHERE al.status = 'error') AS error_count,
  MAX(al.created_at)  AS last_used_at
FROM public.api_keys ak
LEFT JOIN public.activity_log al
  ON al.api_key_id = ak.id
  AND al.workspace_id = ak.workspace_id
  AND al.created_at >= date_trunc('month', now())
WHERE
  ak.workspace_id = $1
  AND ak.deleted_at IS NULL
GROUP BY ak.id, ak.name, ak.key_prefix
ORDER BY call_count DESC;
```

### Error Rate Monitor (Alerting Cron)

```sql
-- Run on a 1-minute schedule by the monitoring Edge Function
-- Returns a row if error rate exceeds threshold; no row means healthy
SELECT
  COUNT(*) FILTER (WHERE status = 'error')::float
  / NULLIF(COUNT(*), 0) * 100  AS error_rate_pct,
  COUNT(*)                     AS total_calls
FROM public.activity_log
WHERE
  created_at >= now() - interval '5 minutes'
HAVING
  COUNT(*) > 20                -- Ignore windows with < 20 calls (too noisy)
  AND (
    COUNT(*) FILTER (WHERE status = 'error')::float
    / NULLIF(COUNT(*), 0) * 100
  ) > 1.0;
```

If this query returns a row, the monitoring Edge Function calls the Sentry Alerts API to trigger the Rule 1 alert. The monitoring Edge Function runs as a Supabase cron job (configured via the Supabase project scheduler, not an external cron service) on a 1-minute schedule.

---

## 10. On-Call Runbook Outline

When an alert fires, follow this sequence. The steps are ordered from fastest-to-check to most-invasive. Do not skip to Supabase or provider status before checking Vercel and Sentry — most incidents originate in application code, not infrastructure.

### Step 1: Verify the Alert is Real (2 minutes)

Open the Sentry issue or Slack alert. Check the raw error rate in Sentry's alert chart or by running the error rate monitor query (Section 9) manually. A single spike that resolves within 2 minutes is self-healing (transient provider blip); wait 2 minutes before escalating.

### Step 2: Check Vercel Logs (5 minutes)

Navigate to Vercel project → Logs. Filter for `source=serverless` or `source=edge` for the last 15 minutes. Look for:
- HTTP 5xx responses from the MCP API routes
- Timeout errors (`FUNCTION_INVOCATION_TIMEOUT`)
- Memory limit errors (`FUNCTION_INVOCATION_MEMORY_ERROR`)
- Repeated error patterns (same error code, same endpoint)

If the errors are concentrated in one route or function, the problem is likely in application code deployed in the last deploy. Check whether a recent deployment correlates with the alert start time.

### Step 3: Check Sentry for Error Details (5 minutes)

Open the Sentry project → Issues. Filter by `environment:production` and sort by `First Seen` to find new errors. Each issue has:
- Stack trace with source-mapped line numbers
- `request_id` tag — use this to correlate with logs and `activity_log`
- `tool_name` tag — identifies which MCP tool is failing

If the error is `provider_error` or `auth_failed`, move to Step 4. If it is a JavaScript/TypeScript error (null dereference, unexpected shape), it is an application bug — roll back the deployment if it was introduced recently.

### Step 4: Check Supabase Logs (5 minutes)

Navigate to Supabase dashboard → Logs → Edge Function logs. Filter to the `mcp` function. Look for:
- Deno runtime errors
- Database connection timeouts (`connection pool exhausted`)
- Vault decryption errors (would appear as `decrypt failed` in the Edge Function log)

Then check Logs → Database. Filter for slow queries (duration > 1000ms). A slow `activity_log` INSERT during a high-traffic period indicates the rate-limit enforcement query is holding a lock too long.

### Step 5: Check Provider Status Pages (3 minutes)

If Step 2–4 show `provider_error` or `provider_unavailable` errors, check:
- Gmail API: https://www.google.com/appsstatus (Google Workspace Status)
- Microsoft Graph: https://status.azure.com
- Fastmail: https://www.fastmail.com/status (no formal status page; monitor IMAP connectivity)

A provider incident resolves itself. No code changes are needed. Post a status update in Slack noting that an external provider is degraded and MCPEmails is returning errors for affected inboxes. Update the status page (if one exists) to reflect partial degradation.

### Step 6: Escalate if Unresolved After 20 Minutes

If the alert has not resolved after working through Steps 1–5, escalate:
1. Post a detailed incident summary in Slack `#incidents` with: alert type, start time, affected tools, error codes, provider status, steps already tried.
2. Identify the last successful deployment (Vercel deployment list) and consider rolling back to it.
3. If a rollback is needed, use the Vercel dashboard "Promote to Production" button on the last good deployment — this takes less than 30 seconds and requires no code push.

### Common Scenarios and Resolutions

| Alert | Most likely cause | Resolution |
|---|---|---|
| Error rate spike, `auth_failed` | Mass token expiry or provider OAuth outage | Check provider status; if healthy, inspect `auth_logs` for token refresh failures |
| Error rate spike, `provider_error` | Provider API degradation | Check provider status page; no action needed if transient |
| p95 latency > 2s on `list_inbox` | IMAP connection pool exhausted or provider slow | Check Supabase Edge Function logs for connection errors; check provider status |
| Rate limit hit rate > 10% | Single agent in a loop | Identify key via SQL in Section 8 Rule 4; contact owner or revoke key |
| Token refresh failure spike | Provider revoked refresh tokens or OAuth misconfiguration | Check `auth_logs.metadata`; verify OAuth client credentials in Supabase Vault |
| Deployment failure | Test failure or build error | Check GitHub Actions CI log; fix code and redeploy |

---

## Appendix A: Environment Variables Required for Observability

All environment variables are set in Vercel (for Next.js) and in Supabase project secrets (for Edge Functions). They are never committed to the repository.

| Variable | Used by | Purpose |
|---|---|---|
| `SENTRY_DSN` | Next.js, Edge Functions | Sentry event ingestion endpoint |
| `SENTRY_AUTH_TOKEN` | CI/CD (Vercel build step) | Source map upload; never used at runtime |
| `SENTRY_ORG` | CI/CD | Sentry organisation slug for CLI commands |
| `SENTRY_PROJECT` | CI/CD | Sentry project slug |
| `VERCEL_ENV` | Auto-set by Vercel | `production` \| `preview` \| `development` |
| `VERCEL_GIT_COMMIT_SHA` | Auto-set by Vercel | Git SHA for Sentry release tagging |
| `SUPABASE_ENV` | Edge Functions | `production` \| `preview` (set manually in project secrets) |
| `DEPLOY_SHA` | Edge Functions | Git SHA, set at deploy time via CI |

---

## Appendix B: Decisions Not Made (and Why)

**OpenTelemetry**: Not adopted for the MVP. OTel adds significant configuration burden and requires an external collector. The value over structured logs + Sentry is not justified until the engineering team grows or the system has multiple independently deployable services. Revisit when any single Supabase Edge Function exceeds 50ms average cold-start.

**Real-time metrics pipeline (Prometheus/Grafana)**: Not adopted. All metrics of interest can be derived from SQL queries on `activity_log`. A dedicated metrics pipeline would duplicate the data already stored in the database. Revisit at 1M+ tool calls/day when SQL aggregation starts adding perceptible latency to dashboard loads.

**Distributed tracing (Honeycomb, Jaeger)**: Not adopted. The current architecture has two hops (Next.js → Supabase Edge Function → provider API), which is simple enough to trace with `request_id` correlation across logs and database rows. Revisit if the MCP layer is decomposed into multiple services.

**Uptime monitoring (Pingdom, Better Uptime)**: A synthetic health check endpoint (`/api/health`) is planned as a separate task. Until it exists, Vercel's own uptime monitoring (available in the Vercel dashboard for Pro/Enterprise plans) covers the Next.js deployment. The MCP Edge Function health is implicitly monitored by the error rate alert.

---

**Version**: 1.0
**Last Updated**: 2026-05-24
**Owner**: Engineering
**Next Review**: 2026-08-24
