import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import {
  ADMIN_CONSENT_STATE_PREFIX,
  outlookAdminConsentEndpoint,
} from '@/lib/email-providers/outlook-oauth';
import {
  ADMIN_CONSENT_STATE_COOKIE,
  ADMIN_CONSENT_STATE_TTL_SECONDS,
  adminConsentLinkKey,
  adminConsentLinkUrl,
  adminConsentResultUrl,
  mintAdminConsentLinkToken,
  verifyAdminConsentLinkToken,
} from '@/lib/email-providers/outlook-admin-link';

/**
 * GET /auth/outlook/admin-consent?t=<token>
 *
 * PUBLIC. This is the link an employee copies from the dashboard and sends to
 * their IT administrator, who usually has no MCP Emails account. The `t`
 * token (lib/email-providers/outlook-admin-link.ts) is an HMAC-signed,
 * seven-day capability naming the inviting workspace and user; no session is
 * needed to use it. Opening it mints a fresh 10-minute state and sends the
 * browser to Microsoft. A bad or expired token lands on the public result
 * page, never on /login.
 *
 * Without `t` (an old bookmark, or a signed-in user following the plain URL),
 * a signed-in user is given a freshly minted link and redirected through it;
 * anyone else is sent to /login as before.
 *
 * Sends a Microsoft 365 tenant administrator to Microsoft's admin consent
 * endpoint, which grants this app's delegated mail permissions once for the
 * whole tenant. After that, ordinary employees can connect their own mailbox
 * through the normal /auth/outlook flow without being blocked.
 *
 * Why this route has to exist at all:
 *   Since late 2025, Microsoft's managed default consent policy (the default
 *   for every new tenant) excludes Mail.Read, Mail.ReadWrite and Mail.ReadBasic
 *   from the delegated permissions an end user may consent to. So on a default
 *   Microsoft 365 tenant an employee cannot self-serve connect their mailbox,
 *   no matter what we do in our own UI. An administrator has to approve the app
 *   once, and this is the link they need.
 *
 * The "organizations" authority is deliberate: it lets whichever admin opens
 * the link sign in and consent for their own tenant, so the same URL works for
 * every customer and we never need to know a tenant id in advance. Personal
 * Microsoft accounts have no tenant and no admin, so they are refused here and
 * should use /auth/outlook directly, where they are unaffected by all of this.
 * (If OUTLOOK_TENANT_ID pins one tenant, that tenant is used instead.)
 *
 * Redirect URI: Microsoft only returns to a REGISTERED redirect URI, and the
 * only registered one is /auth/outlook/callback (the /dashboard URI used
 * before was rejected outright). So the admin comes back through the connect
 * callback, which recognises the admin-consent response by its state prefix
 * (ADMIN_CONSENT_STATE_PREFIX) and forwards to the public result page (or to
 * the dashboard, when the signed-in user is the one who created the link).
 *
 * This endpoint grants nothing by itself. Microsoft authenticates the admin and
 * shows them the full permission list before anything is approved.
 *
 * References:
 *   https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
 *   https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies
 */

/**
 * Must match the delegated scopes requested in /auth/outlook. Admin consent is
 * granted against a specific permission set, so a scope that is missing here is
 * a scope employees will still be blocked on afterwards.
 *
 * openid/profile/email are omitted deliberately: they are sign-in basics that
 * are never restricted by a consent policy, and listing them only makes the
 * admin's approval screen longer than the decision actually requires.
 */
const ADMIN_CONSENT_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/offline_access',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const token = request.nextUrl.searchParams.get('t');

  let key: Buffer;
  try {
    key = adminConsentLinkKey();
  } catch {
    console.error('[outlook/admin-consent] CSRF_SECRET is missing or invalid; cannot sign or verify links');
    return NextResponse.redirect(adminConsentResultUrl(appUrl, 'unavailable'));
  }

  // No token: the pre-link entry point. Only a signed-in member can mint a
  // link, so this keeps old bookmarks working without making the plain URL a
  // public door.
  if (!token) {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.redirect(`${appUrl}/login?redirect=${encodeURIComponent('/auth/outlook/admin-consent')}`);
    }
    const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
    if (!workspaceId) {
      return NextResponse.redirect(`${appUrl}/dashboard?error=no_workspace`);
    }
    const minted = mintAdminConsentLinkToken(workspaceId, user.id, key);
    return NextResponse.redirect(adminConsentLinkUrl(appUrl, minted.token));
  }

  const link = verifyAdminConsentLinkToken(token, key);
  if (!link.ok) {
    return NextResponse.redirect(
      adminConsentResultUrl(appUrl, link.reason === 'expired' ? 'link_expired' : 'link_invalid'),
    );
  }

  // State nonce for this one round trip: single-use, 10 minutes, stored like
  // the connect flow's. It is written with the service-role client because the
  // person opening the link has no session; the RLS insert policy would refuse
  // an anonymous caller, and the token above is what authorises the write.
  // The row carries the INVITER's ids (oauth_states requires both), which is
  // also how the callback knows who asked. The prefix is what lets the shared
  // callback route it to the admin-consent branch.
  const state = `${ADMIN_CONSENT_STATE_PREFIX}${randomBytes(32).toString('base64url')}`;
  const redirectUri = `${appUrl}/auth/outlook/callback`;
  const db = createServiceRoleClient();
  // A shared link can be opened many times. Expired, never-returned rows of
  // this link's inviter are swept first so they do not pile up (a surviving
  // row reads as an abandoned consent in growth_oauth_abandonment).
  await db
    .from('oauth_states')
    .delete()
    .eq('user_id', link.userId)
    .eq('provider', 'outlook')
    .like('state', `${ADMIN_CONSENT_STATE_PREFIX}%`)
    .lt('expires_at', new Date().toISOString());
  const { error: stateError } = await db.from('oauth_states').insert({
    workspace_id: link.workspaceId,
    user_id: link.userId,
    provider: 'outlook',
    state,
    redirect_uri: redirectUri,
    expires_at: new Date(Date.now() + ADMIN_CONSENT_STATE_TTL_SECONDS * 1000).toISOString(),
  });
  if (stateError) {
    // Most likely the inviting workspace or user no longer exists (foreign
    // keys), which makes the link meaningless rather than broken.
    console.error('[outlook/admin-consent] state insert failed:', stateError.code);
    return NextResponse.redirect(adminConsentResultUrl(appUrl, 'link_invalid'));
  }

  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID!,
    scope: ADMIN_CONSENT_SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
  });

  const response = NextResponse.redirect(`${outlookAdminConsentEndpoint()}?${params.toString()}`);
  // Binds the round trip to THIS browser: the callback only honours a state
  // that matches this cookie. SameSite=Lax is sent on Microsoft's top-level
  // GET redirect back to us.
  response.cookies.set(ADMIN_CONSENT_STATE_COOKIE, state, {
    httpOnly: true,
    secure: appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/auth/outlook',
    maxAge: ADMIN_CONSENT_STATE_TTL_SECONDS,
  });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
