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

## 9. Build Sequence

### Phase 1 — Discovery (unblocks clients from finding the OAuth server)

1. `GET /.well-known/oauth-protected-resource`
2. `GET /.well-known/oauth-authorization-server`
3. Update `/api/mcp` to emit `WWW-Authenticate` on 401

Deploy → test with `curl -I https://mcpemails.com/api/mcp` (expect 401 with
`WWW-Authenticate` header containing `resource_metadata`). Then `curl
https://mcpemails.com/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`.

### Phase 2 — Core flow (end-to-end authorization)

4. Migrations: `oauth_refresh_tokens`, `code_challenge_method` column, `deactivated_at` column
5. `POST /api/oauth/token` (authorization_code + refresh_token grants)
6. `GET /authorize` page + Server Action (consent UI, state storage, CSRF)
7. Migration: register `claude-ai-web` with correct redirect URI

At this point the full Authorization Code + PKCE flow can be tested end-to-end.

### Phase 3 — Standards compliance

8. `POST /api/oauth/register` (Dynamic Client Registration)
9. `POST /api/oauth/revoke`

### Phase 4 — Polish

10. Badge on OAuth-issued API keys in dashboard
11. Consent screen inbox picker
12. "Revoke OAuth access" per client in Settings page
13. Tighten CORS on token endpoint to per-client allowlist

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
