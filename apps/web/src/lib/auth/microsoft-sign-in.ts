// ---------------------------------------------------------------------------
// Sign in with Microsoft: the identity guard and the error mapping that
// /auth/callback uses for the Supabase `azure` provider.
//
// WHY A GUARD. Supabase links a new OAuth identity to an existing user with
// the same email when it believes the email is verified. For Microsoft Entra
// the `email` claim is whatever a tenant admin typed into the user's mail
// attribute: any tenant can claim any address. Microsoft's answer is the
// optional ID-token claim `xms_edov` ("email domain owner verified"). Supabase
// (supabase/auth internal/api/provider/oidc.go, AzureIDTokenClaims) treats a
// MISSING `xms_edov` as verified, and keeps the raw claims in
// identity_data.custom_claims. So this guard is stricter than Supabase: an
// `azure` sign-in passes only with `xms_edov` explicitly true, or from the
// Microsoft personal-account tenant, where Microsoft itself verifies the
// sign-in address when the account is created.
//
// WHICH IDENTITY. `app_metadata.provider` is the FIRST provider a user ever
// used, not this sign-in's. Supabase writes `last_sign_in_at` on the identity a
// sign-in used (external.go updates it on every returning OAuth login), so the
// identity with the newest `last_sign_in_at` is the one this exchange signed
// in with. Guarding only that identity means an existing user's own Google or
// password sign-in is never refused because of some other identity.
// ---------------------------------------------------------------------------

/** Microsoft personal accounts (outlook.com, hotmail.com, live.com) sign in from this tenant. */
export const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

export type IdentityLike = {
  provider?: string | null;
  identity_data?: Record<string, unknown> | null;
  last_sign_in_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type UserLike = {
  app_metadata?: { provider?: string | null } | null;
  identities?: IdentityLike[] | null;
} | null | undefined;

/** Reasons /auth/error understands for a Microsoft sign-in. */
export type MicrosoftErrorReason =
  | 'microsoft_email_unverified'
  | 'microsoft_admin_approval'
  | 'oauth_cancelled'
  | 'provider_email_unverified'
  | 'sso_required';

function timeOf(identity: IdentityLike): number {
  for (const value of [identity.last_sign_in_at, identity.updated_at, identity.created_at]) {
    const t = value ? Date.parse(value) : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return -Infinity;
}

/** The identity this sign-in used: the one Supabase stamped most recently. */
export function signedInIdentity(user: UserLike): IdentityLike | null {
  const identities = user?.identities ?? [];
  let latest: IdentityLike | null = null;
  for (const identity of identities) {
    if (!latest || timeOf(identity) > timeOf(latest)) latest = identity;
  }
  return latest;
}

/** `xms_edov` arrives as a boolean, or as "1"/"true" from some tenants. */
function isTrueClaim(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

/** True only when Microsoft vouches that this identity owns its email address. */
export function isMicrosoftEmailVerified(identityData: Record<string, unknown> | null | undefined): boolean {
  if (!identityData) return false;
  const email = typeof identityData.email === 'string' ? identityData.email.trim() : '';
  if (!email) return false;
  const custom = (identityData.custom_claims ?? {}) as Record<string, unknown>;
  if (isTrueClaim(custom.xms_edov) || isTrueClaim(identityData.xms_edov)) return true;
  const tenant = custom.tid ?? identityData.tid;
  return tenant === MICROSOFT_CONSUMER_TENANT_ID;
}

/**
 * Null when the session may stand, otherwise the /auth/error reason. Only a
 * sign-in through the `azure` identity is ever refused.
 */
export function microsoftSignInRefusal(user: UserLike): MicrosoftErrorReason | null {
  if (!user) return null;
  const identity = signedInIdentity(user);
  if (!identity) {
    // No identities to inspect. Fail closed only for a Microsoft account.
    return user.app_metadata?.provider === 'azure' ? 'microsoft_email_unverified' : null;
  }
  if (identity.provider !== 'azure') return null;
  return isMicrosoftEmailVerified(identity.identity_data) ? null : 'microsoft_email_unverified';
}

// Entra error codes that mean "an admin of this organization has to approve
// the app first": consent required (65001) and admin consent required
// (90094, 90095, 900941). Tenants that block user consent return these.
const ADMIN_APPROVAL_CODES = /AADSTS(65001|90094|90095|900941)\b/;
// The user declined the consent screen.
const CANCEL_CODES = /AADSTS65004\b/;
// error_code values Supabase itself puts on an `access_denied` redirect. Those
// are not a user pressing cancel.
const SUPABASE_DENIAL_CODES = new Set(['user_banned', 'signup_disabled', 'provider_email_needs_verification']);

/**
 * Maps the `error`, `error_code` and `error_description` query params that
 * Supabase adds when an OAuth sign-in fails to a reason /auth/error knows.
 * Null means "no known reason": the caller keeps its generic handling.
 */
export function oauthErrorReason(params: URLSearchParams): MicrosoftErrorReason | null {
  const error = params.get('error');
  if (!error) return null;
  const code = params.get('error_code') ?? '';
  const description = params.get('error_description') ?? '';

  // Refusals from our own Supabase auth hooks (migration
  // 20261019153000_auth_hooks_sso_enforcement.sql) arrive as the description.
  if (/\bsso_required\b/.test(description)) return 'sso_required';
  if (/\bmicrosoft_email_unverified\b/.test(description)) return 'microsoft_email_unverified';
  if (ADMIN_APPROVAL_CODES.test(description) || /admin(istrator)? (approval|consent)/i.test(description)) {
    return 'microsoft_admin_approval';
  }
  if (code === 'provider_email_needs_verification') return 'provider_email_unverified';
  if (CANCEL_CODES.test(description)) return 'oauth_cancelled';
  if (error === 'access_denied' && !SUPABASE_DENIAL_CODES.has(code)) return 'oauth_cancelled';
  return null;
}
