import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { randomBytes } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { OUTLOOK_SCOPES, shouldForceConsent } from '@/lib/email-providers/outlook-oauth';

/**
 * GET /auth/outlook
 *
 * Initiates the Outlook (Microsoft) OAuth 2.0 flow. Generates a
 * cryptographically random state nonce, persists it in the `oauth_states`
 * table (expires in 10 minutes), and redirects the user to Microsoft's
 * authorization endpoint.
 *
 * Tenant: "common" accepts both personal Microsoft accounts (Outlook.com,
 * Hotmail.com) and work/school accounts (Microsoft 365). The Azure AD app
 * registration must set "Supported account types" to match.
 *
 * Scopes requested:
 *   - Mail.ReadWrite   : list/read messages AND mutate them (mark read, flag,
 *                        move, archive, copy, delete, drafts, folders) via Graph
 *   - Mail.Send        : send messages via Microsoft Graph
 *   - offline_access   : causes Microsoft to issue a refresh token
 *   - openid           : required for OIDC; provides id_token with user info
 *   - profile          : adds display name to id_token
 *   - email            : ensures the email claim is present in id_token
 *
 * Optional query param:
 *   ?inbox=<uuid>  → Reconnect flow. If the id resolves to an inbox in the
 *                    user's active workspace, its email address is passed to
 *                    Microsoft as `login_hint` so the account chooser
 *                    pre-selects the correct account. Used by the deep link the
 *                    MCP server surfaces to agents when an inbox's token fails.
 *
 * References:
 *   https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 *   Documents/Architecture/email-provider-oauth-flows.md §3
 */

const OUTLOOK_AUTH_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

// IMPORTANT: Existing Outlook inboxes connected before the scope widening must
// RECONNECT (re-consent) to receive Mail.ReadWrite: a silent token refresh will
// NOT grant it. The reconnect path sets `prompt=consent` so reconnection
// re-prompts for the new scope. A first connect deliberately does not.
//
// The scope list and both of those decisions live in `outlook-oauth.ts` so they
// can be unit tested; do not re-declare them here.

export async function GET(request: Request): Promise<NextResponse> {
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

  // Optional reconnect hint: if ?inbox=<uuid> resolves to an inbox in this
  // workspace, use its email address as Microsoft's login_hint so the account
  // chooser pre-selects the right account. Best-effort — a missing or
  // mismatched id simply falls back to the normal chooser.
  const inboxId = new URL(request.url).searchParams.get('inbox');
  let loginHint: string | null = null;
  if (inboxId) {
    const { data: inbox } = await supabase
      .from('inboxes')
      .select('email_address')
      .eq('id', inboxId)
      .eq('workspace_id', workspaceId)
      .eq('provider', 'outlook')
      .maybeSingle();
    loginHint = inbox?.email_address ?? null;
  }

  // Generate a 32-byte cryptographically random state nonce.
  // This ties the callback to this specific authorization request and
  // prevents CSRF attacks on the OAuth callback route.
  const state = randomBytes(32).toString('base64url');
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/auth/outlook/callback`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Persist the state nonce. The callback handler looks this up and deletes
  // it immediately (single-use) before processing the authorization code.
  const { error: stateError } = await supabase.from('oauth_states').insert({
    workspace_id: workspaceId,
    user_id: user.id,
    provider: 'outlook',
    state,
    redirect_uri: redirectUri,
    expires_at: expiresAt,
  });

  if (stateError) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?error=state_store_failed`
    );
  }
  await recordProductFunnelEvent(createServiceRoleClient(), { workspaceId, stage: 'inbox_connection', outcome: 'started', category: 'outlook', phase: 'authorization', connectionType: loginHint ? 'reconnect' : 'first_connect' });

  // Build the Microsoft authorization URL.
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OUTLOOK_SCOPES.join(' '),
    response_mode: 'query',
    state,
  });

  // A reconnect is exactly the case where we already know which address we are
  // reattaching, which is why the login hint doubles as the reconnect signal.
  const isReconnect = loginHint !== null;

  if (shouldForceConsent(isReconnect)) {
    params.set('prompt', 'consent');
  }
  if (loginHint) {
    params.set('login_hint', loginHint);
  }

  return NextResponse.redirect(`${OUTLOOK_AUTH_ENDPOINT}?${params.toString()}`);
}
