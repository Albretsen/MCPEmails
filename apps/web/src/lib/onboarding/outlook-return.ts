/**
 * Bringing a Microsoft sign-in started on /onboarding (or on the inbox step
 * inside the OAuth consent screen) back where it started.
 *
 * /auth/outlook?from=onboarding sets a short-lived cookie; the callback's
 * dashboard redirects are then rewritten here: success goes to
 * /onboarding?connected=outlook, a refusal or cancel to
 * /onboarding?outlook_error=<code> (the inbox step explains it, including the
 * admin-approval case). Any other destination (the admin-consent result page)
 * is left alone. Pure.
 *
 * /auth/outlook?from=onboarding&return_to=/authorize?... (the consent screen's
 * inbox step, onboarding WP-G) stores that consent URL in the cookie instead
 * of '1', so the user comes back to the SAME OAuth request with
 * connected=outlook or outlook_error=<code> added. Only an /authorize path is
 * accepted (onboardingReturnTarget), so the cookie can never send anyone off
 * the site or anywhere but a consent screen.
 */
export const ONBOARDING_RETURN_COOKIE = 'mcpe_onb_return';
export const ONBOARDING_RETURN_TTL_SECONDS = 15 * 60;

/** The cookie value for a plain /onboarding return. */
export const ONBOARDING_RETURN_DEFAULT = '1';

/** Long consent URLs (a CIMD client_id, a long state) still fit in one cookie. */
const MAX_RETURN_PATH = 3000;
const AUTHORIZE_PREFIX = 'a:';
const ERROR_CODE = /^[a-z0-9_]{1,40}$/;

/** `value` when it is a same-origin /authorize?… path we may return to, else null. */
export function authorizeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > MAX_RETURN_PATH) return null;
  if (!value.startsWith('/authorize?')) return null;
  try {
    const url = new URL(value, 'https://x.invalid');
    if (url.origin !== 'https://x.invalid' || url.pathname !== '/authorize') return null;
  } catch {
    return null;
  }
  return value;
}

/** The cookie value /auth/outlook stores for a sign-in started on onboarding. */
export function onboardingReturnCookieValue(returnTo: string | null | undefined): string {
  const path = authorizeReturnPath(returnTo);
  return path ? `${AUTHORIZE_PREFIX}${encodeURIComponent(path)}` : ONBOARDING_RETURN_DEFAULT;
}

/** Where a cookie value says to return: '/onboarding' or a validated /authorize path. */
export function onboardingReturnTarget(cookieValue: string | null | undefined): string {
  if (typeof cookieValue === 'string' && cookieValue.startsWith(AUTHORIZE_PREFIX)) {
    try {
      const path = authorizeReturnPath(decodeURIComponent(cookieValue.slice(AUTHORIZE_PREFIX.length)));
      if (path) return path;
    } catch {
      // A mangled cookie falls back to /onboarding.
    }
  }
  return '/onboarding';
}

export function onboardingReturnLocation(
  location: string | null | undefined,
  appUrl: string,
  target: string = '/onboarding',
): string | null {
  if (!location) return null;
  let url: URL;
  let base: URL;
  try {
    base = new URL(appUrl);
    url = new URL(location, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (url.pathname !== '/dashboard' && url.pathname !== '/dashboard/') return null;
  const out = new URL(target, base);
  if (out.origin !== base.origin) return null;
  out.searchParams.delete('connected');
  out.searchParams.delete('outlook_error');
  const error = url.searchParams.get('error');
  if (error) {
    if (!ERROR_CODE.test(error)) return null;
    out.searchParams.set('outlook_error', error);
    return out.toString();
  }
  if (url.searchParams.get('connected') === 'outlook') {
    out.searchParams.set('connected', 'outlook');
    return out.toString();
  }
  return null;
}
