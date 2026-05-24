# API Key Management

## Purpose

This document is the definitive reference for every aspect of MCP API key management in MCPEmails. It covers key format and entropy, database schema, the scope system, the full key lifecycle, TypeScript implementation details for both the Next.js Route Handlers and the Supabase Edge Function, and the security reasoning behind every design decision.

API keys are the exclusive authentication mechanism for MCP clients connecting to the MCPEmails MCP server. A dashboard user authenticates via Supabase Auth session cookies; those cookies cannot call MCP endpoints. An API key cannot access dashboard endpoints. There is no crossover. This strict separation means that compromising an API key does not grant dashboard access, and a compromised session cookie does not grant programmatic MCP access.

Companion documents:

- `database-schema.md` — full table definitions including the `api_keys` table in context
- `mcp-server-architecture.md` — Edge Function request lifecycle
- `mcp-authentication-flow.md` — end-to-end authentication flow diagram
- `row-level-security.md` — RLS policies for `api_keys`
- `security-architecture.md` — threat model and cryptographic decisions

---

## 1. Key Format and Generation

### 1.1 Format Specification

Every MCPEmails API key follows this exact structure:

```
mcpe_<64 hex characters>
```

Example:

```
mcpe_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7d9e0f2a4b6c8d0e2f4a6b8c0d2e4f6
     └────────────────────────────────────────────────────────────────┘
                  64 hex characters = 32 bytes = 256 bits of entropy
```

- **Prefix `mcpe_`** — five characters, fixed. Identifies MCPEmails keys in log files, configuration files, and secret scanning tooling. The prefix is registered with GitHub Advanced Security's secret scanning patterns and truffleHog's built-in ruleset so any key committed to a repository triggers an alert.
- **Suffix** — 64 lowercase hexadecimal characters produced by `crypto.randomBytes(32).toString('hex')`. Hex encoding is used (rather than base58 or base64) for predictable, fixed-length output that is unambiguous in every terminal and log viewer.
- **Total length** — 69 characters (5 prefix + 64 suffix). Fixed length makes pattern matching reliable.
- **Entropy** — 256 bits from a CSPRNG. Brute-force search across all possible keys exceeds 2^256 operations, which is computationally infeasible regardless of hash speed.

### 1.2 Key Prefix for Display

The first 8 characters of the suffix are stored separately as `key_prefix` and displayed in the dashboard to help users identify which key belongs to which MCP client, without ever re-revealing the full key.

```
mcpe_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7d9e0f2a4b6c8d0e2f4a6b8c0d2e4f6
     └──────┘
     key_prefix = "a3f8b2c9"  (first 8 hex chars of suffix)
```

The display prefix is never used for authentication. It is only queried when rendering the keys list in the dashboard.

### 1.3 Generation Function

Key generation runs inside the Next.js Route Handler (`POST /api/workspaces/[workspaceId]/api-keys`). It uses Node.js `crypto.randomBytes`, which delegates to the operating system's CSPRNG. No third-party library is involved in the random source.

```typescript
// apps/web/lib/api-keys/generate.ts
import crypto from 'node:crypto';

const KEY_PREFIX = 'mcpe_';
const KEY_BYTE_LENGTH = 32; // 256 bits of entropy

export interface GeneratedKey {
  /** The full raw key — shown once to the user, then discarded. Never persisted. */
  rawKey: string;
  /** SHA-256 hex digest of rawKey — the only value stored in the database. */
  keyHash: string;
  /** First 8 characters of the hex suffix — stored for display, not authentication. */
  keyPrefix: string;
}

/**
 * Generate a new MCP API key.
 *
 * The returned `rawKey` MUST be shown to the user immediately and then discarded.
 * Store only `keyHash` and `keyPrefix`. This function must not be called more than
 * once per user-initiated key creation — there is no way to recover a lost raw key.
 */
export function generateApiKey(): GeneratedKey {
  // 32 bytes of CSPRNG output — 256 bits of entropy.
  const randomBytes = crypto.randomBytes(KEY_BYTE_LENGTH);

  // Hex-encode for a fixed-length, unambiguous string.
  const suffix = randomBytes.toString('hex'); // 64 lowercase hex characters

  const rawKey = KEY_PREFIX + suffix;

  // Hash immediately; the raw key must not be logged or stored at any point after this.
  const keyHash = hashApiKey(rawKey);

  // First 8 characters of the suffix for dashboard display.
  const keyPrefix = suffix.slice(0, 8);

  return { rawKey, keyHash, keyPrefix };
}
```

### 1.4 Hashing Function

```typescript
// apps/web/lib/api-keys/generate.ts  (continued)

/**
 * Hash an API key (raw or incoming bearer token) with SHA-256.
 *
 * SHA-256 is appropriate here — not bcrypt — because:
 *   1. The pre-image has 256 bits of CSPRNG entropy. No dictionary attack applies.
 *      The time to brute-force a single SHA-256 hash of a 256-bit random value
 *      exceeds the age of the universe on any foreseeable hardware.
 *   2. bcrypt's deliberate slowness (200–400 ms at cost=12) would add that latency
 *      to every MCP tool call — an unacceptable hot-path cost for zero security gain.
 *   3. SHA-256 is deterministic and fast, enabling a single indexed DB lookup.
 *
 * This function must be used both at key-creation time (in the Route Handler)
 * and at authentication time (in the Edge Function), producing identical output.
 * The algorithm must never be changed without a migration job to re-hash all rows.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}
```

### 1.5 One-Time Reveal Contract

The raw key is shown to the user exactly once — in a modal dialog rendered immediately after the Route Handler returns the creation response. The frontend marks this dialog as non-dismissible until the user acknowledges they have copied the key. The backend never returns a raw key again for any subsequent request.

```typescript
// apps/web/app/api/workspaces/[workspaceId]/api-keys/route.ts (excerpt)
import { generateApiKey } from '@/lib/api-keys/generate';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { validateWorkspaceMembership } from '@/lib/auth/workspace';

export async function POST(
  request: Request,
  { params }: { params: { workspaceId: string } }
) {
  const supabase = createSupabaseServerClient();

  // Verify the authenticated user belongs to this workspace.
  await validateWorkspaceMembership(supabase, params.workspaceId);

  const body = await request.json();
  const { name, scopes } = body;

  // Generate the key — rawKey is returned to the user and never stored.
  const { rawKey, keyHash, keyPrefix } = generateApiKey();

  const { data: apiKeyRow, error } = await supabase
    .from('api_keys')
    .insert({
      workspace_id: params.workspaceId,
      name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes,
    })
    .select('id, name, key_prefix, scopes, created_at')
    .single();

  if (error) {
    // Do not log rawKey or keyHash here.
    console.error('api_key_creation_failed', { workspace_id: params.workspaceId, name });
    return Response.json({ error: 'Key creation failed' }, { status: 500 });
  }

  // rawKey is included ONCE in the response. After this response is sent,
  // it is unrecoverable. The database row contains only keyHash.
  return Response.json({
    ...apiKeyRow,
    rawKey, // shown once in the UI; user must copy it before closing the dialog
  }, { status: 201 });
}
```

---

## 2. Database Schema

### 2.1 `api_keys` Table

```sql
-- migration: 20240601_create_api_keys.sql

CREATE TABLE public.api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy anchor. Deleting a workspace cascades to its keys.
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- The user who created the key — retained for audit log linkage even if the user
  -- later loses workspace membership. ON DELETE RESTRICT prevents orphaned audit trails.
  created_by    uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

  -- Human-readable label chosen by the user at creation time. e.g. "Claude Desktop".
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),

  -- First 8 hex characters of the key suffix. Used only for dashboard display.
  -- Not usable for authentication. Not unique — in theory two keys could share a prefix,
  -- though the probability is negligible.
  key_prefix    text        NOT NULL CHECK (char_length(key_prefix) = 8),

  -- SHA-256 hex digest of the full raw key. This is the only secret-adjacent value
  -- stored here; it cannot be reversed to recover the raw key.
  key_hash      text        NOT NULL UNIQUE CHECK (char_length(key_hash) = 64),

  -- Granted permission scopes. A key with an empty array authenticates but cannot
  -- call any tool.
  scopes        text[]      NOT NULL DEFAULT '{}',

  -- Optional expiry. NULL means the key never expires. The authentication middleware
  -- rejects keys where expires_at < now() with the same 401 as revoked keys.
  expires_at    timestamptz,

  -- Updated asynchronously (fire-and-forget) on every successful authentication.
  -- Used for "last seen" display in the dashboard and for detecting stale keys.
  last_used_at  timestamptz,

  -- Soft-delete field. NULL = active. SET to now() on revocation.
  -- Revoked keys are rejected immediately on next use but are never hard-deleted,
  -- preserving foreign-key integrity for activity_log rows that reference this key.
  revoked_at    timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

### 2.2 Indexes

```sql
-- Primary authentication lookup: hash → key row. Must be O(1).
-- The UNIQUE constraint on key_hash already creates a btree index; this is explicit
-- documentation of the lookup path, not a duplicate index.
-- Supabase/PostgreSQL creates the index automatically from the UNIQUE constraint.

-- Secondary lookup: list all keys for a workspace (dashboard view).
CREATE INDEX idx_api_keys_workspace_id
  ON public.api_keys (workspace_id)
  WHERE revoked_at IS NULL;  -- partial index; dashboard almost never shows revoked keys.

-- For the "find keys that haven't been used in 90 days" scheduled job.
CREATE INDEX idx_api_keys_last_used_at
  ON public.api_keys (last_used_at)
  WHERE revoked_at IS NULL;
```

### 2.3 `updated_at` Trigger

All mutable tables share the `moddatetime` trigger pattern established in the database schema:

```sql
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);
```

### 2.4 Row-Level Security

RLS ensures that application-layer bugs (a missing `.eq('workspace_id', ...)` filter, for example) cannot expose keys from one workspace to another.

```sql
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members can read keys belonging to their workspace.
CREATE POLICY "api_keys_select_own_workspace"
  ON public.api_keys FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- INSERT: workspace members can create keys in their workspace.
-- The Route Handler sets workspace_id from the URL path, not from user input,
-- so the policy only needs to verify membership.
CREATE POLICY "api_keys_insert_own_workspace"
  ON public.api_keys FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = ANY(public.my_workspace_ids()));

-- UPDATE: workspace members can update keys in their workspace.
-- Permitted updates: name, scopes, expires_at, revoked_at, last_used_at.
-- The key_hash column must never be updated after insertion (enforced by
-- application code, not a DB constraint, to avoid complexity with key rotation).
CREATE POLICY "api_keys_update_own_workspace"
  ON public.api_keys FOR UPDATE
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()))
  WITH CHECK (workspace_id = ANY(public.my_workspace_ids()));

-- DELETE: hard deletes are never issued by application code. Revocation uses
-- UPDATE (set revoked_at). This policy exists as a backstop — deny hard deletes.
CREATE POLICY "api_keys_no_hard_delete"
  ON public.api_keys FOR DELETE
  TO authenticated
  USING (false);  -- no authenticated user can hard-delete a key row
```

The MCP Edge Function authenticates using the `service_role` key for the key lookup step (because the API key bearer is not a Supabase Auth user — there is no JWT). This bypasses RLS for that specific query. The Edge Function must therefore apply its own workspace and revocation checks, which it does via the `WHERE` clauses in the lookup query shown in Section 5.

### 2.5 `activity_log` Schema (Relevant Columns)

Each MCP tool call appends a row to `activity_log`. The `api_key_id` column retains a foreign key reference to `api_keys.id` even after revocation, enabling complete audit trails.

```sql
CREATE TABLE public.activity_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id    uuid        REFERENCES public.api_keys(id) ON DELETE SET NULL,
  inbox_id      uuid        REFERENCES public.inboxes(id) ON DELETE SET NULL,
  tool_name     text        NOT NULL,
  scopes_used   text[]      NOT NULL,
  -- Truncated key hash prefix for audit log correlation without exposing the full hash.
  key_hash_prefix  text,    -- first 8 characters of key_hash; e.g. "a3f8b2c9"
  outcome       text        NOT NULL CHECK (outcome IN ('success', 'error', 'scope_denied')),
  error_code    text,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now()
  -- No updated_at — this table is append-only.
);

-- RLS: workspace members can read their own activity log; no one can update or delete.
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_log_select_own_workspace"
  ON public.activity_log FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

CREATE POLICY "activity_log_insert_service_only"
  ON public.activity_log FOR INSERT
  TO authenticated
  WITH CHECK (false);  -- only service_role (Edge Function) may insert
```

---

## 3. Scopes System

### 3.1 Defined Scopes

MCPEmails defines five scopes. Each scope is a string in the `<noun>:<verb>` pattern. Scopes are granted at key-creation time; they cannot be added to an existing key without rotation.

| Scope | Description |
|---|---|
| `email:read` | Read email message content, headers, and attachments from connected inboxes |
| `email:send` | Compose and send new emails; reply to and forward existing messages |
| `email:search` | Execute search queries across inbox contents; search results include message snippets |
| `inbox:manage` | Create, rename, and delete folders; move messages between folders; delete messages |
| `admin` | Introspect workspace configuration; list connected inboxes; no email content access |

**Design principles:**

- No wildcard or omnibus scopes. Strings like `*`, `all`, `full-access` are rejected at the Route Handler level before insertion.
- `email:search` is separate from `email:read` because search queries return snippets from all matching messages across the full inbox. An agent that only needs to read specific known message IDs (e.g., given to it by a user) should not have implicit search capability.
- `email:send` does not imply `email:read`. A notification agent that only sends does not need read access.
- `admin` grants no access to email content. It is used by MCP clients that display inbox connection status or help users manage their MCPEmails workspace through an AI interface.
- The set of valid scopes is enforced as a database check constraint and as a Route Handler validation step. An unknown scope in the `scopes` array causes key creation to fail with a 400.

```sql
-- Constraint on api_keys to prevent invalid scope strings.
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_valid_scopes
  CHECK (
    scopes <@ ARRAY[
      'email:read',
      'email:send',
      'email:search',
      'inbox:manage',
      'admin'
    ]::text[]
  );
```

### 3.2 Tool-to-Scope Mapping

The following mapping is the authoritative definition of which scope each MCP tool requires. It is defined as a constant in the Edge Function and is never overridable by client input.

```typescript
// supabase/functions/mcp/scopes.ts

export const VALID_SCOPES = [
  'email:read',
  'email:send',
  'email:search',
  'inbox:manage',
  'admin',
] as const;

export type Scope = (typeof VALID_SCOPES)[number];

/**
 * Maps every MCP tool name to the single scope required to call it.
 * Tools absent from this map are always blocked, regardless of what scopes
 * the API key carries.
 */
export const TOOL_SCOPE_MAP: Readonly<Record<string, Scope>> = {
  // email:read — read message content
  list_inbox:         'email:read',
  read_email:         'email:read',
  get_attachment:     'email:read',

  // email:search — search queries across inbox content
  search_email:       'email:search',
  search_inbox:       'email:search',

  // email:send — compose and send
  send_email:         'email:send',
  reply_to_email:     'email:send',
  forward_email:      'email:send',
  create_draft:       'email:send',
  update_draft:       'email:send',
  delete_draft:       'email:send',

  // inbox:manage — folder and message organisation
  create_folder:      'inbox:manage',
  rename_folder:      'inbox:manage',
  delete_folder:      'inbox:manage',
  move_email:         'inbox:manage',
  delete_email:       'inbox:manage',
  mark_read:          'inbox:manage',
  mark_unread:        'inbox:manage',
  archive_email:      'inbox:manage',

  // admin — workspace introspection only
  list_inboxes:       'admin',
  get_inbox_status:   'admin',
  get_workspace_info: 'admin',
} as const;
```

### 3.3 Scope Check Function

```typescript
// supabase/functions/mcp/scopes.ts (continued)

import type { ApiKeyRow } from './types.ts';

/**
 * Return true if the given API key row carries the specified scope.
 * Performs a simple array-inclusion check; the enforcement contract is
 * that TOOL_SCOPE_MAP is checked first to resolve the required scope,
 * then this function is called.
 */
export function hasScope(apiKey: ApiKeyRow, scope: Scope): boolean {
  return apiKey.scopes.includes(scope);
}

/**
 * Return true if the given tool is permitted for the given key.
 * Returns false for unknown tool names (not in TOOL_SCOPE_MAP).
 */
export function isToolAuthorized(apiKey: ApiKeyRow, toolName: string): boolean {
  const requiredScope = TOOL_SCOPE_MAP[toolName];
  if (!requiredScope) {
    // Unknown tool — blocked regardless of scopes.
    return false;
  }
  return hasScope(apiKey, requiredScope);
}
```

### 3.4 Scope Enforcement in Middleware

Scope enforcement occurs after successful authentication, at the point where the Edge Function routes a `tools/call` JSON-RPC request to a tool handler. It is not deferred to the tool handler itself — the middleware rejects the request before any email credential is loaded.

```typescript
// supabase/functions/mcp/middleware.ts (excerpt — see full middleware in Section 5)

async function enforceScope(
  apiKey: ApiKeyRow,
  toolName: string,
  requestId: string | number | null
): Promise<void> {
  if (!isToolAuthorized(apiKey, toolName)) {
    const requiredScope = TOOL_SCOPE_MAP[toolName] ?? 'unknown';

    // Log the scope denial for audit purposes.
    await logActivity({
      workspace_id:    apiKey.workspace_id,
      api_key_id:      apiKey.id,
      tool_name:       toolName,
      scopes_used:     [],
      key_hash_prefix: apiKey.key_hash.slice(0, 8),
      outcome:         'scope_denied',
      error_code:      'INSUFFICIENT_SCOPE',
    });

    throw new McpError(
      requestId,
      -32001,
      `Insufficient scope: tool '${toolName}' requires '${requiredScope}'`,
      { required_scope: requiredScope, granted_scopes: apiKey.scopes }
    );
  }
}
```

---

## 4. Key Lifecycle

### 4.1 Creation

The full creation flow:

```
User fills "New API Key" form (name + scope selection)
        │
        ▼
POST /api/workspaces/[workspaceId]/api-keys
        │
        ├─ validateWorkspaceMembership() — user must own/belong to workspace
        ├─ validateScopes(body.scopes) — reject unknown or empty scope arrays
        │
        ├─ generateApiKey()
        │   ├─ crypto.randomBytes(32) → 256 bits CSPRNG
        │   ├─ .toString('hex') → 64-char suffix
        │   ├─ rawKey = 'mcpe_' + suffix
        │   ├─ keyHash = SHA-256(rawKey) → stored
        │   └─ keyPrefix = suffix.slice(0, 8) → stored for display
        │
        ├─ INSERT INTO api_keys (workspace_id, name, key_hash, key_prefix, scopes)
        │
        └─ Response: { ...row, rawKey }  ← rawKey shown ONCE in UI modal
                         │
                         ▼
               rawKey goes out of scope after response is serialised.
               It exists nowhere else. It cannot be recovered.
```

After the response is sent, `rawKey` is garbage-collected. The database row contains `key_hash` and `key_prefix` only. If the user closes the dialog without copying, they must create a new key — there is no recovery path.

### 4.2 Usage (Authentication Path)

Every MCP request triggers this sequence before any tool handler runs:

```
MCP Client: POST /functions/v1/mcp
  Authorization: Bearer mcpe_a3f8b2c9...
        │
        ▼
1. Extract bearer token from Authorization header
   → reject if missing, or if it does not start with 'mcpe_'

2. hashApiKey(bearerToken) → sha256Hex

3. SELECT from api_keys WHERE key_hash = sha256Hex
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   → 401 if no row matches (intentionally vague: same error for
     not-found, revoked, and expired — prevents oracle attacks)

4. (async, fire-and-forget) UPDATE api_keys
   SET last_used_at = now() WHERE id = apiKeyRow.id

5. Dispatch JSON-RPC method
   → if tools/call: enforceScope(apiKey, params.name)
   → if tools/list: return filtered tool list based on key's scopes
   → if initialize: return server capabilities (no scope check)

6. Execute tool handler

7. INSERT INTO activity_log (outcome, tool_name, key_hash_prefix, ...)
```

### 4.3 Rotation

Key rotation is the process of replacing an active key with a new one. It is triggered by the user from the dashboard, or automatically by a scheduled job that detects keys older than the workspace's configured rotation policy.

**Rotation is not atomic in the database** — there is a brief window between issuing the new key and revoking the old one. This is acceptable because the user controls both and the window is seconds. Atomic rotation (two keys valid simultaneously) is the expected operational pattern:

```
Step 1: User clicks "Rotate" in dashboard
        ├─ POST /api/workspaces/[workspaceId]/api-keys
        │   (creates NEW key with same name and scopes)
        └─ UI shows new rawKey ONE TIME

Step 2: User updates their MCP client config with the new key.
        Both old and new key are valid during this window.
        Duration: determined by user. Minutes to hours.

Step 3: User clicks "Revoke" on the old key
        ├─ PATCH /api/workspaces/[workspaceId]/api-keys/[keyId]/revoke
        └─ UPDATE api_keys SET revoked_at = now() WHERE id = oldKeyId

        Old key now rejected on next use.
        New key continues to work.
        Old key row is retained for audit_log foreign key integrity.
```

The Route Handler for rotation enforces that a workspace cannot exceed its plan's key quota. A Free plan workspace that already holds the maximum number of active keys must revoke one before creating another.

### 4.4 Revocation

Revocation is a soft delete. The `revoked_at` column is set to `now()`; the row is never hard-deleted.

```typescript
// apps/web/app/api/workspaces/[workspaceId]/api-keys/[keyId]/revoke/route.ts

export async function PATCH(
  request: Request,
  { params }: { params: { workspaceId: string; keyId: string } }
) {
  const supabase = createSupabaseServerClient();
  await validateWorkspaceMembership(supabase, params.workspaceId);

  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', params.keyId)
    .eq('workspace_id', params.workspaceId)  // belt-and-suspenders; RLS also enforces this
    .is('revoked_at', null);                 // idempotent: no-op if already revoked

  if (error) {
    return Response.json({ error: 'Revocation failed' }, { status: 500 });
  }

  return Response.json({ revoked: true }, { status: 200 });
}
```

**Why soft delete?**

1. `activity_log.api_key_id` is a foreign key to `api_keys.id`. A hard delete would set `api_key_id` to NULL on all historical activity rows via `ON DELETE SET NULL`, destroying the audit trail link.
2. The revoked key row is needed to answer the question: "On what date was key X revoked, and by whom?" — useful for security incident investigation.
3. Soft delete enables the dashboard to show a "Revoked Keys" history view.

**Effect on active requests:** Revocation takes effect on the next authentication attempt. In-flight requests that have already passed authentication are not interrupted (they have already loaded the key row into memory). This is acceptable — the window is the duration of a single MCP tool call (typically < 5 seconds).

---

## 5. TypeScript Implementation

### 5.1 Types

```typescript
// supabase/functions/mcp/types.ts

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AuthenticatedContext {
  apiKey: ApiKeyRow;
  workspaceId: string;
}

export class McpError extends Error {
  constructor(
    public readonly requestId: string | number | null,
    public readonly code: number,
    message: string,
    public readonly data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'McpError';
  }
}
```

### 5.2 `generateApiKey`

Covered in Section 1.3. Reproduced here in full for reference:

```typescript
// apps/web/lib/api-keys/generate.ts
import crypto from 'node:crypto';

const KEY_PREFIX = 'mcpe_';
const KEY_BYTE_LENGTH = 32;

export interface GeneratedKey {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
}

export function generateApiKey(): GeneratedKey {
  const randomBytes = crypto.randomBytes(KEY_BYTE_LENGTH);
  const suffix = randomBytes.toString('hex');
  const rawKey = KEY_PREFIX + suffix;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = suffix.slice(0, 8);
  return { rawKey, keyHash, keyPrefix };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}
```

### 5.3 `hashApiKey` in the Edge Function (Deno Runtime)

The Edge Function runs on the Deno runtime, which exposes Web Crypto rather than Node.js `crypto`. The hash function must be adapted accordingly:

```typescript
// supabase/functions/mcp/crypto.ts
// Deno runtime — uses Web Crypto API (available globally in Supabase Edge Functions).

/**
 * Hash an incoming bearer token with SHA-256.
 * Output is a lowercase hex string identical to the Node.js implementation
 * in apps/web/lib/api-keys/generate.ts — they must produce the same result
 * for the same input, because one writes the hash and the other reads it.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

**Cross-environment consistency note:** Both the Node.js and Deno implementations hash the UTF-8 encoded bytes of the key string and produce a lowercase 64-character hex string. The hash algorithm (SHA-256), encoding (UTF-8), and output format (lowercase hex) must never diverge, or authentication will silently break for all existing keys.

### 5.4 `lookupApiKey`

```typescript
// supabase/functions/mcp/auth.ts
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hashApiKey } from './crypto.ts';
import type { ApiKeyRow } from './types.ts';
import { McpError } from './types.ts';

/**
 * Look up an API key by its hash and validate that it is active.
 *
 * A single query handles all authentication checks:
 *   - key_hash equality → authenticates the bearer token
 *   - revoked_at IS NULL → rejects revoked keys
 *   - expires_at guard → rejects expired keys
 *
 * The same 401 error is returned for all failure cases (not found, revoked,
 * expired) to prevent oracle attacks that could distinguish these states.
 *
 * Timing attack note: the database performs the hash equality check using a
 * btree index equality scan. PostgreSQL text comparison is not constant-time,
 * but the hash comparison is not the timing-sensitive step here — the indexed
 * lookup terminates at the same speed whether the hash is present or absent
 * (both are O(log n) btree traversals). The application-layer
 * `crypto.timingSafeEqual` is applied as an additional defence after the DB
 * returns a candidate row, for defence-in-depth.
 */
export async function lookupApiKey(
  supabase: SupabaseClient,
  bearerToken: string,
  requestId: string | number | null
): Promise<ApiKeyRow> {
  // Basic format guard before touching the database.
  if (!bearerToken.startsWith('mcpe_') || bearerToken.length !== 69) {
    throw new McpError(requestId, -32002, 'Invalid token format', { status: 401 });
  }

  const incomingHash = await hashApiKey(bearerToken);

  const { data: row, error } = await supabase
    .from('api_keys')
    .select('id, workspace_id, name, key_prefix, key_hash, scopes, expires_at, last_used_at, revoked_at, created_at')
    .eq('key_hash', incomingHash)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .single();

  if (error || !row) {
    // Intentionally identical error for all failure modes.
    throw new McpError(requestId, -32002, 'API key is invalid, expired, or has been revoked', { status: 401 });
  }

  // Defence-in-depth: constant-time comparison of the stored hash against the
  // incoming hash in application memory. This protects against hypothetical
  // timing side-channels in the database response path.
  //
  // Note: crypto.timingSafeEqual requires both buffers to have equal length.
  // Both are 64-byte hex strings from SHA-256, so lengths always match.
  const storedHashBytes = new TextEncoder().encode(row.key_hash);
  const incomingHashBytes = new TextEncoder().encode(incomingHash);

  // timingSafeEqual is available in Deno via the node:crypto compatibility layer.
  // Import at the top of the file: import { timingSafeEqual } from 'node:crypto';
  if (!timingSafeEqual(storedHashBytes, incomingHashBytes)) {
    // This branch should never be reached if the DB query is correct, but
    // it defends against a theoretical hash collision or DB bug.
    throw new McpError(requestId, -32002, 'Token verification failed', { status: 401 });
  }

  return row as ApiKeyRow;
}
```

### 5.5 `hasScope` and `isToolAuthorized`

Covered in Section 3.3. Full signatures repeated for reference:

```typescript
export function hasScope(apiKey: ApiKeyRow, scope: Scope): boolean {
  return apiKey.scopes.includes(scope);
}

export function isToolAuthorized(apiKey: ApiKeyRow, toolName: string): boolean {
  const requiredScope = TOOL_SCOPE_MAP[toolName];
  if (!requiredScope) return false;
  return hasScope(apiKey, requiredScope);
}
```

### 5.6 Full Edge Function Auth Middleware

This is the complete middleware that runs on every inbound request to the MCP Edge Function, before any JSON-RPC dispatching:

```typescript
// supabase/functions/mcp/middleware.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { timingSafeEqual } from 'node:crypto';
import { hashApiKey } from './crypto.ts';
import { isToolAuthorized, TOOL_SCOPE_MAP } from './scopes.ts';
import { McpError, type ApiKeyRow, type AuthenticatedContext } from './types.ts';
import { logActivity } from './activity.ts';

// The Edge Function accesses api_keys using the service_role key because
// the incoming request carries an API key bearer token, not a Supabase JWT.
// The service_role key bypasses RLS; the middleware enforces workspace isolation
// explicitly via the WHERE clause.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

/**
 * Authenticate an incoming MCP request and return the validated context.
 *
 * This function:
 *   1. Extracts the bearer token from the Authorization header.
 *   2. Hashes it with SHA-256.
 *   3. Looks it up in api_keys with revocation and expiry checks.
 *   4. Applies constant-time comparison as a defence-in-depth measure.
 *   5. Fires-and-forgets a last_used_at update.
 *
 * Throws McpError on any failure. The caller converts McpError to a JSON-RPC
 * error response. All auth failures produce the same error message to prevent
 * information leakage.
 */
export async function authenticateRequest(
  req: Request,
  requestId: string | number | null
): Promise<AuthenticatedContext> {
  const authHeader = req.headers.get('Authorization');

  if (!authHeader) {
    throw new McpError(
      requestId,
      -32002,
      'Authorization header is required. Provide a Bearer token.',
      { status: 401 }
    );
  }

  if (!authHeader.startsWith('Bearer ')) {
    throw new McpError(
      requestId,
      -32002,
      'Authorization header must use Bearer scheme.',
      { status: 401 }
    );
  }

  const bearerToken = authHeader.slice(7).trim();

  // Quick format check before hashing and hitting the database.
  if (!bearerToken.startsWith('mcpe_') || bearerToken.length !== 69) {
    throw new McpError(
      requestId,
      -32002,
      'API key is invalid, expired, or has been revoked.',
      { status: 401 }
    );
  }

  const incomingHash = await hashApiKey(bearerToken);

  const { data: row, error } = await supabase
    .from('api_keys')
    .select([
      'id',
      'workspace_id',
      'name',
      'key_prefix',
      'key_hash',
      'scopes',
      'expires_at',
      'last_used_at',
      'revoked_at',
      'created_at',
    ].join(', '))
    .eq('key_hash', incomingHash)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .single();

  if (error || !row) {
    throw new McpError(
      requestId,
      -32002,
      'API key is invalid, expired, or has been revoked.',
      { status: 401 }
    );
  }

  // Constant-time comparison in application memory (defence-in-depth).
  const storedBytes  = new TextEncoder().encode(row.key_hash as string);
  const incomingBytes = new TextEncoder().encode(incomingHash);

  if (!timingSafeEqual(storedBytes, incomingBytes)) {
    throw new McpError(
      requestId,
      -32002,
      'API key is invalid, expired, or has been revoked.',
      { status: 401 }
    );
  }

  const apiKey = row as ApiKeyRow;

  // Fire-and-forget: update last_used_at without blocking the request.
  // If this fails, it is logged at warn level but does not fail the request.
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', apiKey.id)
    .then(({ error: updateError }) => {
      if (updateError) {
        console.warn('last_used_at_update_failed', { key_id: apiKey.id, error: updateError.message });
      }
    });

  return {
    apiKey,
    workspaceId: apiKey.workspace_id,
  };
}

/**
 * Enforce that the authenticated API key is authorised to call the given MCP tool.
 * Logs a scope_denied event before throwing, so denials are always auditable.
 */
export async function enforceToolScope(
  ctx: AuthenticatedContext,
  toolName: string,
  requestId: string | number | null
): Promise<void> {
  if (isToolAuthorized(ctx.apiKey, toolName)) {
    return; // authorised — nothing to do
  }

  const requiredScope = TOOL_SCOPE_MAP[toolName] ?? null;

  // Log the denial before throwing — this must not fail silently.
  try {
    await logActivity({
      workspace_id:    ctx.workspaceId,
      api_key_id:      ctx.apiKey.id,
      tool_name:       toolName,
      scopes_used:     [],
      key_hash_prefix: ctx.apiKey.key_hash.slice(0, 8),
      outcome:         'scope_denied',
      error_code:      'INSUFFICIENT_SCOPE',
      duration_ms:     0,
    });
  } catch (logError) {
    console.error('scope_denial_log_failed', { error: String(logError) });
    // Do not swallow the auth failure just because logging failed.
  }

  throw new McpError(
    requestId,
    -32001,
    requiredScope
      ? `Insufficient scope: '${toolName}' requires scope '${requiredScope}'.`
      : `Tool '${toolName}' is not recognised or is not callable via this endpoint.`,
    {
      required_scope:  requiredScope,
      granted_scopes:  ctx.apiKey.scopes,
      status:          403,
    }
  );
}
```

### 5.7 Edge Function Entry Point (Integration)

```typescript
// supabase/functions/mcp/index.ts
import { authenticateRequest, enforceToolScope } from './middleware.ts';
import { dispatchTool } from './tools/index.ts';
import { McpError } from './types.ts';

Deno.serve(async (req: Request) => {
  // Only POST is accepted.
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body: unknown;
  let requestId: string | number | null = null;

  try {
    body = await req.json();
    requestId = (body as { id?: unknown }).id ?? null;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: request body is not valid JSON');
  }

  const rpc = body as { jsonrpc: string; method: string; params?: unknown; id?: unknown };

  if (rpc.jsonrpc !== '2.0') {
    return jsonRpcError(requestId, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  try {
    // Authenticate every request — no method is exempt.
    const ctx = await authenticateRequest(req, requestId);

    if (rpc.method === 'initialize') {
      return jsonRpcResult(requestId, buildInitializeResponse(ctx.apiKey.scopes));
    }

    if (rpc.method === 'notifications/initialized') {
      return new Response(null, { status: 204 });
    }

    if (rpc.method === 'tools/list') {
      return jsonRpcResult(requestId, { tools: buildToolList(ctx.apiKey.scopes) });
    }

    if (rpc.method === 'tools/call') {
      const { name, arguments: toolArgs } = rpc.params as { name: string; arguments: unknown };

      // Scope enforcement before any tool handler is called.
      await enforceToolScope(ctx, name, requestId);

      const result = await dispatchTool(ctx, name, toolArgs);
      return jsonRpcResult(requestId, result);
    }

    return jsonRpcError(requestId, -32601, `Method not found: ${rpc.method}`);

  } catch (err) {
    if (err instanceof McpError) {
      const httpStatus = (err.data?.status as number) ?? 400;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: err.code, message: err.message, data: err.data },
        }),
        { status: httpStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Unexpected errors — log fully, return generic message.
    console.error('mcp_unhandled_error', { error: String(err) });
    return jsonRpcError(requestId, -32603, 'Internal error');
  }
});

function jsonRpcResult(id: unknown, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } }
  );
}
```

---

## 6. Security Considerations

### 6.1 Why Hash, Not Encrypt

API keys are stored as one-way SHA-256 hashes rather than encrypted ciphertext. This is a deliberate design choice with a specific security benefit over encryption.

**Encryption is two-way.** An encrypted value can be decrypted by any process that holds the decryption key. If the decryption key is compromised (stolen from environment variables, leaked in a log), all stored key material is recoverable from the database. Encryption protects the database at rest but not the decryption key.

**A hash is one-way.** SHA-256 is a preimage-resistant function: given the hash, recovering the original key requires an exhaustive search over the input space. With 256 bits of CSPRNG entropy in the pre-image, that search requires 2^256 operations — infeasible regardless of hardware. A database dump that contains `key_hash` values gives the attacker nothing they can use to authenticate; they still need the original raw key.

**Why not bcrypt?** bcrypt adds deliberate slowness to defend against dictionary attacks on low-entropy passwords. An API key is not a password — it has 256 bits of CSPRNG entropy. A dictionary attack is inapplicable. bcrypt at cost=12 adds 200–400 ms to every authentication check; that is an unacceptable latency penalty on the hot MCP request path for no security benefit at this entropy level.

**The correct summary:** hash (not encrypt) because authentication requires only proof of possession, not recovery. One-way hashing with a high-entropy pre-image is the strongest possible storage model for this credential type.

### 6.2 Timing Attack Prevention

A timing attack against API key authentication would attempt to deduce information about stored hashes by measuring the response time of authentication requests. Two mechanisms prevent this:

**SHA-256 hashing before comparison.** The incoming bearer token is hashed before any comparison occurs. The hash output is a fixed-length 256-bit value regardless of the input. All comparison operations work on this fixed-length value, not on the variable-length bearer token. This eliminates timing leakage from variable-length string operations.

**`crypto.timingSafeEqual` in application code.** After the database returns a candidate row, the stored hash and the incoming hash are compared using `crypto.timingSafeEqual` (Node.js) or the equivalent in the Deno compatibility layer. This function compares two equal-length `Buffer` values in constant time — it does not short-circuit on the first differing byte. Standard string equality (`===`) in JavaScript may short-circuit and is not safe for secret comparison.

```typescript
// Correct: constant-time comparison
const storedBytes   = new TextEncoder().encode(row.key_hash);
const incomingBytes = new TextEncoder().encode(incomingHash);
// Both are 64-byte UTF-8 representations of 64-character hex strings.
// timingSafeEqual requires equal-length buffers — guaranteed here.
if (!timingSafeEqual(storedBytes, incomingBytes)) {
  throw new McpError(requestId, -32002, 'API key is invalid, expired, or has been revoked.');
}

// Wrong: do not use this
if (row.key_hash !== incomingHash) { ... }  // may short-circuit
```

**Database-level timing.** The PostgreSQL btree index lookup on `key_hash` is an O(log n) operation. The traversal time is similar for a key that exists and one that does not — both reach a leaf node, either finding the row or not. This does not constitute a timing oracle that reveals meaningful information to an attacker timing requests from outside the database.

**Uniform error responses.** All authentication failures return the same error message and HTTP status code. An attacker cannot distinguish "key not found" from "key revoked" from "key expired" by observing the response — all return 401 with the same body.

### 6.3 Audit Logging — What to Log

Audit logging for API keys must be useful for incident investigation without itself becoming a sensitive data source. The rules:

| Data | Log it? | Reason |
|---|---|---|
| `key_hash_prefix` (first 8 chars of hash) | Yes | Correlates events to a specific key without exposing the full hash |
| Full `key_hash` | Never | A full hash could be used to verify a guessed raw key; 8 chars is insufficient for that |
| Raw key (`rawKey`, bearer token) | Never | Plaintext credential — logging it creates a new attack surface |
| `api_key_id` (UUID) | Yes | Links activity to the key row in the database without exposing credential material |
| `workspace_id` | Yes | Enables per-tenant activity queries |
| `tool_name`, `outcome`, `scopes_used` | Yes | Core audit data |
| `duration_ms` | Yes | Performance monitoring; anomalies may indicate abuse |
| Inbox ID | Yes | Which inbox was accessed |
| Email content or headers | Never in activity_log | Email content is accessed-by-tool; the log records only that the tool was called |

```typescript
// supabase/functions/mcp/activity.ts
interface ActivityLogEntry {
  workspace_id:    string;
  api_key_id:      string;
  tool_name:       string;
  scopes_used:     string[];
  key_hash_prefix: string;  // apiKey.key_hash.slice(0, 8) — NEVER the full hash
  outcome:         'success' | 'error' | 'scope_denied';
  error_code?:     string;
  duration_ms:     number;
  inbox_id?:       string;
}

export async function logActivity(entry: ActivityLogEntry): Promise<void> {
  const { error } = await supabase
    .from('activity_log')
    .insert(entry);

  if (error) {
    // Log to the Edge Function's stderr, not to any DB table that could be queried.
    console.error('activity_log_insert_failed', {
      tool_name: entry.tool_name,
      outcome:   entry.outcome,
      // Do NOT log key_hash_prefix or workspace_id in this error path —
      // they are available from the request context, not from the log failure.
    });
  }
}
```

### 6.4 Rate Limiting Failed Lookups

Repeated failed authentication attempts could indicate a brute-force attempt against a known hash prefix. SHA-256 of a 256-bit random key cannot be brute-forced, but rate limiting is applied regardless — it defends against:

- Credential stuffing with keys leaked from other services.
- Automated scanning for valid key prefixes.
- DoS via authentication load.

Rate limiting is applied at two layers:

**Layer 1: Supabase Edge Function — in-memory per-IP rate limit.**

```typescript
// supabase/functions/mcp/rateLimit.ts
// Simple in-memory counter — resets on each Edge Function cold start.
// For distributed rate limiting, use a Supabase KV store or Upstash Redis.

const failedAttempts = new Map<string, { count: number; resetAt: number }>();

const MAX_FAILURES   = 10;    // max failed attempts per window
const WINDOW_MS      = 60_000; // 1-minute rolling window
const BACKOFF_STATUS = 429;

export function checkRateLimit(ip: string): void {
  const now = Date.now();
  const state = failedAttempts.get(ip);

  if (!state || now > state.resetAt) {
    // No state or window expired — reset.
    failedAttempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return;
  }

  if (state.count >= MAX_FAILURES) {
    throw new McpError(
      null,
      -32002,
      'Too many failed authentication attempts. Try again in 60 seconds.',
      { status: BACKOFF_STATUS, retry_after: Math.ceil((state.resetAt - now) / 1000) }
    );
  }
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const state = failedAttempts.get(ip);

  if (!state || now > state.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    state.count += 1;
  }
}
```

**Layer 2: Supabase platform-level rate limiting.** The Supabase Edge Function platform applies a per-project request rate limit. Configure it in the Supabase dashboard under Edge Functions → Rate Limiting to a value appropriate for the expected MCP call volume.

**Integration with the auth middleware:**

```typescript
// In authenticateRequest() — top of function body:
const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
checkRateLimit(clientIp);

// ... authentication logic ...

// After the DB lookup, if authentication fails:
recordFailedAttempt(clientIp);
throw new McpError(requestId, -32002, 'API key is invalid, expired, or has been revoked.');

// If authentication succeeds, do NOT call recordFailedAttempt.
// Successful authentication resets nothing — a successful attempt after 9
// failures still has those 9 recorded.
```

### 6.5 Secret Scanning Integration

The `mcpe_` prefix is documented in `.github/secret-scanning.json` for GitHub Advanced Security and in `.trufflehog.yml` for truffleHog. CI runs truffleHog on every pull request. Any commit containing a string matching `mcpe_[0-9a-f]{64}` is blocked and triggers an alert.

```yaml
# .trufflehog.yml
rules:
  - name: MCPEmails API Key
    regex: 'mcpe_[0-9a-f]{64}'
    keywords:
      - mcpe_
    severity: CRITICAL
    description: MCPEmails MCP API key detected. Revoke immediately at https://app.mcpemails.com.
```

If a key is detected in a commit, the response procedure is:

1. Immediately revoke the key via the dashboard or directly via the API.
2. Review `activity_log` for any tool calls made with the exposed key after the commit was pushed.
3. Rotate to a new key and update the affected MCP client configuration.
4. Assess whether any emails were accessed or sent by an unauthorised party during the exposure window.

### 6.6 Key Expiry Policy Recommendations

MCPEmails does not enforce a maximum key lifetime by default, but the following policies are recommended:

| Use Case | Recommended `expires_at` |
|---|---|
| Personal use (single user, trusted device) | 1 year or null |
| Team / shared MCP client | 90 days |
| CI/CD automation | 30 days |
| One-off agent task | 24 hours |
| OAuth-delegated third-party MCP client | Same as OAuth token lifetime |

The dashboard surfaces a warning when a key has not been used in 90 days (`last_used_at < now() - interval '90 days'`), prompting the user to revoke it.

### 6.7 Environment Variable Security

The Edge Function requires two environment variables that must be treated as highly sensitive:

| Variable | Purpose | Compromise Impact |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS for the `api_keys` lookup | Full read/write access to all tenant data |
| `SUPABASE_URL` | Edge Function's own project URL | Low sensitivity alone; needed alongside the service key |

**Rules:**

- `SUPABASE_SERVICE_ROLE_KEY` must never appear in client-side code, Next.js `NEXT_PUBLIC_*` variables, or response bodies.
- Set it only via `supabase secrets set SERVICE_ROLE_KEY=...` in CI/CD, never in `.env` files committed to the repository.
- Rotate the service role key immediately if it appears in any log, output, or repository.

---

## 7. Implementation Checklist

The following checklist covers every item that must be implemented and verified before the API key system is considered production-ready:

### Key Generation

- [ ] `generateApiKey()` uses `crypto.randomBytes(32)` — no Math.random(), no UUIDs
- [ ] Output format is `mcpe_` + exactly 64 lowercase hex characters (total 69 chars)
- [ ] `hashApiKey()` uses SHA-256 with UTF-8 encoding, producing a 64-char lowercase hex string
- [ ] The Node.js and Deno implementations of `hashApiKey()` produce identical output for the same input
- [ ] `rawKey` is never written to any database column, log line, or HTTP response after the creation response
- [ ] Creation route returns `rawKey` in the 201 response exactly once; no other endpoint returns it
- [ ] Frontend dialog is non-dismissible until the user acknowledges copying the key

### Database

- [ ] `api_keys` table has all columns specified in Section 2.1
- [ ] `UNIQUE` constraint on `key_hash`
- [ ] `CHECK (char_length(key_hash) = 64)` constraint
- [ ] `CHECK` constraint on `scopes` restricting to the five defined scope values
- [ ] Indexes defined as specified in Section 2.2
- [ ] `moddatetime` trigger on `api_keys.updated_at`
- [ ] RLS enabled; all four policies applied (select, insert, update, no-hard-delete)
- [ ] `activity_log.api_key_id` is `ON DELETE SET NULL` (not CASCADE)
- [ ] No `updated_at` or `DELETE` policy on `activity_log` (append-only)

### Scopes

- [ ] `TOOL_SCOPE_MAP` is defined as a `Readonly` constant (not mutable at runtime)
- [ ] All five scopes are defined; no wildcard or omnibus scopes
- [ ] Route Handler rejects unknown scopes at key creation with a 400
- [ ] `enforceToolScope` runs before any tool handler, not inside it
- [ ] Scope denial is logged to `activity_log` before the error is thrown

### Authentication Middleware

- [ ] Bearer token is extracted from `Authorization: Bearer ...` header only
- [ ] Token format is validated (`mcpe_` prefix + length check) before hashing
- [ ] Hash lookup uses `service_role` client (not `anon` or authenticated user client)
- [ ] Single query checks `key_hash`, `revoked_at IS NULL`, and expiry in one round-trip
- [ ] `crypto.timingSafeEqual` applied after DB returns candidate row
- [ ] Same 401 error for not-found, revoked, and expired keys
- [ ] `last_used_at` is updated asynchronously (fire-and-forget, not awaited)
- [ ] Rate limiting applied per-IP before the DB lookup

### Lifecycle

- [ ] Revocation sets `revoked_at = now()` — no hard deletes
- [ ] Revocation route is idempotent (`.is('revoked_at', null)` guard)
- [ ] Rotation creates a new key before revoking the old one (never in reverse order)
- [ ] `activity_log` rows reference `api_key_id` (not `key_hash`) for post-revocation audit

### Audit Logging

- [ ] Every tool call (success, error, scope_denied) appends to `activity_log`
- [ ] `key_hash_prefix` logged as `key_hash.slice(0, 8)` — never full hash, never raw key
- [ ] `api_key_id` UUID logged for DB-level traceability
- [ ] Email content is not present in any `activity_log` column

### Secret Scanning

- [ ] `mcpe_[0-9a-f]{64}` pattern registered in GitHub secret scanning
- [ ] truffleHog runs in CI on every pull request
- [ ] Revocation runbook is documented and accessible to on-call engineers
