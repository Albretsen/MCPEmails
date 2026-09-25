/**
 * Pure decision helpers for the Outlook OAuth flow.
 *
 * These decisions used to live inline in the route handlers, where they could
 * not be tested without standing up Next and Supabase. All of them are subtle
 * enough that getting them wrong is silent rather than loud, so they are
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

// ─── Authority (tenant) ───────────────────────────────────────────────────────

/**
 * The Microsoft identity platform authority segment every Outlook endpoint is
 * built on: authorize, token (code exchange AND refresh) and admin consent.
 *
 * Read from OUTLOOK_TENANT_ID, defaulting to "common" (personal Microsoft
 * accounts plus any work/school tenant, which is how the Entra app is
 * registered). A tenant GUID or verified domain restricts sign-in to that one
 * organisation. All endpoints must agree: a refresh token issued under one
 * authority is refreshed under the same one.
 *
 * The value is interpolated into a URL path, so anything that is not a plain
 * GUID / domain / well-known alias is ignored rather than trusted.
 */
export function outlookTenant(raw: string | undefined = process.env.OUTLOOK_TENANT_ID): string {
  const value = (raw ?? '').trim();
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) return 'common';
  return value;
}

export function outlookAuthorizeEndpoint(tenant: string = outlookTenant()): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function outlookTokenEndpoint(tenant: string = outlookTenant()): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/**
 * Admin consent only exists for organisations. "common" and "consumers" are
 * mapped to "organizations" so whichever admin opens the link consents for
 * their own tenant; a specific tenant is kept as-is.
 */
export function outlookAdminConsentEndpoint(tenant: string = outlookTenant()): string {
  const authority =
    tenant === 'common' || tenant === 'consumers' ? 'organizations' : tenant;
  return `https://login.microsoftonline.com/${authority}/v2.0/adminconsent`;
}

// ─── Admin consent round trip ─────────────────────────────────────────────────

/**
 * Admin consent returns to the SAME registered redirect URI as the ordinary
 * connect flow (/auth/outlook/callback), so the callback has to tell the two
 * apart. The state nonce carries the marker: oauth_states.provider is
 * constrained to real providers, and this needs no schema change.
 *
 * The prefix is checked in both directions: an admin-consent state can never
 * redeem an authorization code, and a connect state can never be used to
 * report an admin consent.
 */
export const ADMIN_CONSENT_STATE_PREFIX = 'ac.';

export function isAdminConsentState(state: string | null): boolean {
  return !!state && state.startsWith(ADMIN_CONSENT_STATE_PREFIX);
}

/** Dashboard outcome for an admin-consent callback. */
export type AdminConsentOutcome =
  | 'admin_consent_granted'
  | 'admin_consent_cancelled'
  | 'admin_consent_failed';

/**
 * Whether a callback is an admin-consent response rather than a connect
 * response. Microsoft sends `admin_consent=True&tenant=...&state=...` on
 * success and `error=...&error_description=...&state=...` on failure, so the
 * state prefix is the only thing present in both shapes.
 */
export function isAdminConsentCallback(params: URLSearchParams): boolean {
  return params.has('admin_consent') || isAdminConsentState(params.get('state'));
}

/**
 * Classify an admin-consent callback. Only `admin_consent=True` with no error
 * counts as granted; anything else is reported, never assumed.
 */
export function classifyAdminConsentCallback(params: URLSearchParams): AdminConsentOutcome {
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description') ?? '';
    // AADSTS65004: the admin declined on the consent screen.
    if (error === 'access_denied' && !description.includes('AADSTS65001')) {
      return 'admin_consent_cancelled';
    }
    return 'admin_consent_failed';
  }
  return params.get('admin_consent')?.toLowerCase() === 'true'
    ? 'admin_consent_granted'
    : 'admin_consent_failed';
}

// ─── Mailbox address from the id_token ────────────────────────────────────────

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function normaliseEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  return EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * Pick the mailbox address from id_token claims, lowercased and validated.
 *
 * `email` (requested through the `email` scope) is the account's mail
 * attribute, i.e. the primary SMTP address, and is preferred. For work/school
 * accounts `preferred_username` is the UPN, which can differ from the mailbox
 * address (e.g. first.last@corp.example vs flast@corp.example), so it is only a
 * fallback, and only when it is shaped like an address. Graph's /me would be
 * authoritative but needs User.Read, which is not requested.
 *
 * Returns null when neither claim is a usable address; the caller must refuse
 * the connection rather than save an inbox with a broken address.
 */
export function selectOutlookEmail(claims: Record<string, unknown>): string | null {
  return normaliseEmail(claims['email']) ?? normaliseEmail(claims['preferred_username']);
}

// ─── Live access probe ────────────────────────────────────────────────────────

/**
 * What a Graph probe response means for the "Check connection" button.
 *
 *  - ok:           the token reads the mailbox.
 *  - unauthorized: 401, the token is not accepted. Reconnecting fixes it.
 *  - no_mailbox:   signed in fine, but there is no Exchange Online mailbox
 *                  behind the account (on-premises, unlicensed, inactive).
 *                  Reconnecting does NOT fix it.
 *  - forbidden:    403, the token is valid but access to the mailbox is
 *                  refused (tenant policy, application access policy).
 *                  Reconnecting does NOT fix it.
 *  - inconclusive: anything else (5xx, throttling); do not change status.
 */
export type OutlookProbeResult =
  | 'ok'
  | 'unauthorized'
  | 'no_mailbox'
  | 'forbidden'
  | 'inconclusive';

export function classifyOutlookProbe(
  status: number,
  graphErrorCode: string | null | undefined,
): OutlookProbeResult {
  if (status >= 200 && status < 300) return 'ok';
  // Graph reports a missing / on-prem mailbox as MailboxNotEnabledForRESTAPI,
  // with a 401 or a 404 depending on the account. It must win over the plain
  // 401 mapping or we would tell the user to reconnect forever.
  if (
    graphErrorCode === 'MailboxNotEnabledForRESTAPI' ||
    graphErrorCode === 'MailboxNotSupportedForRESTAPI' ||
    graphErrorCode === 'ErrorMailboxNotFound'
  ) {
    return 'no_mailbox';
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'no_mailbox';
  return 'inconclusive';
}

/**
 * What to do with a probe result, given whether the token was just minted.
 *
 * A plain 401 is ambiguous. On a token that has been sitting in the database
 * it can be a stale token, so the answer is one forced refresh and a second
 * probe ('refresh_and_retry'). On a token minted moments ago (by the code
 * exchange, or by that forced refresh) it cannot be staleness: Graph is
 * refusing a valid token, which is exactly what it does for an account with no
 * Exchange Online mailbox. Found live on 2026-09-25: an Entra admin account
 * without an Exchange licence got 401 with an EMPTY body on
 * /me/mailFolders/inbox, even straight after a refresh, and "reconnect" looped
 * forever. Only an invalid_grant from the refresh itself means reconnect, and
 * that is thrown by the refresh, not decided here.
 */
export function settleOutlookProbe(
  result: OutlookProbeResult,
  tokenWasJustMinted: boolean,
): OutlookProbeResult | 'refresh_and_retry' {
  if (result !== 'unauthorized') return result;
  return tokenWasJustMinted ? 'no_mailbox' : 'refresh_and_retry';
}

/**
 * The words for an Outlook account with no mailbox: stored in `last_error` and
 * shown by the connection check. Deliberately never "reconnect".
 */
export const OUTLOOK_NO_MAILBOX_REASON =
  'This Microsoft account has no Outlook / Exchange Online mailbox that Microsoft Graph can reach. ' +
  'Microsoft accepted the sign-in, but there is no mailbox behind it: typically an administrator ' +
  'account without an Exchange Online licence, or an organisation whose mail is hosted somewhere ' +
  'else. Reconnecting will not change this. If the address\'s mail is hosted on another server, ' +
  'remove this inbox and connect the address with IMAP instead.';
