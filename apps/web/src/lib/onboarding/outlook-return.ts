/**
 * Bringing a Microsoft sign-in started on /onboarding back to /onboarding.
 *
 * /auth/outlook?from=onboarding sets a short-lived cookie; the callback's
 * dashboard redirects are then rewritten here: success goes to
 * /onboarding?connected=outlook, a refusal or cancel to
 * /onboarding?outlook_error=<code> (the inbox step explains it, including the
 * admin-approval case). Any other destination (the admin-consent result page)
 * is left alone. Pure.
 */
export const ONBOARDING_RETURN_COOKIE = 'mcpe_onb_return';
export const ONBOARDING_RETURN_TTL_SECONDS = 15 * 60;

const ERROR_CODE = /^[a-z0-9_]{1,40}$/;

export function onboardingReturnLocation(location: string | null | undefined, appUrl: string): string | null {
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
  const out = new URL('/onboarding', base);
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
