/**
 * Signed-in visitors who open the homepage go straight to the dashboard.
 *
 * Someone who types mcpemails.com, opens a bookmark or clicks a search result
 * while signed in almost always wants the app, and used to have to press
 * "Sign in" to get there. The exception is a visitor who is deliberately
 * browsing the marketing site: they followed a link from another page on the
 * site (the dashboard, the pricing page, the logo in the nav), so the request
 * carries a same-site Referer. Those see the homepage as before.
 *
 * This module holds the cheap, synchronous part of the decision: whether the
 * request is even a candidate. Only a candidate pays for the Supabase getUser
 * round trip in the proxy, which then confirms the session is real before
 * redirecting (a stale cookie must still show the homepage, not /login).
 */

/** Locale prefixes the homepage is served under (en has none). */
const HOME_LOCALES = ['nb', 'es', 'fr', 'zh', 'de'];

/**
 * Query parameters that mean the homepage is part of a flow and has to load
 * as asked: an auth code or error coming back from Supabase, or an explicit
 * `?home` from a link that wants the marketing page.
 */
const KEEP_HOME_PARAMS = ['code', 'token_hash', 'error', 'error_description', 'home'];

/** Supabase SSR session cookie, whole (`sb-<ref>-auth-token`) or chunked (`.0`, `.1`). */
const AUTH_COOKIE = /^sb-[^-]+-auth-token(?:\.\d+)?$/;

export interface HomeRedirectInput {
  method: string;
  url: URL;
  headers: Headers;
  cookieNames: string[];
}

export function isHomePath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/') return true;
  return HOME_LOCALES.some((locale) => path === `/${locale}`);
}

/**
 * True when the Referer is a page on this site or one of its subdomains
 * (app.mcpemails.com is the web mail client). The site sends
 * `Referrer-Policy: strict-origin-when-cross-origin`, so same-origin
 * navigations carry the full URL and cross-origin ones at least the origin.
 */
export function cameFromThisSite(referer: string | null, url: URL): boolean {
  if (!referer) return false;
  let refHost: string;
  try {
    refHost = new URL(referer).hostname;
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^www\./, '');
  return refHost === host || refHost.endsWith(`.${host}`);
}

export function isSignedInHomeCandidate({ method, url, headers, cookieNames }: HomeRedirectInput): boolean {
  if (method !== 'GET') return false;
  if (!isHomePath(url.pathname)) return false;
  // Only a top-level page load. Next's client-side navigations and prefetches
  // must not be redirected (the router would get a dashboard payload for a
  // marketing route), and the proxy cannot tell them apart by their `RSC`
  // header or `_rsc` param: Next strips both before the proxy runs. What it
  // does see: a page load asks for text/html, a router fetch does not, and
  // browsers that send Sec-Fetch-Dest say `document` only for page loads.
  if (!(headers.get('accept') ?? '').includes('text/html')) return false;
  const dest = headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  if (KEEP_HOME_PARAMS.some((p) => url.searchParams.has(p))) return false;
  if (cameFromThisSite(headers.get('referer'), url)) return false;
  return cookieNames.some((name) => AUTH_COOKIE.test(name));
}
