/**
 * Gmail OAuth 2.0 helpers.
 *
 * Handles authorization code exchange and token refresh with Google's
 * token endpoint. All credentials (access/refresh tokens) are decrypted
 * only inside server-side code and are NEVER logged or forwarded to clients.
 *
 * References:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   Documents/Architecture/email-provider-oauth-flows.md §2, §7
 */

import { encryptToken, decryptToken } from '@/lib/crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Tables } from '@/types/database.types';

const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_PROFILE_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/profile';

/** The 5-minute proactive refresh window in milliseconds. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GmailTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
}

/**
 * Thrown when an inbox's OAuth credentials can no longer be refreshed.
 *
 * The MCP server should catch this error and return a structured error
 * response instructing the user to reconnect the inbox.
 */
export class InboxAuthError extends Error {
  public readonly code: 'REFRESH_TOKEN_INVALID' | 'MISSING_TOKENS';
  public readonly inboxId: string;

  constructor(
    code: 'REFRESH_TOKEN_INVALID' | 'MISSING_TOKENS',
    inboxId: string
  ) {
    const messages: Record<typeof code, string> = {
      REFRESH_TOKEN_INVALID:
        'Gmail refresh token is invalid or revoked. Please reconnect the inbox.',
      MISSING_TOKENS:
        'Inbox is missing OAuth tokens. Please reconnect the inbox.',
    };
    super(messages[code]);
    this.name = 'InboxAuthError';
    this.code = code;
    this.inboxId = inboxId;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decodes the payload of a JWT without verifying its signature.
 *
 * Safe to use here because the JWT arrives over a server-to-server
 * HTTPS call immediately after the authorization code exchange; it is
 * not user-supplied input.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: expected 3 parts');
  }
  const payloadB64 = parts[1];
  if (!payloadB64) {
    throw new Error('Invalid JWT: missing payload');
  }
  const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Marks an inbox as errored, storing a human-readable reason in `last_error`.
 *
 * Uses the service-role client to bypass RLS; this is called from a
 * background job context where there is no authenticated user session.
 */
async function markInboxErrored(inboxId: string, reason: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from('inboxes')
    .update({
      status: 'error',
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', inboxId);

  if (error) {
    // Log the failure but don't throw; the caller already has an error to handle.
    console.error(`[gmail] Failed to mark inbox ${inboxId} as errored:`, error.message);
  }
}

/**
 * Persists a refreshed access token and its new expiry back to the database.
 *
 * Uses the service-role client to bypass RLS.
 */
async function updateInboxTokens(
  inboxId: string,
  encryptedAccessToken: string,
  newExpiresAt: string
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from('inboxes')
    .update({
      oauth_access_token: encryptedAccessToken,
      oauth_token_expires_at: newExpiresAt,
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', inboxId);

  if (error) {
    throw new Error(`Failed to update tokens for inbox ${inboxId}: ${error.message}`);
  }
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Exchanges a Google authorization code for access and refresh tokens.
 *
 * Returns the access token, refresh token, expiry (seconds), and the
 * authenticated user's email address extracted from the id_token.
 *
 * Throws on any non-200 response from Google's token endpoint.
 */
export async function exchangeGmailCode(
  code: string,
  redirectUri: string
): Promise<GmailTokens> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set. ' +
        'See Documents/Human-Input/ for setup instructions.'
    );
  }

  const response = await fetch(GMAIL_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const body = (await response.json()) as { error?: string; error_description?: string };
    throw new Error(
      `Gmail token exchange failed: ${body.error_description ?? body.error ?? response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token: string;
    token_type: string;
  };

  if (!data.access_token) {
    throw new Error('Gmail token exchange: missing access_token in response');
  }
  if (!data.refresh_token) {
    // This happens when access_type=offline is missing or prompt=consent was
    // not passed. The initiation route always sets both, so this is unexpected.
    throw new Error(
      'Gmail token exchange: no refresh_token returned. ' +
        'Ensure access_type=offline and prompt=consent are set in the auth URL.'
    );
  }
  if (!data.id_token) {
    throw new Error('Gmail token exchange: missing id_token, cannot determine user email');
  }

  const payload = decodeJwtPayload(data.id_token);
  const email = payload['email'];
  if (typeof email !== 'string' || !email) {
    throw new Error('Gmail token exchange: email claim missing from id_token');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email,
  };
}

/**
 * Calls Google's token endpoint with a refresh token to obtain a new
 * access token.
 *
 * Does NOT update the database; callers are responsible for persisting
 * the result via `updateInboxTokens`.
 *
 * Throws an `InboxAuthError` with code `REFRESH_TOKEN_INVALID` if Google
 * returns `invalid_grant` (meaning the refresh token has been revoked or
 * expired and the user must reconnect).
 */
export async function refreshGmailAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set.'
    );
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
    const body = (await response.json()) as { error?: string; error_description?: string };
    // invalid_grant means the refresh token was revoked or has expired.
    // This requires user action (reconnecting the inbox).
    if (body.error === 'invalid_grant') {
      throw new InboxAuthError('REFRESH_TOKEN_INVALID', '');
    }
    throw new Error(
      `Gmail token refresh failed: ${body.error_description ?? body.error ?? response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error('Gmail token refresh: missing access_token in response');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a fresh, plaintext Gmail access token for the given inbox.
 *
 * Proactive refresh check: if the current token expires within 5 minutes
 * (or is already expired), a new access token is obtained via the stored
 * refresh token, the new token is encrypted and written back to the
 * database, and the new plaintext token is returned.
 *
 * Call this function at the start of every Gmail API call. Never cache
 * the returned access token across requests.
 *
 * @throws {InboxAuthError} code='MISSING_TOKENS':  inbox has no stored tokens.
 * @throws {InboxAuthError} code='REFRESH_TOKEN_INVALID': refresh token is revoked;
 *   the user must reconnect the inbox. The inbox is automatically marked as errored.
 * @throws {Error} on unexpected token refresh failures or database write errors.
 */
export async function withFreshGmailToken(
  inbox: Tables<'inboxes'>
): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new InboxAuthError('MISSING_TOKENS', inbox.id);
  }

  const now = new Date();
  const expiresAt = inbox.oauth_token_expires_at
    ? new Date(inbox.oauth_token_expires_at)
    : new Date(0); // treat missing expiry as already expired

  const refreshThreshold = new Date(now.getTime() + REFRESH_THRESHOLD_MS);

  if (expiresAt > refreshThreshold) {
    // Token is fresh; decrypt and return without a network call.
    return decryptToken(inbox.oauth_access_token);
  }

  // Token is expiring within 5 minutes (or already expired); refresh it.
  const refreshToken = decryptToken(inbox.oauth_refresh_token);

  let refreshResult: { accessToken: string; expiresIn: number };
  try {
    refreshResult = await refreshGmailAccessToken(refreshToken);
  } catch (err) {
    if (err instanceof InboxAuthError && err.code === 'REFRESH_TOKEN_INVALID') {
      // Stamp the real inbox ID onto the error, then persist the errored state.
      const typedErr = new InboxAuthError('REFRESH_TOKEN_INVALID', inbox.id);
      await markInboxErrored(
        inbox.id,
        'Refresh token expired or revoked. Please reconnect this inbox.'
      );
      throw typedErr;
    }
    throw err;
  }

  const newExpiresAt = new Date(
    now.getTime() + refreshResult.expiresIn * 1000
  ).toISOString();

  const encryptedAccessToken = encryptToken(refreshResult.accessToken);
  await updateInboxTokens(inbox.id, encryptedAccessToken, newExpiresAt);

  return refreshResult.accessToken;
}

/**
 * Lightweight live check that the access token still grants Gmail access.
 *
 * Returns true when the provider accepts the token, false when it rejects it
 * (401/403, the user must reconnect). A non-auth failure (network, 5xx) is
 * thrown so the caller can treat the result as inconclusive rather than
 * marking an otherwise-healthy inbox as broken.
 */
export async function verifyGmailAccess(accessToken: string): Promise<boolean> {
  const response = await fetch(GMAIL_PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) {
    throw new Error(
      `Gmail profile check failed: ${response.status} ${response.statusText}`
    );
  }
  return true;
}
