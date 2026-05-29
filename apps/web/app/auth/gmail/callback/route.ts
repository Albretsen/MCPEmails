import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { encryptToken } from '@/lib/crypto';
import { exchangeGmailCode } from '@/lib/email-providers/gmail';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';

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

  // 1. Handle user denial: Google sends error=access_denied.
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

  // 3. Verify the user still has an active session. The OAuth callback must
  //    come from the same authenticated browser that initiated the flow.
  //    RLS on oauth_states already enforces user_id = auth.uid(), but this
  //    explicit check makes the contract readable and returns a clear error
  //    rather than a generic invalid_state when the session has expired.
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
    .eq('provider', 'gmail')
    .gt('expires_at', new Date().toISOString())
    .single();

  if (stateError || !oauthState) {
    return redirectWithError('invalid_state');
  }

  // Verify the state row belongs to the currently authenticated user.
  // Guards against a stolen state value being replayed from a different session.
  if (oauthState.user_id !== user.id) {
    return redirectWithError('session_mismatch');
  }

  // 5. Delete the nonce immediately (single-use).
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);

  // 6. Validate redirect_uri by exact string equality.
  //    This prevents a crafted state from redirecting token exchange to a
  //    different URI.
  const expectedRedirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/gmail/callback`;
  if (oauthState.redirect_uri !== expectedRedirectUri) {
    return redirectWithError('redirect_uri_mismatch');
  }

  // 7. Exchange the authorization code for tokens.
  let tokens: { accessToken: string; refreshToken: string; expiresIn: number; email: string };
  try {
    tokens = await exchangeGmailCode(code, expectedRedirectUri);
  } catch (err) {
    console.error('[gmail/callback] token exchange failed:', err);
    return redirectWithError('token_exchange_failed');
  }

  // 8. Enforce the plan inbox cap, but only for a brand-new address. A
  //    reconnect (the email already has a non-deleted inbox) reuses the
  //    existing row via upsert, so it must be allowed even at the cap.
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

  // 9. Encrypt tokens before they touch the database.
  //    encryptToken returns a base64url string (AES-256-GCM: IV || ciphertext || tag).
  const encryptedAccessToken = encryptToken(tokens.accessToken);
  const encryptedRefreshToken = encryptToken(tokens.refreshToken);
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();

  // 9. Upsert the inbox row.
  //    Using workspace_id + email_address as the conflict target means that:
  //    - A first connection inserts a new row.
  //    - Reconnection (including after an error or revocation) updates the
  //      same row, preserving the inbox UUID and its activity_log references.
  //    - deleted_at is cleared so a previously disconnected inbox comes back.
  //
  //    This write uses the service-role client: reconnecting a previously
  //    disconnected inbox means the ON CONFLICT path must UPDATE a soft-deleted
  //    row (deleted_at IS NOT NULL), but the inboxes SELECT/UPDATE RLS policies
  //    hide such rows, so the user-scoped client would fail with save_failed.
  //    Safe here because the user, oauth_state ownership, and workspace have
  //    already been validated above; the write is scoped to workspace_id + email.
  const serviceClient = createServiceRoleClient();
  const { error: upsertError } = await serviceClient.from('inboxes').upsert(
    {
      workspace_id: oauthState.workspace_id,
      provider: 'gmail',
      email_address: tokens.email,
      oauth_access_token: encryptedAccessToken,
      oauth_refresh_token: encryptedRefreshToken,
      oauth_token_expires_at: tokenExpiresAt,
      oauth_scope:
        'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify',
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
    console.error('[gmail/callback] inbox upsert failed:', upsertError);
    return redirectWithError('save_failed');
  }

  // 9. Redirect to the Inboxes page with a success indicator.
  return NextResponse.redirect(`${DASHBOARD_INBOXES}?connected=gmail`);
}
