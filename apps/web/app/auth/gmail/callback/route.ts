import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encryptToken } from '@/lib/crypto';
import { exchangeGmailCode } from '@/lib/email-providers/gmail';

/**
 * GET /auth/gmail/callback
 *
 * Google redirects here after the user approves (or denies) the Gmail
 * permission request. This handler:
 *
 *  1. Handles user denial gracefully.
 *  2. Validates the `state` nonce against the `oauth_states` table
 *     (CSRF protection) and deletes it immediately (single-use).
 *  3. Validates the stored `redirect_uri` by exact string equality.
 *  4. Exchanges the authorization code for access + refresh tokens.
 *  5. AES-256-GCM encrypts the tokens before writing to the database.
 *  6. Upserts the inbox row so reconnection replaces the existing record
 *     without changing the inbox's UUID (preserving activity_log references).
 *  7. Redirects to the Inboxes dashboard page with a success or error flag.
 *
 * Token security:
 *   - Tokens are never logged.
 *   - Encrypted immediately after receipt; only ciphertext touches the DB.
 *   - State nonce is single-use and expires in 10 minutes.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §2
 */

const DASHBOARD_INBOXES = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

function redirectWithError(error: string): NextResponse {
  return NextResponse.redirect(`${DASHBOARD_INBOXES}?error=${error}`);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // 1. Handle user denial — Google sends error=access_denied.
  if (error === 'access_denied') {
    return NextResponse.redirect(`${DASHBOARD_INBOXES}?error=cancelled`);
  }

  // Surface any other OAuth error from Google.
  if (error) {
    return redirectWithError('oauth_error');
  }

  // 2. Both code and state are required.
  if (!code || !state) {
    return redirectWithError('invalid_callback');
  }

  const supabase = await createClient();

  // 3. Look up the state nonce. Filter by provider and check expiry.
  //    The nonce is single-use: we delete it before doing anything else so
  //    a replayed callback cannot succeed even if it arrives before we finish.
  const { data: oauthState, error: stateError } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .eq('provider', 'gmail')
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateError || !oauthState) {
    return redirectWithError('invalid_state');
  }

  // 4. Delete the nonce immediately (single-use).
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);

  // 5. Validate redirect_uri by exact string equality.
  //    This prevents a crafted state from redirecting token exchange to a
  //    different URI.
  const expectedRedirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/gmail/callback`;
  if (oauthState.redirect_uri !== expectedRedirectUri) {
    return redirectWithError('redirect_uri_mismatch');
  }

  // 6. Exchange the authorization code for tokens.
  let tokens: { accessToken: string; refreshToken: string; expiresIn: number; email: string };
  try {
    tokens = await exchangeGmailCode(code, expectedRedirectUri);
  } catch (err) {
    console.error('[gmail/callback] token exchange failed:', err);
    return redirectWithError('token_exchange_failed');
  }

  // 7. Encrypt tokens before they touch the database.
  //    encryptToken returns a base64url string (AES-256-GCM: IV || ciphertext || tag).
  const encryptedAccessToken = encryptToken(tokens.accessToken);
  const encryptedRefreshToken = encryptToken(tokens.refreshToken);
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();

  // 8. Upsert the inbox row.
  //    Using workspace_id + email_address as the conflict target means that:
  //    - A first connection inserts a new row.
  //    - Reconnection (including after an error or revocation) updates the
  //      same row, preserving the inbox UUID and its activity_log references.
  //    - deleted_at is cleared so a previously disconnected inbox comes back.
  const { error: upsertError } = await supabase.from('inboxes').upsert(
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

  // 9. Redirect to the Inboxes page with a success indicator.
  return NextResponse.redirect(`${DASHBOARD_INBOXES}?connected=gmail`);
}
