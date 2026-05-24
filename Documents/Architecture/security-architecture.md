# Security Architecture

## Purpose

This document is the single authoritative reference for security decisions in MCPEmails. It describes the full threat model, every cryptographic mechanism used to protect data at rest and in transit, the database-level access controls that enforce multi-tenant isolation, and the operational practices that keep the system auditable. Every decision recorded here is final and implemented; nothing is a placeholder.

Companion documents:
- `database-schema.md` — table definitions and encrypted column layout
- `row-level-security.md` — RLS policy definitions
- `authentication-session-management.md` — user JWT flows and session lifecycle
- `Documents/MCP/security-best-practices.md` — upstream MCP threat reference

---

## 1. Threat Model

### 1.1 Assets Being Protected

| Asset | Sensitivity | Impact of Compromise |
|---|---|---|
| OAuth access tokens (Gmail, Outlook) | Critical | Attacker reads, sends, and deletes user email; full inbox access for token lifetime |
| OAuth refresh tokens | Critical | Long-lived; enables ongoing inbox access until user revokes in provider's console |
| IMAP/SMTP passwords (Fastmail) | Critical | Non-expiring; attacker has permanent IMAP access until user changes password |
| MCP API keys | High | Attacker can invoke all scoped MCP tools as the user; triggers billing and rate limits |
| User email addresses | Medium | PII; enumerable if exposed; regulatory obligation (GDPR) |
| Workspace configuration and inbox metadata | Medium | Reveals which email providers the user has connected; minor competitive sensitivity |
| Supabase service role key | Critical | Bypasses all RLS; full read/write access to every tenant's data |
| Token encryption key (`TOKEN_ENCRYPTION_KEY`) | Critical | Decrypts all stored OAuth and IMAP credentials across all tenants |

### 1.2 Adversaries

**Malicious MCP clients.** An AI agent or third-party MCP client that has obtained a valid API key may attempt to exceed its granted scopes, access inboxes it was not granted access to, or exploit confused-deputy patterns to obtain authorization codes for other users. Mitigations: per-key scope enforcement, inbox allowlists, per-client consent storage, exact redirect URI validation.

**Compromised API keys.** An API key leaked via a client's log file, config file, or environment variable gives the adversary bearer-token access to the MCP tools that key is scoped for. Mitigations: keys are scoped and inbox-restricted; they can be revoked instantly; audit logs detect unusual call patterns.

**Database leaks.** A SQL injection exploit or Supabase misconfiguration that grants read access to the raw database tables. The adversary sees ciphertext for OAuth tokens and IMAP passwords (AES-256-GCM), bcrypt hashes for API keys, and plaintext metadata that contains no credentials. Mitigations: application-layer AES-256-GCM encryption, bcrypt key hashing, Supabase RLS, Supabase Vault.

**SSRF via OAuth metadata discovery.** During OAuth token exchange or provider metadata discovery, a crafted server response could direct MCPEmails to make server-side HTTP requests to internal infrastructure (cloud metadata endpoint at 169.254.169.254, internal Redis, admin panels). Mitigations: provider URL allowlist, HTTPS-only enforcement, private IP range blocking.

**Confused deputy attacks.** A malicious MCP client exploits the fact that MCPEmails uses a static OAuth client ID with Gmail/Outlook to craft a link that, when visited by a user who already has a consent cookie from a prior authorization, silently grants an authorization code to the attacker's redirect URI. Mitigations: per-client consent storage, state parameter validation, exact redirect URI matching.

**Insider threats and compromised service role key.** A Supabase service role key appearing in a log file or misconfigured environment variable grants full database bypass. Mitigations: service role key never loaded in client-facing code, Edge Functions use it only in the trusted Supabase execution environment, secret scanning in CI.

**Session hijacking.** An attacker obtains a user's Supabase session cookie or a JWT before expiry. Mitigations: HttpOnly + Secure + SameSite=Lax cookies, PKCE for auth code exchange, server-side token validation via `getUser()` (detects revocation even within JWT TTL).

**Prompt injection via email content.** A malicious email body instructs the AI agent to take destructive actions (forward email to attacker, delete messages). Mitigation: email content is passed to the MCP tool call result, not to the tool's execution context; scope enforcement limits destructive operations to keys that explicitly include `send:email` or `manage:folders`.

### 1.3 Out of Scope

- Physical access to Supabase infrastructure (Supabase's responsibility)
- Client-side compromise of the user's machine where their AI agent runs
- Zero-day vulnerabilities in Next.js, Supabase, or Node.js runtimes

---

## 2. API Key Security

### 2.1 Key Generation

API keys are generated in the Next.js Route Handler that handles key creation requests. No third-party library is used for the random source; Node.js `crypto.randomBytes` is the only CSPRNG used.

```typescript
// utils/apiKeys.ts
import crypto from 'node:crypto';

const KEY_PREFIX = 'mcpe_';
const KEY_BYTE_LENGTH = 32; // 256 bits of entropy

/**
 * Generate a new MCP API key. Returns the raw key (shown once to the user)
 * and the SHA-256 hex digest for storage.
 */
export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomBytes = crypto.randomBytes(KEY_BYTE_LENGTH);
  const rawKey = KEY_PREFIX + randomBytes.toString('hex'); // e.g. mcpe_a3f8b2c9...

  // SHA-256 is used for lookup (not bcrypt) because:
  // 1. API keys are 256 bits of entropy — brute-force is computationally infeasible
  //    regardless of hash speed; bcrypt's slow hashing buys nothing here.
  // 2. We need constant-time lookup in the hot MCP authentication path.
  // 3. The key itself functions as the pre-image protection — no password dictionary
  //    applies to a 32-byte random value.
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.substring(0, KEY_PREFIX.length + 8); // "mcpe_" + 8 hex chars

  return { rawKey, keyHash, keyPrefix };
}

/**
 * Hash an incoming bearer token for constant-time comparison against stored hashes.
 * Always produces the same output for the same input; timing is identical for all inputs.
 */
export function hashIncomingKey(bearerToken: string): string {
  return crypto.createHash('sha256').update(bearerToken).digest('hex');
}

/**
 * Constant-time comparison of two hex strings to prevent timing oracle attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
```

### 2.2 Key Format

```
mcpe_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7d9e0f2a4b6c8d0e2f4a6b8c0d2e4f6
│    │
│    └── 64 hex characters = 32 bytes = 256 bits of CSPRNG output
└─────── fixed prefix; allows log scanning and secret detection tooling
```

The prefix `mcpe_` is documented in `.env.example` and registered with GitHub's secret scanning and truffleHog so that any key committed to a repository triggers an immediate alert.

### 2.3 Storage Model

The database stores only:
- `key_prefix` — the first 8 characters after the prefix (`mcpe_` + first 8 hex chars). Shown in the dashboard to help users identify which key is which. Not usable for authentication.
- `key_hash` — the SHA-256 hex digest. Used for authentication lookups. Not reversible to the original key.

The raw key is returned exactly once in the API response at creation time and never persisted anywhere (database, log, response cache). The application never loads a raw key from storage after creation.

### 2.4 Why SHA-256 Instead of bcrypt

bcrypt is chosen for password hashing because it is slow, which defends against dictionary attacks on low-entropy human-chosen passwords. An MCP API key has 256 bits of CSPRNG entropy. The time to brute-force a single SHA-256 digest of a 256-bit random value exceeds the age of the universe on any foreseeable hardware. bcrypt would add 200–400 ms of latency to every MCP tool call with no security benefit for this entropy level. SHA-256 with a 256-bit random pre-image is correct here.

### 2.5 Authentication Path

```
MCP request arrives with Authorization: Bearer <token>
          │
          ▼
Edge Function: hashIncomingKey(token) → sha256_hex
          │
          ▼
SELECT id, workspace_id, scopes, inbox_ids, expires_at, deleted_at
  FROM api_keys
  WHERE key_hash = sha256_hex    -- index lookup; O(1)
          │
          ├─ No row found → 401 Unauthorized
          ├─ deleted_at IS NOT NULL → 401 Unauthorized (revoked)
          ├─ expires_at < now() → 401 Unauthorized (expired)
          └─ All checks pass → resolve workspace, enforce scopes
```

The lookup is a single indexed equality check. `constantTimeEqual` is not needed here because the hash comparison is done by the database, not in application code. However, the Route Handler that handles dashboard key verification does use `constantTimeEqual` when re-deriving hashes in memory.

---

## 3. OAuth Token Encryption

### 3.1 Design Decisions

OAuth access tokens and refresh tokens, and IMAP passwords, are encrypted at the application layer before being written to Supabase. This is defence-in-depth: even if a database dump is obtained (bypassing Supabase's Transparent Column Encryption layer), all credential columns contain only AES-256-GCM ciphertext.

**Algorithm choice.** AES-256-GCM provides authenticated encryption: it both encrypts the data (confidentiality) and authenticates it (integrity). An attacker who modifies the ciphertext in the database will cause decryption to fail with an authentication tag mismatch rather than silently returning corrupt data that could be used to construct an exploit.

**Key source.** The encryption key is derived from the `TOKEN_ENCRYPTION_KEY` environment variable (a 64-character hex string representing 32 random bytes). It is resolved at Edge Function startup, never logged, and never transmitted to the client. A single key encrypts all tenants' tokens; key rotation (see Section 10) requires a re-encryption job.

**IV policy.** A fresh 12-byte IV is generated using `crypto.randomBytes(12)` for every encryption call. The IV is not secret, but it must be unique per (key, plaintext) pair. Using a random IV gives a collision probability of 1/2^96 per key, which is negligible. The IV is stored prepended to the ciphertext; the decryption function reads the first 12 bytes as the IV and the remaining bytes as ciphertext + auth tag.

**Storage format.** The `bytea` column stores: `[12 bytes IV] || [N bytes ciphertext] || [16 bytes GCM auth tag]`. Total overhead per token: 28 bytes.

### 3.2 Encryption Utility

```typescript
// utils/tokenEncryption.ts
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV — recommended for GCM
const TAG_LENGTH = 16;  // 128-bit authentication tag — GCM default

/**
 * Derive the 32-byte encryption key from the environment variable.
 * Called once at module load; throws immediately if the variable is missing
 * or has incorrect length, preventing silent failures.
 */
function getEncryptionKey(): Buffer {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hexKey, 'hex');
}

const ENCRYPTION_KEY: Buffer = getEncryptionKey();

/**
 * Encrypt a plaintext string (OAuth token or IMAP password) for storage.
 * Returns a Buffer containing: [12-byte IV] || [ciphertext] || [16-byte auth tag].
 *
 * The returned Buffer is stored directly as a PostgreSQL `bytea` column value.
 */
export function encryptToken(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv, {
    authTagLength: TAG_LENGTH,
  });

  const ciphertextParts = [
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ];

  const authTag = cipher.getAuthTag();

  // Layout: IV (12) || ciphertext (variable) || auth tag (16)
  return Buffer.concat([iv, ...ciphertextParts, authTag]);
}

/**
 * Decrypt a Buffer previously produced by encryptToken.
 * Throws if the auth tag does not match — indicates ciphertext tampering or
 * key mismatch. Callers must treat a thrown error as a security event and
 * log it (without the ciphertext) before returning a 500 to the user.
 */
export function decryptToken(cipherBuffer: Buffer): string {
  if (cipherBuffer.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Ciphertext buffer too short to be valid');
  }

  const iv = cipherBuffer.subarray(0, IV_LENGTH);
  const authTag = cipherBuffer.subarray(cipherBuffer.length - TAG_LENGTH);
  const ciphertext = cipherBuffer.subarray(IV_LENGTH, cipherBuffer.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final('utf8');
}
```

### 3.3 Usage Pattern

```typescript
// Inside the OAuth callback handler (Route Handler):
import { encryptToken } from '@/utils/tokenEncryption';

const { access_token, refresh_token, expires_in } = await exchangeCodeForTokens(code);

await supabase.from('inboxes').update({
  oauth_access_token:  encryptToken(access_token),   // stored as bytea
  oauth_refresh_token: encryptToken(refresh_token),  // stored as bytea
  oauth_token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
}).eq('id', inboxId);

// access_token and refresh_token go out of scope here; never persisted in plaintext.
```

```typescript
// Inside the MCP Edge Function, before calling Gmail API:
import { decryptToken } from '@/utils/tokenEncryption';

const { data: inbox } = await supabase
  .from('inboxes')
  .select('oauth_access_token, oauth_refresh_token, oauth_token_expires_at')
  .eq('id', inboxId)
  .single();

const accessToken = decryptToken(inbox.oauth_access_token);
// Use accessToken for the Gmail API call; discard after the call completes.
```

### 3.4 Failure Behaviour

If `decryptToken` throws (auth tag mismatch), the Edge Function:
1. Logs the event to `auth_logs` with `event_type: 'token_decryption_failure'` and the `inbox_id` (no ciphertext, no key material).
2. Sets `inboxes.status = 'error'` and `inboxes.last_error = 'Credential decryption failed; please reconnect.'`
3. Returns `500` to the MCP client with a generic message. The MCP client should surface this to the user.

---

## 4. Supabase Row-Level Security

### 4.1 How RLS Protects Against Bypassed Application Auth

RLS policies are enforced by the PostgreSQL query engine, not by application code. Even if a bug in a Server Component, Route Handler, or Edge Function omits a workspace filter — or if an attacker crafts a request that reaches the database without passing through application auth checks — the database engine rewrites every query to include the workspace membership condition before executing it.

The core identity resolution function:

```sql
CREATE OR REPLACE FUNCTION public.my_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid();
$$;
```

`auth.uid()` is set by PostgREST from the JWT's `sub` claim after verifying the JWT signature against Supabase's project secret. It cannot be spoofed by a client.

### 4.2 Key Policies

Every tenant-scoped table has RLS enabled. The key security properties are:

**Cross-tenant isolation.** A query for `inboxes` with the `authenticated` role is always appended with `WHERE workspace_id = ANY(my_workspace_ids())`. A user whose workspace is `ws-A` will receive zero rows from `ws-B`, not an error — this prevents workspace existence enumeration through error messages.

**Append-only audit tables.** `activity_log` and `auth_logs` have no `UPDATE` or `DELETE` policy for the `authenticated` role. No permissive policy means PostgreSQL's default-deny behaviour applies. Application bugs cannot overwrite or delete audit records; only `service_role` (used exclusively in trusted Edge Functions) can insert into these tables.

**Soft-delete invisibility.** Policies on `inboxes` and `api_keys` include `AND deleted_at IS NULL` in their `USING` clauses. Revoked keys and disconnected inboxes are invisible to the `authenticated` role; they remain in the database for audit purposes and can only be seen via `service_role`.

**MCP authentication exception.** The initial API key lookup in the MCP Edge Function must resolve a `workspace_id` from a `key_hash` without knowing the workspace upfront. This single query uses `service_role`. After the workspace is resolved, all subsequent queries in the request use workspace-scoped conditions. See `row-level-security.md` Section "MCP authentication exception" for the exact code path.

**Credential column protection.** RLS does not restrict column-level access (that is a separate PostgreSQL grant mechanism not used here). Application code enforces that `oauth_access_token`, `oauth_refresh_token`, and `imap_password` are only fetched by the specific Edge Functions that need them; all other queries name only non-sensitive columns explicitly.

### 4.3 Validation

The test suite in `supabase/tests/rls/` creates two isolated workspaces (Workspace A and Workspace B) with separate user accounts and asserts cross-tenant isolation for every table, every operation, and both `authenticated` and `anon` roles. A CI check using `psql` meta-commands verifies that every table in the `public` schema has `relrowsecurity = true` before any migration is merged.

---

## 5. SSRF Prevention

### 5.1 Attack Surface

MCPEmails makes outbound HTTP requests during OAuth flows (token endpoint calls to Google, Microsoft, Fastmail) and during MCP tool execution (Gmail API, Microsoft Graph API). If any of those URLs were derived from user-controlled input or from a third-party response that could be manipulated, an attacker could redirect MCPEmails to internal infrastructure.

### 5.2 Provider URL Allowlist

All OAuth provider URLs are hardcoded constants. No URL is ever constructed from user input or from a discoverable metadata document fetched at runtime. The complete set of permitted outbound OAuth domains:

```typescript
// utils/oauthProviders.ts
export const OAUTH_PROVIDER_ENDPOINTS = {
  gmail: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:         'https://oauth2.googleapis.com/token',
    revokeUrl:        'https://oauth2.googleapis.com/revoke',
    apiBase:          'https://gmail.googleapis.com',
  },
  outlook: {
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl:         'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revokeUrl:        'https://graph.microsoft.com/v1.0/me/revokeSignInSessions',
    apiBase:          'https://graph.microsoft.com',
  },
  fastmail: {
    authorizationUrl: 'https://www.fastmail.com/oauth',
    tokenUrl:         'https://www.fastmail.com/oauth/refresh',
    apiBase:          'https://jmap.fastmail.com',
  },
} as const;

type AllowedHost =
  | 'accounts.google.com'
  | 'oauth2.googleapis.com'
  | 'gmail.googleapis.com'
  | 'login.microsoftonline.com'
  | 'graph.microsoft.com'
  | 'www.fastmail.com'
  | 'jmap.fastmail.com';

const ALLOWED_HOSTS = new Set<string>([
  'accounts.google.com',
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'www.fastmail.com',
  'jmap.fastmail.com',
]);

/**
 * Assert that a URL is in the provider allowlist before making any fetch call.
 * Throws immediately if the URL does not match; this prevents any accidental
 * fetch to an unlisted host from being introduced by a future code change.
 */
export function assertAllowedProviderUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`SSRF guard: only HTTPS provider URLs are permitted. Got: ${parsed.protocol}`);
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`SSRF guard: host not in provider allowlist: ${parsed.hostname}`);
  }
}
```

Every `fetch()` call targeting an OAuth provider is preceded by `assertAllowedProviderUrl(url)`. This is enforced by a custom ESLint rule (`no-unlisted-fetch`) that requires the assertion call in the same code block as any `fetch` in `utils/oauth*.ts` and `supabase/functions/`.

### 5.3 Private IP Range Blocking

MCPEmails does not implement a dynamic egress proxy. Instead it relies on the allowlist approach above (which is stronger: no request to an unlisted host is made, regardless of the host's IP). However, the Supabase Edge Function runtime (Deno Deploy) has egress controls that block requests to RFC-1918 private ranges at the network layer. This provides a second layer of defence.

For IMAP/SMTP connections (Fastmail, generic IMAP), the host is user-supplied. Validation is applied before any connection is attempted:

```typescript
// utils/imapSanitizer.ts
import dns from 'node:dns/promises';

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,   // link-local / cloud metadata
  /^0\./,
];

const PRIVATE_IPV6_PATTERNS = [/^::1$/, /^fc/, /^fd/, /^fe80/];

export async function assertSafeImapHost(host: string): Promise<void> {
  // Reject bare IP addresses — users should provide hostnames
  const isIp = /^[\d.]+$/.test(host) || host.includes(':');
  if (isIp) {
    throw new Error('IMAP host must be a hostname, not an IP address');
  }

  // Resolve to IP and check against private ranges
  const addresses = await dns.lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (family === 4) {
      if (PRIVATE_IPV4_RANGES.some((re) => re.test(address))) {
        throw new Error(`SSRF guard: IMAP host resolves to private IP range: ${address}`);
      }
    } else if (family === 6) {
      if (PRIVATE_IPV6_PATTERNS.some((re) => re.test(address))) {
        throw new Error(`SSRF guard: IMAP host resolves to private IPv6 range: ${address}`);
      }
    }
  }
}
```

This DNS-based check is subject to TOCTOU (time-of-check to time-of-use) if DNS resolution changes between validation and connection. For IMAP providers like Fastmail this is not a practical concern because the hostname is validated once at connection setup time and then pinned. Generic IMAP providers are validated at every reconnect. A future improvement would use Smokescreen or similar egress proxy for IMAP connections.

### 5.4 Redirect Following

OAuth token endpoint requests (`POST`) are made with `redirect: 'error'` (no automatic redirect following). Authorization URL redirects are handled by the browser, not the server. No server-side code follows HTTP redirects when making OAuth calls, eliminating redirect-chain SSRF.

---

## 6. Confused Deputy Prevention

### 6.1 The Attack

MCPEmails acts as a static OAuth client ID with Gmail and Microsoft (all users share the same `GMAIL_CLIENT_ID`). If a user has previously authorized MCPEmails and the provider set a consent cookie, a malicious MCP client could craft an authorization URL with its own `redirect_uri` and exploit the consent cookie to obtain an authorization code silently redirected to the attacker's endpoint.

### 6.2 Per-Client Consent Storage

The `mcp_client_consents` table records explicit user consent for each MCP `client_id`:

```sql
CREATE TABLE public.mcp_client_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id     text NOT NULL,              -- dynamically registered MCP client ID
  redirect_uri  text NOT NULL,             -- the exact redirect_uri approved by the user
  scopes        text[] NOT NULL,           -- scopes the user approved for this client
  consented_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id, client_id)
);
```

### 6.3 Authorization Flow with Consent Check

```
MCP client sends /authorize?client_id=<cid>&redirect_uri=<uri>&scope=<scopes>
          │
          ▼
MCPEmails checks mcp_client_consents for (user_id, client_id)
          │
          ├─ Consent row exists with matching redirect_uri and superset scopes
          │      └─ Proceed directly to provider OAuth flow
          │
          └─ No consent row OR different redirect_uri OR new scopes
                 └─ Show MCPEmails consent page (NOT provider page):
                    • display registered client_id and redirect_uri
                    • display requested scopes
                    • CSRF-protected form (SameSite=Lax + CSRF token)
                    • frame-ancestors: none in CSP
                    │
                    ▼
                 User approves → INSERT into mcp_client_consents
                    │
                    ▼
                 Generate state nonce (32 bytes, base64url) → store in oauth_states
                 with (workspace_id, user_id, client_id, redirect_uri, expires_at = now()+10min)
                    │
                    ▼
                 Redirect to provider with MCPEmails's static client_id and state
```

### 6.4 State Parameter Validation

```typescript
// app/api/oauth/callback/route.ts (simplified)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code  = searchParams.get('code');
  const state = searchParams.get('state');

  if (!code || !state) {
    return redirect('/dashboard?error=oauth_missing_params');
  }

  // Look up the state in the database — single use, must exist, must not be expired
  const supabase = await createClient();
  const { data: oauthState, error } = await supabase
    .from('oauth_states')
    .select('id, workspace_id, user_id, provider, redirect_uri, expires_at')
    .eq('state', state)
    .single();

  if (error || !oauthState || new Date(oauthState.expires_at) < new Date()) {
    // State not found, already consumed, or expired — reject
    return redirect('/dashboard?error=oauth_invalid_state');
  }

  // Delete the state row immediately (single-use enforcement)
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);

  // Exchange the code — only against the provider URL for this provider
  const providerEndpoints = OAUTH_PROVIDER_ENDPOINTS[oauthState.provider];
  assertAllowedProviderUrl(providerEndpoints.tokenUrl);

  const tokens = await exchangeCodeForTokens({
    code,
    redirectUri: oauthState.redirect_uri,  // exact match as sent to provider
    tokenUrl: providerEndpoints.tokenUrl,
  });

  // Encrypt and store tokens
  // ...
}
```

**Key guarantees:**
- `state` values are single-use (deleted on first consumption).
- `state` values expire after 10 minutes.
- The `redirect_uri` used in the code exchange is taken from the stored `oauth_states` row, not from the callback request parameters — an attacker cannot substitute a different redirect URI.
- State generation only happens after the user has explicitly approved the consent page.

---

## 7. Audit Logging

### 7.1 What Is Logged

Every MCP tool call produces one row in `activity_log`. The schema (from `database-schema.md`):

```sql
CREATE TABLE public.activity_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id      uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  inbox_id        uuid REFERENCES public.inboxes(id) ON DELETE SET NULL,
  tool_name       text NOT NULL,   -- 'list_inbox' | 'read_email' | 'send_email' | ...
  status          text NOT NULL,   -- 'success' | 'error' | 'rate_limited' | 'unauthorized'
  error_code      text,            -- MCP error code string, if status = 'error'
  duration_ms     integer,         -- wall-clock time for the tool call
  ip_address      inet,            -- source IP of the MCP client
  user_agent      text,            -- User-Agent header from the MCP client
  created_at      timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
```

What is deliberately **not** logged: email message bodies, subject lines, attachment content, the raw bearer token, any OAuth token, any decrypted credential. The `error_code` field contains standardised MCP error codes, never stack traces or credential fragments.

### 7.2 Write Path

The MCP Edge Function writes to `activity_log` using the `service_role` key, because:
1. The MCP request is authenticated by API key, not by a user JWT, so the `authenticated` role is not available.
2. `service_role` bypasses the append-only RLS restriction, which is intentional for the trusted Edge Function.

```typescript
// Inside the MCP Edge Function, after every tool execution:
async function logToolCall(params: {
  workspaceId: string;
  apiKeyId: string | null;
  inboxId: string | null;
  toolName: string;
  status: 'success' | 'error' | 'rate_limited' | 'unauthorized';
  errorCode?: string;
  durationMs: number;
  request: Request;
}): Promise<void> {
  const ip = params.request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null;
  const ua = params.request.headers.get('user-agent') ?? null;

  // Use service-role admin client — this bypasses RLS intentionally
  await adminSupabase.from('activity_log').insert({
    workspace_id: params.workspaceId,
    api_key_id:   params.apiKeyId,
    inbox_id:     params.inboxId,
    tool_name:    params.toolName,
    status:       params.status,
    error_code:   params.errorCode ?? null,
    duration_ms:  params.durationMs,
    ip_address:   ip,
    user_agent:   ua,
  });
}
```

The log write uses a fire-and-await pattern (the write is awaited before returning the tool response). If the write fails, the error is logged to the Edge Function's stderr (visible in Supabase logs) and the tool call response is returned anyway — audit write failures do not cause tool call failures, but they do alert on-call via the stderr monitoring pipeline.

### 7.3 Incident Response

The `activity_log` supports the following incident response queries:

```sql
-- All tool calls made with a specific API key in the last 24 hours:
SELECT tool_name, inbox_id, status, error_code, ip_address, created_at
FROM activity_log
WHERE api_key_id = '<key-uuid>'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;

-- Unusual call patterns: > 50 send_email calls in 1 hour by any key:
SELECT api_key_id, COUNT(*) AS call_count
FROM activity_log
WHERE tool_name = 'send_email'
  AND created_at > now() - interval '1 hour'
GROUP BY api_key_id
HAVING COUNT(*) > 50;

-- All activity from a given IP address:
SELECT workspace_id, api_key_id, tool_name, status, created_at
FROM activity_log
WHERE ip_address = '203.0.113.42'::inet
ORDER BY created_at DESC
LIMIT 500;
```

Rate-limit enforcement (100 calls/minute per key) queries the partition for the current minute:

```sql
SELECT COUNT(*)
FROM activity_log
WHERE api_key_id = '<key-uuid>'
  AND created_at > now() - interval '1 minute';
```

### 7.4 Retention and Archival

Monthly partitions older than 13 months are detached and exported to Supabase Storage as Parquet files before being dropped. The Parquet export preserves the full schema and is queryable via DuckDB or BigQuery for long-term forensics. The live table never exceeds 13 monthly partitions.

---

## 8. HTTP Security Headers

All HTTP responses — whether from Next.js pages, Route Handlers, or Edge Functions — include the following headers. They are set in `next.config.ts` (for Next.js) and in the Edge Function response constructor (for Supabase Edge Functions).

### 8.1 Headers and Rationale

**Content-Security-Policy**

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{nonce}';
  style-src 'self' 'nonce-{nonce}';
  img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com;
  connect-src 'self' https://*.supabase.co wss://*.supabase.co;
  font-src 'self';
  frame-ancestors 'none';
  form-action 'self';
  base-uri 'self';
  upgrade-insecure-requests;
```

`frame-ancestors: none` prevents the MCPEmails consent page from being embedded in an iframe by a malicious third party (clickjacking). `nonce-{nonce}` is generated per-request by Next.js middleware and injected into the CSP header and all `<script>` / `<style>` tags — this eliminates the need for `unsafe-inline` while supporting Next.js's inline script requirements.

**Strict-Transport-Security**

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Two-year HSTS with `includeSubDomains` prevents protocol downgrade attacks. The `preload` directive enables submission to browser preload lists, so the domain is loaded over HTTPS even on first visit by new users.

**X-Frame-Options**

```
X-Frame-Options: DENY
```

Belt-and-suspenders alongside `frame-ancestors: none` in CSP. Older browsers that do not support CSP `frame-ancestors` respect this header.

**X-Content-Type-Options**

```
X-Content-Type-Options: nosniff
```

Prevents browsers from MIME-sniffing responses away from the declared `Content-Type`. Particularly important for email content endpoints that may return user-generated content.

**Referrer-Policy**

```
Referrer-Policy: strict-origin-when-cross-origin
```

Limits the `Referer` header to the origin (no path or query string) on cross-origin requests. Prevents email metadata (e.g., `?thread_id=xxx`) from leaking to external resources.

**Permissions-Policy**

```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

Explicitly disables browser APIs that MCPEmails has no reason to access.

### 8.2 Configuration in Next.js

```typescript
// next.config.ts
const securityHeaders = [
  { key: 'X-Content-Type-Options',   value: 'nosniff' },
  { key: 'X-Frame-Options',          value: 'DENY' },
  { key: 'Referrer-Policy',          value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',       value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // CSP is set dynamically per-request in middleware (nonce injection)
];

export default {
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};
```

The CSP with nonce is set in `middleware.ts` because the nonce must be generated per-request and injected into both the header and the RSC payload. The middleware reads the nonce from `crypto.randomUUID()`, stores it on the request via `x-nonce` header for Server Components to read, and appends the full CSP header to the response.

---

## 9. Input Validation

### 9.1 Principles

All MCP tool inputs are validated at the Edge Function boundary before any downstream call is made. Validation failures return a structured MCP error with code `INVALID_PARAMS` and a human-readable message. Stack traces and internal error messages never reach the MCP client.

Validation is done with [Zod](https://zod.dev/) — schemas are defined alongside the tool implementations and provide type inference for TypeScript as a side effect.

### 9.2 Tool Input Schemas

```typescript
// supabase/functions/mcp/schemas.ts
import { z } from 'zod';

// Shared primitives
const EmailAddress = z.string().email().max(254);   // RFC 5321 max length
const MessageId    = z.string().uuid();             // MCPEmails uses UUID message IDs
const PageSize     = z.number().int().min(1).max(100).default(20);
const PageToken    = z.string().max(512).optional();

// Reject excessively long strings before they hit provider APIs
const SubjectLine  = z.string().min(1).max(998);   // RFC 2822 line length limit
const EmailBody    = z.string().max(10 * 1024 * 1024); // 10 MB

export const ListInboxSchema = z.object({
  inbox_id: MessageId,
  page_size: PageSize,
  page_token: PageToken,
  label: z.string().max(100).optional(),
});

export const ReadEmailSchema = z.object({
  inbox_id: MessageId,
  message_id: z.string().max(256),  // Provider-specific message IDs can be arbitrary strings
});

export const SendEmailSchema = z.object({
  inbox_id:  MessageId,
  to:        z.array(EmailAddress).min(1).max(100),
  cc:        z.array(EmailAddress).max(100).default([]),
  bcc:       z.array(EmailAddress).max(100).default([]),
  subject:   SubjectLine,
  body:      EmailBody,
  body_type: z.enum(['text', 'html']).default('text'),
  // HTML bodies are sanitised before sending — see Section 9.3
});

export const SearchEmailSchema = z.object({
  inbox_id: MessageId,
  query:    z.string().max(500),    // Provider search query; passed as-is but length-capped
  page_size: PageSize,
  page_token: PageToken,
});

export const ReplyEmailSchema = z.object({
  inbox_id:   MessageId,
  message_id: z.string().max(256),
  body:       EmailBody,
  body_type:  z.enum(['text', 'html']).default('text'),
});
```

### 9.3 HTML Email Sanitisation

When `body_type` is `'html'`, the body is sanitised with [DOMPurify](https://github.com/cure53/DOMPurify) (server-side via jsdom) before being passed to the provider API. This prevents an AI agent from sending emails with malicious JavaScript, tracking pixels pointing to data-exfiltrating URLs, or forms.

```typescript
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);

export function sanitiseHtmlEmail(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'ul', 'ol', 'li',
                   'blockquote', 'a', 'h1', 'h2', 'h3', 'pre', 'code'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    FORCE_BODY: true,
  });
}
```

`target` and `rel` are only meaningful on `<a>` tags; the sanitiser enforces `rel="noopener noreferrer"` on all links via a post-processing step.

### 9.4 Search Query Sanitisation

Provider search queries (`search_email.query`) are passed to the Gmail API and Microsoft Graph API as structured query parameters, not as SQL or shell commands, so injection is not a concern at the protocol level. However, queries are length-capped at 500 characters and stripped of ASCII control characters before dispatch.

### 9.5 Error Isolation

Zod `safeParse` is used throughout. A parse failure returns a structured error that is mapped to the MCP `INVALID_PARAMS` error code. The Zod error details (field names and constraints) are included in the error message — they do not expose internal implementation details.

```typescript
const parseResult = ListInboxSchema.safeParse(toolArguments);
if (!parseResult.success) {
  return mcpError({
    code: 'INVALID_PARAMS',
    message: parseResult.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  });
}
const { inbox_id, page_size, page_token } = parseResult.data;
```

---

## 10. Secret Management

### 10.1 Secret Inventory

| Secret | Scope | Owner | Rotation Trigger |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public (client-safe) | Supabase project | Project migration |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public (client-safe) | Supabase project | Compromise suspected |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | Supabase project | Compromise suspected |
| `TOKEN_ENCRYPTION_KEY` | Server-only | MCPEmails | Credential exposure suspected; requires re-encryption job |
| `GMAIL_CLIENT_ID` | Public (in auth URL) | Google Console | Compromise |
| `GMAIL_CLIENT_SECRET` | Server-only | Google Console | Compromise suspected |
| `MICROSOFT_CLIENT_ID` | Public (in auth URL) | Azure App Registration | Compromise |
| `MICROSOFT_CLIENT_SECRET` | Server-only | Azure App Registration | Compromise suspected |
| `FASTMAIL_CLIENT_ID` | Public (in auth URL) | Fastmail Developer Portal | Compromise |
| `FASTMAIL_CLIENT_SECRET` | Server-only | Fastmail Developer Portal | Compromise suspected |

### 10.2 Naming Conventions

- `NEXT_PUBLIC_` prefix: safe to expose in the client JavaScript bundle. Never put a secret here.
- No prefix: server-only. Next.js excludes these from the client bundle automatically; Edge Functions receive them as Supabase secret references.
- Supabase secrets are set via `supabase secrets set <name>=<value>` in CI/CD. They are never written to files or logged.

### 10.3 Environment File Documentation

`.env.example` is committed to the repository and documents every required variable with a description and an example non-secret value. It never contains real values. `.env.local` and `.env.production` are in `.gitignore`.

```bash
# .env.example

# Supabase project credentials — obtain from https://app.supabase.com/project/<id>/settings/api
NEXT_PUBLIC_SUPABASE_URL=https://xyzcompanyabc.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Server-only: never expose in client-side code or NEXT_PUBLIC_ variables
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# AES-256-GCM encryption key for OAuth tokens and IMAP passwords (32 random bytes as hex)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TOKEN_ENCRYPTION_KEY=a1b2c3d4e5f6...64hexchars...

# Gmail OAuth application credentials — obtain from https://console.cloud.google.com/
GMAIL_CLIENT_ID=123456789-abcdefgh.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...

# Microsoft OAuth application credentials — obtain from https://portal.azure.com/
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxx~xxxxxxxxxxxxx

# Fastmail OAuth application credentials — obtain from https://www.fastmail.com/developer/
FASTMAIL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FASTMAIL_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 10.4 Never Log Secrets

The following practices are enforced by code review and ESLint rules:

- No `console.log`, `console.error`, or logger calls may include a variable named `*token*`, `*secret*`, `*key*`, `*password*`, or `*credential*`. The ESLint rule `no-secret-log` is configured to match these patterns.
- Error handlers catch `Error` objects and log only `error.message` and `error.code`, never the full `error` object (which may have the offending value in `error.cause`).
- The `TOKEN_ENCRYPTION_KEY` is never passed as a function argument; it is accessed only within `utils/tokenEncryption.ts` via the module-level constant.
- Structured logging (via `pino`) is configured with a `redact` list: `['req.headers.authorization', 'body.access_token', 'body.refresh_token', 'body.password']`.

### 10.5 Token Encryption Key Rotation

Rotating `TOKEN_ENCRYPTION_KEY` requires re-encrypting all `bytea` columns in `inboxes`. The rotation procedure:

1. Set `TOKEN_ENCRYPTION_KEY_NEXT` in Supabase secrets alongside the existing `TOKEN_ENCRYPTION_KEY`.
2. Deploy a one-off Edge Function that reads each row, decrypts with `TOKEN_ENCRYPTION_KEY`, re-encrypts with `TOKEN_ENCRYPTION_KEY_NEXT`, and writes back — transactionally, one row at a time.
3. After all rows are re-encrypted, set `TOKEN_ENCRYPTION_KEY` to the value of `TOKEN_ENCRYPTION_KEY_NEXT` and remove `TOKEN_ENCRYPTION_KEY_NEXT`.
4. Deploy the updated application that reads only `TOKEN_ENCRYPTION_KEY`.
5. Verify by decrypting a sample row and confirming the access token is valid against the provider.

This procedure does not require downtime; the re-encryption job runs while the application continues to serve traffic using the old key. During the brief window between job completion and application redeployment, newly encrypted rows (by the job) and rows encrypted by the live application are both readable, because the live application still uses the old key. The job writes both old-key-encrypted and new-key-encrypted versions until the application is redeployed.

---

## Summary Decision Table

| Security Control | Mechanism | Covers |
|---|---|---|
| API key brute-force prevention | 256-bit CSPRNG entropy; SHA-256 storage | Database leak |
| API key revocation | Soft delete + lookup excludes `deleted_at IS NOT NULL` | Compromised key |
| OAuth token confidentiality | AES-256-GCM at application layer; IV per encryption | Database leak |
| Credential integrity | GCM auth tag; decryption throws on tamper | Ciphertext modification |
| Multi-tenant isolation | Supabase RLS on all tenant tables | App-level bug, session confusion |
| Audit trail immutability | No UPDATE/DELETE policy on activity_log | Compromised session |
| Confused deputy prevention | Per-client consent table; single-use state nonces; exact redirect URI | Malicious MCP clients |
| SSRF | URL allowlist; HTTPS-only; private IP range block for IMAP | Crafted OAuth responses |
| XSS | HttpOnly cookies; nonce-based CSP; no localStorage for tokens | Script injection |
| Clickjacking | frame-ancestors: none + X-Frame-Options: DENY | Consent page framing |
| Input validation | Zod schemas at Edge Function boundary; size limits | Over-large inputs, malformed data |
| HTML email injection | DOMPurify sanitisation before send | Agent-crafted malicious emails |
| Secret exposure | Never logged; ESLint rules; `.env.example` without values | Log scraping, config leaks |
