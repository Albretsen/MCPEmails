/**
 * Outlook (Microsoft) OAuth 2.0 helpers.
 *
 * Handles authorization code exchange and token refresh with Microsoft's
 * Identity Platform v2.0 endpoint. The authority comes from OUTLOOK_TENANT_ID
 * (default "common", which accepts both personal Microsoft accounts and
 * work/school accounts); see `outlookTenant` in outlook-oauth.ts.
 *
 * All credentials (access/refresh tokens) are decrypted only inside
 * server-side code and are NEVER logged or forwarded to clients.
 *
 * References:
 *   https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 *   Documents/Architecture/email-provider-oauth-flows.md §3, §7
 */

import { encryptToken, decryptToken } from '@/lib/crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Tables } from '@/types/database.types';
import {
  OUTLOOK_SCOPES,
  classifyOutlookProbe,
  outlookTokenEndpoint,
  selectOutlookEmail,
  type OutlookProbeResult,
} from '@/lib/email-providers/outlook-oauth';

/**
 * Live-check probe. It must be covered by the scopes we actually hold:
 * GET /me needs User.Read, which is NOT requested, so it would 403 on every
 * healthy inbox. Reading the Inbox folder's id needs only Mail.ReadWrite.
 */
const OUTLOOK_PROBE_ENDPOINT =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id';

/** The 5-minute proactive refresh window in milliseconds. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OutlookTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
  /** Space-separated scopes Microsoft actually granted, when it says. */
  scope: string | null;
}

/**
 * Thrown by `exchangeOutlookCode` when the id_token carries no usable mailbox
 * address. Distinct from a token-exchange failure so the callback can tell the
 * user what actually went wrong instead of saving an inbox with no address.
 */
export class OutlookEmailMissingError extends Error {
  constructor() {
    super('Outlook token exchange: no usable email address in the id_token');
    this.name = 'OutlookEmailMissingError';
  }
}

/** Result of a refresh-token grant. Microsoft rotates the refresh token. */
export interface OutlookRefreshResult {
  accessToken: string;
  expiresIn: number;
  /**
   * The NEW refresh token Microsoft returned, or null if it returned none.
   * Microsoft issues a fresh one on (almost) every refresh; it has to be
   * persisted, because that is what keeps the 90-day sliding window alive.
   */
  refreshToken: string | null;
}

/**
 * Thrown when an inbox's OAuth credentials can no longer be refreshed.
 *
 * The MCP server should catch this error and return a structured error
 * response instructing the user to reconnect the inbox.
 *
 * Microsoft-specific codes:
 *  - REFRESH_TOKEN_INVALID: invalid_grant or interaction_required
 *  - MISSING_TOKENS: the inbox row has no stored tokens at all
 */
export class OutlookAuthError extends Error {
  public readonly code:
    | 'REFRESH_TOKEN_INVALID'
    | 'MISSING_TOKENS'
    | 'INTERACTION_REQUIRED';
  public readonly inboxId: string;

  constructor(
    code: 'REFRESH_TOKEN_INVALID' | 'MISSING_TOKENS' | 'INTERACTION_REQUIRED',
    inboxId: string
  ) {
    const messages: Record<typeof code, string> = {
      REFRESH_TOKEN_INVALID:
        'Outlook refresh token is invalid or revoked. Please reconnect the inbox.',
      MISSING_TOKENS:
        'Inbox is missing OAuth tokens. Please reconnect the inbox.',
      INTERACTION_REQUIRED:
        'Your organization requires interactive sign-in (e.g. MFA). Please reconnect the inbox.',
    };
    super(messages[code]);
    this.name = 'OutlookAuthError';
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
 * Uses the service-role client to bypass RLS; called from background
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
    // Log the failure but don't throw; caller already has an error to handle.
    console.error(
      `[outlook] Failed to mark inbox ${inboxId} as errored:`,
      error.message
    );
  }
}

/**
 * The inbox columns to write after a successful refresh.
 *
 * The rotated refresh token is written whenever Microsoft returned one,
 * encrypted exactly like the callback encrypts the original. Dropping it (as
 * this code used to) leaves the ORIGINAL refresh token in the row, which
 * silently dies 90 days after connect however active the inbox is.
 */
export function buildRefreshedTokenUpdate(
  result: OutlookRefreshResult,
  now: Date = new Date(),
  encrypt: (plaintext: string) => string = encryptToken
): {
  oauth_access_token: string;
  oauth_refresh_token?: string;
  oauth_token_expires_at: string;
  last_sync_at: string;
  updated_at: string;
} {
  const nowIso = now.toISOString();
  return {
    oauth_access_token: encrypt(result.accessToken),
    ...(result.refreshToken ? { oauth_refresh_token: encrypt(result.refreshToken) } : {}),
    oauth_token_expires_at: new Date(now.getTime() + result.expiresIn * 1000).toISOString(),
    last_sync_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Persists refreshed tokens (access, rotated refresh, expiry) to the database.
 *
 * Uses the service-role client to bypass RLS.
 */
async function updateInboxTokens(
  inboxId: string,
  update: ReturnType<typeof buildRefreshedTokenUpdate>
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from('inboxes')
    .update(update)
    .eq('id', inboxId);

  if (error) {
    throw new Error(
      `Failed to update tokens for inbox ${inboxId}: ${error.message}`
    );
  }
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Exchanges a Microsoft authorization code for access and refresh tokens.
 *
 * Returns the access token, refresh token, expiry (seconds), and the
 * authenticated user's mailbox address extracted from the id_token (see
 * `selectOutlookEmail`: the `email` claim first, the UPN only as a fallback).
 *
 * Throws on any non-200 response from Microsoft's token endpoint, and
 * `OutlookEmailMissingError` when no usable address is in the id_token.
 */
export async function exchangeOutlookCode(
  code: string,
  redirectUri: string
): Promise<OutlookTokens> {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET must be set. ' +
        'See Documents/Human-Input/ for setup instructions.'
    );
  }

  const response = await fetch(outlookTokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    throw new Error(
      `Outlook token exchange failed: ${body.error_description ?? body.error ?? response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token: string;
    token_type: string;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error('Outlook token exchange: missing access_token in response');
  }
  if (!data.refresh_token) {
    // offline_access scope is required for a refresh token. This should not
    // happen because the initiation route always requests it.
    throw new Error(
      'Outlook token exchange: no refresh_token returned. ' +
        'Ensure offline_access is included in the authorization scope.'
    );
  }
  if (!data.id_token) {
    throw new Error(
      'Outlook token exchange: missing id_token, cannot determine user email'
    );
  }

  const email = selectOutlookEmail(decodeJwtPayload(data.id_token));
  if (!email) {
    throw new OutlookEmailMissingError();
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    email,
    scope: typeof data.scope === 'string' && data.scope ? data.scope : null,
  };
}

/**
 * Calls Microsoft's token endpoint with a refresh token to obtain a new
 * access token and (normally) a rotated refresh token.
 *
 * Does NOT update the database; callers are responsible for persisting
 * the result, including `refreshToken` when it is non-null (see
 * `buildRefreshedTokenUpdate`).
 *
 * Throws an `OutlookAuthError` with the appropriate code when:
 *  - `invalid_grant`: refresh token revoked or expired (user must reconnect)
 *  - `interaction_required`: org policy requires interactive sign-in (MFA etc.)
 */
export async function refreshOutlookAccessToken(
  refreshToken: string
): Promise<OutlookRefreshResult> {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET must be set.');
  }

  const response = await fetch(outlookTokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: OUTLOOK_SCOPES.join(' '),
    }),
  });

  if (!response.ok) {
    // A gateway error page is not JSON; that must stay an ordinary (transient)
    // failure, not turn into a SyntaxError that hides the status.
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };

    // invalid_grant: refresh token expired or revoked.
    if (body.error === 'invalid_grant') {
      throw new OutlookAuthError('REFRESH_TOKEN_INVALID', '');
    }

    // interaction_required: org conditional access requires interactive sign-in.
    // This cannot be resolved silently; user must reconnect.
    if (body.error === 'interaction_required') {
      throw new OutlookAuthError('INTERACTION_REQUIRED', '');
    }

    throw new Error(
      `Outlook token refresh failed: ${body.error_description ?? body.error ?? response.statusText}`
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('Outlook token refresh: missing access_token in response');
  }

  return {
    accessToken: data.access_token,
    // Microsoft access tokens last 60-90 minutes; 3600 s if it ever omits it.
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    refreshToken:
      typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : null,
  };
}

/**
 * Returns a fresh, plaintext Outlook access token for the given inbox.
 *
 * Proactive refresh check: if the current token expires within 5 minutes
 * (or is already expired), a new access token is obtained via the stored
 * refresh token, the new token is encrypted and written back to the
 * database, and the new plaintext token is returned.
 *
 * Call this function at the start of every Microsoft Graph API call.
 * Never cache the returned access token across requests.
 *
 * @throws {OutlookAuthError} code='MISSING_TOKENS':        inbox has no stored tokens.
 * @throws {OutlookAuthError} code='REFRESH_TOKEN_INVALID': refresh token is revoked;
 *   the user must reconnect the inbox. The inbox is automatically marked as errored.
 * @throws {OutlookAuthError} code='INTERACTION_REQUIRED':  org policy blocks silent
 *   refresh; user must reconnect. The inbox is automatically marked as errored.
 * @throws {Error} on unexpected refresh failures or database write errors.
 */
export async function withFreshOutlookToken(
  inbox: Tables<'inboxes'>
): Promise<string> {
  if (!inbox.oauth_access_token || !inbox.oauth_refresh_token) {
    throw new OutlookAuthError('MISSING_TOKENS', inbox.id);
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

  let refreshResult: OutlookRefreshResult;
  try {
    refreshResult = await refreshOutlookAccessToken(refreshToken);
  } catch (err) {
    if (err instanceof OutlookAuthError) {
      // Stamp the real inbox ID onto the error, then persist the errored state.
      const reason =
        err.code === 'INTERACTION_REQUIRED'
          ? 'Your organization requires interactive sign-in. Please reconnect this inbox.'
          : 'Refresh token expired or revoked. Please reconnect this inbox.';

      await markInboxErrored(inbox.id, reason);

      // Re-throw with the real inbox ID attached.
      throw new OutlookAuthError(err.code, inbox.id);
    }
    throw err;
  }

  await updateInboxTokens(inbox.id, buildRefreshedTokenUpdate(refreshResult, now));

  return refreshResult.accessToken;
}

/**
 * Lightweight live check that the access token still reads the mailbox.
 *
 * Probes GET /me/mailFolders/inbox?$select=id, which Mail.ReadWrite covers.
 * Returns 'ok', 'unauthorized' (401, reconnect), 'forbidden' (403, access is
 * refused by policy; reconnecting will not help) or 'no_mailbox' (no Exchange
 * Online mailbox behind the account). Anything else (network, 5xx, 429) is
 * thrown so the caller treats the result as inconclusive rather than marking
 * an otherwise-healthy inbox as broken.
 */
export async function verifyOutlookAccess(
  accessToken: string
): Promise<Exclude<OutlookProbeResult, 'inconclusive'>> {
  const response = await fetch(OUTLOOK_PROBE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  let graphErrorCode: string | null = null;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    graphErrorCode = body?.error?.code ?? null;
  }
  const result = classifyOutlookProbe(response.status, graphErrorCode);
  if (result === 'inconclusive') {
    throw new Error(
      `Outlook mailbox check failed: ${response.status} ${response.statusText}`
    );
  }
  return result;
}
