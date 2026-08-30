/**
 * Pure decision helpers for the Outlook OAuth flow.
 *
 * These two decisions used to live inline in the route handlers, where they
 * could not be tested without standing up Next and Supabase. Both of them are
 * subtle enough that getting them wrong is silent rather than loud, so they are
 * isolated here and covered by outlook-oauth.test.ts.
 */

/**
 * Delegated scopes requested when a user connects a mailbox.
 *
 * Mail.ReadWrite is a superset of Mail.Read and is required for every
 * mailbox-mutating Graph call (mark read/unread, flag, move, archive, copy,
 * delete, draft create/update, folder create/rename/delete). Mail.Send is NOT
 * covered by it and must be requested separately.
 */
export const OUTLOOK_SCOPES = [
  'Mail.ReadWrite',
  'Mail.Send',
  'offline_access',
  'openid',
  'profile',
  'email',
] as const;

/**
 * Whether to send `prompt=consent` on an authorization request.
 *
 * Only on reconnect. A first connect must not force the consent screen.
 *
 * The refresh token comes from the offline_access scope, which is granted on a
 * normal authorization, so a first connect does not need forced consent to get
 * one. A reconnect does: re-consent is the only way to pick up a widened scope
 * set (a silent refresh keeps the originally granted scopes) and to replace a
 * revoked refresh token.
 *
 * Sending it unconditionally is harmful on work/school accounts. In a tenant
 * that has already granted admin consent for this app, prompt=consent makes
 * Microsoft re-ask the individual signing-in user, and a non-admin user cannot
 * grant it. The tenant is consented, yet every ordinary employee is turned away.
 */
export function shouldForceConsent(isReconnect: boolean): boolean {
  return isReconnect;
}

/** Dashboard error codes an Outlook callback can redirect with. */
export type OutlookCallbackError =
  | 'admin_consent_required'
  | 'cancelled'
  | 'oauth_error';

/**
 * Classify the `error` / `error_description` pair Microsoft puts on the
 * callback URL into the code the dashboard renders.
 *
 * Returns null when Microsoft reported no error at all.
 *
 * The case that matters is `admin_consent_required`. Since late 2025 the
 * Microsoft-managed default consent policy (the default for every new tenant)
 * excludes Mail.Read / Mail.ReadWrite / Mail.ReadBasic from the delegated
 * permissions an end user may consent to, so a Microsoft 365 employee is
 * refused before ever seeing a consent screen. That is not a failure the person
 * can act on, and it is not them declining, so it must not be reported as
 * either a generic error or a cancellation. Only an administrator can clear it.
 *
 * Microsoft signals it inconsistently: sometimes as error=consent_required, and
 * sometimes as access_denied or invalid_grant carrying AADSTS65001 in the
 * description. The description is therefore checked even when the error code
 * alone looks like an ordinary denial.
 */
export function classifyMicrosoftAuthError(
  error: string | null,
  errorDescription: string | null,
): OutlookCallbackError | null {
  if (!error) return null;

  const description = errorDescription ?? '';
  // AADSTS65001: no consent on record for this app/user.
  // AADSTS900971: no reply address / tenant consent path required.
  const consentBlocked =
    error === 'consent_required' ||
    error === 'interaction_required' ||
    description.includes('AADSTS65001') ||
    description.includes('AADSTS900971');

  if (consentBlocked) return 'admin_consent_required';
  if (error === 'access_denied') return 'cancelled';
  return 'oauth_error';
}
