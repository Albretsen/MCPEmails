# OAuth 2.0 Implementation Plan

## Purpose

This document describes what must be built to support OAuth 2.0 for the MCP Emails
server. It is implementation-focused: it references the high-level design in
`mcp-authentication-flow.md §7` and translates it into concrete routes, pages,
database changes, and a sequenced build plan.

The immediate driver is claude.ai web's "Add custom connector" feature, which
performs OAuth 2.0 discovery and Authorization Code + PKCE flow before it will
connect to a remote MCP server. Bearer-token-only servers are incompatible with
this flow.

This document has been cross-referenced against all files in `Documents/MCP/`
(authentication.md, spec.md, connect-remote-servers.md, security-best-practices.md,
build-server.md, architecture.md). Discrepancies found in that review are addressed
explicitly in each section.

---

## 1. What Already Exists

### Database (migrations applied)

| Table | Purpose |
|---|---|
| `oauth_clients` | Registered MCP client apps (client_id, redirect_uris, allowed scopes) |
| `oauth_consents` | Per-user approval decisions per client — enables skipping re-consent |
| `oauth_auth_codes` | Short-lived (10 min) PKCE authorization codes, stored hashed |

Pre-seeded clients: `claude-desktop`, `cursor-v1`, `n8n-self-hosted`.
Claude.ai web is **not yet registered**.

### Architecture design

`mcp-authentication-flow.md §7` defines the full Authorization Code + PKCE
sequence. The token strategy: the OAuth flow mints a real `mcpe_` API key (same
format as dashboard-created keys) and returns it as the `access_token`. This means:

- Issued OAuth tokens appear in the user's dashboard API Keys list (labelled
  "OAuth: Claude") so they can be revoked.
- There is no separate access-token table to query on each MCP request.

**Token lifetime (spec-aligned):** `Documents/MCP/authentication.md` mandates
access tokens of 1 hour and refresh tokens of ~6 months. The initial design
proposed long-lived tokens with no refresh — this contradicts the project spec
and is corrected in §3.3 below. The OAuth flow now issues a 1-hour `mcpe_` key
with an accompanying refresh token that generates a replacement key.

### The `/authorize` page

`apps/web/app/authorize/page.js` exists and renders a placeholder. The real
authorize UI and server action are not yet implemented.

### What does not exist

| Component | Status |
|---|---|
| `GET /.well-known/oauth-authorization-server` | ❌ Missing |
| `GET /.well-known/oauth-protected-resource` | ❌ Missing (required for discovery chain) |
| `WWW-Authenticate: Bearer resource_metadata=…` on 401 responses | ❌ Missing |
| `GET /authorize` — full UI + Server Action | ❌ Placeholder only |
| `POST /api/oauth/token` | ❌ Missing |
| `POST /api/oauth/register` (Dynamic Client Registration) | ❌ Missing |
| `POST /api/oauth/revoke` | ❌ Missing |
| claude.ai registered in `oauth_clients` | ❌ Missing |
| State nonce server-side storage + validation | ❌ Missing |
| SSRF mitigations on redirect URI validation | ❌ Missing |

---

## 2. How claude.ai Web Connects

When a user enters `https://mcpemails.com/api/mcp` as a custom connector URL,
a compliant MCP client (claude.ai) does the following:

```
1. POST https://mcpemails.com/api/mcp  (no auth)
   ← 401 WWW-Authenticate: Bearer resource_metadata=https://mcpemails.com/.well-known/oauth-protected-resource

2. GET https://mcpemails.com/.well-known/oauth-protected-resource
   ← { authorization_servers: ["https://mcpemails.com"] }

3. GET https://mcpemails.com/.well-known/oauth-authorization-server
   ← { authorization_endpoint, token_endpoint, registration_endpoint, … }

4. (Optional) POST https://mcpemails.com/api/oauth/register
   ← { client_id: "dyn_..." }  ← only if claude.ai is not pre-registered

5. Redirect user to authorization_endpoint with:
   ?client_id=...
   &redirect_uri=https://claude.ai/api/oauth/callback  (verify exact URI)
   &response_type=code
   &scope=read:email search:email
   &state=<cryptographically random, stored by claude.ai>
   &code_challenge=<SHA-256 of verifier, base64url>
   &code_challenge_method=S256

6. User logs in to MCP Emails (if not already) and approves scopes

7. Server validates state, generates auth code, redirects to client callback
   ?code=...&state=<original>

8. claude.ai POSTs to token_endpoint with code + code_verifier

9. Server returns:
   { access_token: "mcpe_...", token_type: "bearer",
     expires_in: 3600, refresh_token: "mcpr_..." }

10. claude.ai sends Authorization: Bearer mcpe_... on all MCP requests
    and refreshes when the token nears expiry
```

---

## 3. Endpoints to Build

### 3.1 Protected Resource Metadata (`/.well-known/oauth-protected-resource`)

**File:** `apps/web/app/.well-known/oauth-protected-resource/route.ts`

> **Spec gap addressed:** The MCP spec discovery chain begins at the resource server,
> not the authorization server. MCP clients send an unauthenticated request and expect
> a `WWW-Authenticate: Bearer resource_metadata=<url>` response header, then fetch the
> Protected Resource Metadata to discover the authorization server list. Without this
> document, clients cannot auto-discover the OAuth server from the MCP endpoint URL.
> (security-best-practices.md §3 "SSRF — Metadata Discovery")

```typescript
export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  return Response.json({
    resource:            `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['read:email', 'search:email', 'send:email'],
    // Deliberately minimal: security-best-practices.md §6 warns against
    // publishing all possible scopes; privilege escalation is done via
    // incremental WWW-Authenticate scope challenges (see §3.6).
  }, {
    headers: { 'Cache-Control': 'max-age=3600' },
  });
}
```

**Also required on the `/api/mcp` route:** When an unauthenticated request
arrives (missing or invalid bearer token), the proxy must return:

```
HTTP 401
WWW-Authenticate: Bearer realm="MCP Emails",
                  resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"
```

This is the entry point for the entire discovery chain.

---

### 3.2 Authorization Server Metadata (`/.well-known/oauth-authorization-server`)

**File:** `apps/web/app/.well-known/oauth-authorization-server/route.ts`

Returns RFC 8414 metadata. Caches for 1 hour; bump cache when endpoints change.

```typescript
export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL;

  return Response.json({
    issuer:                                 base,
    authorization_endpoint:                 `${base}/authorize`,
    token_endpoint:                         `${base}/api/oauth/token`,
    registration_endpoint:                  `${base}/api/oauth/register`,
    revocation_endpoint:                    `${base}/api/oauth/revoke`,
    scopes_supported: [
      // Minimal initial set per security-best-practices.md §6.
      // Clients should request only what they need; privilege escalation
      // is advertised via WWW-Authenticate challenges at call time.
      'read:email',
      'search:email',
      'send:email',
    ],
    response_types_supported:               ['code'],
    grant_types_supported:                  ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:       ['S256'],   // plain is NOT listed
    token_endpoint_auth_methods_supported:  ['none'],   // public clients only
    revocation_endpoint_auth_methods_supported: ['none'],
  }, {
    headers: { 'Cache-Control': 'max-age=3600' },
  });
}
```

> **Scope minimization (security-best-practices.md §6):** Only publish the initial
> minimal scope set here. Scopes like `manage:drafts` and `manage:folders` are not
> in the discovery document; they are advertised on-demand via `WWW-Authenticate`
> challenges when a tool requiring them is called without the necessary scope.

---

### 3.3 `GET /authorize` — Authorization Page

**File:** `apps/web/app/authorize/page.js` (currently a placeholder)

This is a Next.js **Server Component** (not an API route) because it must:
- Read the user's Supabase session server-side
- Render a real HTML consent UI
- Never expose the `redirect_uri` in client-side JS before validation

**Security headers required on this route:**

```
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
```

> CSP `frame-ancestors` is required by security-best-practices.md §1 "Consent UI
> Requirements: prevent iframing via frame-ancestors CSP." Clickjacking on the
> consent page would allow a malicious site to trick a user into approving a client.

**CSRF protection on the consent form:**

The consent form POST must include a server-issued CSRF token in a hidden field,
validated on submission. Use a signed, short-lived (10 min), single-use value stored
in the user's session. Do not rely on `SameSite` alone — the `/authorize` endpoint
is intended to be reached via cross-site redirects, making `SameSite=Strict`
impractical and `SameSite=Lax` insufficient for form POSTs.

**Validation sequence (server-side, before rendering):**

```
1. Parse: client_id, redirect_uri, scope, state, code_challenge,
   code_challenge_method.

2. Look up client_id in oauth_clients. If not found → render error page.
   NEVER redirect to an unvalidated redirect_uri.

3. Validate redirect_uri:
   a. Exact string match against oauth_clients.redirect_uris[].
   b. Must use HTTPS scheme (except loopback: http://localhost, http://127.0.0.1).
   c. Must not resolve to a private IP range (10/8, 172.16/12, 192.168/16,
      169.254/16, ::1, fc00::/7). Perform DNS resolution and check.
      (security-best-practices.md §3 "SSRF — Mitigation")
   If mismatch or invalid → render error page, do NOT redirect.

4. Validate code_challenge_method === 'S256'. Reject 'plain' or missing.

5. Validate scope: each token must appear in oauth_clients.scopes_allowed.
   Strip unknown scopes (do not reject; per RFC 6749 §3.3 unknown scopes are
   silently ignored by the server).

6. Store the state nonce server-side (in the user's session or a short-lived
   DB table) keyed to this request. State is validated at step 8.
   (security-best-practices.md §1: "Store the state value server-side ONLY
   after consent has been explicitly approved. Validate at the callback endpoint.
   Ensure state values are single-use.")
   → State is stored AFTER validation but BEFORE consent rendering, so it exists
   at the point the Server Action runs.

7. Check user session (createClient().auth.getUser()).
   If not authenticated → redirect to
     /login?redirect=/authorize?client_id=...&redirect_uri=...&<all params URL-encoded>
   Ensure /auth/callback passes /authorize?... as the `next` param.

8. Check oauth_consents for (user_id, client_id).
   If stored consent covers all requested scopes exactly → skip UI, generate
   code immediately, validate stored state, redirect.
   If new scopes are requested → show consent UI for the new scopes only.

9. Render consent UI with CSRF token in a hidden form field.
```

**Consent UI must display:**
- Client name and byline (from `oauth_clients`)
- Client logo (if present)
- Each requested scope with a human-readable description
- List of inboxes the user can optionally restrict access to
- "Approve" and "Deny" buttons

**On Approve (Server Action):**

```typescript
'use server';

async function approveOAuth(formData: FormData) {
  // 1. Validate CSRF token from hidden field against session-stored value.
  //    Reject if missing, expired (>10 min), or already used.

  // 2. Re-validate all parameters (Server Action inputs are user-controlled).

  // 3. Retrieve and validate state nonce from server-side storage.
  //    Reject if not found, already consumed, or expired.
  //    Mark as consumed (single-use).

  // 4. Generate 32-byte random authorization code.
  const rawCode = crypto.getRandomValues(new Uint8Array(32));
  const codeB64 = base64url(rawCode);
  const codeHash = await sha256hex(codeB64);

  // 5. Insert auth code (hashed; plaintext discarded after redirect).
  await supabase.from('oauth_auth_codes').insert({
    code_hash:      codeHash,
    client_id:      clientId,
    workspace_id:   workspaceId,
    user_id:        userId,
    client_name:    client.client_name,
    redirect_uri:   redirectUri,
    code_challenge: codeChallenge,
    // code_challenge_method stored so token endpoint can re-enforce S256.
    scopes:         validatedScopes,
    inbox_ids:      selectedInboxIds.length > 0 ? selectedInboxIds : null,
  });

  // 6. Upsert consent record.
  await supabase.from('oauth_consents').upsert({
    user_id:   userId,
    client_id: clientId,
    scopes:    validatedScopes,
    inbox_ids: selectedInboxIds.length > 0 ? selectedInboxIds : null,
  }, { onConflict: 'user_id, client_id' });

  // 7. Log the authorization grant event (see §7 Audit Logging).

  // 8. Redirect to client callback.
  const destination = new URL(redirectUri);
  destination.searchParams.set('code', codeB64);
  destination.searchParams.set('state', state); // original state round-tripped
  redirect(destination.toString());
}
```

**On Deny:** Redirect to `redirect_uri?error=access_denied&state=<state>`.

---

### 3.4 `POST /api/oauth/token`

**File:** `apps/web/app/api/oauth/token/route.ts`

Exchanges an authorization code for an API key. Server-to-server call from the
MCP client.

```
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code
&code=<plaintext code>
&code_verifier=<PKCE verifier>
&client_id=<registered client_id>
&redirect_uri=<must exactly match /authorize>
```

**CORS:** `Access-Control-Allow-Origin` must be set to the specific registered
client origins where possible, rather than `*`. For dynamically registered clients,
restrict to their registered `client_uri` if provided. `*` is a fallback of last
resort only. `OPTIONS` must be handled for preflight.

> **Spec note (security-best-practices.md §3):** `Access-Control-Allow-Origin: *`
> on the token endpoint allows browser JS from any origin to POST to it. Prefer
> an allowlist of registered client origins.

```typescript
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',   // tighten per client after first integration
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function POST(req: Request) {
  const body         = await req.formData();
  const grantType    = body.get('grant_type') as string;
  const code         = body.get('code') as string;
  const codeVerifier = body.get('code_verifier') as string;
  const clientId     = body.get('client_id') as string;
  const redirectUri  = body.get('redirect_uri') as string;

  const supabase = createServiceRoleClient();

  // ── Authorization Code grant ─────────────────────────────────────────────

  if (grantType === 'authorization_code') {
    const codeHash = await sha256hex(code);
    const { data: authCode } = await supabase
      .from('oauth_auth_codes')
      .select('*')
      .eq('code_hash', codeHash)
      .eq('client_id', clientId)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!authCode) return oauthError('invalid_grant', 400);

    // Exact redirect_uri match.
    if (authCode.redirect_uri !== redirectUri) return oauthError('invalid_grant', 400);

    // Re-enforce S256: read code_challenge_method from stored row.
    // Reject if anything other than 'S256' is stored.
    if (authCode.code_challenge_method !== 'S256') return oauthError('invalid_grant', 400);

    // PKCE: SHA-256(code_verifier) must equal stored code_challenge.
    const computedChallenge = base64urlEncode(await sha256raw(codeVerifier));
    if (computedChallenge !== authCode.code_challenge) return oauthError('invalid_grant', 400);

    // Single-use: delete before issuing token (prevents replay).
    await supabase.from('oauth_auth_codes').delete().eq('id', authCode.id);

    // Issue access token (1-hour mcpe_ key, per authentication.md).
    const { fullKey: accessKey, prefix: accessPrefix } = generateApiKey();
    const accessHash = await hashApiKey(accessKey);
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Issue refresh token (stored separately; not an API key).
    const rawRefresh = crypto.getRandomValues(new Uint8Array(32));
    const refreshToken = `mcpr_${base64url(rawRefresh)}`;
    const refreshHash = await sha256hex(refreshToken);

    await supabase.from('api_keys').insert({
      workspace_id: authCode.workspace_id,
      created_by:   authCode.user_id,
      name:         `OAuth: ${authCode.client_name}`,
      key_prefix:   accessPrefix,
      key_hash:     accessHash,
      scopes:       authCode.scopes,
      inbox_ids:    authCode.inbox_ids ?? null,
      expires_at:   expiresAt,
    });

    await supabase.from('oauth_refresh_tokens').insert({
      refresh_hash:  refreshHash,
      workspace_id:  authCode.workspace_id,
      user_id:       authCode.user_id,
      client_id:     clientId,
      scopes:        authCode.scopes,
      inbox_ids:     authCode.inbox_ids ?? null,
      client_name:   authCode.client_name,
      expires_at:    new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(), // 6 months
    });

    // Log token issuance (§7 Audit Logging).

    return Response.json({
      access_token:  accessKey,
      token_type:    'bearer',
      expires_in:    3600,
      refresh_token: refreshToken,
      scope:         authCode.scopes.join(' '),
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ── Refresh Token grant ──────────────────────────────────────────────────

  if (grantType === 'refresh_token') {
    const refreshToken = body.get('refresh_token') as string;
    if (!refreshToken) return oauthError('invalid_request', 400);

    const refreshHash = await sha256hex(refreshToken);
    const { data: rt } = await supabase
      .from('oauth_refresh_tokens')
      .select('*')
      .eq('refresh_hash', refreshHash)
      .eq('client_id', clientId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!rt) return oauthError('invalid_grant', 400);

    // Refresh token rotation: revoke old, issue new pair.
    await supabase
      .from('oauth_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', rt.id);

    const { fullKey: accessKey, prefix: accessPrefix } = generateApiKey();
    const accessHash = await hashApiKey(accessKey);
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    const rawRefresh2 = crypto.getRandomValues(new Uint8Array(32));
    const newRefreshToken = `mcpr_${base64url(rawRefresh2)}`;
    const newRefreshHash = await sha256hex(newRefreshToken);

    await supabase.from('api_keys').insert({
      workspace_id: rt.workspace_id,
      created_by:   rt.user_id,
      name:         `OAuth: ${rt.client_name}`,
      key_prefix:   accessPrefix,
      key_hash:     accessHash,
      scopes:       rt.scopes,
      inbox_ids:    rt.inbox_ids ?? null,
      expires_at:   expiresAt,
    });

    await supabase.from('oauth_refresh_tokens').insert({
      refresh_hash:  newRefreshHash,
      workspace_id:  rt.workspace_id,
      user_id:       rt.user_id,
      client_id:     clientId,
      scopes:        rt.scopes,
      inbox_ids:     rt.inbox_ids ?? null,
      client_name:   rt.client_name,
      expires_at:    rt.expires_at,  // preserve original 6-month window
    });

    return Response.json({
      access_token:  accessKey,
      token_type:    'bearer',
      expires_in:    3600,
      refresh_token: newRefreshToken,
      scope:         rt.scopes.join(' '),
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  return oauthError('unsupported_grant_type', 400);
}
```

---

### 3.5 `POST /api/oauth/register` (Dynamic Client Registration — RFC 7591)

**File:** `apps/web/app/api/oauth/register/route.ts`

Required if claude.ai does not use a pre-registered client_id.

**Security controls (security-best-practices.md §1 "Confused Deputy"):**

> The spec identifies dynamic client registration as a necessary precondition for
> the confused deputy attack. IP rate-limiting alone is insufficient. Additional
> controls:

- Require an initial access token (bearer) for registration, OR restrict to
  authenticated users. Unauthenticated open registration is explicitly a risk
  vector. If open registration is required for claude.ai compatibility, apply
  strict IP rate limiting AND alert on anomalous registration volume.
- Log all registration events to the audit log (client_id, redirect_uris, origin IP).
- Store a `deactivated_at` column on `oauth_clients` so malicious dynamic clients
  can be disabled without deletion (preserving audit trail).
- Dynamically registered clients cap scopes at `['read:email', 'search:email', 'send:email']`
  — no `manage:*` access without first-party registration.

```typescript
export async function POST(req: Request) {
  // IP rate limiting: max 10 registrations/hour per IP.
  // Return 429 with Retry-After: 3600 if exceeded.

  const body        = await req.json();
  const clientName  = String(body.client_name ?? 'Unknown Client').slice(0, 80);
  const redirectUris: string[] = (Array.isArray(body.redirect_uris) ? body.redirect_uris : [])
    .filter((u: unknown) => typeof u === 'string');

  if (redirectUris.length === 0) {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }

  // SSRF: validate all redirect URIs.
  for (const uri of redirectUris) {
    if (!isValidRedirectUri(uri)) {
      return Response.json({ error: 'invalid_redirect_uri' }, { status: 400 });
    }
  }

  const clientId = `dyn_${randomHex(16)}`;
  const scopesAllowed = ['read:email', 'search:email', 'send:email'];

  await createServiceRoleClient().from('oauth_clients').insert({
    client_id:      clientId,
    client_name:    clientName,
    client_byline:  body.client_uri ?? '',
    redirect_uris:  redirectUris,
    scopes_allowed: scopesAllowed,
    is_first_party: false,
  });

  // Audit log: record registration with IP and all submitted metadata.

  return Response.json({
    client_id:              clientId,
    client_name:            clientName,
    redirect_uris:          redirectUris,
    grant_types:            ['authorization_code', 'refresh_token'],
    response_types:         ['code'],
    token_endpoint_auth_method: 'none',
    scope:                  scopesAllowed.join(' '),
  }, { status: 201 });
}
```

**`isValidRedirectUri` implementation must:**
1. Parse the URI. Reject if unparseable.
2. Require `https:` scheme — except allow `http://localhost` and `http://127.0.0.1`
   for development clients.
3. Resolve the hostname to an IP address. Reject if it resolves to any private
   range: `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `fc00::/7`, `::1`.
   (Blocks cloud metadata endpoint attacks via `169.254.169.254`.)
4. Reject wildcard or path-traversal patterns.

---

### 3.6 `POST /api/oauth/revoke` (RFC 7009)

**File:** `apps/web/app/api/oauth/revoke/route.ts`

```typescript
export async function POST(req: Request) {
  // Validate Origin / Referer header to mitigate CSRF on this endpoint.
  // The token provides implicit CSRF protection (attacker needs the token
  // to do anything useful), but Origin validation is defense-in-depth.
  const origin = req.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403 });
  }

  const body  = await req.formData();
  const token = body.get('token') as string;
  const tokenTypeHint = body.get('token_type_hint') as string | null;

  if (!token) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const supabase = createServiceRoleClient();

  if (!tokenTypeHint || tokenTypeHint === 'access_token') {
    const keyHash = await hashApiKey(token);
    await supabase
      .from('api_keys')
      .update({ deleted_at: new Date().toISOString() })
      .eq('key_hash', keyHash)
      .is('deleted_at', null);
  }

  if (!tokenTypeHint || tokenTypeHint === 'refresh_token') {
    const refreshHash = await sha256hex(token);
    await supabase
      .from('oauth_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('refresh_hash', refreshHash)
      .is('revoked_at', null);
  }

  // RFC 7009 §2.2: always return 200, even if token was not found.
  return new Response(null, { status: 200 });
}
```

---

### 3.7 Update `/api/mcp` proxy — 401 with `WWW-Authenticate`

When the proxy receives a request with no valid bearer token, it must respond:

```
HTTP 401
WWW-Authenticate: Bearer realm="MCP Emails",
                  resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"
```

This is the entry point of the spec-compliant discovery chain (§2 step 1).
Without this header, clients that start from the MCP endpoint URL cannot
auto-discover the OAuth server.

---

## 4. Database Changes Required

### 4.1 `oauth_refresh_tokens` table (new)

```sql
CREATE TABLE public.oauth_refresh_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_hash  text        NOT NULL UNIQUE,
  client_id     text        NOT NULL,
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id)        ON DELETE CASCADE,
  client_name   text        NOT NULL,
  scopes        text[]      NOT NULL DEFAULT '{}',
  inbox_ids     uuid[],
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

-- Only service-role may read/write; no user-facing access.
CREATE POLICY "oauth_refresh_tokens_deny_user_access"
  ON public.oauth_refresh_tokens FOR ALL USING (false);
```

### 4.2 `code_challenge_method` column on `oauth_auth_codes` (alter)

The token endpoint must re-read and re-enforce the stored `code_challenge_method`
to ensure it is `S256`. The column must be stored at `/authorize` time.

```sql
ALTER TABLE public.oauth_auth_codes
  ADD COLUMN code_challenge_method text NOT NULL DEFAULT 'S256';
```

### 4.3 `deactivated_at` column on `oauth_clients` (alter)

Allows disabling dynamic clients without losing the audit trail.

```sql
ALTER TABLE public.oauth_clients
  ADD COLUMN deactivated_at timestamptz;
```

### 4.4 Register claude.ai as a first-party client

```sql
-- Confirm the exact redirect_uri by observing the ?redirect_uri= param
-- in the browser when claude.ai first hits /authorize. Update before deploying.
INSERT INTO public.oauth_clients
  (client_id, client_name, client_byline, redirect_uris, scopes_allowed, is_first_party)
VALUES (
  'claude-ai-web',
  'Claude',
  'by Anthropic',
  ARRAY['https://claude.ai/api/mcp/oauth/callback'],  -- verify this URI
  ARRAY['read:email','search:email','send:email','manage:drafts','manage:folders'],
  true
)
ON CONFLICT (client_id) DO NOTHING;
```

**Action required before deploying:** Confirm claude.ai's exact callback URI by
observing the `redirect_uri` parameter when `/authorize` first loads during a live
connection attempt.

---

## 5. Changes to Existing Code

### 5.1 `/api/mcp` proxy route

**Add `WWW-Authenticate` header on 401.** Currently the proxy forwards the 401
from the Edge Function without adding the required `resource_metadata` hint.

> **Token passthrough (security-best-practices.md §2):** The spec states "MCP servers
> MUST NOT accept any tokens that were not explicitly issued for the MCP server."
> The proxy passes `mcpe_` tokens to the Edge Function, which validates them against
> the `api_keys` table. Because the token was issued by MCP Emails specifically for
> use with the MCP Emails Edge Function, this is not token passthrough in the
> prohibited sense — it is the same system forwarding its own tokens internally.
> The distinction matters: token passthrough refers to forwarding a user's third-party
> credential (e.g., a Google OAuth token) to a different downstream service. Forwarding
> our own issued API key to our own Edge Function is internal routing, not passthrough.
> This is documented here to prevent future misreading of this design decision.

### 5.2 Login → Authorize redirect

After magic-link sign-in, `/auth/callback/route.ts` redirects to the `next` param.
Verify that the existing `redirect.startsWith('/')` guard accepts `/authorize?...`
paths with all OAuth query parameters intact.

### 5.3 Dashboard API keys list

OAuth-issued access keys appear labelled "OAuth: Claude". Consider a visual badge
distinguishing OAuth-issued keys (renewable automatically) from manual keys (permanent
until revoked). This is a UX improvement, not a functional requirement.

---

## 6. State Parameter Validation

> **Spec requirement (security-best-practices.md §1):**
> "Generate a cryptographically secure random `state` value for each authorization
> request. Store the `state` value server-side ONLY after consent has been explicitly
> approved. Validate at the callback endpoint. Ensure `state` values are single-use
> and have a short expiration time (e.g., 10 minutes)."

The initial plan delegated state validation entirely to the client. This is incorrect
for the MCP Emails authorization server role. MCP Emails must store the state nonce
(keyed to the user session) and validate it when the Server Action runs.

**Implementation:** Store the `state` value in the user's Supabase session as a
signed short-lived claim when the `/authorize` page first renders. On Server Action
execution, retrieve and compare. Mark consumed to enforce single-use.

---

## 7. Audit Logging

All OAuth events must be recorded. `Documents/MCP/authentication.md` requires audit
logging of all activity. OAuth events are higher-risk than tool calls.

| Event | Log fields |
|---|---|
| Authorization grant (code issued) | user_id, client_id, scopes, inbox_ids, redirect_uri, IP, timestamp |
| Token issued (access + refresh) | user_id, client_id, key_prefix, scopes, IP, timestamp |
| Token refreshed | user_id, client_id, old key_prefix, new key_prefix, IP, timestamp |
| Token revoked (by client) | user_id, client_id, key_prefix, IP, timestamp |
| Dynamic client registered | client_id, redirect_uris, IP, user_agent, timestamp |
| Consent denied | user_id, client_id, IP, timestamp |
| Auth code rejected (invalid/expired) | client_id, reason, IP, timestamp |

Use the existing `activity_log` table or a dedicated `oauth_audit_log` table.
Append-only; no UPDATE or DELETE.

---

## 8. Security Requirements

| Requirement | Implementation |
|---|---|
| PKCE required, S256 only | Reject `plain` or missing at `/authorize`; re-enforce at token endpoint by reading stored `code_challenge_method` |
| State nonce server-side storage | Store in user session at `/authorize` render; validate and consume in Server Action |
| redirect_uri: exact match + HTTPS + no private IP | Validated at `/authorize`, token endpoint, and registration endpoint |
| CSRF on consent form | Short-lived signed CSRF token in hidden form field; single-use |
| CSP frame-ancestors on `/authorize` | `Content-Security-Policy: frame-ancestors 'none'` |
| Authorization code single-use | Hard-delete from `oauth_auth_codes` before issuing token |
| Code expiry | 10-minute TTL enforced via `expires_at` |
| Refresh token rotation | Old refresh token revoked before new pair is issued |
| CORS on token/revoke endpoints | Prefer registered client origin allowlist over `*` |
| CSRF on revoke endpoint | `Origin` header validation as defense-in-depth |
| Never redirect to unvalidated URI | `/authorize` renders an error page, never redirects, if redirect_uri is invalid |
| Dynamic client scope cap | Dynamically registered clients: `read:email`, `search:email`, `send:email` only |
| Dynamic client deactivation | `deactivated_at` column; checked on every authorization request |
| Audit logging | All OAuth events logged; append-only |
| WWW-Authenticate on 401 | `/api/mcp` emits `resource_metadata` hint for auto-discovery |
| Scope minimization in discovery | Only minimal scope set published; privilege escalation via WWW-Authenticate challenges |
| Token lifetime | Access token: 1 hour (`expires_in: 3600`). Refresh token: 6 months. |

---

## 9. Phased Development Plan

Each phase ends with a **gate** — a set of verifiable conditions that must pass
before work on the next phase begins. Phases are independently deployable: each
can be merged and deployed to production without breaking existing functionality.
All tasks within a phase are listed in dependency order.

---

### Pre-conditions

Before writing any code, confirm the following. Work cannot proceed safely without
these.

| # | Pre-condition | How to verify |
|---|---|---|
| P1 | `NEXT_PUBLIC_APP_URL` is set to `https://mcpemails.com` in Vercel production | `vercel env ls` or Vercel dashboard |
| P2 | `oauth_clients`, `oauth_consents`, `oauth_auth_codes` migrations are applied to the production DB | Supabase dashboard → Table Editor |
| P3 | claude.ai's exact OAuth callback redirect URI is known | Trigger a connection attempt from claude.ai; capture `redirect_uri` from the browser address bar when `/authorize` loads |
| P4 | The Supabase Auth session cookie issued by the app uses `HttpOnly`, `Secure`, and `SameSite=Lax` | Inspect the `sb-...` cookie in browser DevTools on `mcpemails.com` |

---

### Phase 1 — Discovery Layer

**Goal:** Make MCP Emails machine-discoverable by any OAuth 2.0 / MCP-compliant
client. No user-facing UI. No tokens issued. No breaking changes to existing
behaviour.

**Why first:** Every subsequent phase depends on clients being able to find the
authorization server. Phase 1 can be deployed and verified before a single line
of the consent UI exists.

#### Tasks

**1.1 — Protected Resource Metadata endpoint**

- **Create:** `apps/web/app/.well-known/oauth-protected-resource/route.ts`
- Returns RFC 8707 JSON linking the MCP endpoint to the authorization server.
- `scopes_supported` lists only the minimal initial set (`read:email`,
  `search:email`, `send:email`). Do not include `manage:*` here.
- Response must include `Cache-Control: max-age=3600`.
- No authentication required.

**1.2 — Authorization Server Metadata endpoint**

- **Create:** `apps/web/app/.well-known/oauth-authorization-server/route.ts`
- Returns RFC 8414 JSON (see §3.2 for full shape).
- Lists `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
  `revocation_endpoint`.
- `code_challenge_methods_supported: ['S256']` — plain must not appear.
- `grant_types_supported: ['authorization_code', 'refresh_token']`.
- Response must include `Cache-Control: max-age=3600`.
- No authentication required.

**1.3 — `WWW-Authenticate` header on `/api/mcp` 401 responses**

- **Modify:** `apps/web/app/api/mcp/route.ts`
- When the upstream Edge Function returns 401, add the header before forwarding:
  ```
  WWW-Authenticate: Bearer realm="MCP Emails",
    resource_metadata="https://mcpemails.com/.well-known/oauth-protected-resource"
  ```
- Also add the header on requests that arrive with no `Authorization` header at all
  (return 401 immediately at the proxy layer rather than forwarding the empty request).
- Existing authenticated requests are unaffected.

#### Phase 1 Gate

All of the following must pass before Phase 2 begins:

```bash
# 1. Unauthenticated hit returns 401 with WWW-Authenticate
curl -si https://mcpemails.com/api/mcp -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  | grep -i 'www-authenticate'
# Expected: WWW-Authenticate: Bearer realm="MCP Emails", resource_metadata=...

# 2. Protected Resource Metadata is valid JSON with required fields
curl -s https://mcpemails.com/.well-known/oauth-protected-resource \
  | jq '{resource,authorization_servers,scopes_supported}'

# 3. Authorization Server Metadata is valid JSON
curl -s https://mcpemails.com/.well-known/oauth-authorization-server \
  | jq '{issuer,authorization_endpoint,token_endpoint,code_challenge_methods_supported}'

# 4. Existing authenticated MCP requests still work (no regression)
curl -s https://mcpemails.com/api/mcp \
  -H 'Authorization: Bearer mcpe_<valid_key>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq '.result'
```

---

### Phase 2 — Database Migrations

**Goal:** All schema changes land before any application code references them.
Running application code against stale schema causes runtime errors; running
new schema against old application code is safe (new columns are ignored).

**Why second:** Token endpoint and authorize page both need the new tables and
columns. Migrations are their own atomic deployment step.

#### Tasks

**2.1 — `code_challenge_method` column on `oauth_auth_codes`**

- **Create migration:** `supabase/migrations/YYYYMMDDXXXXXX_oauth_auth_codes_challenge_method.sql`
  ```sql
  ALTER TABLE public.oauth_auth_codes
    ADD COLUMN IF NOT EXISTS code_challenge_method text NOT NULL DEFAULT 'S256';
  ```
- Default of `'S256'` ensures existing rows (if any) are valid.
- Apply to production: `supabase db push` or via Supabase MCP tool.

**2.2 — `oauth_refresh_tokens` table**

- **Create migration:** `supabase/migrations/YYYYMMDDXXXXXX_oauth_refresh_tokens.sql`
- Full schema defined in §4.1 of this document.
- RLS: deny all user access; service-role only.
- Apply to production after 2.1.

**2.3 — `deactivated_at` column on `oauth_clients`**

- **Create migration:** `supabase/migrations/YYYYMMDDXXXXXX_oauth_clients_deactivated.sql`
  ```sql
  ALTER TABLE public.oauth_clients
    ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
  ```
- Existing rows remain active (NULL = active).

**2.4 — Register claude.ai as a first-party client**

- **Depends on:** Pre-condition P3 (redirect URI confirmed).
- **Create migration:** `supabase/migrations/YYYYMMDDXXXXXX_register_claude_ai_client.sql`
- Insert row per §4.4, using the confirmed redirect URI.
- Use `ON CONFLICT (client_id) DO NOTHING` so the migration is idempotent.

#### Phase 2 Gate

```bash
# Verify all new tables/columns exist
supabase db diff --schema public
# Expected: no pending changes (all migrations applied)

# Verify claude-ai-web is registered
# (via Supabase MCP execute_sql or dashboard)
SELECT client_id, redirect_uris, is_first_party
  FROM oauth_clients WHERE client_id = 'claude-ai-web';
```

---

### Phase 3 — Token Endpoint

**Goal:** Build `POST /api/oauth/token` supporting both `authorization_code` and
`refresh_token` grants. This is the most security-critical endpoint in the entire
flow and should be built and reviewed before the authorize UI, so the contract it
enforces is locked before the UI is written around it.

**Why third:** The authorize page produces auth codes consumed by this endpoint.
Building the endpoint first means it can be tested independently with synthetic
codes before the UI exists.

#### Tasks

**3.1 — Shared crypto utilities**

- **Create:** `apps/web/lib/oauth/crypto.ts`
- Exports: `sha256hex(input: string): Promise<string>`,
  `sha256raw(input: string): Promise<Uint8Array>`,
  `base64urlEncode(buf: Uint8Array): string`,
  `generateApiKey(): { fullKey: string; prefix: string }`,
  `generateRefreshToken(): string` (returns `mcpr_<base64url(32 bytes)>`).
- These are used by the token endpoint, the authorize Server Action, and the
  registration endpoint. Centralising them prevents subtle inconsistencies
  (e.g., different base64url padding behaviour across callers).

**3.2 — Token endpoint**

- **Create:** `apps/web/app/api/oauth/token/route.ts`
- Implements `authorization_code` and `refresh_token` grants per §3.4.
- Handles `OPTIONS` for CORS preflight.
- `CORS`: set `Access-Control-Allow-Origin` to the requesting client's registered
  `client_uri` if available; fall back to `*`. Tighten post-Phase 4.
- Uses service-role Supabase client throughout (auth codes have deny-all RLS).
- On `authorization_code`: deletes auth code before inserting key (prevents
  partial success leaving a live code if key insert fails — wrap in a DB transaction
  or use a Supabase RPC function).
- On `refresh_token`: marks old refresh token `revoked_at` before inserting new pair.
- Logs all issuance and refresh events to audit log.
- Returns `Retry-After: 60` on rate limit (max 10 token requests/min per IP).

**3.3 — `oauthError` helper**

- **Create:** `apps/web/lib/oauth/errors.ts`
- Returns `Response.json({ error, error_description }, { status })` in RFC 6749
  error format, with consistent CORS headers.
- Used by token, revoke, and register endpoints.

#### Phase 3 Gate

Test with `curl` using a synthetically inserted auth code (bypasses the UI):

```sql
-- Insert a test auth code directly (run in Supabase SQL editor)
INSERT INTO oauth_auth_codes (
  code_hash, client_id, workspace_id, user_id, client_name,
  redirect_uri, code_challenge, code_challenge_method, scopes
) VALUES (
  sha256('test_code_plain'),  -- hash of the plaintext we'll send
  'claude-desktop',
  '<your_workspace_id>',
  '<your_user_id>',
  'Claude Desktop',
  'claude://oauth/callback',
  '<SHA-256-base64url of 'test_verifier'>',
  'S256',
  ARRAY['read:email']
);
```

```bash
# Exchange the code
curl -s -X POST https://mcpemails.com/api/oauth/token \
  -d 'grant_type=authorization_code' \
  -d 'code=test_code_plain' \
  -d 'code_verifier=test_verifier' \
  -d 'client_id=claude-desktop' \
  -d 'redirect_uri=claude://oauth/callback' \
  | jq '{access_token: .access_token[0:15], expires_in, refresh_token: .refresh_token[0:15]}'
# Expected: access_token starts with mcpe_, expires_in: 3600, refresh_token starts with mcpr_

# Replay the same code — must fail
curl -s -X POST https://mcpemails.com/api/oauth/token \
  -d 'grant_type=authorization_code' \
  -d 'code=test_code_plain' \
  -d 'code_verifier=test_verifier' \
  -d 'client_id=claude-desktop' \
  -d 'redirect_uri=claude://oauth/callback' \
  | jq .error
# Expected: "invalid_grant"

# Use the access token against the MCP server
curl -s https://mcpemails.com/api/mcp \
  -H "Authorization: Bearer <access_token_from_above>" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | jq .result
```

---

### Phase 4 — Authorization Page

**Goal:** Build the `/authorize` page and Server Action that a real user flows
through. This is the only phase that requires browser testing; all other phases
are testable with `curl`.

**Why fourth:** The token endpoint (Phase 3) is already solid before the UI is
built around it. The UI's job is solely to produce a valid auth code; the token
endpoint's job is to consume it.

#### Tasks

**4.1 — CSRF token utility**

- **Create:** `apps/web/lib/oauth/csrf.ts`
- `issueCsrfToken(sessionId: string): Promise<string>` — signs a short-lived
  (10 min) single-use token with HMAC-SHA-256 using `ENCRYPTION_KEY`.
- `validateCsrfToken(token: string, sessionId: string): Promise<boolean>` —
  verifies signature, expiry, and that the token has not been used before.
  Mark used tokens in a short-lived store (e.g., an `oauth_csrf_tokens` table
  with a 10-min TTL, or the user's Supabase session).

**4.2 — State nonce utility**

- **Create:** `apps/web/lib/oauth/state.ts`
- `storeStateNonce(sessionId: string, state: string, ttlSeconds: number): Promise<void>`
- `consumeStateNonce(sessionId: string, state: string): Promise<boolean>` — returns
  true once only; subsequent calls with the same state return false.
- Implementation: a lightweight `oauth_state_nonces` table with `(session_id, state_hash,
  expires_at, consumed_at)`, or equivalent signed-cookie approach.

**4.3 — Redirect URI validator**

- **Create:** `apps/web/lib/oauth/redirect-uri.ts`
- `isValidRedirectUri(uri: string): Promise<boolean>` per the SSRF rules in §3.5.
- DNS resolution for private IP blocking: use `dns.promises.lookup()` (Node.js)
  or an equivalent in the Next.js server environment. Cache results for 60 seconds
  to avoid repeated DNS calls.
- Shared by the authorize page, token endpoint, and registration endpoint.

**4.4 — Authorize page**

- **Rewrite:** `apps/web/app/authorize/page.js` (currently a placeholder)
- Server Component; reads params and Supabase session server-side.
- Adds `Content-Security-Policy: frame-ancestors 'none'` to the response headers.
- Issues a CSRF token (4.1) and a state nonce (4.2) at render time.
- Renders consent UI with hidden CSRF field and all OAuth params as hidden fields.
- Inbox picker: multi-select list of the user's active inboxes. Empty selection
  means "all inboxes" (null `inbox_ids`).
- "Deny" button submits to a separate Server Action that redirects with
  `error=access_denied`.

**4.5 — Approve Server Action**

- **Create:** `apps/web/app/authorize/actions.ts`
- `'use server'`
- Validates CSRF token (consume on first use).
- Re-validates all OAuth parameters (treat form data as untrusted).
- Validates and consumes state nonce.
- Generates auth code, inserts into `oauth_auth_codes` (with `code_challenge_method`).
- Upserts `oauth_consents`.
- Writes audit log row.
- Calls `redirect(destination.toString())` (Next.js redirect from Server Action).

**4.6 — Login → Authorize redirect continuity**

- **Verify and modify if needed:** `apps/web/app/auth/callback/route.ts`
- The `next` param passed through magic-link sign-in must survive URL-encoding
  of the entire `/authorize?client_id=...&redirect_uri=...&...` path.
- Test by triggering the authorize flow as an unauthenticated user and confirming
  the user lands back on `/authorize` with all original params intact after signing in.

#### Phase 4 Gate

Manual browser walkthrough (cannot be fully automated with `curl`):

```
1. Open https://mcpemails.com/authorize?
     client_id=claude-desktop
     &redirect_uri=claude://oauth/callback
     &response_type=code
     &scope=read:email
     &state=test_state_abc
     &code_challenge=<SHA-256 of 'test_verifier_x'>
     &code_challenge_method=S256
   as an unauthenticated user.
   → Expected: redirected to /login, then back to /authorize after sign-in.

2. As an authenticated user, load the same URL.
   → Expected: consent UI renders with client name "Claude Desktop",
     scope list, inbox picker, Approve + Deny buttons.
   → Expected: page cannot be iframed (check in DevTools → Console:
     load the page in an iframe and confirm it is blocked by CSP).

3. Click Approve.
   → Expected: browser navigates to
     claude://oauth/callback?code=<32-byte-b64url>&state=test_state_abc

4. Click Deny (fresh flow).
   → Expected: browser navigates to
     claude://oauth/callback?error=access_denied&state=test_state_abc

5. Replay the approved code through the token endpoint (Phase 3 curl test).
   → Expected: valid mcpe_ access token returned, expires_in: 3600.

6. Re-visit /authorize with the same client after consent — confirm consent
   screen is skipped and code is issued immediately (auto-approve).

7. Submit the consent form with a forged or replayed CSRF token.
   → Expected: 400 / error page; no auth code issued.

8. Submit the consent form with a replayed state nonce.
   → Expected: 400 / error page; no auth code issued.
```

---

### Phase 5 — Standards Compliance

**Goal:** Complete the OAuth 2.0 surface area required by RFC. Neither endpoint
is needed for the claude.ai end-to-end flow (claude.ai uses the pre-registered
`claude-ai-web` client_id and does not call revoke on disconnect). Both are
required for third-party integrators.

#### Tasks

**5.1 — Registration endpoint**

- **Create:** `apps/web/app/api/oauth/register/route.ts`
- Implements RFC 7591 per §3.5.
- Calls `isValidRedirectUri` (4.3) for every URI in the request.
- Rate limit: 10 registrations per IP per hour. Return `429` with
  `Retry-After: 3600` if exceeded.
- Writes audit log row on every successful registration.
- Checks `deactivated_at IS NULL` on lookups — deactivated dynamic clients cannot
  re-register with the same `client_id` (they get a new one if they re-register).

**5.2 — Revocation endpoint**

- **Create:** `apps/web/app/api/oauth/revoke/route.ts`
- Implements RFC 7009 per §3.6.
- Validates `Origin` header against an allowlist of known client origins.
- Handles both `access_token` and `refresh_token` hints.
- Always returns `200` per RFC 7009 §2.2.
- Writes audit log row.

#### Phase 5 Gate

```bash
# Register a dynamic client
curl -s -X POST https://mcpemails.com/api/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"Test Client","redirect_uris":["https://example.com/cb"]}' \
  | jq '{client_id,scope}'
# Expected: client_id starts with "dyn_", scope is minimal set

# Attempt to register with private-IP redirect URI
curl -s -X POST https://mcpemails.com/api/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"Evil","redirect_uris":["http://169.254.169.254/evil"]}' \
  | jq .error
# Expected: "invalid_redirect_uri"

# Revoke an access token
curl -s -X POST https://mcpemails.com/api/oauth/revoke \
  -d 'token=mcpe_<previously_issued_token>' \
  -w '%{http_code}'
# Expected: 200

# Confirm revoked token no longer works
curl -s https://mcpemails.com/api/mcp \
  -H 'Authorization: Bearer mcpe_<revoked_token>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | jq .error
# Expected: unauthorized / invalid_token
```

---

### Phase 6 — End-to-End Validation with claude.ai

**Goal:** The full flow works from inside claude.ai web. This phase is not about
writing code — it is about confirming integration and resolving any remaining
friction.

#### Tasks

**6.1 — Confirm claude.ai redirect URI and update migration if needed**

If the redirect URI captured during Pre-condition P3 differs from what was
inserted in migration 2.4, write a corrective migration now.

**6.2 — End-to-end connection test**

1. Navigate to claude.ai → Settings → Connectors → Add custom connector.
2. Enter `https://mcpemails.com/api/mcp`.
3. Follow the OAuth flow through the MCP Emails consent page.
4. Confirm the connector appears as connected.
5. Start a conversation and invoke an email tool (e.g., "list my inbox").
6. Confirm the activity appears in the MCP Emails dashboard.

**6.3 — Verify token refresh works**

Wait for (or manually expire) the 1-hour access token. Confirm claude.ai
transparently refreshes it using the refresh token without requiring re-authorization.

**6.4 — Verify disconnect and revocation**

Disconnect the connector in claude.ai. Confirm the access token is revoked
(via the revoke endpoint or dashboard). Confirm subsequent MCP calls return 401.

#### Phase 6 Gate

The integration is complete when:

- [ ] claude.ai connects without errors
- [ ] At least one email tool call succeeds via the connector
- [ ] Activity log shows the call with the OAuth-issued key prefix
- [ ] Token refresh happens silently after 1 hour
- [ ] Disconnecting the connector revokes the token; further calls return 401

---

### Phase 7 — Dashboard UX

**Goal:** Surface OAuth in the user-facing dashboard so users understand what
has been authorized and can manage it.

These tasks are purely UX improvements and have no impact on the OAuth protocol
or MCP server behaviour. They can be done in any order within the phase.

#### Tasks

**7.1 — Badge on OAuth-issued API keys**

- **Modify:** `apps/web/components/dashboard/Pages.jsx` — `KeysPage`
- Keys with names starting `"OAuth: "` get a small badge (e.g., "OAuth") next to
  the key name. Distinguish them from manually created keys.
- Show `expires_at` inline (e.g., "expires in 47 min") for OAuth keys since they
  have a 1-hour TTL.

**7.2 — "Connected apps" section in Settings**

- **Create:** new section in `SettingsPage` component.
- Lists each unique `client_id` that has an active (non-revoked) OAuth key for
  this workspace.
- Shows: client name, scopes granted, date first authorized, "Revoke access" button.
- "Revoke access" calls `DELETE /api/oauth/connections/<client_id>` (new route)
  which soft-deletes all `api_keys` and `oauth_refresh_tokens` for that client.

**7.3 — New route: `DELETE /api/oauth/connections/[clientId]`**

- **Create:** `apps/web/app/api/oauth/connections/[clientId]/route.ts`
- Requires authenticated Supabase session.
- Revokes all active keys and refresh tokens for the given `client_id` within
  the user's workspace.
- Deletes the `oauth_consents` row so the user will see the consent screen again
  if they re-connect.
- Returns `204`.

#### Phase 7 Gate

- [ ] OAuth-issued keys are visually distinct in the API Keys dashboard view
- [ ] Keys show a countdown to expiry
- [ ] Settings page lists all connected apps
- [ ] Revoking an app via Settings immediately invalidates MCP access
- [ ] Re-connecting the same app shows the consent screen again

---

### Summary Timeline

| Phase | What it delivers | Can deploy independently? |
|---|---|---|
| Pre-conditions | Prerequisites confirmed | N/A |
| 1 — Discovery | Machine-discoverable OAuth server | ✅ Yes — no breaking changes |
| 2 — Migrations | Schema ready for Phases 3–5 | ✅ Yes — additive only |
| 3 — Token endpoint | Token exchange; testable with curl | ✅ Yes — new route |
| 4 — Authorize page | Full browser-driven consent flow | ✅ Yes — replaces placeholder |
| 5 — RFC compliance | Dynamic registration + revocation | ✅ Yes — new routes |
| 6 — E2E validation | claude.ai connected and working | N/A — validation only |
| 7 — Dashboard UX | Users can manage connected apps | ✅ Yes — UI only |

---

## 10. Testing Checklist

- [ ] `GET /api/mcp` (no auth) returns 401 with `WWW-Authenticate: Bearer resource_metadata=...`
- [ ] `/.well-known/oauth-protected-resource` returns valid JSON with `authorization_servers`
- [ ] `/.well-known/oauth-authorization-server` returns valid RFC 8414 JSON; no `manage:*` scopes listed
- [ ] `/authorize` with unknown `client_id` renders error page (no redirect)
- [ ] `/authorize` with mismatched `redirect_uri` renders error page (no redirect)
- [ ] `/authorize` with `http://` redirect_uri (non-loopback) renders error page
- [ ] `/authorize` with private-IP redirect_uri renders error page
- [ ] `/authorize` with `code_challenge_method=plain` is rejected
- [ ] `/authorize` with unauthenticated user redirects to `/login?redirect=/authorize?...`
- [ ] Consent form CSRF token is validated; forged requests rejected
- [ ] `/authorize` page has `Content-Security-Policy: frame-ancestors 'none'`
- [ ] State nonce is stored server-side and validated on Server Action execution
- [ ] State nonce is single-use (replay rejected)
- [ ] Approve → auth code in DB, redirect to `redirect_uri?code=...&state=...`
- [ ] Deny → redirect to `redirect_uri?error=access_denied`
- [ ] Token endpoint: valid code + S256 verifier → `access_token` + `refresh_token` + `expires_in: 3600`
- [ ] Token endpoint: replayed code rejected (single-use)
- [ ] Token endpoint: expired code rejected (>10 min)
- [ ] Token endpoint: wrong `code_verifier` rejected
- [ ] Token endpoint: `code_challenge_method` ≠ `S256` on stored row rejected
- [ ] Refresh grant: valid refresh token → new access + refresh pair; old refresh revoked
- [ ] Refresh grant: revoked refresh token rejected
- [ ] Refresh grant: expired (>6 month) refresh token rejected
- [ ] Issued `mcpe_` access token (1 hr) authenticates against `/api/mcp`
- [ ] Expired access token returns 401 from `/api/mcp`
- [ ] Token appears in dashboard as "OAuth: Claude" with expiry shown
- [ ] Revoke endpoint: access token soft-deleted; next MCP request returns 401
- [ ] Revoke endpoint: refresh token revoked; next refresh attempt returns `invalid_grant`
- [ ] All OAuth events appear in audit log
- [ ] Full end-to-end: add connector in claude.ai → consent → MCP tool call succeeds
