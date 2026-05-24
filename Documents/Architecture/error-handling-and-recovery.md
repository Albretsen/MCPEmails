# Error Handling and Recovery

## Purpose

This document specifies how MCPEmails handles errors across all three surfaces where they can occur: the MCP server (JSON-RPC), the Next.js application (HTTP), and the client-side UI (React). It defines the canonical error taxonomy, the mapping from provider-specific failures to our error codes, the retry strategy, and the exact recovery flows a user must take to restore a broken inbox or API key.

All decisions here are binding for agents implementing any part of the error path. Do not introduce new error codes, new toast variants, or new inbox status values without updating this document.

---

## 1. Overview: Three Error Surfaces

MCPEmails operates three distinct error surfaces. Each surface has its own error format, audience, and recovery mechanism.

### 1.1 MCP Server Errors (JSON-RPC)

The MCP server is a Supabase Edge Function that speaks JSON-RPC 2.0. Its clients are AI agents — Claude Desktop, Claude API callers, or any MCP-compatible agent runtime. Errors here are machine-readable and must convey enough information for the agent to decide whether to retry, surface a message to the user, or abort. The audience is code, not people.

Format:
```json
{
  "jsonrpc": "2.0",
  "id": "req-abc123",
  "error": {
    "code": -32001,
    "message": "API key is invalid or has been revoked.",
    "data": {
      "errorType": "auth",
      "inboxId": null,
      "retryable": false
    }
  }
}
```

### 1.2 Next.js App Errors (HTTP)

The Next.js app serves the dashboard at `app.mcpemails.com`. Route Handlers (API routes) return structured JSON errors. Server Components that fail render into error boundary pages. The audience is the browser, either for programmatic fetch error handling in client components or for user-facing error pages.

### 1.3 Client-Side UI Errors

React components that encounter errors — failed fetches, optimistic update reversals, form validation failures — surface them through a toast notification system. The audience is the human user. Messages must be plain English, actionable, and never expose internal error codes or stack traces.

---

## 2. MCP Server Error Taxonomy

### 2.1 Complete TypeScript Type

```typescript
/**
 * JSON-RPC 2.0 error object as returned by the MCPEmails MCP server.
 * The `data` field is always present on errors originating from this server.
 */
export interface JsonRpcError {
  /** Numeric error code. Negative integers per JSON-RPC 2.0. */
  code: JsonRpcErrorCode;
  /** Human-readable message intended for developers, not end users. */
  message: string;
  /** Structured metadata about the error. */
  data: JsonRpcErrorData;
}

export type JsonRpcErrorCode =
  // JSON-RPC 2.0 standard codes
  | -32700  // Parse error
  | -32600  // Invalid Request
  | -32601  // Method not found
  | -32602  // Invalid params
  | -32603  // Internal error
  // MCPEmails custom codes
  | -32001  // Authentication failure (invalid/revoked API key)
  | -32002  // Resource not found (inbox, message)
  | -32003  // Provider error (upstream Gmail/Outlook/IMAP failure)
  | -32029; // Rate limited

export interface JsonRpcErrorData {
  /** Internal error category. Maps to the numeric code. */
  errorType:
    | 'parse'
    | 'invalid_request'
    | 'method_not_found'
    | 'invalid_params'
    | 'internal'
    | 'auth'
    | 'not_found'
    | 'provider_error'
    | 'rate_limited';
  /**
   * The inbox ID that the failing tool was operating on,
   * or null if the error occurred before inbox resolution.
   */
  inboxId: string | null;
  /**
   * Whether the agent should retry this request.
   * False for auth, not_found, invalid_params, invalid_request.
   * True for provider_error, rate_limited, and internal (sometimes).
   */
  retryable: boolean;
  /**
   * Only present when errorType is 'rate_limited'.
   * Number of seconds the agent must wait before retrying.
   */
  retryAfterSeconds?: number;
  /**
   * Only present when errorType is 'provider_error'.
   * The HTTP status code returned by the upstream provider API,
   * or null for IMAP errors that have no HTTP status.
   */
  providerStatus?: number | null;
}
```

### 2.2 Error Code Reference Table

| Code | Name | Retryable | When it fires |
|------|------|-----------|---------------|
| -32700 | Parse error | No | The request body is not valid JSON |
| -32600 | Invalid Request | No | The JSON-RPC envelope is missing required fields (`jsonrpc`, `method`, `id`) |
| -32601 | Method not found | No | The `method` field names a tool that does not exist |
| -32602 | Invalid params | No | A required tool parameter is missing or has the wrong type |
| -32603 | Internal error | Sometimes | An unexpected server-side exception occurred (database unreachable, Edge Function crash) |
| -32001 | Auth failure | No | The bearer token is missing, malformed, does not match any `api_keys.key_hash`, has been soft-deleted, or has expired |
| -32002 | Not found | No | The requested inbox (`account` parameter) is not found in this workspace, or the requested email message ID does not exist |
| -32003 | Provider error | Yes | The Gmail API, Microsoft Graph, or IMAP server returned a non-retryable error (e.g., mailbox full, message deleted server-side) or a retryable transient error (e.g., 503 from Google) — see §4 for the exact mapping |
| -32029 | Rate limited | Yes | The API key has exceeded 100 calls/minute, 1 000 calls/hour, or 10 000 calls/day; the `data.retryAfterSeconds` field tells the agent how long to wait |

**On -32603 retryability:** Internal errors are marked `retryable: true` only when the Edge Function can determine the failure is transient (e.g., a Supabase connection pool timeout). If the cause is unknown, `retryable: false` is returned to prevent agents from flooding a broken system.

---

## 3. MCP Tool Execution Errors: `isError` vs Throwing

The MCP protocol distinguishes between two ways a tool call can fail:

- **Throw a JSON-RPC error** (the `error` field in the JSON-RPC response) — the tool call itself was rejected; the agent receives no tool result at all.
- **Return `isError: true` in the tool result** — the tool call was accepted and executed, but the execution produced a failure outcome; the agent receives a structured result that happens to represent an error.

### When to throw a JSON-RPC error

Throw a JSON-RPC error when the problem exists at the protocol or infrastructure level, before the email operation begins:

- Authentication (`-32001`): The bearer token is invalid. No email operation should be attempted.
- Invalid params (`-32602`): A required parameter is missing or malformed. The tool cannot even begin.
- Method not found (`-32601`): The tool name does not exist.
- Rate limited (`-32029`): The request is being rejected before any provider call is made.
- Internal error (`-32603`): The Edge Function crashed before the email operation started.

In all these cases, there is no meaningful result to return. The JSON-RPC `error` field is the correct channel.

### When to return `isError: true`

Return `isError: true` when the tool executed correctly — the API key was valid, the provider was reached, the operation was attempted — but the result is a failure:

```typescript
// Tool result with isError: true
{
  content: [
    {
      type: "text",
      text: "Failed to send email: recipient inbox is full (552 Message too large). The message was not delivered."
    }
  ],
  isError: true
}
```

Use `isError: true` for:
- **Send failures where the message was not delivered**: SMTP rejections, invalid recipient addresses, attachment size limits, provider-side quota exhaustion for outbound mail.
- **Message-not-found on read**: The `read_email` or `reply_to_email` tool was called with a valid inbox and a message ID that no longer exists (the email was deleted on the provider side after the agent retrieved the ID). The tool executed correctly; the outcome is that the message is gone.
- **Search timeouts**: `search_emails` hit the provider's search timeout. The search was attempted; no results were returned.

**Why the distinction matters:** An agent runtime that receives a JSON-RPC `error` may treat the entire tool invocation as a transport failure and retry blindly. An agent that receives `isError: true` in a structured result can read the error text, reason about it, and decide whether to retry with different parameters, inform the user, or abort. For errors that result from the email domain (not the protocol), `isError: true` gives the agent better decision-making information.

**Rule of thumb:** If the error would have happened even if the inbox had no emails in it and the provider were perfectly healthy, throw a JSON-RPC error. If the error is a consequence of the specific email operation that was attempted, return `isError: true`.

---

## 4. Provider Error Mapping

Each email provider has its own error vocabulary. The MCP server normalises these to the codes in §2.

### 4.1 Gmail API (HTTP)

Gmail errors arrive as HTTP status codes with a JSON error body from the Google API.

| Gmail HTTP Status | Gmail Error Reason | MCP Code | Retryable | Notes |
|---|---|---|---|---|
| 400 | `invalidArgument` | -32602 | No | A parameter passed to the Gmail API was invalid — usually caused by a bad message ID format |
| 401 | `authError` | -32001 | No | The OAuth access token was rejected; the inbox is marked `error` in the DB |
| 403 | `forbidden` | -32001 | No | The OAuth scope does not cover the requested operation |
| 403 | `rateLimitExceeded` (user quota) | -32003 | Yes | Gmail's per-user quota; retry after 100 s |
| 403 | `domainPolicy` | -32003 | No | A Google Workspace admin policy blocked the action |
| 404 | `notFound` | -32002 | No | The message or thread does not exist |
| 429 | `rateLimitExceeded` (global) | -32029 | Yes | Global quota; `retryAfterSeconds` taken from the `Retry-After` header |
| 500 | `backendError` | -32003 | Yes | Transient Gmail backend error; retry with backoff |
| 503 | `serviceUnavailable` | -32003 | Yes | Gmail is down; retry with backoff |

**Token expiry handling:** Before each Gmail API call, the Edge Function checks `inboxes.oauth_token_expires_at`. If `now() + 30 seconds > oauth_token_expires_at`, it attempts a token refresh using the stored `oauth_refresh_token`. If the refresh call returns 400 (invalid grant), the inbox is marked `status = 'error'`, `last_error = 'OAuth refresh token rejected by Google'`, and a `-32001` error is returned to the agent. This is the single point where a Gmail auth failure transitions from "retryable" to "terminal".

### 4.2 Microsoft Graph (Outlook)

| Graph HTTP Status | Graph Error Code | MCP Code | Retryable | Notes |
|---|---|---|---|---|
| 400 | `RequestBodyRead` / `invalidRequest` | -32602 | No | Malformed request |
| 401 | `InvalidAuthenticationToken` | -32001 | No | Token expired or revoked |
| 403 | `ErrorAccessDenied` | -32001 | No | Scope insufficient |
| 403 | `ErrorQuotaExceeded` | -32003 | No | Mailbox storage quota exceeded — not retryable, user action needed |
| 404 | `ErrorItemNotFound` | -32002 | No | Message, folder, or mailbox not found |
| 429 | `TooManyRequests` | -32029 | Yes | `retryAfterSeconds` from `Retry-After` header |
| 503 | `ServiceNotAvailable` | -32003 | Yes | Microsoft service degradation |
| 504 | `ServiceTimeout` | -32003 | Yes | Graph gateway timeout |

**Refresh logic** mirrors Gmail: check expiry 30 s ahead, refresh proactively, mark inbox `error` on refresh failure.

### 4.3 IMAP (Fastmail and generic IMAP)

IMAP errors are tagged status responses, not HTTP codes. MCPEmails uses the `imapflow` library; errors surface as `ImapflowError` instances with a `code` property.

| IMAP Response / Condition | MCP Code | Retryable | Notes |
|---|---|---|---|
| `AUTHENTICATIONFAILED` | -32001 | No | Password is wrong or the app-specific password was revoked in Fastmail settings |
| `[UNAVAILABLE]` | -32003 | Yes | Server is temporarily unavailable |
| `[OVERQUOTA]` | -32003 | No | Mailbox is over quota; user action needed |
| `[NONEXISTENT]` mailbox | -32002 | No | The inbox name (folder) does not exist |
| `[NOTPERMITTED]` | -32001 | No | The IMAP user does not have permission to access this mailbox |
| Connection timeout (TCP) | -32003 | Yes | Network-level failure |
| TLS handshake failure | -32003 | No | Certificate error; not transient; requires admin action |
| `NO [EXPUNGED]` on UID fetch | -32002 | No | The message was expunged (deleted) before the fetch completed |

**IMAP connection management:** Connections are not kept open between MCP tool calls. Each tool call opens a connection, performs the operation, and closes the connection. This is less efficient than persistent connections but eliminates the complexity of connection state management across stateless Edge Function invocations. At current expected call volumes (100 calls/minute maximum per key), the connection overhead is acceptable.

---

## 5. Next.js Error Hierarchy

### 5.1 Error Boundary File Convention

Next.js App Router uses filesystem-based error boundaries. MCPEmails places `error.js` files at each segment level where partial failure should be isolated:

```
app/
  error.js                          ← Root-level fallback (catches everything not caught below)
  (dashboard)/
    error.js                        ← Dashboard shell errors (sidebar, nav)
    (dashboard)/inboxes/
      error.js                      ← Inbox list errors
      [inboxId]/
        error.js                    ← Single inbox view errors
    (dashboard)/keys/
      error.js                      ← API key management errors
    (dashboard)/activity/
      error.js                      ← Activity log errors
  (auth)/
    error.js                        ← Auth flow errors
```

Each `error.js` receives the error object and a `reset` function. The component renders a contextual error state (not a full-page crash) and shows a retry button that calls `reset()`.

**Decision:** Not every route segment needs its own `error.js`. Leaf segments that render self-contained cards (e.g., the email preview panel inside `[inboxId]`) are wrapped in React `<ErrorBoundary>` components instead, because `error.js` in the App Router requires the segment to be a Client Component boundary, which conflicts with Server Component data fetching in those leaf routes.

### 5.2 `not-found.js`

`not-found.js` files are placed at:
- `app/(dashboard)/inboxes/[inboxId]/not-found.js` — shown when the inbox ID in the URL does not belong to the current workspace
- `app/(dashboard)/keys/[keyId]/not-found.js` — shown when the API key ID is not found or revoked

These pages do not show an error; they show a "this resource does not exist" state with a link back to the list.

### 5.3 `global-error.js`

`app/global-error.js` is the last resort. It replaces the entire HTML document (including the root layout) and is shown only when the root `layout.js` itself throws. It renders a minimal HTML page with no dashboard chrome — just a message, a stack trace collapsed in dev mode, and a "Reload page" button.

### 5.4 Route Handler (API Route) Error Format

All Route Handlers return errors in this format:

```typescript
export interface ApiErrorResponse {
  error: {
    /** Machine-readable error code, e.g. "inbox_not_found" */
    code: string;
    /** Human-readable message safe to display */
    message: string;
    /** Present only when the error is tied to a specific request field */
    field?: string;
  };
}
```

HTTP status codes follow REST conventions: 400 for validation, 401 for auth, 403 for scope, 404 for not found, 429 for rate limit, 500 for internal. Route Handlers never return a JSON-RPC envelope — that format is reserved for the MCP Edge Function.

---

## 6. Toast Notification System

### 6.1 Design Decisions

Toasts are the only feedback mechanism for transient errors in the dashboard. No modal dialogs for errors unless the error requires an explicit user decision (e.g., "Your inbox has disconnected — reconnect now?"). Alert banners are used only for persistent, workspace-level issues (e.g., an inbox that has been in `error` status for more than 24 hours).

Positioning: bottom-right corner on desktop, bottom-center on mobile. Toasts stack vertically, newest on top, maximum 3 visible simultaneously. Older toasts auto-dismiss to make room.

### 6.2 Toast Hook Interface

```typescript
export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  /** Display text. Plain English; no error codes. */
  message: string;
  /** Visual style and icon. */
  variant: ToastVariant;
  /**
   * Auto-dismiss duration in milliseconds.
   * - success: 4000
   * - info: 5000
   * - warning: 6000
   * - error: 0 (never auto-dismisses; user must close)
   */
  duration?: number;
  /**
   * Optional action button rendered inside the toast.
   * Use for one-click recovery actions (e.g., "Reconnect", "View key").
   */
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface UseToast {
  /** Show a toast. Returns the toast ID so it can be dismissed programmatically. */
  toast: (options: ToastOptions) => string;
  /** Immediately remove a specific toast. */
  dismiss: (id: string) => void;
  /** Remove all currently visible toasts. */
  dismissAll: () => void;
}

export declare function useToast(): UseToast;
```

### 6.3 Duration Defaults

| Variant | Default duration | Rationale |
|---|---|---|
| `success` | 4 000 ms | Confirmations are low priority; auto-dismiss quickly |
| `info` | 5 000 ms | Slightly longer to ensure the user reads it |
| `warning` | 6 000 ms | Longer; may require the user to act |
| `error` | 0 (no auto-dismiss) | Errors must be explicitly acknowledged so they are not missed |

All durations reset on mouse-hover over the toast (i.e., hovering pauses the dismiss timer).

### 6.4 Standard Usage Patterns

```typescript
// Successful inbox connection
toast({
  variant: 'success',
  message: 'Gmail inbox connected successfully.',
});

// Failed send
toast({
  variant: 'error',
  message: 'Email could not be sent. The recipient address was rejected by the server.',
});

// Inbox disconnected — with recovery action
toast({
  variant: 'warning',
  message: 'Your Gmail inbox has disconnected.',
  action: {
    label: 'Reconnect',
    onClick: () => router.push(`/inboxes/${inboxId}/reconnect`),
  },
});

// Rate limit hit during dashboard operation
toast({
  variant: 'info',
  message: 'Too many requests. Please wait a moment before trying again.',
  duration: 5000,
});
```

**Rule:** Never include error codes, HTTP status codes, or provider error messages verbatim in toast messages. The `last_error` column in the database holds the technical detail; the toast message is for the user.

---

## 7. Retry Logic

### 7.1 Retryable vs Non-Retryable

| Error / Condition | Retryable | Reason |
|---|---|---|
| Network timeout (TCP) | Yes | Transient infrastructure failure |
| HTTP 429 from provider | Yes | Rate limit; resolve by waiting |
| HTTP 500 / 503 from provider | Yes | Transient provider outage |
| IMAP connection timeout | Yes | Network-level transient failure |
| HTTP 401 (token expired, refresh succeeds) | Yes, once | The retry happens after proactive token refresh |
| HTTP 401 (token rejected after refresh) | No | Credentials are invalid; inbox marked error |
| HTTP 403 (scope denied) | No | The OAuth scope will not change without user action |
| HTTP 404 (message not found) | No | The resource does not exist; retrying will not create it |
| Invalid params (-32602) | No | The agent sent a malformed request |
| API key auth failure (-32001) | No | The key is invalid; the agent cannot fix this by retrying |
| IMAP `AUTHENTICATIONFAILED` | No | Password is wrong; retrying will lock the account |

### 7.2 Retry Strategy (MCP Server)

The MCP server itself does not retry provider calls automatically for all error types. The retry behaviour depends on the error type:

**Proactive token refresh (always):**
Before each provider call, if the token expires in less than 30 seconds, the Edge Function refreshes it and retries the original call once. This is transparent to the agent and does not count as an error.

**Rate-limited provider responses:**
When the Gmail API or Microsoft Graph returns a 429, the Edge Function does not retry — it propagates the failure as a `-32029` error with `retryAfterSeconds` set to the value of the `Retry-After` response header (or 60 seconds if no header is present). The decision to retry belongs to the agent, not the server. This prevents the Edge Function from hanging on a retry while holding a billing-metered execution slot.

**Transient provider errors (500/503):**
The Edge Function retries once after a 1-second delay for transient provider errors. If the second attempt also fails, it propagates as `-32003 retryable: true`. A single server-side retry absorbs brief provider hiccups without requiring the agent to implement retries for every call.

**No retries:**
Auth failures, not-found errors, and invalid-params errors are propagated immediately without any retry.

### 7.3 Retry Strategy (Agent Side, Documented for SDK Integrators)

Agents using the MCPEmails MCP server should implement the following backoff:

```typescript
async function callWithRetry(
  tool: string,
  params: Record<string, unknown>,
  maxAttempts = 5,
): Promise<unknown> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await callMcpTool(tool, params);
    } catch (err) {
      if (!isMcpError(err)) throw err;

      // Never retry non-retryable errors
      if (!err.data.retryable) throw err;

      if (attempt === maxAttempts) throw err;

      const baseDelay = err.code === -32029
        ? (err.data.retryAfterSeconds ?? 60) * 1000
        : 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s

      const jitter = Math.random() * 0.2 * baseDelay; // ±20% jitter
      const delay = Math.min(baseDelay + jitter, 30_000); // cap at 30 s

      await sleep(delay);
    }
  }
  throw new Error('Unreachable');
}
```

---

## 8. Inbox Error States

### 8.1 Status Values

The `inboxes.status` column drives both the dashboard UI and the MCP server's behaviour when looking up credentials:

| Status | Meaning | MCP server behaviour |
|---|---|---|
| `pending` | Connected but never successfully used (e.g., OAuth just completed; first token refresh not yet run) | Attempt the call; treat like `active` |
| `active` | Credentials are valid; last sync succeeded | Normal operation |
| `error` | A non-recoverable failure has been recorded | Return `-32002` (inbox found but unusable) with `data.inboxId` set; agent should not retry |
| `revoked` | User explicitly disconnected the inbox | Return `-32002` |

**Why `-32002` for a found-but-broken inbox:** The inbox ID is valid and known to the workspace, but the credentials it holds cannot be used. From the agent's perspective the resource is effectively not available. Using `-32002` signals that retrying will not help, which is the correct behaviour — the only resolution is user action.

### 8.2 When an Inbox Is Marked Error

A token refresh failure is the primary trigger. The sequence:

1. The Token Refresh Edge Function runs on schedule (every 5 minutes, querying inboxes expiring in the next 10 minutes).
2. It decrypts `oauth_refresh_token` and calls the provider's token endpoint.
3. If the provider returns 400 (`invalid_grant`) or 401:
   - `inboxes.status` is set to `'error'`.
   - `inboxes.last_error` is set to a human-readable string (e.g., `"Google rejected the refresh token. The user may have revoked access in Google Account settings."`). This string never contains the token or any secret.
   - `inboxes.oauth_access_token` and `inboxes.oauth_refresh_token` columns are **not cleared** — they are preserved so that, in rare cases where the provider error was transient, a future manual reconnect can attempt to reuse the flow. In practice, a manual reconnect always starts a fresh OAuth flow; the old tokens are overwritten.
4. The Token Refresh Edge Function logs the failure to `auth_logs` with `event_type = 'token_revoked'`.

An `active` inbox is also marked `error` by the MCP Edge Function if a mid-call token refresh (the proactive 30-second check) fails. This happens inline during the tool call.

### 8.3 UI Surface for Inbox Errors

The dashboard inbox list fetches `id, email_address, display_name, status, last_sync_at, last_error` for each inbox. Error inboxes are displayed with:

- A red status indicator dot.
- A "Disconnected" badge next to the email address.
- The `last_error` string rendered as a help tooltip (hover to reveal), prefixed with "Last error:".
- A "Reconnect" button that navigates to the OAuth reconnect flow for that inbox.

A persistent alert banner appears at the top of the dashboard if any inbox has been in `error` status for more than 24 hours. The banner is not dismissible until the inbox is reconnected or deleted.

---

## 9. Logging

### 9.1 What Gets Logged

Every error — whether a JSON-RPC error, an HTTP error from a Route Handler, or an inbox state transition — is logged with a consistent set of fields. The `activity_log` table records MCP-level events; a structured console log in the Edge Function runtime captures the full error for Supabase log streaming.

**Mandatory fields on every error log entry:**

| Field | Type | Source |
|---|---|---|
| `errorType` | string | The `data.errorType` from the JSON-RPC error, or an analogous category for HTTP errors |
| `errorCode` | number or string | The JSON-RPC code (e.g., `-32001`) or HTTP status code |
| `userId` | string or null | The `user_id` derived from the workspace of the API key, or null if auth failed before workspace resolution |
| `apiKeyId` | string or null | The `api_keys.id` of the key used in the request, or null if auth failed before key lookup |
| `inboxId` | string or null | The `inboxes.id` the tool was operating on, or null |
| `tool` | string or null | The MCP tool name (e.g., `read_email`), or null if the error occurred at the method-dispatch layer |
| `timestamp` | ISO 8601 string | `new Date().toISOString()` at the moment the error is caught |
| `message` | string | The same human-readable message returned in the error response |

**Conditional field:**

| Field | Type | Condition |
|---|---|---|
| `stack` | string | Development environment only (`process.env.NODE_ENV === 'development'`). Never logged in production. |

### 9.2 What Is Never Logged

- Raw API key values (bearer tokens from the `Authorization` header).
- OAuth access tokens or refresh tokens.
- IMAP passwords.
- Email message body content (even on parse errors).
- Any field that would expose PII not already stored in the `users` or `inboxes` tables.

### 9.3 Structured Log Format

```typescript
// Emitted via console.error() in Edge Functions, captured by Supabase log drains
interface ErrorLogEntry {
  level: 'error';
  errorType: string;
  errorCode: number | string;
  userId: string | null;
  apiKeyId: string | null;
  inboxId: string | null;
  tool: string | null;
  timestamp: string;
  message: string;
  // dev only:
  stack?: string;
}
```

### 9.4 `activity_log` Fields for Errors

When an MCP tool call results in an error, the `activity_log` row is written with:
- `status = 'error'`
- `error_code = <the string errorType, e.g. "auth">` — the string form, not the numeric code, to make the column human-readable in SQL queries
- `duration_ms` still recorded, reflecting how long the edge function ran before the error

This means the `activity_log` is also the primary source for error rate analytics and rate-limit enforcement, without requiring a separate error log table.

---

## 10. Recovery Flows

### 10.1 Disconnected Inbox (OAuth Token Revoked)

**Symptom:** `inboxes.status = 'error'`; MCP tools return `-32002`; dashboard shows red indicator and "Disconnected" badge.

**User flow:**
1. User clicks "Reconnect" on the inbox card, or follows the dashboard alert banner to Settings > Inboxes.
2. The reconnect page confirms the inbox email address and the provider.
3. Clicking "Reconnect to Google" (or Microsoft) starts a fresh OAuth flow from the beginning — same as the initial connection flow.
4. On successful callback, the new `oauth_access_token` and `oauth_refresh_token` overwrite the old values (encrypted).
5. `inboxes.status` is set back to `'active'`, `inboxes.last_error` is cleared.
6. An `auth_logs` entry is written with `event_type = 'token_refreshed'` and `metadata.reason = 'manual_reconnect'`.
7. The dashboard alert banner disappears on next render.

**What the agent must do:** Nothing. Once the inbox is reconnected, subsequent MCP calls to `list_inbox` or `read_email` with the same `account` identifier will succeed. The agent does not need to be notified — it can simply retry at its next run cycle.

### 10.2 Expired or Revoked API Key

**Symptom:** MCP tool calls return `-32001`; the agent can no longer authenticate.

**User flow:**
1. The agent surfaces the error to the user (or the user notices the agent stopped working).
2. The user navigates to Dashboard > API Keys.
3. The user creates a new key with the same scopes as the broken key (or different scopes if the need has changed).
4. The user configures their agent with the new key (e.g., updates the Claude Desktop `claude_desktop_config.json`).
5. The user optionally revokes the old key — it is already non-functional but soft-deleting it keeps the `activity_log` foreign key intact.

There is no "refresh" for API keys. Keys are bearer tokens; if one is compromised or expires, the resolution is always: create a new key, update the client, optionally revoke the old key.

**For expired keys specifically:** If the key has an `expires_at` in the past, the error message in the `-32001` response is `"API key has expired."` rather than the generic invalid/revoked message. This helps the user understand why a previously-working key stopped working.

### 10.3 Fastmail / IMAP Credential Changed

**Symptom:** `inboxes.status = 'error'`; `last_error` contains `"IMAP authentication failed"`.

**User flow:**
1. The user navigates to Dashboard > Inboxes, clicks on the affected inbox.
2. The inbox detail page shows an "Update credentials" form with fields for IMAP host, port, and password.
3. The user enters the new app-specific password (generated in Fastmail settings or their IMAP provider's admin panel).
4. On submit, the Route Handler encrypts the new password and updates `inboxes.imap_password`.
5. It then attempts a test IMAP connection (connect, `LIST ""`, disconnect). If the test succeeds, `status` is set to `'active'`. If not, the error is returned to the form as a field-level validation error.

### 10.4 Agent Encounters Rate Limit (-32029)

**Symptom:** The MCP server returns `-32029` with a `retryAfterSeconds` value.

**Agent recovery (no user action needed in most cases):**
1. The agent reads `data.retryAfterSeconds`.
2. It waits at least that many seconds before retrying, applying jitter as per §7.3.
3. If the agent is running a batch operation (e.g., reading 200 emails), it should pause the batch rather than abandoning it.
4. The rate limit resets automatically at the per-minute, per-hour, and per-day windows.

**If the user is actively watching:** A toast is shown in the dashboard activity feed row for the rate-limited tool call. The toast says "Your AI agent hit the rate limit. Calls resume automatically." — no action required.

**If the agent hits the daily limit (10 000 calls/day):** This is unlikely in normal use but indicates the agent is running an unusually large batch. The `retryAfterSeconds` reflects the time until midnight UTC when the daily counter resets. The user may also consider creating a second API key, which has an independent rate limit.

### 10.5 Provider Outage (-32003, retryable)

**Symptom:** MCP tools return `-32003` with `retryable: true`; `data.providerStatus` is 503 or 500.

**Agent recovery:** Retry with exponential backoff (§7.3). Provider outages typically resolve within minutes. No user action is required unless the outage persists for more than 30 minutes.

**Inbox status:** The inbox is NOT marked `error` for transient provider errors. Only persistent auth failures cause a status transition. A single 503 from Gmail does not indicate the inbox is broken.

**If the outage is prolonged:** After 5 consecutive failed retries (approximately 1 minute of backoff), the agent should stop retrying and surface a message to the user: "Gmail is temporarily unavailable. Trying again later." The inbox remains `active` in the database.

### 10.6 Internal Error (-32603)

**Symptom:** MCP tools return `-32603`. This should be rare.

**Immediate action:** None required if `retryable: true`. The agent retries using the standard backoff.

**If -32603 is persistent:** The issue is almost certainly an Edge Function crash or a Supabase infrastructure problem. The user should check the MCPEmails status page or contact support. The internal error is logged with a full stack trace (in development) and a structured error entry in the Supabase log drain (in production) for the engineering team to investigate.

---

## Appendix A: JSON-RPC Error Construction Reference

```typescript
// Utility used inside the MCP Edge Function to construct error responses

function mcpError(
  id: string | number | null,
  code: JsonRpcErrorCode,
  message: string,
  data: JsonRpcErrorData,
): Response {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  });
  return new Response(body, {
    status: 200, // JSON-RPC always responds with HTTP 200; errors are in the payload
    headers: { 'Content-Type': 'application/json' },
  });
}

// Examples:
mcpError(req.id, -32001, 'API key is invalid or has been revoked.', {
  errorType: 'auth',
  inboxId: null,
  retryable: false,
});

mcpError(req.id, -32029, 'Rate limit exceeded. Retry after 47 seconds.', {
  errorType: 'rate_limited',
  inboxId: resolvedInboxId,
  retryable: true,
  retryAfterSeconds: 47,
});

mcpError(req.id, -32003, 'Gmail returned a 503 Service Unavailable response.', {
  errorType: 'provider_error',
  inboxId: resolvedInboxId,
  retryable: true,
  providerStatus: 503,
});
```

**Why HTTP 200 for errors:** The JSON-RPC 2.0 specification states that an error response is still a valid JSON-RPC response. Returning HTTP 4xx for JSON-RPC errors would break MCP client libraries that do not inspect the HTTP status code. All MCPEmails JSON-RPC responses — success and error — use HTTP 200. HTTP status codes are used only by the Next.js Route Handlers (REST), not by the MCP Edge Function.

---

**Version:** 1.0  
**Last Updated:** 2026-05-24  
**Owned by:** Architecture  
**Next Review:** 2026-08-24
