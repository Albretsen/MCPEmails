/**
 * Fastmail OAuth 2.0 / JMAP helpers.
 *
 * Handles authorization code exchange and token refresh with Fastmail's
 * OAuth token endpoint. Unlike Gmail and Outlook, Fastmail does not include
 * an id_token in its token response — the user's email address is resolved by
 * calling the JMAP session endpoint immediately after token exchange.
 *
 * Token lifetimes:
 *   - Access token:  1 year (365 days)
 *   - Refresh token: does not expire (valid until user revokes in Fastmail settings)
 *
 * All credentials (access/refresh tokens) are decrypted only inside
 * server-side code and are NEVER logged or forwarded to clients.
 *
 * References:
 *   https://www.fastmail.com/dev/oauth
 *   Documents/Architecture/email-provider-oauth-flows.md §4, §7
 */

import { encryptToken, decryptToken } from '@/lib/crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Tables } from '@/types/database.types';

const FASTMAIL_TOKEN_ENDPOINT = 'https://www.fastmail.com/oauth/token';
const FASTMAIL_JMAP_SESSION_ENDPOINT = 'https://api.fastmail.com/jmap/session';

/** The 5-minute proactive refresh window in milliseconds. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FastmailTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. Fastmail issues ~1-year tokens. */
  expiresIn: number;
  /** The primary email address of the authenticated account. */
  email: string;
}

/**
 * Thrown when a Fastmail inbox's OAuth credentials can no longer be used.
 *
 * The MCP server should catch this error and return a structured error
 * response instructing the user to reconnect the inbox.
 *
 * Fastmail-specific notes:
 *  - REFRESH_TOKEN_INVALID: HTTP 401 on the token endpoint during refresh
 *  - MISSING_TOKENS: the inbox row has no stored tokens at all
 */
export class FastmailAuthError extends Error {
  public readonly code: 'REFRESH_TOKEN_INVALID' | 'MISSING_TOKENS';
  public readonly inboxId: string;

  constructor(
    code: 'REFRESH_TOKEN_INVALID' | 'MISSING_TOKENS',
    inboxId: string
  ) {
    const messages: Record<typeof code, string> = {
      REFRESH_TOKEN_INVALID:
        'Fastmail refresh token is invalid or revoked — user must reconnect the inbox.',
      MISSING_TOKENS:
        'Inbox is missing OAuth tokens — user must reconnect the inbox.',
    };
    super(messages[code]);
    this.name = 'FastmailAuthError';
    this.code = code;
    this.inboxId = inboxId;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Marks an inbox as errored, storing a human-readable reason in `last_error`.
 *
 * Uses the service-role client to bypass RLS — called from a background
 * job context where there is no authenticated user session.
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
    // Log the failure but don't throw — caller already has an error to handle.
    console.error(
      `[fastmail] Failed to mark inbox ${inboxId} as errored:`,
      error.message
    );
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
    throw new Error(
      `Failed to update tokens for inbox ${inboxId}: ${error.message}`
    );
  }
}

/**
 * Fetches the primary email address of the authenticated Fastmail account
 * by calling the JMAP session endpoint with the given access token.
 *
 * Fastmail's token response does not include an id_token, so this is the
 * canonical way to determine which account was just authorized.
 *
 * The JMAP session object's `primaryAccounts` property is a map from
 * account ID to capability URLs. The keys of that map are the account IDs,
 * which for Fastmail are the user's primary email addresses.
 *
 * Throws if the session endpoint returns a non-200 response or if no
 * account ID can be extracted.
 */
async function resolveEmailFromJmapSession(accessToken: string): Promise<string> {
  const response = await fetch(FASTMAIL_JMAP_SESSION_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      `Fastmail JMAP session fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const session = (await response.json()) as {
    primaryAccounts?: Record<string, string>;
    username?: string;
  };

  // `primaryAccounts` keys are account IDs (email addresses) in Fastmail's JMAP.
  if (session.primaryAccounts) {
    const accountIds = Object.keys(session.primaryAccounts);
    if (accountIds.length > 0 && accountIds[0]) {
      return accountIds[0];
    }
  }

  // Fall back to `username` if primaryAccounts is absent or empty.
  if (session.username) {
    return session.username;
  }

  throw new Error(
    'Fastmail JMAP session: could not determine primary email address — ' +
      'neither primaryAccounts nor username found in session response'
  );
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Exchanges a Fastmail authorization code for access and refresh tokens,
 * then resolves the user's email address via the JMAP session endpoint.
 *
 * Returns the access token, refresh token, expiry (seconds), and the
 * authenticated user's email address.
 *
 * Throws on any non-200 response from Fastmail's token endpoint or if
 * the JMAP session call fails.
 */
export async function exchangeFastmailCode(
  code: string,
  redirectUri: string
): Promise<FastmailTokens> {
  const clientId = process.env.FASTMAIL_CLIENT_ID;
  const clientSecret = process.env.FASTMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'FASTMAIL_CLIENT_ID and FASTMAIL_CLIENT_SECRET must be set. ' +
        'See Documents/Human-Input/ for setup instructions.'
    );
  }

  const response = await fetch(FASTMAIL_TOKEN_ENDPOINT, {
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
    const body = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    throw new Error(
      `Fastmail token exchange failed: ${body.error_description ?? body.error ?? response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  if (!data.access_token) {
    throw new Error('Fastmail token exchange: missing access_token in response');
  }
  if (!data.refresh_token) {
    // offline_access scope is required for a refresh token.
    throw new Error(
      'Fastmail token exchange: no refresh_token returned. ' +
        'Ensure offline_access is included in the authorization scope.'
    );
  }

  // Fastmail does not include an id_token. Resolve the email via JMAP session.
  const email = await resolveEmailFromJmapSession(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email,
  };
}

/**
 * Calls Fastmail's token endpoint with a refresh token to obtain a new
 * access token.
 *
 * Does NOT update the database — callers are responsible for persisting
 * the result via `updateInboxTokens`.
 *
 * Fastmail uses HTTP 401 (rather than a JSON error body with `invalid_grant`)
 * to indicate that the refresh token is no longer valid. Any 4xx/5xx response
 * from the token endpoint during refresh is treated as a token invalidation
 * and raises a `FastmailAuthError` with code `REFRESH_TOKEN_INVALID`.
 */
export async function refreshFastmailAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.FASTMAIL_CLIENT_ID;
  const clientSecret = process.env.FASTMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('FASTMAIL_CLIENT_ID and FASTMAIL_CLIENT_SECRET must be set.');
  }

  const response = await fetch(FASTMAIL_TOKEN_ENDPOINT, {
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
    // Fastmail signals token invalidation via HTTP 401; treat any non-200 as
    // a revoked token requiring the user to reconnect.
    throw new FastmailAuthError('REFRESH_TOKEN_INVALID', '');
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error('Fastmail token refresh: missing access_token in response');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Returns a fresh, plaintext Fastmail access token for the given inbox.
 *
 * Proactive refresh check: if the current token expires within 5 minutes
 * (or is already expired), a new access token is obtained via the stored
 * refresh token, the new token is encrypted and written back to the
 * database, and the new plaintext token is returned.
 *
 * In practice, Fastmail's access tokens last 1 year, so this function
 * will almost always return the stored token without a network call. The
 * refresh path is maintained for correctness and to handle future Fastmail
 * policy changes.
 *
 * Call this function at the start of every Fastmail JMAP API call.
 * Never cache the returned access token across requests.
 *
 * @throws {FastmailAuthError} code='MISSING_TOKENS'        — inbox has no stored tokens.
 * @throws {FastmailAuthError} code='REFRESH_TOKEN_INVALID' — refresh token is revoked;
 *   the user must reconnect the inbox. The inbox is automatically marked as errored.
 * @throws {Error} on unexpected refresh failures or database write errors.
 */
export async function withFreshFastmailToken(
  inbox: Tables<'inboxes'>
): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new FastmailAuthError('MISSING_TOKENS', inbox.id);
  }

  const now = new Date();
  const expiresAt = inbox.oauth_token_expires_at
    ? new Date(inbox.oauth_token_expires_at)
    : new Date(0); // treat missing expiry as already expired

  const refreshThreshold = new Date(now.getTime() + REFRESH_THRESHOLD_MS);

  if (expiresAt > refreshThreshold) {
    // Token is fresh — decrypt and return without a network call.
    return decryptToken(inbox.oauth_access_token);
  }

  // Token is expiring within 5 minutes (or already expired) — refresh it.
  const storedRefreshToken = decryptToken(inbox.oauth_refresh_token);

  let refreshResult: { accessToken: string; expiresIn: number };
  try {
    refreshResult = await refreshFastmailAccessToken(storedRefreshToken);
  } catch (err) {
    if (err instanceof FastmailAuthError && err.code === 'REFRESH_TOKEN_INVALID') {
      // Stamp the real inbox ID onto the error, then persist the errored state.
      const typedErr = new FastmailAuthError('REFRESH_TOKEN_INVALID', inbox.id);
      await markInboxErrored(
        inbox.id,
        'Refresh token expired or revoked — user must reconnect this inbox.'
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
 * Lightweight live check that the access token still grants Fastmail access.
 *
 * Returns true when the JMAP session endpoint accepts the token, false when it
 * rejects it (401/403 — the user must reconnect). A non-auth failure (network,
 * 5xx) is thrown so the caller can treat the result as inconclusive rather than
 * marking an otherwise-healthy inbox as broken.
 */
export async function verifyFastmailAccess(accessToken: string): Promise<boolean> {
  const response = await fetch(FASTMAIL_JMAP_SESSION_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) {
    throw new Error(
      `Fastmail session check failed: ${response.status} ${response.statusText}`
    );
  }
  return true;
}
