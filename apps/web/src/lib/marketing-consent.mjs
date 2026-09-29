// ---------------------------------------------------------------------------
// Marketing email consent, captured at signup and nowhere else.
//
// WHY THIS FILE EXISTS. Norwegian law (markedsføringsloven § 15) and the
// ePrivacy rules require PRIOR consent before we send anyone marketing email.
// Consent is only worth something if we can later show exactly what a person
// agreed to. So every consent row in `public.users` carries a
// `marketing_consent_source` naming the version of the checkbox they ticked,
// and this file is the record of what each version said, in English.
//
// THE RULES.
//   1. Never edit the wording of an existing version. If the checkbox text in
//      messages/en/auth.json (signup.marketingConsent) changes, add a NEW
//      version here, point CURRENT at it, and add it to the CHECK constraint in
//      a new migration. The test in marketing-consent.test.mjs fails until the
//      shown English text equals the wording recorded for CURRENT.
//   2. Consent is recorded server-side only. The browser says "the box was
//      ticked, version X"; the timestamp is always the database's now().
//   3. No box, no consent. Every signup path that does not show this checkbox
//      (login-page OAuth, magic link, invites) records nothing, which means NULL.
//
// HOW IT REACHES THE DATABASE.
//   * Password signup: SignupApp puts `marketing_consent: true` and
//     `marketing_consent_version` into the signUp user metadata ONLY when the box
//     is ticked. The BEFORE INSERT trigger on public.users
//     (20260929100000_marketing_consent.sql) reads them off auth.users and
//     stamps now().
//   * Google / GitHub from the signup page: OAuth has no metadata channel, so
//     SignupApp sets a short-lived first-party cookie before leaving for the
//     provider. /auth/callback reads it, and only for an account created by that
//     very exchange calls the service-role-only RPC
//     `record_signup_marketing_consent`. The cookie is cleared on every callback.
//     A cookie rather than a query parameter because a link someone else crafts
//     can carry a query parameter, but cannot set a cookie on our origin.
// ---------------------------------------------------------------------------

/** The version the signup form shows today. */
export const MARKETING_CONSENT_VERSION = 'signup_checkbox_v1';

/**
 * Every version ever shown, mapped to its exact English wording. Append only.
 * The database CHECK constraint on users.marketing_consent_source accepts
 * exactly these keys.
 */
export const MARKETING_CONSENT_WORDING = Object.freeze({
  signup_checkbox_v1: 'Email me product tips and offers. Unsubscribe anytime.',
});

/** Cookie that carries a ticked box across the OAuth round trip. */
export const MARKETING_CONSENT_COOKIE = 'mcpe_signup_mc';

/** Scoped to /auth so it rides only to /auth/callback, never to the app. */
const COOKIE_PATH = '/auth';

/** Long enough for a slow provider consent screen, short enough to go stale. */
export const MARKETING_CONSENT_COOKIE_MAX_AGE_S = 15 * 60;

export function isKnownConsentVersion(value) {
  return typeof value === 'string' && Object.hasOwn(MARKETING_CONSENT_WORDING, value);
}

/**
 * The user-metadata fields a password signup sends. An empty object when the
 * box is not ticked, so an unticked signup carries no consent keys at all.
 */
export function signupConsentMetadata(consented) {
  if (consented !== true) return {};
  return { marketing_consent: true, marketing_consent_version: MARKETING_CONSENT_VERSION };
}

/** `document.cookie` assignment that records a ticked box for the OAuth hop. */
export function consentCookieString({ secure }) {
  return `${MARKETING_CONSENT_COOKIE}=${MARKETING_CONSENT_VERSION}; Path=${COOKIE_PATH}; Max-Age=${MARKETING_CONSENT_COOKIE_MAX_AGE_S}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** `document.cookie` assignment (or Set-Cookie value) that removes it. */
export function clearConsentCookieString({ secure }) {
  return `${MARKETING_CONSENT_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * Browser only. Sets the cookie when the box is ticked and clears any earlier
 * one when it is not, so an old tick can never outlive an untick.
 */
export function rememberOAuthConsent(consented, doc = globalThis.document, loc = globalThis.location) {
  if (!doc) return;
  const secure = loc?.protocol === 'https:';
  doc.cookie = consented === true ? consentCookieString({ secure }) : clearConsentCookieString({ secure });
}

/** Server: the consent version in a Cookie header, or null. */
export function consentVersionFromCookieHeader(header) {
  if (typeof header !== 'string' || header === '') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== MARKETING_CONSENT_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return isKnownConsentVersion(value) ? value : null;
  }
  return null;
}
