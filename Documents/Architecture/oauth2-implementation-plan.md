# OAuth 2.0 Implementation Plan

## Purpose

This document describes what must be built to support OAuth 2.0 for the MCP Emails
server. It is implementation-focused: it references the high-level design already
captured in `mcp-authentication-flow.md §7` and translates it into concrete routes,
pages, database changes, and a sequenced build plan.

The immediate driver is claude.ai web's "Add custom connector" feature, which
performs OAuth 2.0 discovery and Authorization Code + PKCE flow before it will
connect to a remote MCP server. Bearer-token-only servers are incompatible with
this flow.

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
sequence and the token endpoint behaviour: the OAuth flow mints a real `mcpe_`
API key (same format as dashboard-created keys) and returns it as the
`access_token`. This means:

- The MCP Edge Function needs **zero changes** — it already validates `mcpe_`
  bearer tokens on every request.
- Issued OAuth tokens appear in the user's dashboard API Keys list (labelled
  "OAuth: Claude") so they can be revoked.
- There is no separate access-token table to query on each MCP request.

### The `/authorize` page

`apps/web/app/authorize/page.js` exists and renders a placeholder. The real
authorize UI and server action are not yet implemented.

### What does not exist

| Component | Status |
|---|---|
| `/.well-known/oauth-authorization-server` | ❌ Missing |
| `GET /authorize` — full UI + Server Action | ❌ Placeholder only |
| `POST /api/oauth/token` | ❌ Missing |
| `POST /api/oauth/register` (Dynamic Client Registration) | ❌ Missing |
| `POST /api/oauth/revoke` | ❌ Missing |
| claude.ai registered in `oauth_clients` | ❌ Missing |

---

## 2. How claude.ai Web Connects

When a user enters `https://mcpemails.com/api/mcp` as a custom connector URL,
claude.ai does the following automatically:

```
1. GET https://mcpemails.com/.well-known/oauth-authorization-server
   → discovers authorization_endpoint, token_endpoint, scopes_supported

2. (Optional) POST https://mcpemails.com/api/oauth/register
   → dynamically registers itself and gets a client_id
   → only needed if claude.ai does not have a pre-registered client_id

3. Redirect user to authorization_endpoint with:
   ?client_id=...
   &redirect_uri=https://claude.ai/api/oauth/callback  (approximate)
   &response_type=code
   &scope=read:email search:email send:email
   &state=<random>
   &code_challenge=<SHA-256 of verifier>
   &code_challenge_method=S256

4. User logs in to MCP Emails (if not already) and approves scopes

5. Server redirects to claude.ai callback with ?code=...&state=...

6. claude.ai POSTs to token_endpoint with code + code_verifier

7. Server returns { access_token: "mcpe_...", token_type: "bearer", expires_in: ... }

8. claude.ai sends Authorization: Bearer mcpe_... on all MCP requests
```

---

## 3. Endpoints to Build

### 3.1 `GET /.well-known/oauth-authorization-server` (RFC 8414)

**File:** `apps/web/app/.well-known/oauth-authorization-server/route.ts`

Returns static JSON describing the server. This is the discovery document
claude.ai reads before starting the flow.

```typescript
export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL; // https://mcpemails.com

  return Response.json({
    issuer: base,
    authorization_endpoint:          `${base}/authorize`,
    token_endpoint:                   `${base}/api/oauth/token`,
    registration_endpoint:            `${base}/api/oauth/register`,
    scopes_supported: [
      'read:email',
      'search:email',
      'send:email',
      'manage:drafts',
      'manage:folders',
    ],
    response_types_supported:         ['code'],
    grant_types_supported:            ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients only
    revocation_endpoint:              `${base}/api/oauth/revoke`,
  });
}
```

**Security:** No auth required. Cache with `Cache-Control: max-age=3600`.

---

### 3.2 `GET /authorize` — Authorization Page

**File:** `apps/web/app/authorize/page.js` (currently a placeholder)

This is a Next.js **Server Component** (not an API route) because it must:
- Read the user's Supabase session server-side
- Render a real HTML consent UI
- Never expose the redirect_uri in client-side JS before validation

**Validation (server-side, before rendering):**

```
1. Read client_id, redirect_uri, scope, state, code_challenge,
   code_challenge_method from query string.

2. Look up client_id in oauth_clients table.
   If not found → render an error page (do NOT redirect — redirect_uri is unvalidated).

3. Validate redirect_uri by exact string equality against oauth_clients.redirect_uris[].
   If mismatch → render an error page (do NOT redirect).

4. Validate code_challenge_method === 'S256'. Reject 'plain'.

5. Validate each requested scope is in oauth_clients.scopes_allowed[].
   Unknown scopes → render error or strip (TBD — reject is safer).

6. Check user session (createClient().auth.getUser()).
   If not authenticated → redirect to /login?redirect=/authorize?<all params>
   The /login page must forward the user back here after magic-link sign-in.

7. Check oauth_consents for (user_id, client_id).
   If the stored consent covers all requested scopes → skip consent UI,
   generate code, redirect to redirect_uri immediately (auto-approve).

8. Otherwise → render consent UI.
```

**Consent UI must display:**
- Client name and byline (from `oauth_clients`)
- Client logo (if present)
- Each requested scope with a human-readable description
- The list of inboxes the user can optionally restrict access to
- "Approve" and "Deny" buttons

**On Approve (Server Action):**

```typescript
'use server';

async function approveOAuth(formData: FormData) {
  const clientId      = formData.get('client_id') as string;
  const redirectUri   = formData.get('redirect_uri') as string;
  const scope         = formData.get('scope') as string;
  const state         = formData.get('state') as string;
  const codeChallenge = formData.get('code_challenge') as string;
  const inboxIds      = formData.getAll('inbox_ids') as string[]; // [] = all

  // Re-validate everything (Server Action inputs are user-controlled).
  // ... same validation as above ...

  // Generate a 32-byte random authorization code.
  const rawCode = crypto.getRandomValues(new Uint8Array(32));
  const codeB64 = base64url(rawCode);
  const codeHash = await sha256hex(codeB64);

  // Insert the auth code (stored hashed, plaintext discarded).
  await supabase.from('oauth_auth_codes').insert({
    code_hash:      codeHash,
    client_id:      clientId,
    workspace_id:   workspaceId,
    user_id:        userId,
    client_name:    client.client_name,
    redirect_uri:   redirectUri,
    code_challenge: codeChallenge,
    scopes:         scope.split(' '),
    inbox_ids:      inboxIds.length > 0 ? inboxIds : null,
  });

  // Upsert consent record so future visits skip the consent screen.
  await supabase.from('oauth_consents').upsert({
    user_id:   userId,
    client_id: clientId,
    scopes:    scope.split(' '),
    inbox_ids: inboxIds.length > 0 ? inboxIds : null,
  }, { onConflict: 'user_id, client_id' });

  // Redirect to the client with the plaintext code + original state.
  const destination = new URL(redirectUri);
  destination.searchParams.set('code', codeB64);
  destination.searchParams.set('state', state);
  redirect(destination.toString());
}
```

**On Deny:** Redirect to `redirect_uri?error=access_denied&state=<state>`.

---

### 3.3 `POST /api/oauth/token`

**File:** `apps/web/app/api/oauth/token/route.ts`

Exchanges an authorization code for an API key. This is a server-to-server call
from the MCP client (claude.ai), not from the user's browser.

```
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code
&code=<plaintext code>
&code_verifier=<PKCE verifier>
&client_id=<registered client_id>
&redirect_uri=<must match what was sent to /authorize>
```

**Implementation (per `mcp-authentication-flow.md §7`):**

```typescript
export async function POST(req: Request) {
  // Parse form body
  const body         = await req.formData();
  const grantType    = body.get('grant_type');
  const code         = body.get('code') as string;
  const codeVerifier = body.get('code_verifier') as string;
  const clientId     = body.get('client_id') as string;
  const redirectUri  = body.get('redirect_uri') as string;

  if (grantType !== 'authorization_code') {
    return oauthError('unsupported_grant_type', 400);
  }

  // Use service-role client (bypasses RLS; auth codes have deny-all RLS policy)
  const supabase = createServiceRoleClient();

  // 1. Look up auth code by hash (10-minute TTL enforced in query)
  const codeHash = await sha256hex(code);
  const { data: authCode } = await supabase
    .from('oauth_auth_codes')
    .select('*')
    .eq('code_hash', codeHash)
    .eq('client_id', clientId)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (!authCode) return oauthError('invalid_grant', 400);

  // 2. Validate redirect_uri exact match (replay / injection protection)
  if (authCode.redirect_uri !== redirectUri) return oauthError('invalid_grant', 400);

  // 3. PKCE: verify SHA-256(code_verifier) === stored code_challenge
  const computedChallenge = base64urlEncode(await sha256raw(codeVerifier));
  if (computedChallenge !== authCode.code_challenge) return oauthError('invalid_grant', 400);

  // 4. Single-use: delete the code before issuing the token
  await supabase.from('oauth_auth_codes').delete().eq('id', authCode.id);

  // 5. Generate API key (same format as dashboard-created keys)
  const { fullKey, prefix } = generateApiKey(); // mcpe_<base58>
  const keyHash = await hashApiKey(fullKey);

  await supabase.from('api_keys').insert({
    workspace_id: authCode.workspace_id,
    created_by:   authCode.user_id,
    name:         `OAuth: ${authCode.client_name}`,
    key_prefix:   prefix,
    key_hash:     keyHash,
    scopes:       authCode.scopes,
    inbox_ids:    authCode.inbox_ids ?? null,
    // No expiry — key is long-lived; user revokes via dashboard if needed.
  });

  // 6. Return standard OAuth 2.0 token response
  return Response.json({
    access_token: fullKey,
    token_type:   'bearer',
    scope:        authCode.scopes.join(' '),
    // No refresh_token — the access_token is long-lived.
    // No expires_in — long-lived; omitting is valid per RFC 6749 §5.1.
  });
}
```

**CORS:** Must include `Access-Control-Allow-Origin: *` and respond to `OPTIONS`
so claude.ai's server-side fetch (which may originate cross-origin) succeeds.

---

### 3.4 `POST /api/oauth/register` (Dynamic Client Registration — RFC 7591)

**File:** `apps/web/app/api/oauth/register/route.ts`

Required if claude.ai does not use a pre-registered client_id. This endpoint
allows any compliant MCP client to register itself automatically.

```typescript
export async function POST(req: Request) {
  const body = await req.json();

  const clientId   = `dyn_${randomHex(16)}`; // generated, not caller-chosen
  const clientName = String(body.client_name ?? 'Unknown Client').slice(0, 80);
  const redirectUris: string[] = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: unknown) => typeof u === 'string')
    : [];

  if (redirectUris.length === 0) {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }

  // All dynamically registered clients get a restricted scope set.
  // They cannot self-grant admin or manage:folders without a first-party
  // registration approved by the operator.
  const scopesAllowed = ['read:email', 'search:email', 'send:email'];

  await createServiceRoleClient().from('oauth_clients').insert({
    client_id:     clientId,
    client_name:   clientName,
    client_byline: body.client_uri ?? '',
    redirect_uris: redirectUris,
    scopes_allowed: scopesAllowed,
    is_first_party: false,
  });

  return Response.json({
    client_id:          clientId,
    client_name:        clientName,
    redirect_uris:      redirectUris,
    grant_types:        ['authorization_code'],
    response_types:     ['code'],
    token_endpoint_auth_method: 'none',
    scope:              scopesAllowed.join(' '),
  }, { status: 201 });
}
```

**Rate limiting:** Apply IP-based rate limiting (e.g., 10 registrations/hour per IP)
to prevent the `oauth_clients` table being flooded.

---

### 3.5 `POST /api/oauth/revoke` (RFC 7009)

**File:** `apps/web/app/api/oauth/revoke/route.ts`

Allows clients to signal that a token has been discarded (e.g., on user logout
within the client app). Because our tokens are API keys stored in `api_keys`,
revocation means soft-deleting the matching row.

```typescript
export async function POST(req: Request) {
  const body  = await req.formData();
  const token = body.get('token') as string;

  if (!token) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const keyHash = await hashApiKey(token);
  // Soft-delete — same as user clicking "Revoke" in dashboard.
  // Intentionally returns 200 even if the token was not found (RFC 7009 §2.2).
  await createServiceRoleClient()
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('key_hash', keyHash)
    .is('deleted_at', null);

  return new Response(null, { status: 200 });
}
```

---

## 4. Database Changes Required

### 4.1 Register claude.ai as a first-party client

A migration must insert a row for claude.ai. The exact redirect URI must be
confirmed by testing — claude.ai uses its own OAuth callback URL.

```sql
-- New migration: 202605XXXXXX_register_claude_ai_oauth_client.sql

INSERT INTO public.oauth_clients
  (client_id, client_name, client_byline, redirect_uris, scopes_allowed, is_first_party)
VALUES
  (
    'claude-ai-web',
    'Claude',
    'by Anthropic',
    ARRAY[
      'https://claude.ai/api/mcp/oauth/callback'  -- verify exact URI from claude.ai docs
    ],
    ARRAY['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:folders'],
    true
  )
ON CONFLICT (client_id) DO NOTHING;
```

**Action required:** Confirm claude.ai's exact redirect URI before writing this
migration. One way to find it: start the OAuth flow from claude.ai, watch the
`redirect_uri` param in the browser's address bar when you land on `/authorize`.

### 4.2 No new tables needed

The existing `oauth_clients`, `oauth_consents`, and `oauth_auth_codes` tables
cover all requirements. The access token is an API key stored in the existing
`api_keys` table.

---

## 5. Changes to Existing Code

### 5.1 `/api/mcp` proxy route

**No changes needed.** The proxy forwards the `Authorization: Bearer mcpe_...`
header directly to the Supabase Edge Function, which validates it as a standard
API key. An OAuth-issued token is indistinguishable from a dashboard-created key
at the MCP layer — both are `mcpe_` API keys stored in `api_keys`.

### 5.2 Login → Authorize redirect

After the user completes magic-link sign-in, Supabase Auth redirects to
`/auth/callback`, which then redirects to the `next` param. The `/authorize`
page must append `next=/authorize?<all_original_params>` when bouncing
unauthenticated users to `/login`.

Ensure `/auth/callback/route.ts` already passes through arbitrary `/authorize?...`
paths in the `next` param (verify that the existing `redirect.startsWith('/')`
guard accepts `/authorize` paths).

### 5.3 Dashboard API keys list

OAuth-issued keys appear in the dashboard under the name "OAuth: Claude". No
code changes are needed, but consider adding a badge or icon that distinguishes
OAuth-issued keys from manually created keys so users can identify them. This is
a UX improvement, not a functional requirement.

---

## 6. Security Requirements

| Requirement | Implementation |
|---|---|
| PKCE required (S256 only) | Reject `code_challenge_method=plain` at `/authorize` |
| redirect_uri exact match | Validate against DB at `/authorize` AND `/api/oauth/token` |
| State parameter | Included by client; round-tripped in redirect; MCP Emails does not validate state (client responsibility) |
| Authorization code single-use | Hard-delete from `oauth_auth_codes` before issuing token |
| Code expiry | 10-minute TTL enforced via `expires_at` column |
| CORS on token endpoint | `Access-Control-Allow-Origin: *` required for server-to-server fetch |
| Never redirect to unvalidated URI | `/authorize` must render an error page (not redirect) if redirect_uri is invalid |
| Dynamic client scope cap | Dynamically registered clients limited to `read:email, search:email, send:email` |
| Rate limit registration | IP-based limit on `POST /api/oauth/register` |

---

## 7. Build Sequence

Build in this order. Each phase is independently deployable and testable.

### Phase 1 — Discovery (unblocks OAuth clients from knowing where to go)

1. `GET /.well-known/oauth-authorization-server`

Deploy → verify with `curl https://mcpemails.com/.well-known/oauth-authorization-server`.

### Phase 2 — Core flow (unblocks end-to-end testing)

2. `POST /api/oauth/token`
3. `GET /authorize` page + Server Action (approve + deny)
4. Migration: register `claude-ai-web` client with correct redirect URI

At this point, the full Authorization Code + PKCE flow can be tested manually
using a browser and curl.

### Phase 3 — Standards compliance (unblocks automated client registration)

5. `POST /api/oauth/register` (Dynamic Client Registration)
6. `POST /api/oauth/revoke`

### Phase 4 — Polish

7. UX badge on OAuth-issued API keys in dashboard
8. Consent screen inbox picker (let users restrict which inboxes the client can access)
9. "Revoke OAuth access" button per client in Settings page

---

## 8. Testing Checklist

- [ ] `/.well-known/oauth-authorization-server` returns valid RFC 8414 JSON
- [ ] `/authorize` with unknown `client_id` renders an error page (does not redirect)
- [ ] `/authorize` with mismatched `redirect_uri` renders an error page (does not redirect)
- [ ] `/authorize` with unauthenticated user redirects to `/login` then back
- [ ] Approve flow generates an auth code and redirects to `redirect_uri?code=...`
- [ ] Deny flow redirects to `redirect_uri?error=access_denied`
- [ ] `/api/oauth/token` with valid code + verifier returns `mcpe_` access token
- [ ] `/api/oauth/token` rejects a replayed code (single-use)
- [ ] `/api/oauth/token` rejects an expired code (>10 min old)
- [ ] `/api/oauth/token` rejects wrong `code_verifier`
- [ ] Issued `mcpe_` token authenticates successfully against `/api/mcp`
- [ ] Issued token appears in dashboard API Keys list as "OAuth: Claude"
- [ ] `/api/oauth/revoke` soft-deletes the key; subsequent MCP request returns 401
- [ ] Full end-to-end: add connector in claude.ai → consent → MCP call succeeds
