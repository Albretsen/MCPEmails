/**
 * Gmail Token Refresh — Supabase Edge Function
 *
 * Scheduled to run every 10 minutes. Proactively refreshes Gmail access
 * tokens that are within 10 minutes of expiry so that MCP tool calls never
 * stall on a synchronous refresh at invocation time.
 *
 * On `invalid_grant` from Google (refresh token revoked/expired), the inbox
 * is marked as `status = 'error'` and `last_error` is populated with a
 * human-readable reconnection message.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §7
 *   https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ─── Constants ────────────────────────────────────────────────────────────────

const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Query window: refresh tokens expiring within this many minutes. */
const REFRESH_WINDOW_MINUTES = 10;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ─── Crypto helpers (Web Crypto API — Deno compatible) ────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64urlEncode(bytes: Uint8Array): string {
  // btoa works on binary strings
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
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
 *
 * Web Crypto's `encrypt` returns ciphertext || auth tag as a single buffer,
 * so we prepend the IV to produce the canonical layout.
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

// ─── Gmail token refresh ──────────────────────────────────────────────────────

interface RefreshResult {
  accessToken: string;
  expiresIn: number;
}

interface GoogleErrorResponse {
  error?: string;
  error_description?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * Calls Google's token endpoint with the given plaintext refresh token.
 *
 * Returns `{ invalidGrant: true }` when the refresh token has been revoked
 * so the caller can mark the inbox as errored rather than throwing.
 */
async function callGmailRefreshEndpoint(
  refreshToken: string
): Promise<RefreshResult | { invalidGrant: true }> {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in edge function env.');
  }

  const response = await fetch(GMAIL_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = (await response.json()) as GoogleErrorResponse;
    if (body.error === 'invalid_grant') {
      return { invalidGrant: true };
    }
    throw new Error(
      `Gmail refresh failed (HTTP ${response.status}): ${body.error_description ?? body.error ?? 'unknown'}`
    );
  }

  const data = (await response.json()) as GoogleTokenResponse;
  if (!data.access_token) {
    throw new Error('Gmail refresh: missing access_token in response');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

// ─── Edge Function entry point ────────────────────────────────────────────────

Deno.serve(async (_req: Request): Promise<Response> => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[gmail-token-refresh] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
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
    console.error('[gmail-token-refresh] Failed to load encryption key:', message);
    return new Response(
      JSON.stringify({ error: 'Encryption key unavailable' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Query all active Gmail inboxes with tokens expiring within the window.
  const windowTimestamp = new Date(
    Date.now() + REFRESH_WINDOW_MINUTES * 60 * 1000
  ).toISOString();

  const { data: inboxes, error: queryError } = await supabase
    .from('inboxes')
    .select('id, oauth_access_token, oauth_refresh_token, oauth_token_expires_at')
    .eq('status', 'active')
    .eq('provider', 'gmail')
    .lt('oauth_token_expires_at', windowTimestamp)
    .is('deleted_at', null);

  if (queryError) {
    console.error('[gmail-token-refresh] Query failed:', queryError.message);
    return new Response(
      JSON.stringify({ error: 'Database query failed', detail: queryError.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!inboxes || inboxes.length === 0) {
    console.log('[gmail-token-refresh] No Gmail tokens require refresh.');
    return new Response(
      JSON.stringify({ refreshed: 0, errored: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  console.log(`[gmail-token-refresh] Found ${inboxes.length} inbox(es) to refresh.`);

  let refreshed = 0;
  let errored = 0;

  for (const inbox of inboxes) {
    if (!inbox.oauth_refresh_token) {
      console.warn(`[gmail-token-refresh] Inbox ${inbox.id} has no refresh token — skipping.`);
      continue;
    }

    try {
      const refreshToken = await decryptToken(inbox.oauth_refresh_token, aesKey);
      const result = await callGmailRefreshEndpoint(refreshToken);

      if ('invalidGrant' in result) {
        // Refresh token is no longer valid — mark inbox as errored.
        await supabase
          .from('inboxes')
          .update({
            status: 'error',
            last_error: 'Refresh token expired or revoked — reconnection required.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', inbox.id);

        console.warn(`[gmail-token-refresh] Inbox ${inbox.id}: invalid_grant — marked as errored.`);
        errored++;
        continue;
      }

      const newExpiresAt = new Date(
        Date.now() + result.expiresIn * 1000
      ).toISOString();

      const encryptedAccessToken = await encryptToken(result.accessToken, aesKey);

      const { error: updateError } = await supabase
        .from('inboxes')
        .update({
          oauth_access_token: encryptedAccessToken,
          oauth_token_expires_at: newExpiresAt,
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', inbox.id);

      if (updateError) {
        console.error(
          `[gmail-token-refresh] Failed to update tokens for inbox ${inbox.id}:`,
          updateError.message
        );
        errored++;
        continue;
      }

      console.log(`[gmail-token-refresh] Inbox ${inbox.id}: token refreshed, expires ${newExpiresAt}.`);
      refreshed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gmail-token-refresh] Inbox ${inbox.id}: unexpected error:`, message);
      errored++;
    }
  }

  return new Response(
    JSON.stringify({ refreshed, errored, total: inboxes.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
