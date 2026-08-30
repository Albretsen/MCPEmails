import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /auth/outlook/admin-consent
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
 *
 * This endpoint grants nothing by itself. Microsoft authenticates the admin and
 * shows them the full permission list before anything is approved.
 *
 * References:
 *   https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
 *   https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies
 */

const ADMIN_CONSENT_ENDPOINT =
  'https://login.microsoftonline.com/organizations/v2.0/adminconsent';

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

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  // Require a signed-in user. This link is surfaced from inside the dashboard
  // for an admin to follow or forward; it is not a public entry point.
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/login?next=/dashboard`
    );
  }

  // No state nonce is needed and none is used: this flow grants a tenant-wide
  // permission inside Microsoft and returns the admin to the dashboard with
  // nothing we act on. There is no code to exchange and no token to store, so
  // there is no callback to protect against replay. The employee still has to
  // complete the real /auth/outlook flow afterwards, and that one is CSRF-bound.
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID!,
    scope: ADMIN_CONSENT_SCOPES.join(' '),
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
  });

  return NextResponse.redirect(`${ADMIN_CONSENT_ENDPOINT}?${params.toString()}`);
}
