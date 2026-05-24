# MCP Authentication Flow

## Purpose

This document describes how MCPEmails authenticates MCP clients and enforces access control at every layer of the request path. It covers API key format and lifecycle, the scope system, per-request authentication middleware, session binding, per-tool scope enforcement, the OAuth authorize flow for third-party MCP clients, key revocation, and error responses.

The MCP layer uses an entirely separate auth mechanism from the Next.js dashboard. Dashboard users authenticate via Supabase Auth session cookies (magic link / OAuth sign-in). MCP clients authenticate exclusively via API key bearer tokens. A session cookie cannot call MCP tools, and an API key cannot access the dashboard. There is no crossover.

---

## 1. Overview

An API key is a long-lived credential issued to an MCP client that grants access to a scoped subset of the user's inboxes and MCP tools. When an AI agent (e.g., Claude Desktop, a custom LLM application) wants to read or send email on behalf of a user, it connects to the MCPEmails MCP server endpoint and presents the key as a bearer token.

Every inbound MCP request passes through three successive checks before any email operation executes:

1. **Authentication** — is the bearer token a valid, unexpired, unrevoked API key?
2. **Session binding** — which inboxes is this key authorized to access?
3. **Scope enforcement** — does this key carry the scope required by the tool being called?

If any check fails, the request is rejected with a structured error before touching email credentials. Passing all three checks grants the request access to exactly the inbox set and tool set the user configured when issuing the key.

```
MCP Client
    │
    │  POST /mcp  (Authorization: Bearer mcpe_...)
    ▼
┌──────────────────────────────────────────────┐
│  MCP Edge Function                           │
│                                              │
│  1. Extract + hash bearer token              │
│  2. DB lookup → api_keys row                 │
│     (validates: exists, not deleted,         │
│      not expired)                            │
│  3. Load allowed inbox_ids from key row      │
│  4. Dispatch JSON-RPC method                 │
│  5. On tools/call: check scopes              │
│  6. Execute tool → email provider            │
│  7. Append row to activity_log               │
└──────────────────────────────────────────────┘
    │
    ▼
Email Provider (Gmail API / Microsoft Graph / IMAP)
```

---

## 2. API Key Format

### Format

Every API key follows this structure:

```
mcpe_<base58-encoded 32 random bytes>
```

Example:

```
mcpe_3vKq8mN2pXcRtYhJwLdFsAeUbGiZo7nMkCxWqP9y
```

- `mcpe_` — fixed prefix identifying MCPEmails keys; allows users and secret scanners to recognise a leaked key
- The suffix is 32 bytes of output from `crypto.getRandomValues()` (Web Crypto API, available in Supabase Edge Functions), encoded in base58 to avoid ambiguous characters (`0`, `O`, `I`, `l`)
- Total length is predictable (prefix 5 chars + 43 base58 chars = 48 chars), making pattern matching in logs reliable

### Key Prefix (Display Identifier)

The first 8 characters of the suffix (after `mcpe_`) are stored in `api_keys.key_prefix` as a display-only identifier. This prefix is shown in the dashboard so users can identify which key is which without ever exposing the full key again.

```
mcpe_3vKq8mN2...   →   key_prefix = "3vKq8mN2"
```

The prefix is never used for authentication. It is only queried for dashboard rendering.

### Generation

```typescript
function generateApiKey(): { fullKey: string; prefix: string } {
  // 32 bytes = 256 bits of entropy
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);

  const suffix = base58Encode(randomBytes); // custom alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
  const fullKey = `mcpe_${suffix}`;
  const prefix = suffix.slice(0, 8);

  return { fullKey, prefix };
}
```

### Storage

The plaintext key is never written to the database. Immediately after generation:

1. The full key is shown once to the user in the dashboard (a one-time reveal dialog)
2. The full key is hashed with SHA-256
3. Only the hex-encoded hash is stored in `api_keys.key_hash`
4. The plaintext is discarded; it cannot be recovered

```typescript
async function hashApiKey(fullKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(fullKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

The `api_keys` table schema:

```sql
CREATE TABLE public.api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  name          text NOT NULL,             -- e.g. "Claude Desktop"
  key_prefix    text NOT NULL,             -- first 8 chars of suffix, display only
  key_hash      text NOT NULL UNIQUE,      -- SHA-256 hex of full key
  scopes        text[] NOT NULL DEFAULT '{}',
  inbox_ids     uuid[],                    -- null = all active inboxes; array = specific subset
  expires_at    timestamptz,               -- null = never expires
  last_used_at  timestamptz,
  deleted_at    timestamptz,               -- soft delete = revocation
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

**Why SHA-256 and not bcrypt?**

The database schema documentation notes bcrypt at cost=12 as the hash algorithm. SHA-256 is a valid alternative when the input already has high entropy (256 bits of random data). Unlike a low-entropy password, an API key with 256 bits of entropy cannot be brute-forced regardless of hash speed — SHA-256 is appropriate and is fast enough for the hot path of every MCP request without a perceptible latency hit. Both choices are defensible; the implementation must be consistent. This document treats the hashing as SHA-256 for the MCP hot path. The implementation must not mix algorithms across rows.

---

## 3. Scope System

Scopes follow a `<action>:<resource>` naming pattern. When a key is created, the user selects which scopes to grant. A key can carry zero or more scopes; a key with no scopes can authenticate successfully but cannot call any tool.

### Defined Scopes

| Scope | Permitted MCP Tools |
|---|---|
| `read:email` | `list_inbox`, `read_email`, `get_attachment` |
| `search:email` | `search_email` |
| `send:email` | `send_email`, `reply_to_email`, `forward_email` |
| `manage:drafts` | `create_draft`, `update_draft`, `delete_draft` |
| `manage:folders` | `create_folder`, `move_email`, `delete_email` |

### Scope-to-Tool Mapping

The mapping is defined as a static constant in the MCP Edge Function. Tools not listed here are blocked regardless of scopes.

```typescript
const TOOL_SCOPE_REQUIREMENTS: Record<string, string> = {
  list_inbox:      'read:email',
  read_email:      'read:email',
  get_attachment:  'read:email',
  search_email:    'search:email',
  send_email:      'send:email',
  reply_to_email:  'send:email',
  forward_email:   'send:email',
  create_draft:    'manage:drafts',
  update_draft:    'manage:drafts',
  delete_draft:    'manage:drafts',
  create_folder:   'manage:folders',
  move_email:      'manage:folders',
  delete_email:    'manage:folders',
};
```

### Scope Design Principles

Following the least-privilege guidance in the MCP security best practices:

- Scopes are granular by action category; no wildcard or omnibus scopes are supported (`*`, `all`, `full-access` are explicitly rejected at key creation time)
- `search:email` is separate from `read:email` because search results include snippets from all matching messages; an agent that only needs to read specific emails should not need broad search access
- `send:email` does not imply `read:email`; a key that can only send email (e.g., a notification agent) cannot read the inbox
- The set of `scopes_supported` exposed at the MCP server's metadata endpoint lists only these five scopes, not a broader catalog

---

## 4. Request Authentication

Every request to `/mcp` (the Supabase Edge Function that serves the MCP endpoint) runs the auth middleware before dispatching to any MCP method handler.

### Middleware Implementation

```typescript
interface AuthenticatedRequest {
  apiKeyRow: {
    id: string;
    workspace_id: string;
    scopes: string[];
    inbox_ids: string[] | null;  // null means access all active inboxes
    expires_at: string | null;
  };
}

async function authenticateMcpRequest(
  req: Request,
  supabase: SupabaseClient
): Promise<AuthenticatedRequest> {
  // Step 1: Extract bearer token from Authorization header
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new McpAuthError('missing_token', 'Authorization header with Bearer token is required', 401);
  }

  const bearerToken = authHeader.slice(7).trim(); // strip "Bearer "

  if (!bearerToken.startsWith('mcpe_')) {
    throw new McpAuthError('invalid_token', 'Token does not match expected key format', 401);
  }

  // Step 2: Hash the incoming token
  const keyHash = await hashApiKey(bearerToken);

  // Step 3: Look up the hash in the database
  // The query also checks expiry inline; this eliminates a separate check
  const { data: apiKeyRow, error } = await supabase
    .from('api_keys')
    .select('id, workspace_id, scopes, inbox_ids, expires_at, deleted_at')
    .eq('key_hash', keyHash)
    .is('deleted_at', null)                        // not revoked
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`) // not expired
    .single();

  if (error || !apiKeyRow) {
    // Intentionally vague: same error for "not found", "revoked", and "expired"
    // to prevent oracle attacks
    throw new McpAuthError('invalid_token', 'API key is invalid, expired, or has been revoked', 401);
  }

  // Step 4: Update last_used_at asynchronously (fire-and-forget)
  // Do not await — this must not block the request path
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKeyRow.id)
    .then(() => {});

  return { apiKeyRow };
}
```

### What the DB Lookup Validates

A single query handles all authentication checks:

| Check | Mechanism |
|---|---|
| Key exists | `eq('key_hash', keyHash)` matches exactly one row |
| Key not revoked | `.is('deleted_at', null)` excludes soft-deleted rows |
| Key not expired | `.or('expires_at.is.null,expires_at.gt.now()')` |
| Constant-time comparison | SHA-256 hash comparison by the database; not susceptible to timing attacks in the application layer |

---

## 5. Session Binding

After authentication, the `apiKeyRow.inbox_ids` column determines which inboxes the key can touch during the request.

```typescript
async function resolveAccessibleInboxes(
  apiKeyRow: AuthenticatedRequest['apiKeyRow'],
  supabase: SupabaseClient
): Promise<InboxRecord[]> {
  let query = supabase
    .from('inboxes')
    .select('id, email_address, provider, status, oauth_token_expires_at')
    .eq('workspace_id', apiKeyRow.workspace_id)
    .eq('status', 'active')
    .is('deleted_at', null);

  if (apiKeyRow.inbox_ids !== null) {
    // Key is scoped to specific inboxes
    query = query.in('id', apiKeyRow.inbox_ids);
  }
  // else: inbox_ids is null → access all active inboxes in the workspace

  const { data: inboxes, error } = await query;

  if (error) {
    throw new McpInternalError('Failed to resolve inbox access');
  }

  return inboxes ?? [];
}
```

**Key binding decisions:**

- `inbox_ids = null` means "all current and future inboxes in this workspace". This is the default when a key is created from the dashboard without selecting specific inboxes.
- `inbox_ids = ['uuid-a', 'uuid-b']` means "only these two inboxes". If an inbox is later removed from the workspace, it simply does not appear in query results; no special revocation logic is required.
- Row-Level Security on the `inboxes` table additionally constrains the query by `workspace_id` at the database level, so even if application code omitted the workspace filter, the database would enforce it.
- Inboxes with `status = 'error'` are excluded. A tool call against an inbox whose OAuth token has expired or been revoked would fail at the provider level; returning it as inaccessible here gives a cleaner error message to the agent.

The resolved inbox list is attached to the request context and passed to all tool handlers. No tool handler fetches its own inbox list; the list comes exclusively from this resolved set.

---

## 6. Per-Tool Scope Enforcement

Tool dispatch happens after authentication and session binding. When the MCP client sends a `tools/call` request, the scope check runs before the tool's handler is invoked.

```typescript
async function dispatchToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: RequestContext  // contains apiKeyRow and accessible inboxes
): Promise<McpToolResult> {

  // Step 1: Check the tool is known
  const requiredScope = TOOL_SCOPE_REQUIREMENTS[toolName];
  if (requiredScope === undefined) {
    throw new McpError('method_not_found', `Unknown tool: ${toolName}`, -32601);
  }

  // Step 2: Check the key carries the required scope
  if (!context.apiKeyRow.scopes.includes(requiredScope)) {
    throw new McpAuthError(
      'insufficient_scope',
      `Tool '${toolName}' requires scope '${requiredScope}'. ` +
      `This key has: [${context.apiKeyRow.scopes.join(', ')}]`,
      403
    );
  }

  // Step 3: If the tool targets a specific inbox, confirm it is in the accessible set
  const targetInboxId = args['inbox_id'] as string | undefined;
  if (targetInboxId) {
    const allowed = context.accessibleInboxes.some((inbox) => inbox.id === targetInboxId);
    if (!allowed) {
      throw new McpAuthError(
        'insufficient_scope',
        `Inbox '${targetInboxId}' is not accessible with this key`,
        403
      );
    }
  }

  // Step 4: Execute the tool
  return await TOOL_HANDLERS[toolName](args, context);
}
```

**Why enforce scopes at dispatch, not at listing?**

The `tools/list` response can filter the tool list to only those callable with the current key's scopes. This is a good UX improvement (the agent does not try tools it cannot use) but is not a security boundary — a client could call `tools/call` directly with any tool name. The `dispatchToolCall` check is the authoritative enforcement point.

**Inbox-level scoping within a tool call:**

A key scoped to two specific inboxes cannot be used to `list_inbox` and then call `read_email` on an inbox outside that set by crafting the `inbox_id` argument. The explicit inbox membership check (Step 3) blocks this regardless of scope.

---

## 7. The OAuth Authorize Flow

MCPEmails supports standard OAuth 2.0 authorization code flow so that third-party MCP clients (e.g., Claude Desktop, a custom agent framework) can obtain API keys on behalf of users without the user copying and pasting a key manually.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /authorize` | Authorization page shown to the user |
| `POST /api/oauth/token` | Authorization code → API key exchange |
| `GET /api/oauth/metadata` | OAuth server metadata (RFC 8414) |

### Flow Sequence

```
MCP Client                  User's Browser              MCPEmails Server
    │                              │                           │
    │  1. Open /authorize?         │                           │
    │     client_id=...&           │                           │
    │     redirect_uri=...&        │                           │
    │     scope=read:email&        │                           │
    │     state=<random>&          │                           │
    │     code_challenge=...       │                           │
    │─────────────────────────────►│                           │
    │                              │                           │
    │                              │  2. Serve /authorize page │
    │                              │◄──────────────────────────│
    │                              │                           │
    │                              │  3. User logs in (if not) │
    │                              │     User reviews scopes   │
    │                              │     User clicks Approve   │
    │                              │──────────────────────────►│
    │                              │                           │
    │                              │  4. Server validates:     │
    │                              │     - redirect_uri exact  │
    │                              │       match               │
    │                              │     - requested scopes    │
    │                              │       are valid           │
    │                              │     - CSRF state param    │
    │                              │                           │
    │                              │  5. Generate auth code    │
    │                              │     (32 random bytes,     │
    │                              │      10-min TTL, stored   │
    │                              │      hashed in DB)        │
    │                              │                           │
    │  6. Redirect to              │                           │
    │     redirect_uri?code=...    │                           │
    │     &state=<original>        │                           │
    │◄─────────────────────────────│                           │
    │                              │                           │
    │  7. POST /api/oauth/token    │                           │
    │     code=...                 │                           │
    │     code_verifier=...        │                           │
    │     client_id=...            │                           │
    │─────────────────────────────────────────────────────────►│
    │                              │                           │
    │                              │  8. Validate code +       │
    │                              │     PKCE verifier         │
    │                              │     Generate API key      │
    │                              │     Store hash, scopes    │
    │                              │     Hard-delete auth code │
    │                              │                           │
    │  9. Response:                │                           │
    │     { "access_token":        │                           │
    │       "mcpe_...",            │                           │
    │       "token_type": "bearer",│                           │
    │       "scope": "read:email" }│                           │
    │◄─────────────────────────────────────────────────────────│
    │                              │                           │
    │  10. Store API key           │                           │
    │      Use for all future      │                           │
    │      MCP calls               │                           │
```

### Authorization Page (`/authorize`)

The `/authorize` page is a Next.js Server Component that:

1. Reads `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, and `code_challenge_method` from the query string
2. Validates `redirect_uri` by exact string comparison against the registered URI for `client_id` in the `oauth_clients` table; rejects with an error page if it does not match (redirect URI manipulation prevention)
3. Validates each requested scope against the allowed scope catalog; rejects unknown or disallowed scopes
4. If the user is not authenticated, redirects to magic link login, then back to `/authorize` with the original parameters preserved
5. Displays the requesting client's name, the inboxes the user wants to grant access to, and each requested scope with a human-readable description
6. On Approve, calls a Server Action that generates the authorization code and redirects to `redirect_uri?code=<code>&state=<original state>`

**Consent storage:** The user's approval decision is stored per `(user_id, client_id)` pair in an `oauth_consents` table. On a subsequent authorization request from the same client requesting the same or fewer scopes, the consent screen is skipped. If the client requests additional scopes not previously approved, the consent screen is shown again for the new scopes only.

This per-client consent record is what prevents the Confused Deputy attack: even if the provider's consent cookie allows skipping the provider OAuth screen, MCPEmails always shows its own consent UI for new `client_id` registrations.

### Token Endpoint (`POST /api/oauth/token`)

```typescript
export async function POST(req: Request) {
  const body = await req.formData();
  const code         = body.get('code') as string;
  const codeVerifier = body.get('code_verifier') as string;
  const clientId     = body.get('client_id') as string;
  const redirectUri  = body.get('redirect_uri') as string;

  // 1. Look up the auth code (stored as SHA-256 hash, 10-minute TTL)
  const codeHash = await hashValue(code);
  const { data: authCode } = await supabase
    .from('oauth_auth_codes')
    .select('*')
    .eq('code_hash', codeHash)
    .eq('client_id', clientId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!authCode) {
    return errorResponse('invalid_grant', 'Authorization code is invalid or expired', 400);
  }

  // 2. Validate redirect_uri exactly matches what was used at /authorize
  if (authCode.redirect_uri !== redirectUri) {
    return errorResponse('invalid_grant', 'redirect_uri mismatch', 400);
  }

  // 3. Validate PKCE code_verifier against stored code_challenge
  const computedChallenge = base64urlEncode(await sha256(codeVerifier));
  if (computedChallenge !== authCode.code_challenge) {
    return errorResponse('invalid_grant', 'PKCE verification failed', 400);
  }

  // 4. Delete the auth code immediately (single-use enforcement)
  await supabase.from('oauth_auth_codes').delete().eq('id', authCode.id);

  // 5. Generate and persist the API key
  const { fullKey, prefix } = generateApiKey();
  const keyHash = await hashApiKey(fullKey);

  await supabase.from('api_keys').insert({
    workspace_id: authCode.workspace_id,
    created_by:   authCode.user_id,
    name:         `OAuth: ${authCode.client_name}`,
    key_prefix:   prefix,
    key_hash:     keyHash,
    scopes:       authCode.scopes,
    inbox_ids:    authCode.inbox_ids,
  });

  // 6. Return the key — this is the ONLY time the plaintext key exists outside memory
  return Response.json({
    access_token: fullKey,
    token_type:   'bearer',
    scope:        authCode.scopes.join(' '),
  });
}
```

**PKCE is required** — the `code_challenge_method` must be `S256`. Plain `code_challenge_method=plain` is rejected. This ensures the authorization code cannot be intercepted and exchanged by a third party even if the redirect is captured.

---

## 8. Key Revocation

Revocation is a soft delete: setting `deleted_at = now()` on the `api_keys` row.

```typescript
async function revokeApiKey(keyId: string, workspaceId: string): Promise<void> {
  const { error } = await supabase
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId);  // ownership check

  if (error) throw new Error('Revocation failed');

  // Log the event
  await supabase.from('auth_logs').insert({
    workspace_id: workspaceId,
    event_type:   'key_revoked',
    metadata:     { key_id: keyId },
  });
}
```

### Effect

Revocation is immediate. The next MCP request using the revoked key will fail the database lookup at authentication step 3 (because `is('deleted_at', null)` will no longer match the row). There is no caching layer between the auth middleware and the database for key lookups; every request does a live query.

There is no grace period. The authentication documentation notes a "wait 24 hours" guidance for key rotation — this is a courtesy period for clients to update their stored key, not a server-enforced delay. Once a key is revoked by the user, it is dead immediately.

### Rotation Procedure

To rotate a key without downtime:

1. Generate a new API key from the dashboard
2. Configure the MCP client to use the new key
3. Verify the client is functioning with the new key
4. Revoke the old key

The old key remains valid during steps 1–3, ensuring no gap in service.

---

## 9. Error Responses

All errors from the MCP auth layer follow the JSON-RPC 2.0 error format for MCP-protocol-level errors, and standard HTTP error responses for HTTP-level rejections (e.g., missing Authorization header before any MCP framing is processed).

### Missing Token

The client sent no `Authorization` header, or the header is present but not in `Bearer <token>` format.

**HTTP 401:**
```json
{
  "error": "missing_token",
  "error_description": "Authorization header with Bearer token is required"
}
```

Header included: `WWW-Authenticate: Bearer realm="MCPEmails"`

### Invalid Token (not found, revoked, or expired)

The key hash does not match any active row, or the key is soft-deleted, or `expires_at` is in the past.

The response is intentionally identical for all three cases to prevent oracle attacks — an attacker cannot distinguish "this key once existed but was revoked" from "this key never existed."

**HTTP 401:**
```json
{
  "error": "invalid_token",
  "error_description": "API key is invalid, expired, or has been revoked"
}
```

### Insufficient Scope

The key is valid but does not carry the scope required by the requested tool.

**HTTP 403 (or JSON-RPC error within a 200 for tools/call):**
```json
{
  "error": "insufficient_scope",
  "error_description": "Tool 'send_email' requires scope 'send:email'. This key has: [read:email, search:email]",
  "required_scope": "send:email"
}
```

The `required_scope` field allows the MCP client to construct a targeted re-authorization request rather than requesting all scopes.

### Inaccessible Inbox

The key is valid and has the right scope, but the requested inbox is not in the key's authorized inbox set.

**HTTP 403:**
```json
{
  "error": "insufficient_scope",
  "error_description": "Inbox 'f47ac10b-...' is not accessible with this key"
}
```

The same `insufficient_scope` error code is used deliberately. From the client's perspective, the correct remedy in both cases is to obtain a key with broader access. Distinguishing "wrong scope" from "wrong inbox" does not help the client and could help an attacker enumerate which inbox UUIDs belong to a workspace.

### Rate Limit Exceeded

```json
{
  "error": "rate_limit_exceeded",
  "error_description": "Rate limit exceeded for this API key",
  "limit": 100,
  "window": "60s",
  "retry_after": 30
}
```

`Retry-After: 30` header is also included.

---

## 10. Security Properties

### Why Hashing Prevents Database Leaks from Exposing Usable Keys

If an attacker gains read access to the `api_keys` table — via SQL injection, a misconfigured backup, or a compromised database credential — they see:

```
key_prefix = "3vKq8mN2"
key_hash   = "a3f7c2e1b8d9f0a4c6e3b1d5f8a2c4e7..."
```

The `key_prefix` is 8 characters and is used only for display. The `key_hash` is the SHA-256 of a 256-bit random value.

To recover a key from its SHA-256 hash, an attacker must find the preimage — a 256-bit input that produces that specific hash. SHA-256 is a one-way function; no algorithm faster than exhaustive search over the 2^256 keyspace is known. At 10^9 hash attempts per second (a generous estimate for a single machine), searching even a fraction of this space would take longer than the age of the universe. A database breach exposes no usable keys.

This contrasts with hashing low-entropy inputs (e.g., 6-digit PINs) where preimage attacks via rainbow tables are practical. The security guarantee here derives entirely from the input entropy (256 random bits), not from the hash function's computational cost.

### Token Passthrough Is Not Used

MCPEmails issues its own API keys; it does not accept tokens from other systems and forward them to email providers. When the MCP Edge Function calls the Gmail API or Microsoft Graph on behalf of a request, it decrypts the user's stored OAuth tokens using Supabase Vault. The bearer token used to authenticate the MCP client and the OAuth token used to call the email provider are completely separate credentials that the MCP client never sees. This complies with the MCP specification's explicit prohibition on token passthrough.

### No Session-Based MCP Auth

MCP clients do not use session IDs or session cookies. Each request is independently authenticated against the `api_keys` table. There is no session to hijack; the only credential is the API key bearer token, which is long-lived and revocable by the user at any time.

### Audit Trail

Every authenticated MCP tool call (successful or failed) is recorded in `activity_log` with `api_key_id`, `inbox_id`, `tool_name`, `status`, `ip_address`, and `user_agent`. This table is append-only; no application code issues UPDATE or DELETE against it. Users can review the full history in Dashboard > Security. A compromised key is detectable by reviewing its activity log before revocation.

---

## Summary Table

| Concern | Decision |
|---|---|
| Key format | `mcpe_` prefix + 32 random bytes base58-encoded |
| Key storage | SHA-256 hash only; plaintext shown once and discarded |
| Scope granularity | 5 action-specific scopes; no wildcards |
| Authentication mechanism | Bearer token in Authorization header, hashed and DB-looked-up per request |
| Session model | Stateless — no session cache; every request hits the DB |
| Inbox binding | `inbox_ids` array on the key row; null = all workspace inboxes |
| Scope enforcement | Static `TOOL_SCOPE_REQUIREMENTS` map, checked at `tools/call` dispatch |
| OAuth flow | Authorization code + PKCE; per-client consent stored to prevent Confused Deputy |
| Revocation effect | Immediate; soft delete blocks next DB lookup |
| Error oracle protection | Identical 401 for missing, invalid, revoked, and expired keys |
| Token passthrough | Prohibited; MCP client credentials and email provider credentials are entirely separate |
