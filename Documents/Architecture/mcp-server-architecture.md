# MCP Server Architecture

## Purpose

This document describes the design and implementation of the MCPEmails MCP server — the component that exposes user email accounts to AI agents via the Model Context Protocol. It covers the transport layer, JSON-RPC 2.0 request lifecycle, capability negotiation, tool registry, error handling, and operational concerns specific to running MCP inside a Supabase Edge Function.

---

## 1. Overview

The MCPEmails MCP server is a **remote MCP server** that implements the Streamable HTTP transport defined in the MCP specification. It runs as a **Supabase Edge Function** deployed to the Deno runtime at Supabase's edge infrastructure.

Its sole responsibility is to accept JSON-RPC 2.0 requests from MCP clients, authenticate the caller using an API key, execute the requested email tool, and return a well-formed JSON-RPC 2.0 response. It does not serve the Next.js dashboard and it does not participate in Supabase Auth session management — it is entirely decoupled from the browser-facing application layer.

### Where it lives

```
Supabase Edge Function: supabase/functions/mcp/index.ts
URL pattern:           https://<project-ref>.supabase.co/functions/v1/mcp
Custom domain:         https://mcp.mcpemails.com  (via Supabase custom domains)
```

Every HTTP POST to this URL is a complete MCP interaction: parse request, authenticate, execute, respond. There is no persistent WebSocket or long-lived connection. Each request is stateless at the transport layer; the only persistent state lives in the Supabase database.

### What it connects

```
AI Agent (MCP Client)
        │
        │  HTTP POST — JSON-RPC 2.0 body
        │  Authorization: Bearer mcpe_<key>
        ▼
Supabase Edge Function (MCP Server)
        │
        ├──► Supabase DB (api_keys, inboxes, activity_log)
        │
        ├──► Gmail API  (googleapis.com)
        ├──► Microsoft Graph API  (graph.microsoft.com)
        └──► Fastmail IMAP/SMTP  (imap.fastmail.com)
```

The Edge Function is the only component that touches both the API key authentication database and the email provider APIs. No other part of the system has this access.

---

## 2. Transport Layer

MCPEmails uses the **Streamable HTTP transport** as specified in MCP. This transport uses HTTP POST for all client-to-server messages. Server-Sent Events (SSE) for streaming are not implemented in the initial version; all responses are returned as a single HTTP response body.

### Endpoint

```
POST https://mcp.mcpemails.com
```

All MCP messages — `initialize`, `tools/list`, `tools/call`, and `notifications/initialized` — are sent to the same endpoint via HTTP POST.

### Request shape

```
POST / HTTP/1.1
Host: mcp.mcpemails.com
Content-Type: application/json
Authorization: Bearer mcpe_live_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7
Accept: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Required headers:**

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `application/json` | Body is always JSON |
| `Authorization` | `Bearer mcpe_<key>` | API key authentication |
| `Accept` | `application/json` | Non-streaming response |

**Optional headers:**

| Header | Purpose |
|--------|---------|
| `X-Request-ID` | Client-provided correlation ID; echoed in response for tracing |
| `User-Agent` | Logged to `activity_log.user_agent` for diagnostics |

### Response shape

All responses are HTTP 200 with `Content-Type: application/json`, regardless of whether the JSON-RPC result represents a success or a tool-level error. HTTP error status codes (4xx, 5xx) are reserved for transport-level failures — authentication rejection, malformed JSON, or Edge Function runtime errors — not for MCP-level errors.

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

**HTTP status codes used:**

| Status | Meaning |
|--------|---------|
| `200 OK` | Valid JSON-RPC request processed (result or error in body) |
| `400 Bad Request` | Body is not valid JSON or not a valid JSON-RPC object |
| `401 Unauthorized` | Missing or malformed `Authorization` header |
| `403 Forbidden` | Valid API key but revoked, expired, or insufficient scope |
| `405 Method Not Allowed` | Request method is not POST |
| `429 Too Many Requests` | API key rate limit exceeded (pre-parse, before JSON-RPC) |
| `500 Internal Server Error` | Unhandled Edge Function exception |

The distinction matters: a `tools/call` that returns `isError: true` inside the result is a `200` response; a completely missing API key is a `401` with no JSON-RPC body.

### Notification handling

MCP notifications (messages without an `id` field) are accepted and acknowledged with HTTP 204 No Content. The primary notification clients send is `notifications/initialized` after a successful `initialize` exchange. The server logs receipt of this notification but takes no other action — all session state is derived from the API key on every request.

---

## 3. JSON-RPC 2.0 Request Lifecycle

Every POST to the MCP endpoint follows this processing pipeline. Steps are sequential; any failure short-circuits to an appropriate error response.

```
 1. Parse HTTP body
 2. Validate JSON-RPC envelope
 3. Authenticate API key (Authorization header)
 4. Check scope for method
 5. Route to method handler
 6. Execute tool (for tools/call)
 7. Write activity_log entry
 8. Return JSON-RPC response
```

### Step 1 — Parse HTTP body

The Edge Function reads the raw request body and parses it as JSON. If the body is not valid JSON, the function returns HTTP 400 immediately, before any JSON-RPC processing:

```
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": "Request body is not valid JSON"}
```

### Step 2 — Validate JSON-RPC envelope

The parsed object is validated for the required JSON-RPC 2.0 fields:

- `jsonrpc` must be exactly `"2.0"`
- `method` must be a non-empty string
- `id` must be present for requests (absent for notifications)
- `params` is optional; if present, must be an object or array

Notifications (no `id`) are handled and acknowledged; they bypass the remaining steps.

Invalid envelopes return a JSON-RPC parse error or invalid request error:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32700,
    "message": "Parse error"
  }
}
```

### Step 3 — Authenticate API key

The `Authorization: Bearer <token>` header is extracted. The raw token value is bcrypt-hashed (cost=12) and compared against `api_keys.key_hash` using a constant-time comparison. This lookup uses the Supabase service-role client because the workspace is not yet known; the key hash itself is the lookup key.

If the key is not found, is revoked (`deleted_at IS NOT NULL`), or is expired (`expires_at < now()`), the function returns HTTP 403 with a JSON-RPC error payload:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Invalid or revoked API key",
    "data": { "hint": "Generate a new key at https://mcpemails.com/settings/keys" }
  }
}
```

On success, the resolved `api_key` row (with `workspace_id`, `scopes[]`, and `inbox_ids[]`) is carried through the rest of the pipeline. The `last_used_at` column is updated asynchronously (fire and forget) to avoid adding latency to the hot path.

### Step 4 — Check scope for method

Before dispatching to a method handler, the server checks that the resolved API key's `scopes` array authorises the operation:

| Method | Required scope |
|--------|---------------|
| `initialize` | None (always permitted) |
| `tools/list` | None (always permitted) |
| `tools/call` with `read:email` tools | `read:email` |
| `tools/call` with `send:email` tools | `send:email` |
| `tools/call` with `manage:drafts` tools | `manage:drafts` |
| `tools/call` with `manage:folders` tools | `manage:folders` |

Scope enforcement for `tools/call` is deferred to the tool registry dispatcher (step 6), not done as a blanket check here, because the required scope depends on which tool is being called.

### Step 5 — Route to method handler

The `method` field routes to one of four handlers:

```typescript
switch (request.method) {
  case "initialize":            return handleInitialize(request);
  case "notifications/initialized": return handleNotification(request);
  case "tools/list":            return handleToolsList(request, apiKey);
  case "tools/call":            return handleToolsCall(request, apiKey);
  default:                      return methodNotFound(request);
}
```

Unknown methods return a JSON-RPC method-not-found error (`-32601`).

### Step 6 — Execute tool (tools/call only)

The tool registry resolves the named tool, validates arguments against its `inputSchema`, confirms the API key has the required scope, loads the relevant inbox credentials from the database, and calls the tool handler. See section 6 for the full registry design.

### Step 7 — Write activity_log entry

After every `tools/call` (success or error), an entry is appended to `activity_log` using the service-role client. This insert is awaited before returning the response to ensure the audit trail is complete even if the client disconnects. Fields written:

- `workspace_id` — from the resolved API key
- `api_key_id` — the key used for this call
- `inbox_id` — the inbox the tool operated on (nullable)
- `tool_name` — the tool invoked
- `status` — `'success'` | `'error'` | `'rate_limited'`
- `error_code` — populated if status is `'error'`
- `duration_ms` — wall-clock time from step 5 entry to tool completion
- `ip_address` — from the incoming request
- `user_agent` — from the `User-Agent` header

`initialize` and `tools/list` calls are not logged (they carry no sensitive operation semantics and would pollute the activity feed with noise).

### Step 8 — Return JSON-RPC response

The method handler returns a `JsonRpcResponse` object which is serialised and returned as HTTP 200.

---

## 4. Supported Methods

### `initialize`

The mandatory capability negotiation handshake. The client sends its capabilities and protocol version; the server responds with its own capabilities and identity.

**The server does not maintain session state between requests.** Each `initialize` call is idempotent. The API key resolved in step 3 determines which capabilities are available; there is no per-connection state.

**Supported protocol version:** `2025-06-18`

If the client sends an older or newer protocol version, the server always responds with `2025-06-18`. The MCP specification permits servers to negotiate down; clients that strictly require a different version must handle the mismatch on their side.

### `notifications/initialized`

Acknowledged with HTTP 204. No server-side logic; this notification is part of the MCP handshake but carries no actionable information for a stateless server.

### `tools/list`

Returns the complete list of tools registered in the tool registry. Supports an optional `cursor` parameter for pagination, though the initial implementation returns all tools in a single response (the tool list is static and small enough that pagination is unnecessary).

The list is scoped by the API key's `scopes[]`: a key with only `read:email` will not see `send_email` in the tool list. This prevents AI agents from discovering tools they cannot call.

### `tools/call`

Invokes a named tool with the provided arguments. The full dispatch sequence is:

1. Look up the tool by `params.name` in the registry
2. Validate `params.arguments` against `inputSchema` (Zod)
3. Confirm the API key has the tool's required scope
4. Confirm the requested `inbox_id` (if provided) is in `api_key.inbox_ids` (or that `inbox_ids` is null, meaning all inboxes)
5. Load inbox credentials from the database
6. Execute the provider-specific implementation
7. Return result or execution error

### Adding new methods

New JSON-RPC methods are added by:
1. Adding a `case` to the router switch
2. Implementing the handler function
3. Documenting the required scope (or none)
4. Adding integration tests

MCP resources and prompts are not implemented in the initial version. If they are added later, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` would follow the same pattern.

---

## 5. Capability Negotiation

The `initialize` exchange is the first thing every MCP client does. The server's response declares what the client can expect to use. MCPEmails declares a conservative, accurate capability set.

### Server capability declaration

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": {
        "listChanged": false
      }
    },
    "serverInfo": {
      "name": "mcpemails",
      "version": "1.0.0"
    }
  }
}
```

**`tools.listChanged: false`** — The tool list does not change at runtime. MCPEmails tools are a fixed, versioned set. If a new tool is added, it ships in a new deployment (with a version bump in `serverInfo.version`). Clients should not subscribe to `notifications/tools/list_changed` events; none will be emitted. This is set to `false` rather than omitted because explicitly declaring false communicates intent rather than relying on omission semantics.

**No `resources` capability** — Resources are not implemented. Clients that attempt `resources/list` will receive a `-32601 Method not found` error.

**No `prompts` capability** — Prompts are not implemented.

**No `logging` capability** — Server-to-client log messages are not implemented. Internal logs go to Supabase Edge Function logs, not to the MCP client.

### Client capabilities the server honours

The server reads `params.capabilities` from the client's `initialize` request but does not use any client capabilities in the initial version. `elicitation`, `sampling`, and `roots` client capabilities are noted but ignored. This is valid: the server simply does not exercise those client primitives.

### Version compatibility

| Client protocol version | Server behaviour |
|------------------------|-----------------|
| `2025-06-18` | Full support |
| Any earlier version | Responds with `2025-06-18`; may succeed or fail depending on client tolerance |
| Any future version | Responds with `2025-06-18`; client must handle negotiation |

---

## 6. Tool Registry

The tool registry is the central data structure that maps tool names to their schemas and handler functions. It is a static, in-memory registry built at module load time (benefiting from Edge Function warm starts — see section 8).

### Tool definition type

```typescript
interface ToolDefinition {
  /** Unique name used in tools/list and tools/call */
  name: string;
  /** Human-readable label shown in MCP client UIs */
  title: string;
  /** Detailed description for the AI agent */
  description: string;
  /** Zod schema for argument validation and inputSchema generation */
  argsSchema: z.ZodObject<any>;
  /** Which api_keys.scopes[] value is required to invoke this tool */
  requiredScope: "read:email" | "send:email" | "manage:drafts" | "manage:folders";
  /** The implementation; receives validated args and an authenticated InboxContext */
  handler: (args: unknown, ctx: InboxContext) => Promise<ToolResult>;
}

interface InboxContext {
  /** The resolved inbox row (credentials decrypted) */
  inbox: DecryptedInbox;
  /** The resolved api_key row */
  apiKey: ApiKey;
  /** Supabase client scoped to service_role for activity_log writes */
  supabase: SupabaseClient;
}

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}
```

### Tool registration

Tools are registered at module initialisation using a registry singleton:

```typescript
// supabase/functions/mcp/registry.ts

import { ToolRegistry } from "./tool-registry.ts";
import { listInboxTool } from "./tools/list-inbox.ts";
import { readEmailTool } from "./tools/read-email.ts";
import { searchEmailTool } from "./tools/search-email.ts";
import { sendEmailTool } from "./tools/send-email.ts";
import { replyToEmailTool } from "./tools/reply-to-email.ts";
import { forwardEmailTool } from "./tools/forward-email.ts";
import { createDraftTool } from "./tools/create-draft.ts";

export const registry = new ToolRegistry();

registry.register(listInboxTool);
registry.register(readEmailTool);
registry.register(searchEmailTool);
registry.register(sendEmailTool);
registry.register(replyToEmailTool);
registry.register(forwardEmailTool);
registry.register(createDraftTool);
```

### Tool discovery (tools/list)

The `handleToolsList` function serialises registered tools into the MCP `tools/list` response format. The `argsSchema` is converted to a JSON Schema object (using `zodToJsonSchema`) for the `inputSchema` field:

```typescript
async function handleToolsList(
  request: JsonRpcRequest,
  apiKey: ApiKeyRow
): Promise<JsonRpcResponse> {
  const tools = registry.list()
    .filter(tool => apiKey.scopes.includes(tool.requiredScope))
    .map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.argsSchema),
    }));

  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { tools },
  };
}
```

Scope filtering here means the client's AI agent is only informed about tools it is allowed to call. This reduces noise in the agent's reasoning and prevents it from attempting calls that would fail on scope grounds.

### Tool dispatch (tools/call)

```typescript
async function handleToolsCall(
  request: JsonRpcRequest,
  apiKey: ApiKeyRow
): Promise<JsonRpcResponse> {
  const { name, arguments: rawArgs } = request.params as { name: string; arguments: unknown };

  // 1. Look up tool
  const tool = registry.get(name);
  if (!tool) {
    return jsonRpcError(request.id, -32602, `Unknown tool: ${name}`);
  }

  // 2. Check scope
  if (!apiKey.scopes.includes(tool.requiredScope)) {
    return jsonRpcError(request.id, -32001, `Insufficient scope: ${tool.requiredScope} required`);
  }

  // 3. Validate arguments
  const parseResult = tool.argsSchema.safeParse(rawArgs);
  if (!parseResult.success) {
    return jsonRpcError(request.id, -32602, "Invalid arguments", parseResult.error.format());
  }

  // 4. Resolve inbox (if args contain inbox_id)
  const inboxId = (parseResult.data as any).inbox_id;
  const inbox = await resolveInbox(inboxId, apiKey);
  if (!inbox) {
    return jsonRpcError(request.id, -32602, "Inbox not found or not accessible");
  }

  // 5. Execute
  const startMs = Date.now();
  let result: ToolResult;
  try {
    result = await tool.handler(parseResult.data, { inbox, apiKey, supabase });
  } catch (err) {
    result = {
      content: [{ type: "text", text: `Tool execution failed: ${err.message}` }],
      isError: true,
    };
  }

  // 6. Log
  await writeActivityLog({ apiKey, inbox, tool, result, durationMs: Date.now() - startMs });

  return {
    jsonrpc: "2.0",
    id: request.id,
    result,
  };
}
```

### Initial tool set

| Tool name | Scope | Provider support | Description |
|-----------|-------|-----------------|-------------|
| `list_inbox` | `read:email` | Gmail, Outlook, Fastmail | List email messages with optional filters |
| `read_email` | `read:email` | Gmail, Outlook, Fastmail | Fetch a single email by ID (headers + body) |
| `search_email` | `read:email` | Gmail, Outlook, Fastmail | Full-text search across an inbox |
| `send_email` | `send:email` | Gmail, Outlook, Fastmail | Compose and send a new email |
| `reply_to_email` | `send:email` | Gmail, Outlook, Fastmail | Reply to an existing email thread |
| `forward_email` | `send:email` | Gmail, Outlook, Fastmail | Forward an email to one or more recipients |
| `create_draft` | `manage:drafts` | Gmail, Outlook | Save a message as a draft without sending |

Each tool's file lives in `supabase/functions/mcp/tools/<tool-name>.ts` and contains the `ToolDefinition` export. Adding a new tool requires only creating the file and adding one `registry.register()` call.

### Provider dispatch within a tool

Each tool handler receives a `DecryptedInbox` that contains a `provider` field (`'gmail'`, `'outlook'`, `'fastmail'`). Tools implement a switch on this field to call the correct provider client:

```typescript
// tools/list-inbox.ts (simplified)
export const listInboxTool: ToolDefinition = {
  name: "list_inbox",
  requiredScope: "read:email",
  handler: async (args, ctx) => {
    switch (ctx.inbox.provider) {
      case "gmail":   return listGmailMessages(args, ctx.inbox);
      case "outlook": return listGraphMessages(args, ctx.inbox);
      case "fastmail": return listImapMessages(args, ctx.inbox);
      default: throw new Error(`Unsupported provider: ${ctx.inbox.provider}`);
    }
  },
  // ...
};
```

---

## 7. Error Codes

MCPEmails uses both the standard JSON-RPC 2.0 error codes and a set of application-specific codes in the `-32001` to `-32099` range (reserved for implementation-defined errors by the JSON-RPC spec).

### Standard JSON-RPC 2.0 codes

| Code | Name | When returned |
|------|------|--------------|
| `-32700` | Parse error | Body is not valid JSON |
| `-32600` | Invalid request | JSON-RPC envelope is malformed (missing `jsonrpc`, `method`, etc.) |
| `-32601` | Method not found | `method` value has no registered handler |
| `-32602` | Invalid params | `arguments` fail schema validation; unknown `tool` name |
| `-32603` | Internal error | Unhandled exception in server code |

### MCPEmails custom codes

| Code | Name | When returned |
|------|------|--------------|
| `-32001` | Invalid API key | Key not found, revoked, expired, or insufficient scope |
| `-32002` | Inbox not found | The specified `inbox_id` does not exist or is not accessible by this API key |
| `-32003` | Provider auth failure | The email provider (Gmail/Outlook/Fastmail) rejected the stored credentials |
| `-32004` | Provider unavailable | The email provider API returned a 5xx or is unreachable |
| `-32029` | Rate limited | The API key has exceeded its call rate limit (100/min, 1000/hr, 10000/day) |

The gap between `-32001` and `-32029` is reserved for future codes. Code `-32029` mirrors the semantic of HTTP 429 because some MCP clients inspect the JSON-RPC error code to determine retry behaviour.

### Two-tier error model

MCP distinguishes between **protocol errors** (invalid JSON-RPC, unknown method) and **tool execution errors** (the tool ran but the operation failed):

**Protocol error** — returned as a JSON-RPC `error` object; `result` is absent:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32602,
    "message": "Unknown tool: delete_everything",
    "data": {}
  }
}
```

**Tool execution error** — returned as a JSON-RPC `result` with `isError: true`; the `error` field is absent. This is the correct MCP pattern because the tool itself ran successfully from the protocol's perspective:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Failed to fetch emails: Gmail API returned 403 Forbidden (token revoked). The user must reconnect their Gmail account at https://mcpemails.com/inboxes."
      }
    ],
    "isError": true
  }
}
```

Tool execution errors include actionable human-readable messages because these strings are surfaced directly to the AI agent, which uses them to decide next steps or to communicate the situation to the end user.

### Rate limiting detail

Rate limiting is enforced at two points:

1. **Pre-parse (HTTP layer)**: Before reading the request body, the Edge Function queries `activity_log` to count calls in the last 60 seconds for the incoming API key hash. If the count exceeds 100, the function returns HTTP 429 with a `Retry-After` header immediately, without executing any JSON-RPC processing:

   ```
   HTTP/1.1 429 Too Many Requests
   Retry-After: 23
   Content-Type: application/json

   {"error": "rate_limit_exceeded", "retry_after": 23}
   ```

2. **JSON-RPC error (for edge cases)**: If the rate limit check is bypassed due to a race condition (two concurrent requests both pass the check), the tool handler detects the overflow during the `activity_log` insert and returns a JSON-RPC `-32029` error in the response body with `isError: true`.

The pre-parse check uses a fast counting query against the current month's `activity_log` partition:

```sql
SELECT COUNT(*) FROM activity_log
WHERE api_key_id = $1
  AND created_at > now() - interval '60 seconds';
```

A dedicated index on `(api_key_id, created_at DESC)` makes this query sub-millisecond.

---

## 8. Cold Start Mitigations

Supabase Edge Functions run on the Deno runtime. Each function instance is a fresh Deno isolate. After a period of inactivity, instances are evicted and the next request must wait for a cold start: loading the module, initialising global state, and establishing database connections.

Cold starts are unavoidable in the serverless model, but their impact can be minimised through several design choices.

### Keep module initialisation cheap

All module-level code (executed at cold start) is intentionally minimal:
- The tool registry is built synchronously from in-memory objects (no I/O)
- No database connections are established at module load; connections are lazy
- No environment variable fetching happens at module load beyond what Deno caches

The only module-level I/O is the Supabase client construction, which is deferred to first request.

### Supabase connection pooling via PgBouncer

Supabase's infrastructure fronts PostgreSQL with PgBouncer in transaction-mode pooling. Edge Function instances do not hold persistent database connections between requests; each invocation acquires a connection from the pool for the duration of its transaction and releases it immediately. This means cold starts do not need to establish new TCP connections to PostgreSQL — PgBouncer maintains a warm pool regardless of Edge Function instance churn.

### Structured for minimal request overhead

The common code path (authenticate → dispatch → execute → log) is designed to touch the database exactly three times per `tools/call`:
1. `SELECT` from `api_keys` to authenticate and resolve workspace/scopes
2. `SELECT` from `inboxes` to fetch (encrypted) credentials
3. `INSERT` into `activity_log` to record the call

Steps 1 and 2 are parallelised where possible: once the `api_key` row is resolved and the `inbox_id` is known (from the tool arguments), both the inbox credential fetch and the rate limit count query run concurrently.

### Warm-start scheduling (future)

For workspaces on paid plans, a scheduled ping (every 5 minutes) can be sent to the Edge Function to keep an instance warm. This is not implemented in the initial version because Edge Function warm-up semantics vary and Supabase may handle this at the platform level.

### No module-level singletons that block cold start

Unlike Node.js, Deno isolates do not share state between requests. This means there is no risk of state leaking between calls, but it also means there is no benefit to module-level connection caching. Each request gets a fresh Supabase client. This is the correct and safe behaviour for a multi-tenant system: credential isolation is guaranteed by the isolate boundary, not by application logic.

---

## 9. Example JSON-RPC Exchanges

### 9.1 Full initialize handshake

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "elicitation": {}
    },
    "clientInfo": {
      "name": "claude-desktop",
      "version": "0.10.0"
    }
  }
}
```

**Server responds:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": {
        "listChanged": false
      }
    },
    "serverInfo": {
      "name": "mcpemails",
      "version": "1.0.0"
    }
  }
}
```

**Client sends (notification — no response expected):**

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

**Server responds:** `HTTP 204 No Content`

---

### 9.2 Tool discovery

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

**Server responds (for a key with `read:email` scope only):**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "list_inbox",
        "title": "List Inbox",
        "description": "List email messages in an inbox. Supports filtering by date range, sender, subject, and read status. Returns metadata only — use read_email to fetch full content.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "inbox_id": {
              "type": "string",
              "format": "uuid",
              "description": "The inbox to list emails from"
            },
            "max_results": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 20,
              "description": "Maximum number of emails to return"
            },
            "unread_only": {
              "type": "boolean",
              "default": false,
              "description": "If true, return only unread messages"
            },
            "after_date": {
              "type": "string",
              "format": "date",
              "description": "Return only emails received after this date (ISO 8601)"
            }
          },
          "required": ["inbox_id"]
        }
      },
      {
        "name": "read_email",
        "title": "Read Email",
        "description": "Fetch the full content of a single email including headers, text body, HTML body, and attachment metadata. Does not download attachment binary data.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "inbox_id": {
              "type": "string",
              "format": "uuid",
              "description": "The inbox containing the email"
            },
            "message_id": {
              "type": "string",
              "description": "Provider-specific message ID returned by list_inbox"
            }
          },
          "required": ["inbox_id", "message_id"]
        }
      },
      {
        "name": "search_email",
        "title": "Search Email",
        "description": "Full-text search across an inbox. Uses the provider's native search (Gmail search syntax for Gmail, Outlook KQL for Outlook, IMAP SEARCH for Fastmail).",
        "inputSchema": {
          "type": "object",
          "properties": {
            "inbox_id": {
              "type": "string",
              "format": "uuid",
              "description": "The inbox to search"
            },
            "query": {
              "type": "string",
              "description": "Search query string"
            },
            "max_results": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 20
            }
          },
          "required": ["inbox_id", "query"]
        }
      }
    ]
  }
}
```

---

### 9.3 Successful tools/call — list_inbox

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_inbox",
    "arguments": {
      "inbox_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "max_results": 5,
      "unread_only": true
    }
  }
}
```

**Server responds:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 5 unread messages:\n\n1. From: alice@example.com | Subject: Q2 budget review | Date: 2026-05-24T09:15:00Z | ID: msg_18f3a9\n2. From: bob@acme.com | Subject: Re: Project kickoff | Date: 2026-05-24T08:42:00Z | ID: msg_18f3a1\n3. From: noreply@github.com | Subject: [mcpemails/mcpemails] Pull request opened | Date: 2026-05-23T21:07:00Z | ID: msg_18f38c\n4. From: carol@partner.org | Subject: Contract renewal | Date: 2026-05-23T16:30:00Z | ID: msg_18f372\n5. From: dave@vendor.com | Subject: Invoice #2026-0512 | Date: 2026-05-23T11:05:00Z | ID: msg_18f359"
      }
    ],
    "isError": false
  }
}
```

---

### 9.4 Successful tools/call — send_email

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "send_email",
    "arguments": {
      "inbox_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "to": ["alice@example.com"],
      "subject": "Re: Q2 budget review",
      "body": "Hi Alice,\n\nThanks for sending this over. I'll review it and get back to you by EOD.\n\nBest,\nAsgeir",
      "body_format": "text"
    }
  }
}
```

**Server responds:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Email sent successfully. Message ID: msg_18f4b2"
      }
    ],
    "isError": false
  }
}
```

---

### 9.5 Protocol error — unknown tool

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "delete_all_emails",
    "arguments": {}
  }
}
```

**Server responds:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32602,
    "message": "Unknown tool: delete_all_emails",
    "data": {
      "available_tools": ["list_inbox", "read_email", "search_email"]
    }
  }
}
```

---

### 9.6 Protocol error — invalid API key

**Client sends** (with a revoked key):

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/list",
  "params": {}
}
```

**Server responds:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "error": {
    "code": -32001,
    "message": "Invalid or revoked API key",
    "data": {
      "hint": "Generate a new key at https://mcpemails.com/settings/keys"
    }
  }
}
```

---

### 9.7 Tool execution error — provider revoked credentials

**Client sends:**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "list_inbox",
    "arguments": {
      "inbox_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "max_results": 10
    }
  }
}
```

**Server responds** (Gmail revoked the OAuth token):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Unable to access Gmail inbox: OAuth token has been revoked or expired. The user must reconnect their Gmail account at https://mcpemails.com/inboxes. Inbox status has been updated to 'error'."
      }
    ],
    "isError": true
  }
}
```

---

### 9.8 Rate limit exceeded

**Client sends** (101st request in 60 seconds):

The server returns HTTP 429 before parsing the body:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 47

{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32029,
    "message": "Rate limit exceeded",
    "data": {
      "limit": 100,
      "window": "60 seconds",
      "retry_after": 47
    }
  }
}
```

---

## Integration with the Database Schema

The MCP Edge Function interacts with four tables in `public`:

| Table | Operation | Purpose |
|-------|-----------|---------|
| `api_keys` | `SELECT` (service_role) | Authenticate the bearer token; resolve workspace_id and scopes |
| `inboxes` | `SELECT` (service_role) | Load provider credentials for the target inbox |
| `activity_log` | `INSERT` (service_role) | Record every tool invocation |
| `api_keys` | `UPDATE last_used_at` (service_role, async) | Track key usage for dashboard display |

All queries use the `service_role` Supabase client inside the Edge Function. RLS is bypassed for MCP-path queries by design (the workspace is resolved from the key, not from a user JWT). Data isolation between workspaces is enforced in application code: the `inbox_ids` constraint on each API key, validated before any query is executed against a provider's API, guarantees that one workspace's API key cannot be used to access another workspace's inboxes.

See `Documents/Architecture/database-schema.md` and `Documents/Architecture/row-level-security.md` for the full table definitions and RLS policy rationale.

---

## Security Properties

**Bearer token is a secret.** The raw API key must be treated as a credential. It is generated once, shown once, and never stored in plaintext. The Edge Function authenticates by bcrypt-hashing the incoming token and comparing it to `api_keys.key_hash`. An attacker with read access to the database cannot recover usable keys.

**Scope enforcement is not advisory.** The `scopes` check in `handleToolsCall` is a hard gate, not a hint. A key with only `read:email` scope will receive a `-32001` error when calling `send_email`, even if it passes all other validation. The scope check runs before inbox credential loading, so no credentials are fetched for unauthorised calls.

**Inbox ID validation prevents cross-workspace access.** When `api_key.inbox_ids` is not null, the `inbox_id` argument is validated against that allowlist before the inbox is fetched. If the caller supplies an inbox ID from a different workspace, the check fails and no credentials are loaded.

**Credentials are decrypted in-memory, never logged.** OAuth tokens and IMAP passwords are decrypted from their `bytea` ciphertext inside the Edge Function's memory. They are never written to logs, never included in JSON-RPC responses, and discarded as soon as the provider call completes.

**Each request is isolated.** Deno isolates do not share memory between concurrent requests. There is no risk of one request's decrypted credentials being visible to another request running on the same instance.
