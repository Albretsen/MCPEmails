/**
 * Outlook Token Refresh — Supabase Edge Function
 *
 * Runs every 10 minutes from pg_cron (migration
 * 20260925120000_schedule_outlook_token_refresh.sql), authenticated by the
 * X-Dispatch-Secret header (see `authorised` below). Proactively refreshes Outlook access tokens that are within 10
 * minutes of expiry so that MCP tool calls never stall on a synchronous
 * refresh at invocation time.
 *
 * It is also what keeps IDLE inboxes alive. A Microsoft refresh token has a
 * 90-day sliding lifetime and Microsoft rotates it on every refresh, so every
 * refresh here persists the new refresh token it is handed. Without a
 * scheduled run, an inbox nobody touches for 90 days dies.
 *
 * On `invalid_grant` from Microsoft (refresh token revoked/expired), or
 * `interaction_required` (org conditional-access policy blocks silent refresh),
 * the inbox is marked as `status = 'error'` and `last_error` is populated with
 * a human-readable reconnection message.
 *
 * Uses the Microsoft Identity Platform v2.0 endpoint under OUTLOOK_TENANT_ID
 * (default "common", which accepts both personal Microsoft accounts and
 * work/school accounts), the same authority the web app signs in with.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §3, §7
 *   https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow#refresh-the-access-token
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Same rule as `outlookTenant` in apps/web/src/lib/email-providers/outlook-oauth.ts:
 * OUTLOOK_TENANT_ID if it is a plain GUID / domain / alias, else "common".
 */
function outlookTokenEndpoint(): string {
  const raw = (Deno.env.get('OUTLOOK_TENANT_ID') ?? '').trim();
  const tenant = raw && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(raw) ? raw : 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/** Must match OUTLOOK_SCOPES in apps/web/src/lib/email-providers/outlook-oauth.ts. */
const OUTLOOK_SCOPE = 'Mail.ReadWrite Mail.Send offline_access openid profile email';

/** Query window: refresh tokens expiring within this many minutes. */
const REFRESH_WINDOW_MINUTES = 10;

/**
 * Rows fetched per page when draining the expiring-token queue. Must not exceed
 * PostgREST's `db-max-rows` (1000): a server-truncated page would look like the
 * last page and we would silently skip the rest of the queue again.
 */
const QUERY_PAGE_SIZE = 1000;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ─── Crypto helpers (Web Crypto API — Deno compatible) ────────────────────────

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKey(): Promise<CryptoKey> {
  const keyHex = Deno.env.get('ENCRYPTION_KEY');
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32'
    );
  }
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Decrypts a base64url-encoded ciphertext produced by the Next.js
 * `encryptToken` function in `lib/crypto.ts`.
 *
 * Stored layout: IV (12 bytes) || ciphertext || GCM auth tag (16 bytes)
 * Web Crypto AES-GCM decrypt expects: ciphertext || auth tag as one buffer.
 */
async function decryptToken(ciphertext: string, key: CryptoKey): Promise<string> {
  const raw = base64urlDecode(ciphertext);
  const iv = raw.slice(0, IV_LENGTH);
  // Everything after the IV: ciphertext || auth tag — passed as-is to Web Crypto.
  const encryptedWithTag = raw.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
    key,
    encryptedWithTag
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypts a plaintext string using AES-256-GCM and returns a base64url
 * string in the same layout as `encryptToken` in `lib/crypto.ts`:
 *   IV (12 bytes) || ciphertext || GCM auth tag (16 bytes)
 */
async function encryptToken(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encryptedWithTag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
    key,
    new TextEncoder().encode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encryptedWithTag);
  const result = new Uint8Array(IV_LENGTH + encryptedBytes.length);
  result.set(iv, 0);
  result.set(encryptedBytes, IV_LENGTH);
  return base64urlEncode(result);
}

// ─── Outlook token refresh ────────────────────────────────────────────────────

interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  /** The rotated refresh token, or null if Microsoft returned none. */
  refreshToken: string | null;
}

interface MicrosoftErrorResponse {
  error?: string;
  error_description?: string;
  suberror?: string;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Discriminated union for outcomes that require caller-specific handling
 * rather than a thrown exception.
 */
type RefreshOutcome =
  | { ok: true; result: RefreshResult }
  | { ok: false; reason: 'invalid_grant' | 'interaction_required' };

/**
 * Calls Microsoft's token endpoint with the given plaintext refresh token.
 *
 * Returns:
 *  - `{ ok: true, result }` on success.
 *  - `{ ok: false, reason: 'invalid_grant' }` when the refresh token has been
 *    revoked or expired. The inbox must be marked as errored.
 *  - `{ ok: false, reason: 'interaction_required' }` when the user's org has a
 *    conditional-access policy (e.g. MFA, compliant device) that blocks silent
 *    refresh. The inbox must be marked as errored.
 *
 * Throws on any other non-200 response.
 */
async function callOutlookRefreshEndpoint(
  refreshToken: string
): Promise<RefreshOutcome> {
  const clientId = Deno.env.get('OUTLOOK_CLIENT_ID');
  const clientSecret = Deno.env.get('OUTLOOK_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error(
      'OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET must be set in edge function env.'
    );
  }

  const response = await fetch(outlookTokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      // Request the same scope set originally granted (offline_access
      // included) so Microsoft issues a rotated refresh token in the response.
      // It is persisted below; that is what keeps the sliding window alive.
      scope: OUTLOOK_SCOPE,
    }),
  });

  if (!response.ok) {
    // A gateway error page is not JSON; keep it an ordinary failure.
    const body = (await response.json().catch(() => ({}))) as MicrosoftErrorResponse;

    // invalid_grant: refresh token expired or user revoked access in Microsoft
    // account settings. The only recovery is a new interactive authorization.
    if (body.error === 'invalid_grant') {
      return { ok: false, reason: 'invalid_grant' };
    }

    // interaction_required: org conditional-access policy (MFA, compliant
    // device, location restriction) prevents silent refresh. User must reconnect
    // via the full interactive OAuth flow.
    if (body.error === 'interaction_required') {
      return { ok: false, reason: 'interaction_required' };
    }

    throw new Error(
      `Outlook refresh failed (HTTP ${response.status}): ` +
        `${body.error_description ?? body.error ?? 'unknown'}`
    );
  }

  const data = (await response.json()) as MicrosoftTokenResponse;
  if (!data.access_token) {
    throw new Error('Outlook refresh: missing access_token in response');
  }

  return {
    ok: true,
    result: {
      accessToken: data.access_token,
      // Microsoft issues 1-hour (3600 s) access tokens; fall back to that if
      // expires_in is absent (it should always be present).
      expiresIn: data.expires_in ?? 3600,
      refreshToken: data.refresh_token || null,
    },
  };
}

// ─── Caller auth ──────────────────────────────────────────────────────────────

/**
 * This function is deployed with verify_jwt = false (pg_cron posts with no
 * Supabase JWT), so the gateway lets every request through and the check has
 * to live here. Same contract as the other cron-only entry points
 * (mcp-server /dispatch-scheduled-sends and /triage-dispatch, and the web
 * app's billing lifecycle dispatcher): an `X-Dispatch-Secret` header that
 * must equal the DISPATCH_SECRET function secret, which pg_cron reads from
 * the Vault secret `dispatch_secret`. Fails closed when the env var is unset.
 */
function authorised(req: Request): boolean {
  const expected = Deno.env.get('DISPATCH_SECRET');
  if (!expected) {
    console.error('[outlook-token-refresh] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(req.headers.get('x-dispatch-secret') ?? '');
  // Length is not secret. Compare every byte so the time taken does not
  // reveal how long a matching prefix was.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ─── Edge Function entry point ────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed, use POST' }),
      { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
    );
  }
  if (!authorised(req)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: invalid or missing X-Dispatch-Secret' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      '[outlook-token-refresh] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    );
    return new Response(
      JSON.stringify({ error: 'Missing required environment variables' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let aesKey: CryptoKey;
  try {
    aesKey = await importAesKey();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[outlook-token-refresh] Failed to load encryption key:', message);
    return new Response(
      JSON.stringify({ error: 'Encryption key unavailable' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Query all active Outlook inboxes with tokens expiring within the window.
  const windowTimestamp = new Date(
    Date.now() + REFRESH_WINDOW_MINUTES * 60 * 1000
  ).toISOString();

  // Paged with .range(): PostgREST truncates an unpaged select at db-max-rows
  // (1000) without raising an error, so once more than that many tokens fall
  // into the same 10-minute window the tail is simply never seen by this run --
  // and those tokens expire in the gap. Draining the queue here (before the
  // refresh loop mutates any row) keeps the page offsets stable.
  const inboxes: {
    id: string;
    oauth_access_token: string | null;
    oauth_refresh_token: string | null;
    oauth_token_expires_at: string | null;
  }[] = [];

  for (let from = 0; ; from += QUERY_PAGE_SIZE) {
    const { data: page, error: queryError } = await supabase
      .from('inboxes')
      .select('id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at')
      .eq('status', 'active')
      .eq('provider', 'outlook')
      .lt('oauth_token_expires_at', windowTimestamp)
      .is('deleted_at', null)
      // A total order is what makes the offsets mean anything: without it two
      // pages can overlap or skip. Soonest-to-expire first, id as tie-breaker.
      .order('oauth_token_expires_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + QUERY_PAGE_SIZE - 1);

    if (queryError) {
      console.error('[outlook-token-refresh] Query failed:', queryError.message);
      return new Response(
        JSON.stringify({ error: 'Database query failed', detail: queryError.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const batch = page ?? [];
    inboxes.push(...batch);
    // A short page means the server had nothing more to give; a full one means
    // there may be another behind it.
    if (batch.length < QUERY_PAGE_SIZE) break;
  }

  if (inboxes.length === 0) {
    console.log('[outlook-token-refresh] No Outlook tokens require refresh.');
    return new Response(
      JSON.stringify({ refreshed: 0, errored: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  console.log(
    `[outlook-token-refresh] Found ${inboxes.length} inbox(es) to refresh.`
  );

  let refreshed = 0;
  let errored = 0;

  for (const inbox of inboxes) {
    if (!inbox.oauth_refresh_token) {
      console.warn(
        `[outlook-token-refresh] Inbox ${inbox.id} has no refresh token — skipping.`
      );
      continue;
    }

    try {
      const refreshToken = await decryptToken(inbox.oauth_refresh_token, aesKey);
      const outcome = await callOutlookRefreshEndpoint(refreshToken);

      if (!outcome.ok) {
        // Determine a user-readable message based on the failure reason.
        const lastError =
          outcome.reason === 'interaction_required'
            ? 'Your organization requires interactive sign-in (e.g. MFA) — please reconnect this inbox.'
            : 'Outlook refresh token expired or revoked — reconnection required.';

        await supabase
          .from('inboxes')
          .update({
            status: 'error',
            last_error: lastError,
            updated_at: new Date().toISOString(),
          })
          .eq('id', inbox.id);

        console.warn(
          `[outlook-token-refresh] Inbox ${inbox.id}: ${outcome.reason} — marked as errored.`
        );
        errored++;
        continue;
      }

      const newExpiresAt = new Date(
        Date.now() + outcome.result.expiresIn * 1000
      ).toISOString();

      const encryptedAccessToken = await encryptToken(
        outcome.result.accessToken,
        aesKey
      );
      // Microsoft rotates the refresh token. Keeping only the original one
      // means the inbox dies 90 days after connect no matter how often this
      // runs, so the new one is stored, encrypted the same way.
      const encryptedRefreshToken = outcome.result.refreshToken
        ? await encryptToken(outcome.result.refreshToken, aesKey)
        : null;

      const { error: updateError } = await supabase
        .from('inboxes')
        .update({
          oauth_access_token: encryptedAccessToken,
          ...(encryptedRefreshToken ? { oauth_refresh_token: encryptedRefreshToken } : {}),
          oauth_token_expires_at: newExpiresAt,
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', inbox.id);

      if (updateError) {
        console.error(
          `[outlook-token-refresh] Failed to update tokens for inbox ${inbox.id}:`,
          updateError.message
        );
        errored++;
        continue;
      }

      console.log(
        `[outlook-token-refresh] Inbox ${inbox.id}: token refreshed, expires ${newExpiresAt}.`
      );
      refreshed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[outlook-token-refresh] Inbox ${inbox.id}: unexpected error:`,
        message
      );
      errored++;
    }
  }

  return new Response(
    JSON.stringify({ refreshed, errored, total: inboxes.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
