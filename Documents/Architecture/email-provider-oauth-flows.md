# Email Provider OAuth Flows

## Purpose

This document is the authoritative architecture reference for how MCPEmails connects to Gmail, Outlook, and Fastmail email accounts. It covers the full OAuth lifecycle — from the moment a user clicks "Connect" through token storage, proactive refresh, error recovery, and eventual revocation — along with the Fastmail app-password alternative, encryption decisions, and required environment variables.

---

## 1. Why Each Provider Needs Its Own OAuth App

MCPEmails is not a generic IMAP relay. It acts as a **confidential OAuth 2.0 client** to each email provider independently. Each provider runs its own authorization server with its own:

- **Client registration** — MCPEmails registers once per provider in that provider's developer console and receives a `client_id` / `client_secret` pair. These credentials identify MCPEmails to the provider; they are not interchangeable.
- **Authorization endpoint** — Each provider's consent page is at a different URL with different parameter names, scope syntax, and tenant routing rules.
- **Token endpoint** — Token exchange and refresh calls go to provider-specific endpoints, using different authentication conventions (Basic auth vs. POST body vs. `client_assertion`).
- **Scope vocabulary** — Google uses full URI-style scopes; Microsoft uses short dot-notation scopes; Fastmail uses short strings. Sending the wrong scope format to a provider returns an invalid-scope error.
- **Token lifetimes** — Google access tokens last 1 hour; Microsoft access tokens last 1 hour; Fastmail access tokens last 1 year. Refresh cadence and expiry handling must be tuned per provider.
- **Revocation endpoint** — Each provider exposes a different revocation URL and expects a different request body.

Sharing one OAuth app across providers is not possible because providers do not federate their consent flows. A single registered app on Google cannot be used to request Microsoft tokens.

The practical consequence for MCPEmails is that the codebase contains three provider-specific modules under `lib/email-providers/` — one for Gmail, one for Outlook, and one for Fastmail — each implementing a common `EmailProvider` interface. The OAuth flow wiring in Next.js Route Handlers is also per-provider, because the callback routes (`/auth/gmail/callback`, `/auth/outlook/callback`, `/auth/fastmail/callback`) are registered as allowed redirect URIs in each respective developer console and cannot be unified without breaking all three provider configurations simultaneously.

---

## 2. Gmail OAuth

### Scopes

Gmail access requires Google OAuth 2.0 scopes from the Google API. MCPEmails requests the following three scopes:

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | List messages, fetch message bodies, search |
| `https://www.googleapis.com/auth/gmail.send` | Compose and send new messages |
| `https://www.googleapis.com/auth/gmail.modify` | Apply/remove labels, move messages to trash |

`gmail.modify` is a superset of `gmail.readonly`; both are listed explicitly in the authorization request because Google's consent screen renders each scope separately and users should see exactly what they are granting. `gmail.send` is a distinct, higher-risk scope that Google shows with a separate warning. If MCPEmails later drops send support, this scope should be removed from the authorization request and existing grants re-evaluated.

> **Deferred: signature auto-import.** A signature auto-import feature (Phase 2 of the Email Signatures plan) would read the account's existing Gmail signature via `GET users/me/settings/sendAs/{email}`, which needs the `gmail.settings.basic` **sensitive** scope plus a re-submission of the OAuth consent screen for verification. This is **not currently requested**: the scope was backed out of the request and the import call is commented out (`maybeImportGmailSignature`) until verification is approved. Manual per-inbox signatures still ship and work on all providers.

These scopes do not cover calendar or contacts; no cross-product scopes are requested. This is consistent with the scope minimization principle described in `Documents/MCP/security-best-practices.md` — tokens obtained by a compromised API key should have the minimum lateral reach possible.

`gmail.readonly`, `gmail.send`, and `gmail.modify` are classified as **restricted scopes** by Google. All require app verification before they can be used in production with more than 100 test users. The production Google Cloud project must complete Google's OAuth verification process before public launch.

### Authorization URL Construction

The authorization request is built server-side in the Route Handler at `app/auth/gmail/route.ts` (the initiation endpoint, not the callback). No authorization URL is constructed client-side.

```typescript
// app/auth/gmail/route.ts
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { randomBytes } from 'crypto';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // Resolve workspace
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  // Generate a 32-byte cryptographically random state nonce
  const state = randomBytes(32).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/gmail/callback`;

  // Persist the state nonce — expires in 10 minutes
  await supabase.from('oauth_states').insert({
    workspace_id: member.workspace_id,
    user_id: user.id,
    provider: 'gmail',
    state,
    redirect_uri: redirectUri,
  });

  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ].join(' '),
    access_type: 'offline',   // required to receive a refresh token
    prompt: 'consent',        // force consent screen to ensure refresh token is issued
    state,
  });

  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
```

`access_type=offline` instructs Google to issue a refresh token. Without it, Google issues only an access token and the user must re-authorize after 1 hour. `prompt=consent` forces the consent screen to appear even if the user has previously authorized the app; this is necessary to guarantee that Google issues a new refresh token (Google only issues a refresh token on the first consent, or when consent is forced).

### Callback Route: `/auth/gmail/callback`

```typescript
// app/auth/gmail/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { encryptToken } from '@/lib/crypto';
import { exchangeGmailCode } from '@/lib/email-providers/gmail';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // 1. Handle user denial
  if (error === 'access_denied') {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=cancelled`
    );
  }

  // 2. Validate required parameters
  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=invalid_callback`
    );
  }

  const supabase = await createClient();

  // 3. Look up and validate the state nonce (single-use, expiry-checked by DB)
  const { data: oauthState, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .eq('provider', 'gmail')
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateError || !oauthState) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=invalid_state`
    );
  }

  // 4. Delete the state nonce immediately (single-use)
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);

  // 5. Validate redirect_uri matches what was registered (exact string equality)
  const expectedRedirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/gmail/callback`;
  if (oauthState.redirect_uri !== expectedRedirectUri) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=redirect_uri_mismatch`
    );
  }

  // 6. Exchange the authorization code for tokens
  let tokens: { accessToken: string; refreshToken: string; expiresIn: number; email: string };
  try {
    tokens = await exchangeGmailCode(code, expectedRedirectUri);
  } catch {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=token_exchange_failed`
    );
  }

  // 7. Encrypt tokens before storage
  const encryptedAccessToken = encryptToken(tokens.accessToken);
  const encryptedRefreshToken = encryptToken(tokens.refreshToken);
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();

  // 8. Upsert the inbox record (handles reconnection without losing the existing row)
  const { error: upsertError } = await supabase
    .from('inboxes')
    .upsert(
      {
        workspace_id: oauthState.workspace_id,
        provider: 'gmail',
        email_address: tokens.email,
        oauth_access_token: encryptedAccessToken,
        oauth_refresh_token: encryptedRefreshToken,
        oauth_token_expires_at: tokenExpiresAt,
        oauth_scope: 'gmail.readonly gmail.send gmail.modify',
        status: 'active',
        last_error: null,
        deleted_at: null,     // un-soft-delete if previously deleted
      },
      {
        onConflict: 'workspace_id, email_address',
        ignoreDuplicates: false,
      }
    );

  if (upsertError) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?error=save_failed`
    );
  }

  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/inboxes?connected=gmail`
  );
}
```

### Token Exchange

The `exchangeGmailCode` function calls Google's token endpoint:

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

code=<authorization_code>
&client_id=<GMAIL_CLIENT_ID>
&client_secret=<GMAIL_CLIENT_SECRET>
&redirect_uri=<redirect_uri>
&grant_type=authorization_code
```

Google responds with:
```json
{
  "access_token": "...",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "...",
  "token_type": "Bearer",
  "id_token": "..."
}
```

The `id_token` is a JWT containing the user's Google profile including their email address. The function decodes the `id_token` (without verification — it is trusted because it arrives over a server-to-server HTTPS call immediately after the code exchange) to extract the email address for the `email_address` column.

### What Gets Stored in the `inboxes` Table

| Column | Value |
|---|---|
| `provider` | `'gmail'` |
| `email_address` | Email address from the decoded `id_token` |
| `oauth_access_token` | AES-256-GCM ciphertext of the access token (`bytea`) |
| `oauth_refresh_token` | AES-256-GCM ciphertext of the refresh token (`bytea`) |
| `oauth_token_expires_at` | `now() + 3600 seconds` |
| `oauth_scope` | `'gmail.readonly gmail.send gmail.modify'` |
| `status` | `'active'` |
| `imap_*` columns | `NULL` (not used for Gmail) |

---

## 3. Outlook (Microsoft) OAuth

### Scopes

Outlook access uses the Microsoft Identity Platform (v2.0 endpoint). MCPEmails requests:

| Scope | Why |
|---|---|
| `Mail.Read` | List and read message bodies via Microsoft Graph |
| `Mail.Send` | Send messages via Microsoft Graph |
| `offline_access` | Causes Microsoft to issue a refresh token |
| `openid` | Required for OIDC; provides `id_token` with user email |
| `profile` | Included by default with `openid`; adds display name |
| `email` | Ensures the `email` claim is present in the `id_token` |

`Mail.ReadWrite` is intentionally **not** requested. MCPEmails only needs to move emails to trash, which is achieved via the `Move` API with `Mail.ReadWrite` — but the MVP defers folder-management operations for Outlook. `Mail.Read` + `Mail.Send` is the minimal set for the initial feature surface. When folder management is added, the Outlook scope will need to include `Mail.ReadWrite`, and existing users will need to reconnect to grant the new scope.

`offline_access` is how Microsoft's OAuth v2.0 endpoint signals that a refresh token should be included in the response. Unlike Google's `access_type=offline`, this is a scope string, not a parameter.

### Tenant Configuration

MCPEmails is a multi-tenant application and must accept sign-ins from any Microsoft organization, not just one specific Azure AD tenant. The authorization and token endpoints use the `common` tenant:

```
https://login.microsoftonline.com/common/oauth2/v2.0/authorize
https://login.microsoftonline.com/common/oauth2/v2.0/token
```

Using `common` means that both personal Microsoft accounts (Outlook.com, Hotmail.com) and work/school accounts (Microsoft 365) can connect. If MCPEmails were only for enterprise use, the endpoint would be `organizations`; for personal-only use it would be `consumers`. The `common` choice is the correct default for a public SaaS.

The Azure AD app registration must have **"Supported account types"** set to **"Accounts in any organizational directory and personal Microsoft accounts"** to match this tenant configuration. If the app registration is scoped to a single tenant but the auth URL uses `common`, Microsoft will reject tokens from outside that tenant.

### Callback Route: `/auth/outlook/callback`

The structure is identical to the Gmail callback. Key differences:

- State lookup filters on `provider = 'outlook'`
- Token exchange calls `https://login.microsoftonline.com/common/oauth2/v2.0/token` with `client_id`, `client_secret`, `code`, `redirect_uri`, and `grant_type=authorization_code`
- The email address is extracted from the `id_token`'s `email` claim
- Stored `provider` value is `'outlook'`

```typescript
// lib/email-providers/outlook.ts — token exchange
export async function exchangeOutlookCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; email: string }> {
  const response = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID!,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET!,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    }
  );

  if (!response.ok) {
    const body = await response.json();
    throw new Error(`Outlook token exchange failed: ${body.error_description}`);
  }

  const data = await response.json();

  // Decode id_token to get email — no signature verification needed here
  // because it arrived over a server-to-server HTTPS call
  const idTokenPayload = JSON.parse(
    Buffer.from(data.id_token.split('.')[1], 'base64url').toString()
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email: idTokenPayload.email ?? idTokenPayload.preferred_username,
  };
}
```

### What Gets Stored in the `inboxes` Table

| Column | Value |
|---|---|
| `provider` | `'outlook'` |
| `email_address` | Email from `id_token.email` or `preferred_username` |
| `oauth_access_token` | AES-256-GCM ciphertext (`bytea`) |
| `oauth_refresh_token` | AES-256-GCM ciphertext (`bytea`) |
| `oauth_token_expires_at` | `now() + 3600 seconds` (Microsoft issues 1-hour access tokens) |
| `oauth_scope` | `'Mail.Read Mail.Send offline_access'` |
| `status` | `'active'` |

---

## 4. Fastmail OAuth

### Scopes

Fastmail implements the JMAP OAuth 2.0 extension. MCPEmails requests:

| Scope | Why |
|---|---|
| `https://www.fastmail.com/dev/protocol-email` | JMAP email access (read, send, move, flag) |
| `offline_access` | Refresh token |

Fastmail's JMAP API provides a single scope that covers all email operations (read, send, folder management). MCPEmails cannot request a read-only subset of Fastmail's email scope — the provider does not offer that granularity. This means a Fastmail connection carries more capability than equivalent Gmail or Outlook connections. The MCP layer enforces operation-level restrictions through the `scopes` column on the `api_keys` table, which limits what MCP tools can be called even when the underlying email credential has broader access.

### Authorization URL Construction

Fastmail's OAuth discovery document is available at `https://www.fastmail.com/.well-known/oauth-authorization-server`. The authorization endpoint is `https://www.fastmail.com/oauth`. The initiation handler at `app/auth/fastmail/route.ts` follows the same pattern as Gmail, generating a state nonce and redirecting.

### Callback Route: `/auth/fastmail/callback`

Token exchange uses Fastmail's token endpoint:

```
POST https://www.fastmail.com/oauth/token
Content-Type: application/x-www-form-urlencoded

code=<authorization_code>
&client_id=<FASTMAIL_CLIENT_ID>
&client_secret=<FASTMAIL_CLIENT_SECRET>
&redirect_uri=<redirect_uri>
&grant_type=authorization_code
```

Fastmail's token response does not include an `id_token`. The user's email address must be resolved by calling the JMAP session endpoint immediately after token exchange:

```typescript
// Fetch the authenticated identity's email address
const sessionResponse = await fetch('https://api.fastmail.com/jmap/session', {
  headers: { Authorization: `Bearer ${data.access_token}` },
});
const session = await sessionResponse.json();
const email = session.primaryAccounts
  ? Object.keys(session.primaryAccounts)[0]
  : session.username;
```

### Token Lifetimes

Fastmail issues unusually long-lived tokens:

- **Access token**: 1 year
- **Refresh token**: Does not expire (valid until user revokes in Fastmail settings)

The 5-minute proactive refresh check (see Section 7) still runs, but for Fastmail inboxes it will virtually never trigger a refresh in practice. The `oauth_token_expires_at` column is still populated and the refresh logic is still wired up — this maintains a uniform code path and protects against future Fastmail policy changes.

### What Gets Stored in the `inboxes` Table

| Column | Value |
|---|---|
| `provider` | `'fastmail'` |
| `email_address` | Email from JMAP session endpoint |
| `oauth_access_token` | AES-256-GCM ciphertext (`bytea`) |
| `oauth_refresh_token` | AES-256-GCM ciphertext (`bytea`) |
| `oauth_token_expires_at` | `now() + 365 days` |
| `oauth_scope` | `'https://www.fastmail.com/dev/protocol-email offline_access'` |
| `status` | `'active'` |

### App-Password Alternative

Fastmail users can generate application-specific passwords in Fastmail Settings → Privacy & Security → App Passwords. These passwords:

- Are tied to a specific set of Fastmail-defined permissions selected at generation time
- Do not expire unless revoked
- Work with IMAP/SMTP (not JMAP)
- Do not require an OAuth flow

MCPEmails supports this as an alternative connection method via a form in the inbox connection UI. The user enters their Fastmail email address and the app password. The credential is stored in `inboxes.imap_password` (AES-256-GCM encrypted `bytea`), and the IMAP/SMTP connection parameters are set to Fastmail's standard values:

| Column | Value |
|---|---|
| `provider` | `'fastmail'` |
| `imap_host` | `imap.fastmail.com` |
| `imap_port` | `993` |
| `imap_tls` | `true` |
| `smtp_host` | `smtp.fastmail.com` |
| `smtp_port` | `587` |
| `smtp_tls` | `true` |
| `imap_password` | AES-256-GCM ciphertext of the app password (`bytea`) |
| `oauth_*` columns | `NULL` |
| `status` | `'active'` |

The app-password path skips OAuth entirely. No `oauth_states` record is created. Validation is done by attempting an IMAP `LOGIN` before saving — if the login fails, the form returns an error and nothing is persisted.

The trade-off: app passwords are more fragile (must be manually revoked by the user if compromised; do not auto-refresh) but simpler for users who are uncomfortable with OAuth permission dialogs or whose Fastmail account is managed by an organization that has disabled OAuth for third-party apps.

---

## 5. Token Storage Schema

All email credentials are stored in the `public.inboxes` table. The columns relevant to credential storage are:

| Column | Type | Encrypted | Description |
|---|---|---|---|
| `provider` | `text` | No | `'gmail'`, `'outlook'`, or `'fastmail'` |
| `email_address` | `text` | No | The connected email address; used as the human-readable identifier in the UI |
| `oauth_access_token` | `bytea` | Yes — AES-256-GCM | The current access token; decrypted only when making a provider API call |
| `oauth_refresh_token` | `bytea` | Yes — AES-256-GCM | The long-lived refresh token; decrypted only to perform a token refresh |
| `oauth_token_expires_at` | `timestamptz` | No | The expiry timestamp of the current access token; checked in plaintext to decide whether a refresh is needed without decrypting the token |
| `oauth_scope` | `text` | No | Space-separated list of granted scopes; stored for display and to detect when a scope upgrade requires re-authorization |
| `imap_password` | `bytea` | Yes — AES-256-GCM | Fastmail app-password path only |
| `status` | `text` | No | `'pending'`, `'active'`, `'error'`, `'revoked'` |
| `last_error` | `text` | No | Human-readable error description; never contains token values |
| `last_sync_at` | `timestamptz` | No | Timestamp of the last successful provider API call |

The `oauth_token_expires_at` column is stored unencrypted intentionally. The token refresh Edge Function runs a query like:

```sql
SELECT id, workspace_id, provider, oauth_token_expires_at
FROM inboxes
WHERE status = 'active'
  AND provider IN ('gmail', 'outlook', 'fastmail')
  AND oauth_token_expires_at < now() + interval '5 minutes'
```

If the expiry were encrypted, this query would require decrypting every active inbox row on every run — which would be O(n) decryptions regardless of how many tokens actually need refreshing. Storing the expiry in plaintext keeps the fan-out to only rows that actually need action.

The partial index `idx_inboxes_token_expires_active` on `(oauth_token_expires_at) WHERE status = 'active'` ensures this query is served by an index seek rather than a sequential scan.

---

## 6. Encryption at Rest

### Algorithm

All credential columns (`oauth_access_token`, `oauth_refresh_token`, `imap_password`) are encrypted using **AES-256-GCM** before the application writes them to the database. The ciphertext stored in the `bytea` column has this layout:

```
[ 12-byte IV ][ ciphertext ][ 16-byte GCM auth tag ]
```

Total overhead per value: 28 bytes. A 256-byte access token produces a 284-byte `bytea` value.

GCM mode is chosen because:
- It provides **authenticated encryption** — the auth tag detects any bitflip or tampering of the stored ciphertext, so the application will fail loudly rather than silently decrypt garbage.
- It is widely supported and has no patent encumbrances.
- A fresh random IV per encryption ensures that two encryptions of the same plaintext produce different ciphertexts (preventing oracle attacks).

### Key Management

The encryption key is a 32-byte secret stored in Supabase Vault as a named secret (`email_token_encryption_key`). It is exposed to application code only inside Supabase Edge Functions via the Vault API — it is never written to a `.env` file or included in the Next.js server bundle.

```typescript
// lib/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Key is loaded once per Edge Function cold start from Vault
let encryptionKey: Buffer | null = null;

function getKey(): Buffer {
  if (!encryptionKey) {
    const keyHex = process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error('EMAIL_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    encryptionKey = Buffer.from(keyHex, 'hex');
  }
  return encryptionKey;
}

export function encryptToken(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: IV || ciphertext || authTag
  return Buffer.concat([iv, encrypted, authTag]);
}

export function decryptToken(ciphertext: Buffer): string {
  const iv = ciphertext.subarray(0, IV_LENGTH);
  const authTag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const encrypted = ciphertext.subarray(IV_LENGTH, ciphertext.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
```

### Key Rotation

Key rotation is a manual, coordinated operation:

1. Generate a new 32-byte key and store it in Vault under a new version.
2. Run a migration Edge Function that reads every encrypted credential row, decrypts with the old key, re-encrypts with the new key, and writes back in a transaction.
3. Update the Vault secret reference to point to the new version.
4. Verify a sample of rows decrypts correctly before decommissioning the old key version.

Key rotation does not require user re-authentication. It should be performed whenever a key compromise is suspected and as a routine annual operation.

### Defense in Depth

The application-layer AES-256-GCM encryption is the primary protection. Supabase's `pgsodium` extension (Transparent Column Encryption) provides a secondary layer at the storage level. Even if an attacker bypasses PostgreSQL's authentication (e.g., via a misconfigured connection pooler or a snapshot leak), they see `pgsodium`-encrypted `bytea` values. If they also bypass `pgsodium` (e.g., via direct file-system access to the data directory), they see AES-256-GCM ciphertext that is useless without the Vault key. The Vault key is never stored adjacent to the database data.

---

## 7. Token Refresh Lifecycle

### Trigger: 5 Minutes Before Expiry

The proactive refresh threshold is **5 minutes before `oauth_token_expires_at`**. This was chosen because:

- Provider token endpoints respond in under 1 second in the happy path, so 5 minutes is not operationally needed for latency.
- 5 minutes provides enough buffer for the case where the scheduled refresh job is delayed by a cold start or transient Supabase unavailability.
- Google's tokens expire at exactly 3600 seconds. If the refresh window were 0 (refresh only when already expired), a token could expire between the check and the API call, causing a failed MCP tool invocation. 5 minutes eliminates this race.

### Refresh Before Every Provider API Call

The inline refresh check runs at the start of every email provider API call, inside the MCP Edge Function:

```typescript
// lib/email-providers/gmail.ts
export async function withFreshGmailToken(inbox: InboxRow): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(inbox.oauth_token_expires_at);
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt > fiveMinutesFromNow) {
    // Token is fresh enough — just decrypt and return
    return decryptToken(inbox.oauth_access_token);
  }

  // Token is expiring soon — refresh it
  const refreshToken = decryptToken(inbox.oauth_refresh_token);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = await response.json();
    // If the refresh token itself is invalid, mark the inbox as errored
    if (body.error === 'invalid_grant') {
      await markInboxErrored(inbox.id, 'Refresh token expired or revoked — user must reconnect');
      throw new InboxAuthError('REFRESH_TOKEN_INVALID', inbox.id);
    }
    throw new Error(`Token refresh failed: ${body.error_description}`);
  }

  const data = await response.json();
  const newAccessToken = data.access_token;
  const newExpiresAt = new Date(now.getTime() + data.expires_in * 1000).toISOString();

  // Re-encrypt and write back
  const encryptedAccessToken = encryptToken(newAccessToken);
  await updateInboxTokens(inbox.id, encryptedAccessToken, newExpiresAt);

  return newAccessToken;
}
```

### Scheduled Background Refresh

In addition to inline refresh, a Supabase Edge Function runs on a schedule (every 10 minutes) to pre-refresh tokens that are within the 5-minute window. This catches the case where an inbox is connected but an AI agent has not been actively calling it — without background refresh, a token could expire and the next MCP call would incur the latency of a synchronous refresh before responding.

The scheduled function queries:

```sql
SELECT id, workspace_id, provider,
       oauth_access_token, oauth_refresh_token, oauth_token_expires_at
FROM inboxes
WHERE status = 'active'
  AND provider IN ('gmail', 'outlook', 'fastmail')
  AND oauth_token_expires_at < now() + interval '10 minutes'
  AND deleted_at IS NULL
```

It then refreshes each token and writes back the new value. If refresh fails with `invalid_grant`, it sets `status = 'error'` and `last_error = 'Refresh token expired or revoked — reconnection required'`.

### On Refresh Failure

When a refresh fails with `invalid_grant` (or equivalent — see provider mapping below), the inbox is marked as errored:

```typescript
async function markInboxErrored(inboxId: string, reason: string): Promise<void> {
  const supabase = createServiceRoleClient(); // bypass RLS for this write
  await supabase
    .from('inboxes')
    .update({
      status: 'error',
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', inboxId);
}
```

The `last_error` column is shown in the dashboard UI as a user-readable message. The dashboard displays a banner on the errored inbox with a "Reconnect" button that triggers the OAuth flow again.

#### Provider-Specific Error Codes for Refresh Failure

| Provider | Error indicating refresh token is invalid |
|---|---|
| Gmail | `error: "invalid_grant"` |
| Outlook | `error: "invalid_grant"` or `error: "interaction_required"` |
| Fastmail | HTTP 401 on the token endpoint |

When `interaction_required` is returned by Outlook, it means the user's organization has conditional access policies (e.g., MFA required, compliant device required) that prevent silent token refresh. The inbox is marked as errored with the message "Your organization requires you to sign in again" and the reconnect flow re-initiates the full interactive authorization.

---

## 8. Reconnection Flow

When an inbox has `status = 'error'`, the user can click "Reconnect" in the dashboard. The reconnection flow re-uses the standard OAuth flow with one addition: it upserts rather than inserts the `inboxes` row.

The upsert in the callback handler (shown in Section 2) uses `onConflict: 'workspace_id, email_address'` to match the existing errored row by email address and overwrite:

- `oauth_access_token` — new encrypted token
- `oauth_refresh_token` — new encrypted refresh token
- `oauth_token_expires_at` — new expiry
- `status` — reset to `'active'`
- `last_error` — set to `NULL`
- `deleted_at` — set to `NULL` (un-soft-deletes the row if it was soft-deleted)

All other columns are preserved:
- `id` — the inbox UUID does not change, so any `activity_log` rows still reference the same inbox ID
- `created_at` — the original connection date is preserved
- `workspace_id`, `provider`, `display_name` — unchanged

This means an AI agent's memory of "inbox id X is my email account" remains valid after reconnection. If the OAuth flow were to create a new `inboxes` row on reconnect (using `INSERT`), the activity log would lose its foreign key linkage and the MCP layer's inbox reference would point to a non-existent row.

The reconnect flow handles the edge case where the user connects a different email address than the one originally connected. In that case, no conflict is found and a new `inboxes` row is inserted. The old errored row remains in the database with `status = 'error'` and is shown in the dashboard as a separate disconnected inbox. The user can explicitly delete the old inbox to remove it.

---

## 9. Revocation

### User-Initiated Disconnect

When a user clicks "Disconnect" in the inbox settings, the following operations run in order inside a single database transaction:

**Step 1: Revoke with the provider**

The access token is decrypted and submitted to the provider's revocation endpoint. If revocation fails (e.g., the token is already expired), the failure is logged but does not abort the local cleanup — local cleanup proceeds regardless.

| Provider | Revocation endpoint | Method | Body |
|---|---|---|---|
| Gmail | `https://oauth2.googleapis.com/revoke` | POST | `token=<access_token>` |
| Outlook | `https://login.microsoftonline.com/common/oauth2/v2.0/logout` | GET | `post_logout_redirect_uri=...` |
| Fastmail | `https://www.fastmail.com/oauth/revoke` | POST | `token=<access_token>` |

**Step 2: Clear the tokens from the database**

```typescript
await supabase
  .from('inboxes')
  .update({
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_password: null,
    status: 'revoked',
    updated_at: new Date().toISOString(),
  })
  .eq('id', inboxId)
  .eq('workspace_id', workspaceId); // RLS double-check
```

**Step 3: Soft-delete the row**

```typescript
await supabase
  .from('inboxes')
  .update({ deleted_at: new Date().toISOString() })
  .eq('id', inboxId)
  .eq('workspace_id', workspaceId);
```

The soft delete (`deleted_at IS NOT NULL`) excludes the row from all dashboard queries and from the unique constraint `UNIQUE (workspace_id, email_address) WHERE deleted_at IS NULL`. This allows the same email address to be reconnected in the future.

**Step 4: Log the revocation event**

An `auth_logs` record is inserted with `event_type = 'token_revoked'`, `provider`, and `inbox_id` in the `metadata` JSONB column.

### Provider-Initiated Revocation

If the user revokes access directly in the provider's account settings (outside of MCPEmails), the next token refresh will return `invalid_grant`, and the inbox will be marked as `status = 'error'` by the refresh failure path (Section 7). The tokens are not cleared from the database immediately in this case — they remain as ciphertext until the user explicitly disconnects in MCPEmails or the inbox is garbage-collected by a future cleanup job.

This is acceptable: the ciphertext is useless without the Vault key, and the provider has already invalidated the token on their side. The stale ciphertext poses no security risk.

---

## 10. Environment Variables

### Gmail

| Variable | Location | Description |
|---|---|---|
| `GMAIL_CLIENT_ID` | Server-only | OAuth 2.0 client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | Server-only | OAuth 2.0 client secret from Google Cloud Console |

**Google Cloud Console setup:**
- Project must have the Gmail API enabled
- OAuth consent screen must be configured with the three Gmail scopes
- Authorized redirect URI must include both `http://localhost:3000/auth/gmail/callback` (development) and `https://<production-domain>/auth/gmail/callback` (production)
- For production with more than 100 users, the app must pass Google's OAuth verification for restricted scopes

### Outlook

| Variable | Location | Description |
|---|---|---|
| `OUTLOOK_CLIENT_ID` | Server-only | Application (client) ID from Azure Portal |
| `OUTLOOK_CLIENT_SECRET` | Server-only | Client secret value from Azure Portal (not the secret ID) |

**Azure Portal setup:**
- App registration under Azure Active Directory
- Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
- API permissions: `Mail.Read` and `Mail.Send` (Delegated, not Application)
- Redirect URI must be registered as type "Web" in the app registration

### Fastmail

| Variable | Location | Description |
|---|---|---|
| `FASTMAIL_CLIENT_ID` | Server-only | Client ID from Fastmail Developer settings |
| `FASTMAIL_CLIENT_SECRET` | Server-only | Client secret from Fastmail Developer settings |

### Shared

| Variable | Location | Description |
|---|---|---|
| `EMAIL_TOKEN_ENCRYPTION_KEY` | Server-only (Vault) | 64-character hex string (32 bytes) — AES-256-GCM encryption key for all token columns. Never set this in `.env.local`; use Supabase Vault in production. |
| `NEXT_PUBLIC_APP_URL` | Public | The base URL of the application, e.g. `https://mcpemails.com`. Used to construct callback URIs and redirect targets. Must not have a trailing slash. |

---

## Inbox Connection Lifecycle State Diagram

```
                        ┌─────────────────────────────┐
                        │         (no record)          │
                        └──────────────┬──────────────┘
                                       │
                        User clicks "Connect" in dashboard
                                       │
                                       ▼
                        ┌─────────────────────────────┐
                        │           PENDING            │
                        │  (row inserted, OAuth flow   │
                        │   in progress)               │
                        └──────┬──────────────┬────────┘
                               │              │
                  OAuth success │              │ User denies / timeout /
                                │              │ code exchange fails
                                ▼              ▼
                   ┌────────────────┐    ┌────────────────┐
                   │    ACTIVE      │    │  (row deleted) │
                   │                │    │  Back to start  │
                   │ Tokens valid,  │    └────────────────┘
                   │ API calls work │
                   └─────┬────┬────┘
                         │    │
    Token refresh fails  │    │ User clicks
    (invalid_grant /     │    │ "Disconnect"
     provider revokes)   │    │
                         │    ▼
                         │  ┌────────────────────────────┐
                         │  │           REVOKED           │
                         │  │  Tokens cleared from DB,   │
                         │  │  provider revocation sent, │
                         │  │  row soft-deleted           │
                         │  └────────────────────────────┘
                         │
                         ▼
                   ┌──────────────────────────────────────┐
                   │               ERROR                   │
                   │  status='error', tokens still stored  │
                   │  (encrypted), last_error populated,   │
                   │  dashboard shows reconnect banner      │
                   └────────────────┬─────────────────────┘
                                    │
                     User clicks "Reconnect" → OAuth flow
                                    │
                                    ▼
                   ┌────────────────────────────────────┐
                   │              ACTIVE                 │
                   │  Upserted: new tokens, last_error   │
                   │  cleared, same inbox ID preserved   │
                   └────────────────────────────────────┘
```

**State transitions summary:**

| From | To | Trigger |
|---|---|---|
| (no record) | PENDING | User initiates OAuth flow |
| PENDING | ACTIVE | Callback handler completes successfully |
| PENDING | (no record) | User denies, flow times out, or code exchange fails |
| ACTIVE | ERROR | Token refresh returns `invalid_grant`; provider revokes externally |
| ACTIVE | REVOKED | User clicks "Disconnect" |
| ERROR | ACTIVE | User reconnects via OAuth flow |
| REVOKED | ACTIVE | User reconnects via OAuth flow (new row or upsert if same email) |

---

## Security Decisions Cross-Referenced with MCP Security Model

The token and OAuth flows described in this document are designed to be consistent with the attack mitigations documented in `Documents/MCP/security-best-practices.md`:

**Confused deputy**: The `oauth_states` table stores the `state` nonce with the `workspace_id` and `user_id` of the user who initiated the flow. The callback handler validates the state before processing any tokens, and state values are single-use (deleted immediately after lookup). The `redirect_uri` stored with each state nonce is validated by exact string equality in the callback handler — not by prefix or pattern matching.

**Token passthrough**: MCPEmails never passes provider OAuth tokens to MCP clients. MCP clients authenticate with MCPEmails-issued API keys (stored as bcrypt hashes in `api_keys`). The provider tokens live exclusively server-side, encrypted in the database, and are decrypted only inside Edge Functions that make direct calls to provider APIs. There is no mechanism by which an MCP client can receive or replay a Gmail/Outlook/Fastmail token.

**SSRF**: The OAuth callback handlers only make outbound HTTPS calls to hardcoded provider endpoints (`oauth2.googleapis.com`, `login.microsoftonline.com`, `www.fastmail.com`). No URLs from the request parameters are used as outbound destinations. The state nonce validation occurs before any outbound call is made.

**Scope minimization**: Each provider connection requests the minimum scopes required for the feature surface. The `api_keys.scopes` column provides a second layer of restriction at the MCP tool level, so a key with only `read:email` cannot trigger send operations even if the underlying inbox credential grants `Mail.Send`.

**Session hijacking**: The OAuth state parameter is cryptographically random (32 bytes from `randomBytes`), stored server-side, and expires in 10 minutes. It is bound to a specific `workspace_id` and `user_id`, so a stolen state nonce from one user's flow cannot be replayed in another user's context.
