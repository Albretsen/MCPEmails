import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encryptToken } from '@/lib/crypto';
import { exchangeFastmailCode } from '@/lib/email-providers/fastmail';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';

/**
 * GET /auth/fastmail/callback
 *
 * Fastmail redirects here after the user approves (or denies) the OAuth
 * permission request. This handler:
 *
 *  1. Handles user denial gracefully.
 *  2. Validates the `state` nonce against the `oauth_states` table
 *     (CSRF protection) and deletes it immediately (single-use).
 *  3. Validates the stored `redirect_uri` by exact string equality.
 *  4. Exchanges the authorization code for access + refresh tokens.
 *  5. Resolves the user's email address via the Fastmail JMAP session endpoint
 *     (Fastmail does not include an id_token in its token response).
 *  6. AES-256-GCM encrypts the tokens before writing to the database.
 *  7. Upserts the inbox row so reconnection replaces the existing record
 *     without changing the inbox's UUID (preserving activity_log references).
 *  8. Sets oauth_token_expires_at to now + 365 days to reflect Fastmail's
 *     1-year access token lifetime.
 *  9. Redirects to the Inboxes dashboard page with a success or error flag.
 *
 * Token security:
 *   - Tokens are never logged.
 *   - Encrypted immediately after receipt; only ciphertext touches the DB.
 *   - State nonce is single-use and expires in 10 minutes.
 *
 * References:
 *   https://www.fastmail.com/dev/oauth
 *   Documents/Architecture/email-provider-oauth-flows.md §4
 */

const DASHBOARD_INBOXES = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

/** Fastmail access tokens are valid for 1 year (365 days in seconds). */
const FASTMAIL_ACCESS_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

function redirectWithError(error: string): NextResponse {
  return NextResponse.redirect(`${DASHBOARD_INBOXES}?error=${error}`);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // 1. Handle user denial — Fastmail sends error=access_denied.
  if (error === 'access_denied') {
    return NextResponse.redirect(`${DASHBOARD_INBOXES}?error=cancelled`);
  }

  // Surface any other OAuth error from Fastmail.
  if (error) {
    return redirectWithError('oauth_error');
  }

  // 2. Both code and state are required.
  if (!code || !state) {
    return redirectWithError('invalid_callback');
  }

  const supabase = await createClient();

  // 3. Verify the user still has an active session. The OAuth callback must
  //    come from the same authenticated browser that initiated the flow.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return redirectWithError('session_expired');
  }

  // 4. Look up the state nonce. Filter by provider and check expiry.
  //    The nonce is single-use: we delete it before doing anything else so
  //    a replayed callback cannot succeed even if it arrives before we finish.
  const { data: oauthState, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .eq('provider', 'fastmail')
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateError || !oauthState) {
    return redirectWithError('invalid_state');
  }

  // Verify the state row belongs to the currently authenticated user.
  if (oauthState.user_id !== user.id) {
    return redirectWithError('session_mismatch');
  }

  // 4. Delete the nonce immediately (single-use).
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);

  // 5. Validate redirect_uri by exact string equality.
  //    This prevents a crafted state from redirecting token exchange to a
  //    different URI.
  const expectedRedirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/fastmail/callback`;
  if (oauthState.redirect_uri !== expectedRedirectUri) {
    return redirectWithError('redirect_uri_mismatch');
  }

  // 6. Exchange the authorization code for tokens and resolve the email address
  //    via the JMAP session endpoint (Fastmail does not issue an id_token).
  let tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    email: string;
  };
  try {
    tokens = await exchangeFastmailCode(code, expectedRedirectUri);
  } catch (err) {
    console.error('[fastmail/callback] token exchange failed:', err);
    return redirectWithError('token_exchange_failed');
  }

  // 6b. Enforce the plan inbox cap — but only for a brand-new address. A
  //     reconnect (the email already has a non-deleted inbox) reuses the
  //     existing row via upsert, so it must be allowed even at the cap.
  const alreadyConnected = await inboxExistsForEmail(
    supabase,
    oauthState.workspace_id,
    tokens.email
  );
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, oauthState.workspace_id);
    if (inboxLimit.atLimit) {
      return redirectWithError('inbox_limit_reached');
    }
  }

  // 7. Encrypt tokens before they touch the database.
  //    encryptToken returns a base64url string (AES-256-GCM: IV || ciphertext || tag).
  const encryptedAccessToken = encryptToken(tokens.accessToken);
  const encryptedRefreshToken = encryptToken(tokens.refreshToken);

  // 8. Fastmail tokens are valid for 1 year. If the token endpoint returns a
  //    valid expires_in, honour it; otherwise fall back to 365 days.
  const expiresInSeconds =
    typeof tokens.expiresIn === 'number' && tokens.expiresIn > 0
      ? tokens.expiresIn
      : FASTMAIL_ACCESS_TOKEN_LIFETIME_SECONDS;

  const tokenExpiresAt = new Date(
    Date.now() + expiresInSeconds * 1000
  ).toISOString();

  // 9. Upsert the inbox row.
  //    Using workspace_id + email_address as the conflict target means that:
  //    - A first connection inserts a new row.
  //    - Reconnection (including after an error or revocation) updates the
  //      same row, preserving the inbox UUID and its activity_log references.
  //    - deleted_at is cleared so a previously disconnected inbox comes back.
  const { error: upsertError } = await supabase.from('inboxes').upsert(
    {
      workspace_id: oauthState.workspace_id,
      provider: 'fastmail',
      email_address: tokens.email,
      oauth_access_token: encryptedAccessToken,
      oauth_refresh_token: encryptedRefreshToken,
      oauth_token_expires_at: tokenExpiresAt,
      oauth_scope:
        'https://www.fastmail.com/dev/protocol-email offline_access',
      status: 'active',
      last_error: null,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'workspace_id, email_address',
      ignoreDuplicates: false,
    }
  );

  if (upsertError) {
    return redirectWithError('save_failed');
  }

  // 10. Redirect to the Inboxes page with a success indicator.
  return NextResponse.redirect(`${DASHBOARD_INBOXES}?connected=fastmail`);
}
