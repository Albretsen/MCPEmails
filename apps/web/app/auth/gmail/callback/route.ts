import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { encryptToken } from '@/lib/crypto';
import { exchangeGmailCode } from '@/lib/email-providers/gmail';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { captureError } from '@/lib/errors/capture';
import { recordOAuthCallbackFailure, recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { clientGuidePath } from '@/lib/onboarding/state';
import { canManageInboxes, fetchWorkspaceRole, INSUFFICIENT_ROLE_REDIRECT_CODE } from '@/lib/workspace/roles';

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

async function recordDeniedAuthorization(state: string | null): Promise<void> {
  if (!state) return;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data: oauthState } = await supabase.from('oauth_states').select('id,workspace_id,user_id').eq('state', state).eq('provider', 'gmail').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!oauthState || oauthState.user_id !== user.id) return;
  await supabase.from('oauth_states').delete().eq('id', oauthState.id);
  await recordProductFunnelEvent(createServiceRoleClient(), { workspaceId: oauthState.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: 'gmail', errorCategory: 'provider_denied' });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const serviceClientForFailure = createServiceRoleClient();

  // 1. Handle user denial: Google sends error=access_denied.
  if (error === 'access_denied') {
    await recordOAuthCallbackFailure(serviceClientForFailure, state, 'gmail', 'provider_denied');
    await recordDeniedAuthorization(state);
    return NextResponse.redirect(`${DASHBOARD_INBOXES}?error=cancelled`);
  }

  // Surface any other OAuth error from Google.
  if (error) {
    await recordOAuthCallbackFailure(serviceClientForFailure, state, 'gmail', 'unknown');
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

  // 6b. Membership is not permission. Everything above proves the callback came
  //     from the same authenticated browser that started the flow; none of it
  //     says the caller may attach a mailbox to `oauthState.workspace_id`. A
  //     workspace VIEWER is read-only, and connecting a mailbox hands every
  //     other member of that workspace a live credential through the MCP
  //     server. Refused here, BEFORE the code is exchanged, so no tokens are
  //     ever minted for a connection that will not be made.
  //
  //     This surface answers with a redirect rather than JSON, so the refusal
  //     follows the file's existing convention (redirectWithError) instead of
  //     inventing a second one. The dashboard falls back to its generic
  //     connection-failed toast for a code it does not recognise, and a
  //     dedicated string is wired up for this one.
  const callerRole = await fetchWorkspaceRole(supabase, oauthState.workspace_id, user.id);
  if (!canManageInboxes(callerRole)) {
    // Deliberately NOT recorded as a funnel failure. product_funnel_events
    // constrains error_category to a fixed list that has no value for this,
    // and folding a refused viewer into an existing one would count an
    // authorization refusal as a connection attempt that went wrong. Same
    // reasoning as the SSRF host guard on the generic IMAP route: a request
    // we decline up front should leave no trace that reads as real demand.
    return redirectWithError(INSUFFICIENT_ROLE_REDIRECT_CODE);
  }

  // 7. Exchange the authorization code for tokens.
  let tokens: { accessToken: string; refreshToken: string; expiresIn: number; email: string };
  try {
    tokens = await exchangeGmailCode(code, expectedRedirectUri);
  } catch (err) {
    console.error('[gmail/callback] token exchange failed:', err);
    // Recorded so the activation-funnel drop-off at this step is measurable
    // (this table previously had zero writes anywhere in the codebase).
    await captureError(err, {
      severity: 'medium',
      route: 'auth/gmail/callback',
      reason: 'token_exchange_failed',
      workspaceId: oauthState.workspace_id,
      userId: user.id,
    });
    await recordProductFunnelEvent(createServiceRoleClient(), { workspaceId: oauthState.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: 'gmail', errorCategory: 'token_exchange_failed', phase: 'token_exchange' });
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
      await recordProductFunnelEvent(createServiceRoleClient(), { workspaceId: oauthState.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: 'gmail', errorCategory: 'plan_limit', phase: 'persistence', connectionType: 'first_connect' });
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
        'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic',
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
    await captureError(new Error(upsertError.message), {
      severity: 'high',
      route: 'auth/gmail/callback',
      reason: 'inbox_upsert_failed',
      workspaceId: oauthState.workspace_id,
      userId: user.id,
    });
    await recordProductFunnelEvent(serviceClient, { workspaceId: oauthState.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: 'gmail', errorCategory: 'persistence_failed', phase: 'persistence', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
    return redirectWithError('save_failed');
  }

  // 9. Redirect to the Inboxes page with a success indicator.
  await recordProductFunnelEvent(serviceClient, { workspaceId: oauthState.workspace_id, stage: 'inbox_connection', outcome: 'success', category: 'gmail', phase: 'complete', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  const { data: onboarding } = await serviceClient.from('workspaces').select('onboarding_client').eq('id', oauthState.workspace_id).maybeSingle();
  const guide = new URL(clientGuidePath(onboarding?.onboarding_client), DASHBOARD_INBOXES);
  guide.searchParams.set('connected', 'gmail');
  return NextResponse.redirect(guide.toString());
}
