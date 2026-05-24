# Edge Functions Architecture

## Purpose

This document is the authoritative reference for how MCPEmails uses Supabase Edge Functions — what runs there, why, what the Deno runtime constrains, and exactly how each function is structured, deployed, and tested. Every section contains implementable code; nothing here is placeholder.

---

## 1. Which Logic Lives in Edge Functions

MCPEmails uses Supabase Edge Functions for exactly three purposes. Everything else runs in Next.js Route Handlers on Vercel.

### 1.1 Function Inventory

| Function | HTTP Trigger | Purpose |
|---|---|---|
| `mcp-server` | `POST` from MCP clients | JSON-RPC 2.0 endpoint for all AI agent tool calls |
| `email-oauth-callback` | `GET` redirect from Gmail / Outlook / Fastmail | OAuth code-for-token exchange; stores encrypted tokens |
| `token-refresh` | Supabase Cron (every 5 min) or on-demand `POST` | Proactive refresh of expiring OAuth tokens |

### 1.2 `mcp-server`

The `mcp-server` function is the only publicly visible MCP endpoint. Every AI agent (Claude Desktop, custom LLM apps, MCP-compatible tools) connects here via HTTP POST. It implements the MCP Streamable HTTP transport over JSON-RPC 2.0.

Why an Edge Function instead of a Next.js Route Handler:

- **Global low latency** — Supabase Edge Functions deploy to 15+ Deno V8 isolate regions. An agent connecting from Tokyo or São Paulo gets a nearby isolate. Next.js Route Handlers on Vercel also have global coverage, but the MCP server benefits from running adjacent to the Supabase database (same infrastructure) for the three database roundtrips it makes per `tools/call`.
- **No JWT coupling** — The MCP transport uses its own API key bearer token scheme (`mcpe_...`). It is entirely decoupled from Supabase Auth sessions. Edge Functions can opt out of Supabase's built-in JWT verification with `--no-verify-jwt`, making this separation clean and explicit.
- **Isolation** — MCP traffic is completely separated from the Next.js dashboard at the transport and runtime level. A spike in agent traffic cannot exhaust Vercel function concurrency limits and affect dashboard users.

### 1.3 `email-oauth-callback`

When a user connects an inbox, their browser is redirected to the email provider's consent page. After approval, the provider redirects back to `https://<project-ref>.supabase.co/functions/v1/email-oauth-callback?code=...&state=...`.

Why an Edge Function instead of a Next.js Route Handler:

- The OAuth state nonce is validated against a row in the Supabase `oauth_states` table. Running this validation inside a Supabase Edge Function eliminates one network hop — the database is adjacent, not remote.
- Token encryption uses `SubtleCrypto` (Web Crypto API, native to the Deno runtime). No npm packages are needed for AES-256-GCM; the implementation is self-contained.
- The callback URL registered with each provider (`REDIRECT_URI`) must be stable and provider-approved. Using a Supabase URL (rather than a Vercel preview URL, which changes per deployment) avoids having to update the registered redirect URI on every preview deployment.

**What this function does:**

1. Validates the `state` nonce against `oauth_states` (prevents CSRF)
2. Exchanges the authorization `code` for access + refresh tokens via the provider's token endpoint
3. Encrypts the tokens with AES-256-GCM using the `ENCRYPTION_KEY` secret
4. Upserts an `inboxes` row with the encrypted tokens, provider metadata, and expiry timestamp
5. Deletes the consumed `oauth_states` row
6. Redirects the browser to the dashboard with a success or error query parameter

### 1.4 `token-refresh`

OAuth access tokens expire — Gmail and Microsoft Graph tokens last ~1 hour. The `token-refresh` function runs on a cron schedule (every 5 minutes) and refreshes any token expiring within the next 10 minutes, keeping all active inboxes continuously authorized.

Why an Edge Function instead of a Next.js Route Handler or a database trigger:

- **Cron integration** — Supabase Cron can invoke an Edge Function on a schedule with no external infrastructure. A Next.js Route Handler would require an external cron service (Vercel Cron, etc.) or a pg_cron job that HTTP-calls Vercel, adding unnecessary indirection.
- **Stateless** — Each invocation queries for expiring tokens, refreshes them, and writes the new tokens back. No persistent process is needed.

### 1.5 What Does NOT Belong in Edge Functions

The 150-second CPU time limit and 512 MB memory cap make some workloads a poor fit for Edge Functions. The following are handled in Next.js Route Handlers (`apps/web/app/api/`) instead:

| Workload | Where it runs | Reason |
|---|---|---|
| Heavy MIME parsing (`email-parsing-pipeline`) | Next.js Route Handler | Multi-megabyte message bodies with complex MIME trees benefit from Node.js's `mailparser` ecosystem; keeping the parsed result in Vercel's serverless compute avoids streaming large blobs through the Edge Function budget |
| Large attachment proxying | Next.js Route Handler | Attachment bytes should stream directly from the provider to the browser; routing them through a Deno isolate with a 512 MB cap is a budget risk |
| Long-running IMAP sessions | Next.js Route Handler | Persistent IMAP connections (IDLE mode) require a long-lived process. Edge Functions are request-scoped; the IMAP session would be torn down on function completion. IMAP management lives in a persistent Next.js backend service or a separate Fly.io process |
| Stripe webhook processing | Next.js Route Handler | The `stripe` npm package is Node.js-only; the webhook signature verification relies on it |
| Admin database scripts | Direct Supabase CLI / pg scripts | Migration and one-off data operations are not served over HTTP |

---

## 2. Deno Runtime Constraints

Supabase Edge Functions run on **Deno 1.40+** in a V8 isolate sandbox. Deno's security model and module system are fundamentally different from Node.js. Violations of these constraints produce runtime errors that are difficult to debug in production — every constraint below has been encountered in real Deno Edge Function deployments.

### 2.1 No Node.js Built-ins

Deno does not support Node.js's built-in modules (`crypto`, `buffer`, `fs`, `path`, `stream`, `http`, etc.) unless they are imported via the Node compatibility layer (`node:` prefix, available in Deno ≥ 1.28). Even then, many Node APIs behave differently or are partial stubs.

**Rule: never import from bare `crypto`, `buffer`, or any other Node built-in.** Use Deno or Web standard equivalents.

| Node.js | Deno / Web equivalent |
|---|---|
| `require('crypto').randomBytes(32)` | `crypto.getRandomValues(new Uint8Array(32))` |
| `require('crypto').createHash('sha256')` | `await crypto.subtle.digest('SHA-256', data)` |
| `require('crypto').createCipheriv(...)` | `await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)` |
| `require('crypto').timingSafeEqual(a, b)` | `timingSafeEqual(a, b)` from `https://deno.land/std/crypto/timing_safe_equal.ts` |
| `require('bcrypt')` | `import bcrypt from 'https://esm.sh/bcryptjs@2.4.3'` (pure JS, no native bindings) |
| `require('buffer').Buffer.from(...)` | `new TextEncoder().encode(...)` or `Uint8Array.from(...)` |

**AES-256-GCM encryption example using Web Crypto (no Node.js):**

```typescript
// supabase/functions/_shared/encryption.ts

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // bits

/**
 * Import a raw 32-byte hex key string as a CryptoKey.
 * Call once at module level — the key material is stable across requests.
 */
async function importKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: ALGORITHM },
    false, // not extractable
    ["encrypt", "decrypt"],
  );
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);
  // Prepend IV to ciphertext so the decrypt function can extract it
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(b64Combined: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const combined = Uint8Array.from(atob(b64Combined), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
```

### 2.2 No npm Packages — Use esm.sh or deno.land/x

Deno does not have `node_modules`. Packages are imported by URL. The two approved registries for MCPEmails Edge Functions are:

- **`https://esm.sh/<package>@<version>`** — ESM-compatible builds of npm packages. Use for packages that do not rely on Node.js native addons.
- **`https://deno.land/std@<version>/...`** — Deno's standard library. Use for utilities like `crypto/timing_safe_equal`, `encoding/base64`, `http/server`.

**Always pin to an exact version.** Floating imports (`esm.sh/zod`) will resolve to different versions at cold start time if the CDN cache misses, causing hard-to-reproduce bugs.

```typescript
// Good — pinned versions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { z } from "https://esm.sh/zod@3.22.4";
import { timingSafeEqual } from "https://deno.land/std@0.208.0/crypto/timing_safe_equal.ts";

// Bad — unpinned, will drift
import { createClient } from "https://esm.sh/@supabase/supabase-js";
import { z } from "https://esm.sh/zod";
```

Packages that require native Node.js addons (e.g., `bcrypt` — the C++ variant, not `bcryptjs`) will fail silently or throw an import error. Use the pure-JS alternatives:

| Avoid | Use instead |
|---|---|
| `bcrypt` (native) | `bcryptjs` via `esm.sh/bcryptjs@2.4.3` |
| `sharp` (image processing) | Not available in Edge Functions; move workload to Next.js |
| `canvas` | Not available; use an external service |
| `node-gyp`-based packages | Not available; find a WASM or pure-JS equivalent |

### 2.3 Resource Limits

| Resource | Limit | Practical Implication |
|---|---|---|
| Memory | 512 MB | Do not buffer large email bodies in memory; stream or paginate |
| CPU time | 150 seconds | Appropriate for API calls and database queries; not for IMAP IDLE or batch processing |
| Bundle size | ~500 KB per function (informal target) | Import only the modules you need; do not import entire provider SDKs |
| Execution timeout | 150 seconds | Long-running operations must be chunked or offloaded |

The 512 MB memory limit applies to the entire isolate, including the Deno runtime itself. In practice, functions should stay well under 100 MB for email operations. If a single `read_email` call returns a message body that, after decoding, is 20 MB of HTML, that is still well within budget.

### 2.4 Bundle Size Budget: < 500 KB Per Function

Deno bundles imports into the function's deployment artifact. Large dependencies increase both bundle size and cold start time.

**Approach:** import subpaths rather than entire packages where possible.

```typescript
// Good — only imports the createClient factory
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Avoid importing an entire SDK when you need one method
// e.g., do not import the entire googleapis npm package — use fetch() against the REST API
const response = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20`,
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
```

### 2.5 Cold Start Target: < 300 ms (Function-Internal)

The Deno runtime initialises a new isolate for each cold-start request. The function's module-level code (top-level `import` statements and any statements outside the `serve` handler) runs during this initialisation. Keep it cheap:

- Do not make database calls at module level.
- Do not make HTTP calls at module level.
- Build the tool registry synchronously from in-memory objects.
- Pre-compile regex patterns at module level (the cost is borne once per cold start, amortised across warm requests).

End-to-end cold start target (including Supabase's platform boot time) is **p95 < 500 ms**. Function-internal cold start (module load + first request) should be **< 300 ms**.

---

## 3. Request / Response Shape

### 3.1 Standard Request Object

All Edge Functions receive a standard Web API `Request` object and must return a `Response` object. This is the Fetch API — the same interface used in browser service workers.

```typescript
// Entry point signature for every Edge Function
Deno.serve(async (req: Request): Promise<Response> => {
  // req.method, req.url, req.headers, req.json(), req.text(), req.body
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

### 3.2 CORS Headers for Browser Clients

The Next.js dashboard makes browser-side fetch calls to Edge Functions (for OAuth initiation status and inbox connection confirmation). CORS headers are required for any function that may be called from a browser context.

**Required CORS headers:**

```
Access-Control-Allow-Origin: https://mcpemails.com
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Request-ID
Access-Control-Max-Age: 86400
```

For the `mcp-server` function, CORS is less critical (AI agents do not run in browsers), but it is still set to allow testing from browser-based MCP inspector tools and to future-proof the endpoint.

The CORS preflight (`OPTIONS`) request must be handled before any authentication logic, because preflight requests do not carry `Authorization` headers.

```typescript
// supabase/functions/_shared/cors.ts

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_URL") ?? "https://mcpemails.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-ID",
  "Access-Control-Max-Age": "86400",
};

/**
 * Returns a 204 No Content response for CORS preflight requests.
 * Call this before any auth logic in the main handler.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

/**
 * Merges CORS headers into an existing Headers object.
 * Use when constructing a non-preflight Response.
 */
export function withCors(headers: HeadersInit = {}): Headers {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    h.set(k, v);
  }
  return h;
}
```

### 3.3 JSON-RPC 2.0 Response Envelope (`mcp-server`)

All responses from the `mcp-server` function use the JSON-RPC 2.0 envelope. HTTP status 200 is used for all valid requests (including tool-level errors); non-200 status codes indicate transport-level failures only.

**Success response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "isError": false
  }
}
```

**Method-level error (protocol):**
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

**Tool execution error (HTTP 200, `isError: true`):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "Gmail API returned 403. The inbox must be reconnected at https://mcpemails.com/inboxes." }],
    "isError": true
  }
}
```

### 3.4 Error Shape for Non-MCP Endpoints

The `email-oauth-callback` and `token-refresh` functions return a simpler error envelope:

```typescript
// Error shape for non-MCP Edge Functions
interface EdgeFunctionError {
  error: string;   // Human-readable message
  code: string;    // Machine-readable constant (SCREAMING_SNAKE_CASE)
}
```

Examples:

```json
{ "error": "State nonce not found or expired", "code": "INVALID_OAUTH_STATE" }
{ "error": "Token exchange failed: invalid_grant", "code": "OAUTH_TOKEN_EXCHANGE_FAILED" }
{ "error": "Missing required environment variable: GMAIL_CLIENT_SECRET", "code": "CONFIGURATION_ERROR" }
```

---

## 4. Function Structure and File Layout

### 4.1 Annotated File Tree

```
supabase/
├── config.toml                          # Supabase project configuration
├── seed.sql                             # Local development seed data
├── migrations/                          # Timestamped SQL migration files
│   └── ...
│
└── functions/
    │
    ├── _shared/                         # Shared utilities — imported by all functions
    │   ├── cors.ts                      # CORS headers + preflight handler
    │   ├── supabase.ts                  # Supabase client factory (service role + user JWT variants)
    │   ├── auth.ts                      # API key extraction and validation against api_keys table
    │   ├── encryption.ts                # AES-256-GCM encrypt/decrypt (Web Crypto API, no Node)
    │   └── json-rpc.ts                  # JSON-RPC 2.0 types and response helpers
    │
    ├── mcp-server/                      # Primary MCP endpoint — AI agents connect here
    │   ├── index.ts                     # Entry point: Deno.serve, CORS, routing
    │   ├── handlers/
    │   │   ├── initialize.ts            # MCP initialize handshake
    │   │   ├── tools-list.ts            # tools/list — returns scope-filtered tool list
    │   │   └── tools-call.ts            # tools/call — validates, dispatches, logs
    │   ├── registry.ts                  # Tool registry singleton
    │   └── tools/
    │       ├── list-inbox.ts            # list_inbox tool definition and handler
    │       ├── read-email.ts            # read_email tool definition and handler
    │       ├── search-email.ts          # search_email tool definition and handler
    │       ├── send-email.ts            # send_email tool definition and handler
    │       ├── reply-to-email.ts        # reply_to_email tool definition and handler
    │       ├── forward-email.ts         # forward_email tool definition and handler
    │       └── create-draft.ts          # create_draft tool definition and handler
    │
    ├── email-oauth-callback/            # OAuth redirect target registered with providers
    │   └── index.ts                     # Validates state, exchanges code, stores tokens, redirects
    │
    └── token-refresh/                   # Cron-invoked OAuth token refresher
        └── index.ts                     # Finds expiring tokens, refreshes, updates DB
```

### 4.2 Why `_shared/` Uses a Leading Underscore

The Supabase CLI deploys each directory under `functions/` as a separate Edge Function — **unless** the directory name starts with an underscore. The `_shared/` convention tells the CLI that these files are not standalone functions; they are utilities imported by the real functions. Without the underscore, the CLI would attempt to deploy `_shared/` as a function and fail.

Imports from `_shared/` use a relative path:

```typescript
// Inside supabase/functions/mcp-server/index.ts
import { handleCors, withCors } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { validateApiKey } from "../_shared/auth.ts";
```

---

## 5. Supabase Client in Edge Functions

### 5.1 Two Client Modes

Edge Functions use two distinct Supabase client configurations depending on the operation:

| Mode | Key used | RLS | When to use |
|---|---|---|---|
| Service role | `SUPABASE_SERVICE_ROLE_KEY` | Bypassed | Internal operations: auth validation, token reads/writes, activity logging |
| User JWT | User's JWT from request | Enforced | User-scoped reads where RLS should be the enforcement layer |

The `mcp-server` function exclusively uses the service role client. It does not receive a Supabase Auth JWT from MCP clients — those clients authenticate via the MCPEmails API key, not a Supabase session. Data isolation is enforced in application code (inbox ID allowlist on each API key), not via RLS on the MCP path.

The `email-oauth-callback` function uses the service role client for all database writes. The OAuth callback is a server-side operation; there is no user session in the Deno runtime at callback time.

### 5.2 `_shared/supabase.ts`

```typescript
// supabase/functions/_shared/supabase.ts

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Fail fast at cold start — missing env vars are a configuration error,
  // not a runtime error. The function will not serve any requests.
  throw new Error(
    "Missing required environment variables: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY",
  );
}

/**
 * Creates a Supabase client using the service role key.
 * Bypasses Row-Level Security — use only for internal operations
 * where application-level access control has already been enforced.
 *
 * Do NOT use this client for user-facing data reads unless the
 * calling code has validated access via the API key's inbox_ids allowlist.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: {
      // Edge Functions do not maintain user sessions; disable auto-refresh
      // and persistence to avoid unexpected token storage behaviour.
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        // Tag requests to the database with the function name for debugging.
        "x-supabase-edge-function": Deno.env.get("SUPABASE_FUNCTION_NAME") ?? "unknown",
      },
    },
  });
}

/**
 * Creates a Supabase client that enforces RLS using the user's JWT.
 * Use this when the operation should be scoped to exactly what the
 * authenticated user is allowed to read or write.
 *
 * @param userJwt - The bearer token extracted from the request
 *                  Authorization header (a Supabase Auth JWT, NOT an mcpe_ key)
 */
export function createUserClient(userJwt: string): SupabaseClient {
  return createClient(SUPABASE_URL!, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: {
      headers: { Authorization: `Bearer ${userJwt}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
```

### 5.3 Environment Variable Availability

The Supabase runtime automatically injects two variables into every Edge Function without any manual configuration:

| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Always present; set by Supabase infrastructure |
| `SUPABASE_SERVICE_ROLE_KEY` | The project's service role JWT | Always present; set by Supabase infrastructure |

All other variables (OAuth client IDs/secrets, `ENCRYPTION_KEY`, `APP_URL`) must be set manually using `supabase secrets set`. They are encrypted at rest in Supabase's vault and injected at runtime.

---

## 6. Cold Start Mitigations

Cold starts are unavoidable in serverless V8 isolate runtimes. The strategies below keep them short and their impact on users minimal.

### 6.1 Top-Level Imports (Not Inline)

Imports at the top of the file are resolved and compiled once when the isolate starts. Imports inside the request handler are re-resolved on every request (or require dynamic import machinery). Always put imports at the module level.

```typescript
// Good — V8 pre-compiles these at cold start
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { z } from "https://esm.sh/zod@3.22.4";
import { handleCors } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  // req handler body — no imports here
});

// Bad — re-imported on every request, defeats compilation cache
Deno.serve(async (req) => {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.39.3");
  // ...
});
```

### 6.2 Dynamic Imports for Rarely-Used Code Paths

The one exception to the top-level rule: if a code path is taken by < 5% of requests and its import adds > 50 KB to the bundle, use a dynamic import so cold starts for the 95% case are not penalised.

```typescript
// Example: the token-refresh function only needs the Outlook token refresh
// logic on the rare occasion it finds an Outlook inbox near expiry.
// Dynamic import keeps the common path lean.
if (inbox.provider === "outlook") {
  const { refreshOutlookToken } = await import("./providers/outlook-refresh.ts");
  newTokens = await refreshOutlookToken(inbox);
}
```

### 6.3 Pre-Compile Regex at Module Level

Regex compilation is non-trivial. Patterns used in authentication (API key format validation) or request routing must be compiled once at module load, not inside the handler.

```typescript
// supabase/functions/mcp-server/index.ts

// Pre-compiled at module load — zero cost per request
const API_KEY_PATTERN = /^mcpe_[1-9A-HJ-NP-Za-km-z]{43}$/;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Pattern already compiled — this is a fast bytecode execution, not compilation
  if (!API_KEY_PATTERN.test(token)) {
    return new Response(JSON.stringify({ error: "Invalid API key format" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // ...
});
```

### 6.4 No Large JSON Imports

Do not `import config from "./config.json"` with large objects. JSON imports are parsed and held in memory for the lifetime of the isolate. Fetch configuration from the database on first request (with a module-level cache variable) or use environment variables for small values.

```typescript
// Avoid — large static JSON parsed at cold start
import PROVIDER_CAPABILITIES from "./provider-capabilities.json";

// Prefer — small, inlined constants
const SUPPORTED_PROVIDERS = ["gmail", "outlook", "fastmail"] as const;
type Provider = typeof SUPPORTED_PROVIDERS[number];
```

### 6.5 Connection Pooling via PgBouncer

Supabase fronts PostgreSQL with PgBouncer in **transaction-mode pooling**. Edge Function isolates do not hold persistent TCP connections between requests. Each request borrows a connection from the pool for the duration of its transaction and releases it immediately. PgBouncer maintains warm connections regardless of isolate churn, so cold-started isolates do not pay a TCP handshake cost to the database.

This means the database connection "setup" for a cold start is actually just creating the Supabase JS client object (cheap, synchronous) — not a real TCP connection.

### 6.6 Parallelising Database Queries

The `mcp-server` function makes three database queries per `tools/call`. Steps 1 (API key lookup) and 2 (inbox credential fetch) can be parallelised once the `inbox_id` is known from the tool arguments:

```typescript
// Parse JSON-RPC body first to extract inbox_id from arguments
const body = await req.json();
const inboxId = body?.params?.arguments?.inbox_id;
const rawToken = extractBearerToken(req);

// Run both DB queries concurrently
const [apiKeyResult, inboxResult] = await Promise.all([
  supabase.from("api_keys").select("*").eq("key_hash", await hashToken(rawToken)).single(),
  inboxId
    ? supabase.from("inboxes").select("*").eq("id", inboxId).single()
    : Promise.resolve({ data: null, error: null }),
]);
```

This reduces the hot-path database latency from two sequential roundtrips to one parallel roundtrip.

### 6.7 Cold Start Target Summary

| Metric | Target |
|---|---|
| Module load (imports + top-level code) | < 100 ms |
| First request handling (after module load) | < 200 ms |
| p95 end-to-end cold start (including platform boot) | < 500 ms |
| p50 end-to-end warm request | < 80 ms |

---

## 7. Deployment

### 7.1 Deploying a Function

```bash
# Deploy a single function
supabase functions deploy mcp-server --project-ref <project-ref>

# Deploy with JWT verification disabled (required for mcp-server,
# which uses its own API key auth instead of Supabase Auth JWTs)
supabase functions deploy mcp-server \
  --project-ref <project-ref> \
  --no-verify-jwt

# Deploy all functions at once (for initial setup or full redeploy)
supabase functions deploy --project-ref <project-ref>
```

The `--no-verify-jwt` flag tells Supabase's gateway to pass ALL requests through to the function, including those without a `Authorization: Bearer <supabase-jwt>` header. The function itself performs authentication using the MCPEmails API key. Without this flag, Supabase would reject requests that don't carry a valid Supabase Auth JWT before they reach the function code.

`email-oauth-callback` and `token-refresh` do **not** use `--no-verify-jwt` — they are either called by the Supabase runtime internally (cron) or handle their own auth via state nonce validation.

### 7.2 Environment Variables: `supabase secrets set`

Edge Function environment variables are set via the Supabase CLI's secrets store, not via `.env` files or Vercel environment settings. Secrets are encrypted at rest and injected at function runtime.

```bash
# Required secrets for Edge Functions
# Run once per environment (replace <project-ref> with your Supabase project reference)

supabase secrets set \
  ENCRYPTION_KEY="<64-char hex string — 32 bytes — generated with: openssl rand -hex 32>" \
  --project-ref <project-ref>

supabase secrets set \
  GMAIL_CLIENT_ID="<from Google Cloud Console>" \
  GMAIL_CLIENT_SECRET="<from Google Cloud Console>" \
  --project-ref <project-ref>

supabase secrets set \
  OUTLOOK_CLIENT_ID="<from Azure App Registration>" \
  OUTLOOK_CLIENT_SECRET="<from Azure App Registration>" \
  --project-ref <project-ref>

supabase secrets set \
  FASTMAIL_CLIENT_ID="<from Fastmail Developer Settings>" \
  FASTMAIL_CLIENT_SECRET="<from Fastmail Developer Settings>" \
  --project-ref <project-ref>

supabase secrets set \
  APP_URL="https://mcpemails.com" \
  --project-ref <project-ref>
```

**Never set Edge Function secrets via Vercel.** Vercel environment variables are injected into the Next.js build and runtime — they are not available inside Supabase Edge Functions. The two secret stores are entirely separate.

### 7.3 Local Development

```bash
# Start the full local Supabase stack (PostgreSQL, Auth, Storage, Edge Functions runtime)
supabase start

# Serve a specific Edge Function with hot reload
# .env.local contains the secrets needed locally (NOT committed to git)
supabase functions serve mcp-server --env-file .env.local

# Serve all functions simultaneously
supabase functions serve --env-file .env.local

# Test the locally-served mcp-server
curl -i \
  --request POST \
  "http://localhost:54321/functions/v1/mcp-server" \
  --header "Authorization: Bearer mcpe_<your-local-api-key>" \
  --header "Content-Type: application/json" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'

# Test the oauth callback locally (simulate provider redirect)
curl -i \
  "http://localhost:54321/functions/v1/email-oauth-callback?code=test_code&state=<state-from-oauth_states>"
```

The local Supabase stack runs on these ports:

| Service | Port | URL |
|---|---|---|
| Edge Functions | 54321 | `http://localhost:54321/functions/v1/<function-name>` |
| PostgreSQL | 54322 | `postgresql://postgres:postgres@localhost:54322/postgres` |
| Supabase Studio | 54323 | `http://localhost:54323` |
| Inbucket (email) | 54324 | `http://localhost:54324` |

### 7.4 Verifying Deployment

After deploying, verify the function is live and responding correctly:

```bash
# Check function status via Supabase CLI
supabase functions list --project-ref <project-ref>

# Hit the deployed function directly
curl -i \
  --request OPTIONS \
  "https://<project-ref>.supabase.co/functions/v1/mcp-server" \
  --header "Origin: https://mcpemails.com" \
  --header "Access-Control-Request-Method: POST"
# Expect: 204 with Access-Control-Allow-Origin header

# Verify JSON-RPC envelope is accepted (without valid auth — expect 401/403)
curl -i \
  --request POST \
  "https://<project-ref>.supabase.co/functions/v1/mcp-server" \
  --header "Authorization: Bearer mcpe_invalid" \
  --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expect: JSON-RPC error with code -32001
```

**Checking logs:**

```bash
# Stream live logs from the deployed function
supabase functions logs mcp-server --project-ref <project-ref>

# View last 100 log lines
supabase functions logs mcp-server --project-ref <project-ref> --limit 100
```

Logs are also available in the Supabase Dashboard under **Edge Functions → mcp-server → Logs**. Each log line includes the request ID, duration, and any `console.log` / `console.error` output from the function.

### 7.5 CI/CD Integration

In the GitHub Actions production deployment workflow, Edge Functions are deployed in the `deploy-edge-functions` job, after database migrations and before the Vercel application deployment:

```yaml
# .github/workflows/deploy-production.yml (relevant excerpt)
deploy-edge-functions:
  name: Deploy Supabase Edge Functions
  runs-on: ubuntu-latest
  needs: [migrate]
  env:
    SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
  steps:
    - uses: actions/checkout@v4
    - uses: supabase/setup-cli@v1
      with:
        version: latest
    - name: Deploy mcp-server (custom auth — no JWT verification)
      run: |
        supabase functions deploy mcp-server \
          --project-ref ${{ secrets.SUPABASE_PROJECT_ID }} \
          --no-verify-jwt
    - name: Deploy email-oauth-callback
      run: |
        supabase functions deploy email-oauth-callback \
          --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
    - name: Deploy token-refresh
      run: |
        supabase functions deploy token-refresh \
          --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
```

---

## 8. Shared Utilities

### 8.1 `_shared/auth.ts`

```typescript
// supabase/functions/_shared/auth.ts

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { timingSafeEqual } from "https://deno.land/std@0.208.0/crypto/timing_safe_equal.ts";

// Pre-compiled at module level — no per-request regex construction
const API_KEY_PATTERN = /^mcpe_[1-9A-HJ-NP-Za-km-z]{43}$/;

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  scopes: string[];
  inbox_ids: string[] | null; // null means access to all inboxes in workspace
  expires_at: string | null;
  deleted_at: string | null;
  last_used_at: string | null;
}

export interface AuthResult {
  ok: true;
  apiKey: ApiKeyRow;
}

export interface AuthError {
  ok: false;
  status: number;
  code: number;
  message: string;
}

/**
 * Extracts the bearer token from the Authorization header.
 * Returns null if the header is missing or malformed.
 */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Validates an MCPEmails API key (mcpe_...) against the database.
 *
 * Authentication flow:
 * 1. Check format with regex (fast rejection of garbage tokens)
 * 2. Hash the token with SHA-256 (we store hashes, not raw tokens)
 * 3. Look up the hash in api_keys
 * 4. Verify the key is not revoked or expired
 *
 * @returns AuthResult on success, AuthError on any failure
 */
export async function validateApiKey(
  token: string,
  supabase: SupabaseClient,
): Promise<AuthResult | AuthError> {
  // Fast path: reject tokens that don't match the expected format
  if (!API_KEY_PATTERN.test(token)) {
    return {
      ok: false,
      status: 401,
      code: -32001,
      message: "Malformed API key: expected format mcpe_<43 chars>",
    };
  }

  // Hash the incoming token for database lookup
  const tokenHash = await sha256Hex(token);

  const { data: apiKey, error } = await supabase
    .from("api_keys")
    .select(
      "id, workspace_id, key_hash, key_prefix, name, scopes, inbox_ids, expires_at, deleted_at, last_used_at",
    )
    .eq("key_hash", tokenHash)
    .single();

  if (error || !apiKey) {
    return {
      ok: false,
      status: 403,
      code: -32001,
      message: "Invalid or revoked API key",
    };
  }

  // Check revocation
  if (apiKey.deleted_at !== null) {
    return {
      ok: false,
      status: 403,
      code: -32001,
      message: "API key has been revoked",
    };
  }

  // Check expiry
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    return {
      ok: false,
      status: 403,
      code: -32001,
      message: "API key has expired",
    };
  }

  // Fire-and-forget: update last_used_at without awaiting
  // (avoids adding a write roundtrip to the hot path)
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKey.id)
    .then(() => {}) // explicitly discard the promise
    .catch(console.error);

  return { ok: true, apiKey };
}

/**
 * Computes the SHA-256 hex digest of a string.
 * Uses Web Crypto API (no Node.js crypto required).
 */
async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

### 8.2 `_shared/json-rpc.ts`

```typescript
// supabase/functions/_shared/json-rpc.ts

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/**
 * Constructs a JSON-RPC 2.0 error response object.
 */
export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * Constructs a JSON-RPC 2.0 success response object.
 */
export function rpcSuccess(
  id: string | number | null,
  result: unknown,
): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Serialises a JsonRpcResponse to an HTTP Response with correct headers.
 * Always returns HTTP 200 — HTTP status codes are for transport errors only.
 */
export function toHttpResponse(
  rpc: JsonRpcResponse,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(rpc), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * Standard JSON-RPC 2.0 error codes
 */
export const RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCPEmails custom codes
  INVALID_API_KEY: -32001,
  INBOX_NOT_FOUND: -32002,
  PROVIDER_AUTH_FAILURE: -32003,
  PROVIDER_UNAVAILABLE: -32004,
  RATE_LIMITED: -32029,
} as const;
```

---

## 9. Full `mcp-server/index.ts` Skeleton

This is the complete, annotated entry point for the `mcp-server` Edge Function. It is production-ready — not a toy example. All imports, type annotations, and error paths are present.

```typescript
// supabase/functions/mcp-server/index.ts
//
// MCPEmails MCP Server — Supabase Edge Function (Deno runtime)
//
// Implements the MCP Streamable HTTP transport over JSON-RPC 2.0.
// AI agents connect here via HTTP POST with an mcpe_... bearer token.
//
// Protocol reference: https://spec.modelcontextprotocol.io/specification/2025-06-18/

// ─── Imports ─────────────────────────────────────────────────────────────────
// All imports at the top level so V8 can pre-compile them at cold start.
// Never import inside the request handler.

import { handleCors, withCors } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { extractBearerToken, validateApiKey } from "../_shared/auth.ts";
import {
  JsonRpcRequest,
  JsonRpcResponse,
  RPC_CODES,
  rpcError,
  rpcSuccess,
  toHttpResponse,
} from "../_shared/json-rpc.ts";
import { handleInitialize } from "./handlers/initialize.ts";
import { handleToolsList } from "./handlers/tools-list.ts";
import { handleToolsCall } from "./handlers/tools-call.ts";

// ─── Module-level constants (compiled once at cold start) ─────────────────────

const SERVER_INFO = { name: "mcpemails", version: "1.0.0" } as const;

// Regex pre-compiled at module load — zero cost per request
const REQUEST_ID_HEADER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ─── Entry Point ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = req.headers.get("X-Request-ID") ?? crypto.randomUUID();

  // ── CORS preflight ──────────────────────────────────────────────────────────
  // Must be handled BEFORE auth because OPTIONS requests carry no credentials.
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // ── Method guard ────────────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Only POST is accepted", code: "METHOD_NOT_ALLOWED" }),
      {
        status: 405,
        headers: withCors({ "Content-Type": "application/json" }),
      },
    );
  }

  // ── Parse JSON body ─────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const errResponse = rpcError(null, RPC_CODES.PARSE_ERROR, "Request body is not valid JSON");
    return new Response(JSON.stringify(errResponse), {
      status: 400,
      headers: withCors({ "Content-Type": "application/json" }),
    });
  }

  // ── Validate JSON-RPC 2.0 envelope ──────────────────────────────────────────
  const rpcRequest = parseJsonRpcEnvelope(body);
  if (!rpcRequest.ok) {
    const errResponse = rpcError(
      (body as Record<string, unknown>)?.id as string | number | null ?? null,
      RPC_CODES.INVALID_REQUEST,
      rpcRequest.error,
    );
    return toHttpResponse(errResponse, Object.fromEntries(withCors().entries()));
  }

  const { request } = rpcRequest;

  // ── Handle MCP notifications (no id field) ───────────────────────────────────
  // Notifications are fire-and-forget — acknowledge with 204, no body.
  if (request.id === undefined || request.id === null) {
    // Log the notification for debugging but take no other action.
    console.log(`[${requestId}] Received notification: ${request.method}`);
    return new Response(null, {
      status: 204,
      headers: withCors(),
    });
  }

  // ── Create Supabase client (service role, bypasses RLS) ─────────────────────
  // Instantiated per-request — Deno isolates don't share state between requests.
  const supabase = createServiceClient();

  // ── Authenticate API key ─────────────────────────────────────────────────────
  const token = extractBearerToken(req);
  if (!token) {
    const errResponse = rpcError(
      request.id,
      RPC_CODES.INVALID_API_KEY,
      "Authorization header is missing or malformed. Expected: Authorization: Bearer mcpe_...",
    );
    return new Response(JSON.stringify(errResponse), {
      status: 401,
      headers: withCors({ "Content-Type": "application/json" }),
    });
  }

  const authResult = await validateApiKey(token, supabase);
  if (!authResult.ok) {
    const errResponse = rpcError(request.id, authResult.code, authResult.message, {
      hint: "Generate a new key at https://mcpemails.com/settings/keys",
    });
    return new Response(JSON.stringify(errResponse), {
      status: authResult.status,
      headers: withCors({ "Content-Type": "application/json" }),
    });
  }

  const { apiKey } = authResult;

  // ── Route to method handler ──────────────────────────────────────────────────
  let rpcResponse: JsonRpcResponse;

  try {
    switch (request.method) {
      case "initialize":
        rpcResponse = handleInitialize(request, SERVER_INFO);
        break;

      case "notifications/initialized":
        // Already handled above via the id === null path.
        // This branch is reached only if the client sends a notification WITH an id,
        // which is technically invalid per JSON-RPC 2.0 but we handle gracefully.
        rpcResponse = rpcSuccess(request.id, {});
        break;

      case "tools/list":
        rpcResponse = await handleToolsList(request, apiKey);
        break;

      case "tools/call":
        rpcResponse = await handleToolsCall(request, apiKey, supabase);
        break;

      default:
        rpcResponse = rpcError(
          request.id,
          RPC_CODES.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
          {
            supported_methods: ["initialize", "notifications/initialized", "tools/list", "tools/call"],
          },
        );
    }
  } catch (err) {
    // Catch-all for unhandled exceptions in method handlers.
    // This should never be reached in normal operation — each handler
    // has its own try/catch. If it is reached, it represents a bug.
    console.error(`[${requestId}] Unhandled exception in method handler:`, err);
    rpcResponse = rpcError(
      request.id,
      RPC_CODES.INTERNAL_ERROR,
      "An internal error occurred. The MCPEmails team has been notified.",
    );
  }

  // ── Return JSON-RPC response ─────────────────────────────────────────────────
  return new Response(JSON.stringify(rpcResponse), {
    status: 200,
    headers: withCors({
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    }),
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type EnvelopeParseResult =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; error: string };

/**
 * Parses and validates the JSON-RPC 2.0 envelope.
 * Does not validate method-specific params — that is the handler's responsibility.
 */
function parseJsonRpcEnvelope(body: unknown): EnvelopeParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (obj["jsonrpc"] !== "2.0") {
    return { ok: false, error: 'Field "jsonrpc" must be exactly "2.0"' };
  }

  if (typeof obj["method"] !== "string" || obj["method"].length === 0) {
    return { ok: false, error: 'Field "method" must be a non-empty string' };
  }

  if (
    obj["params"] !== undefined &&
    typeof obj["params"] !== "object"
  ) {
    return { ok: false, error: 'Field "params" must be an object or array if present' };
  }

  // id is optional for notifications (absent = notification);
  // present = request. Both are valid.
  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id: obj["id"] as string | number | null,
      method: obj["method"] as string,
      params: obj["params"] as Record<string, unknown> | undefined,
    },
  };
}
```

---

## 10. `email-oauth-callback/index.ts` Skeleton

```typescript
// supabase/functions/email-oauth-callback/index.ts
//
// Handles the OAuth redirect callback from Gmail, Outlook, and Fastmail.
// The registered redirect URI for all three providers points here.
//
// Flow: provider redirects here with ?code=...&state=...
// This function validates state, exchanges code for tokens,
// encrypts tokens, stores them, and redirects back to the dashboard.

import { createServiceClient } from "../_shared/supabase.ts";
import { encrypt } from "../_shared/encryption.ts";
import { handleCors, CORS_HEADERS } from "../_shared/cors.ts";

const APP_URL = Deno.env.get("APP_URL") ?? "https://mcpemails.com";

// Token endpoint URLs — stable, no need to fetch at runtime
const TOKEN_ENDPOINTS: Record<string, string> = {
  gmail: "https://oauth2.googleapis.com/token",
  outlook: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  fastmail: "https://api.fastmail.com/oauth2/token",
};

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "GET") {
    return errorRedirect("METHOD_NOT_ALLOWED", "Only GET is accepted");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Provider denied access or user cancelled
  if (error) {
    return errorRedirect("OAUTH_DENIED", `Provider returned error: ${error}`);
  }

  if (!code || !state) {
    return errorRedirect("MISSING_PARAMS", "Missing code or state parameter");
  }

  const supabase = createServiceClient();

  // ── Validate state nonce ─────────────────────────────────────────────────────
  const { data: oauthState, error: stateError } = await supabase
    .from("oauth_states")
    .select("*")
    .eq("state", state)
    .gt("expires_at", new Date().toISOString()) // not expired
    .single();

  if (stateError || !oauthState) {
    return errorRedirect("INVALID_OAUTH_STATE", "State nonce not found or expired");
  }

  // Consume the state nonce immediately to prevent replay
  await supabase.from("oauth_states").delete().eq("id", oauthState.id);

  const provider = oauthState.provider as string;
  const tokenEndpoint = TOKEN_ENDPOINTS[provider];
  if (!tokenEndpoint) {
    return errorRedirect("UNKNOWN_PROVIDER", `Unknown provider: ${provider}`);
  }

  // ── Exchange code for tokens ─────────────────────────────────────────────────
  const clientId = Deno.env.get(`${provider.toUpperCase()}_CLIENT_ID`);
  const clientSecret = Deno.env.get(`${provider.toUpperCase()}_CLIENT_SECRET`);

  if (!clientId || !clientSecret) {
    console.error(`Missing OAuth credentials for provider: ${provider}`);
    return errorRedirect("CONFIGURATION_ERROR", "OAuth provider not configured");
  }

  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthState.redirect_uri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    console.error(`Token exchange failed for ${provider}:`, body);
    return errorRedirect("OAUTH_TOKEN_EXCHANGE_FAILED", "Token exchange failed");
  }

  const tokens = await tokenResponse.json();
  const encryptionKey = Deno.env.get("ENCRYPTION_KEY")!;

  // ── Encrypt and store tokens ─────────────────────────────────────────────────
  const encryptedAccessToken = await encrypt(tokens.access_token, encryptionKey);
  const encryptedRefreshToken = tokens.refresh_token
    ? await encrypt(tokens.refresh_token, encryptionKey)
    : null;

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const { error: upsertError } = await supabase.from("inboxes").upsert(
    {
      workspace_id: oauthState.workspace_id,
      user_id: oauthState.user_id,
      provider,
      email: tokens.email ?? null, // Gmail returns email in token response; others do not
      access_token_encrypted: encryptedAccessToken,
      refresh_token_encrypted: encryptedRefreshToken,
      token_expires_at: expiresAt,
      status: "active",
      connected_at: new Date().toISOString(),
    },
    {
      onConflict: "workspace_id, provider, email",
      ignoreDuplicates: false, // Update existing row on reconnect
    },
  );

  if (upsertError) {
    console.error("Failed to store inbox tokens:", upsertError);
    return errorRedirect("DATABASE_ERROR", "Failed to save inbox connection");
  }

  // ── Redirect to dashboard with success ───────────────────────────────────────
  return Response.redirect(
    `${APP_URL}/dashboard/inboxes?connected=${provider}&status=success`,
    302,
  );
});

function errorRedirect(code: string, message: string): Response {
  const params = new URLSearchParams({ error: code, message });
  return Response.redirect(`${APP_URL}/dashboard/inboxes?${params.toString()}`, 302);
}
```

---

## 11. `token-refresh/index.ts` Skeleton

```typescript
// supabase/functions/token-refresh/index.ts
//
// Refreshes OAuth access tokens that are expiring within the next 10 minutes.
// Invoked every 5 minutes by Supabase Cron.
// Can also be triggered on-demand via POST from the dashboard
// when a provider call returns 401 (reactive refresh).

import { createServiceClient } from "../_shared/supabase.ts";
import { encrypt, decrypt } from "../_shared/encryption.ts";
import { handleCors } from "../_shared/cors.ts";

const TOKEN_REFRESH_ENDPOINTS: Record<string, string> = {
  gmail: "https://oauth2.googleapis.com/token",
  outlook: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  fastmail: "https://api.fastmail.com/oauth2/token",
};

// Refresh tokens expiring within this window
const REFRESH_WINDOW_MINUTES = 10;

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const supabase = createServiceClient();
  const encryptionKey = Deno.env.get("ENCRYPTION_KEY")!;

  // Find all inboxes with tokens expiring within the refresh window
  const cutoff = new Date(
    Date.now() + REFRESH_WINDOW_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: expiringInboxes, error } = await supabase
    .from("inboxes")
    .select("id, provider, refresh_token_encrypted, token_expires_at")
    .eq("status", "active")
    .not("refresh_token_encrypted", "is", null)
    .lt("token_expires_at", cutoff);

  if (error) {
    console.error("Failed to query expiring tokens:", error);
    return new Response(
      JSON.stringify({ error: "Database query failed", code: "DATABASE_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const results = { refreshed: 0, failed: 0, skipped: 0 };

  for (const inbox of expiringInboxes ?? []) {
    const endpoint = TOKEN_REFRESH_ENDPOINTS[inbox.provider];
    if (!endpoint) {
      results.skipped++;
      continue;
    }

    const clientId = Deno.env.get(`${inbox.provider.toUpperCase()}_CLIENT_ID`);
    const clientSecret = Deno.env.get(`${inbox.provider.toUpperCase()}_CLIENT_SECRET`);

    if (!clientId || !clientSecret) {
      console.error(`Missing credentials for provider: ${inbox.provider}`);
      results.skipped++;
      continue;
    }

    try {
      const refreshToken = await decrypt(inbox.refresh_token_encrypted!, encryptionKey);

      const refreshParams = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: refreshParams.toString(),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`Token refresh failed for inbox ${inbox.id} (${inbox.provider}):`, body);

        // Mark the inbox as errored so the user is notified in the dashboard
        await supabase
          .from("inboxes")
          .update({ status: "error", error_code: "TOKEN_REFRESH_FAILED" })
          .eq("id", inbox.id);

        results.failed++;
        continue;
      }

      const newTokens = await response.json();
      const newEncryptedAccessToken = await encrypt(newTokens.access_token, encryptionKey);
      const newExpiresAt = newTokens.expires_in
        ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
        : null;

      // Update encrypted access token and expiry
      // Refresh token may rotate (Microsoft rotates on every refresh)
      const updates: Record<string, string | null> = {
        access_token_encrypted: newEncryptedAccessToken,
        token_expires_at: newExpiresAt,
        status: "active",
        error_code: null,
      };

      if (newTokens.refresh_token) {
        updates.refresh_token_encrypted = await encrypt(newTokens.refresh_token, encryptionKey);
      }

      await supabase.from("inboxes").update(updates).eq("id", inbox.id);

      results.refreshed++;
    } catch (err) {
      console.error(`Unexpected error refreshing inbox ${inbox.id}:`, err);
      results.failed++;
    }
  }

  console.log(
    `Token refresh complete — refreshed: ${results.refreshed}, failed: ${results.failed}, skipped: ${results.skipped}`,
  );

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

---

## Cross-References

- **`Documents/Architecture/mcp-server-architecture.md`** — Deep dive into JSON-RPC 2.0 method routing, the tool registry, capability negotiation, and all error codes.
- **`Documents/Architecture/email-provider-oauth-flows.md`** — Per-provider OAuth scope definitions, authorization URL construction, and token lifetimes for Gmail, Outlook, and Fastmail.
- **`Documents/Architecture/deployment-architecture.md`** — CI/CD pipeline, environment separation, `supabase secrets set` procedures, and the full production deployment workflow.
- **`Documents/Architecture/security-architecture.md`** — Credential encryption design (AES-256-GCM), API key hashing (SHA-256), and multi-tenant isolation guarantees.
- **`Documents/Architecture/database-schema.md`** — `api_keys`, `inboxes`, `oauth_states`, and `activity_log` table definitions that Edge Functions read and write.
- **`Documents/Architecture/mcp-authentication-flow.md`** — API key format, scope system, per-request authentication middleware lifecycle, and key revocation.

---

**Version**: 1.0
**Last Updated**: 2026-05-24
**Next Review**: 2026-08-24
