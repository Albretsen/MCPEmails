import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { randomBytes } from 'crypto';

/**
 * GET /auth/gmail
 *
 * Initiates the Gmail OAuth 2.0 flow. Generates a cryptographically random
 * state nonce, persists it in the `oauth_states` table (expires in 10 minutes),
 * and redirects the user to Google's authorization endpoint.
 *
 * Required Google OAuth scopes:
 *   - gmail.readonly  : list and fetch message bodies
 *   - gmail.send      : compose and send new messages
 *   - gmail.modify    : apply/remove labels, move to trash
 *
 * access_type=offline  → Google issues a refresh token
 * prompt=consent       → Forces the consent screen so a refresh token is
 *                        always returned, even for repeat authorizations.
 *
 * References:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   Documents/Architecture/email-provider-oauth-flows.md §2
 */

const GMAIL_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

export async function GET() {
  const supabase = await createClient();

  // Verify the user is authenticated before starting the OAuth flow.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/login?next=/dashboard`
    );
  }

  // Resolve the active workspace for this user (cookie-aware, multi-workspace safe).
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);

  if (!workspaceId) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?error=no_workspace`
    );
  }

  // Note: the plan inbox cap is enforced in the callback, where the email
  // address is known. That lets reconnecting an existing inbox proceed even
  // at the cap while still blocking brand-new connections.

  // Generate a 32-byte cryptographically random state nonce.
  // This ties the callback to this specific authorization request and
  // prevents CSRF attacks on the OAuth callback route.
  const state = randomBytes(32).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/gmail/callback`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Persist the state nonce. The callback handler looks this up and deletes
  // it immediately (single-use) before processing the authorization code.
  const { error: stateError } = await supabase.from('oauth_states').insert({
    workspace_id: workspaceId,
    user_id: user.id,
    provider: 'gmail',
    state,
    redirect_uri: redirectUri,
    expires_at: expiresAt,
  });

  if (stateError) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?error=state_store_failed`
    );
  }

  // Build the Google authorization URL.
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return NextResponse.redirect(`${GMAIL_AUTH_ENDPOINT}?${params.toString()}`);
}
