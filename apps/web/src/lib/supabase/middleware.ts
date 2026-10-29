import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import type { Database } from '@/types/database.types';
import {
  CLIENT_INTENT_PARAM,
  CONNECT_INTENT_PARAM,
  withClientIntent,
  withConnectIntent,
} from '@/lib/connect/intent-carry.mjs';
import { mayUseThisDeployment, STAGING_RESTRICTED_REASON } from '@/lib/env/app-env';

/**
 * Refreshes the Supabase session on every request and enforces route-level
 * access control.
 *
 * Must be called from `middleware.ts` at the project root. Uses the request
 * and response objects directly (not Next.js's cookies() API) because
 * middleware cannot call cookies() from next/headers.
 *
 * Side effects:
 *  - Transparently refreshes the access token when near expiry
 *  - Redirects unauthenticated requests to /login for protected routes
 *  - Preserves the original path as `?redirect=` so the login page can send
 *    the user back after a successful sign-in
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          // NextResponse.next({ request }) copies the request headers at the
          // moment it is called, so the response must be rebuilt AFTER the
          // refreshed cookies are on the request. Built once up front, the
          // page render got the cookies the browser sent: an expired access
          // token and a refresh token Supabase had just rotated, so every
          // Server Component calling getUser() refreshed with a used token.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });
          // Apply cache-control headers so CDNs never cache auth responses.
          Object.entries(headers).forEach(([key, value]) => {
            supabaseResponse.headers.set(key, value);
          });
        },
      },
    }
  );

  // IMPORTANT: getUser() makes a server-side request to Supabase Auth to
  // validate the token and detect revoked sessions. Do not replace this with
  // getSession(), which only verifies the JWT signature locally.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Staging only (APP_ENV=staging): a session whose address is not on
  // EMAIL_RECIPIENT_ALLOWLIST is refused everywhere except /auth/*, whatever
  // created it (password signup returns its session in the browser, OAuth and
  // magic link go through /auth/callback, which also refuses them). Always
  // true in production.
  if (user && !mayUseThisDeployment(user.email) && !request.nextUrl.pathname.startsWith('/auth/')) {
    return stagingRefusal(request);
  }

  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    // Unauthenticated user accessing a protected route → send to /login.
    // Preserve the original path so the callback can redirect back after sign-in.
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('redirect', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isAuthPath(request.nextUrl.pathname)) {
    // Already-authenticated user visiting an auth page → honor ?redirect= if
    // present (e.g. /login?redirect=/authorize?...), otherwise send to /dashboard.
    const redirectParam = request.nextUrl.searchParams.get('redirect');
    // SECURITY: only accept same-origin relative paths. A protocol-relative
    // URL like `//evil.com` (or `/\evil.com`) passes a bare startsWith('/')
    // check and resolves to an external origin → open redirect.
    const isSafeRedirect =
      !!redirectParam &&
      redirectParam.startsWith('/') &&
      !redirectParam.startsWith('//') &&
      !redirectParam.startsWith('/\\');
    const destination =
      isSafeRedirect
        ? new URL(redirectParam, request.nextUrl.origin).toString()
        : new URL(
            // A signed-in visitor who pressed "Connect IONOS free" on a provider
            // page is bounced from /signup?provider=ionos to here. Keep the
            // hint on the way (shape-checked; the dashboard validates it).
            // The AI app hint (?client=) rides along the same way.
            withClientIntent(
              withConnectIntent(
                '/dashboard',
                request.nextUrl.searchParams.get(CONNECT_INTENT_PARAM),
              ),
              request.nextUrl.searchParams.get(CLIENT_INTENT_PARAM),
            ),
            request.nextUrl.origin,
          ).toString();
    return NextResponse.redirect(destination);
  }

  return supabaseResponse;
}

/**
 * The staging refusal: a 403 for API calls, otherwise the sign-in error page.
 * Both drop the Supabase auth cookies so the browser stops presenting them.
 */
function stagingRefusal(request: NextRequest): NextResponse {
  const response = request.nextUrl.pathname.startsWith('/api/')
    ? NextResponse.json({ error: STAGING_RESTRICTED_REASON }, { status: 403 })
    : NextResponse.redirect(new URL(`/auth/error?reason=${STAGING_RESTRICTED_REASON}`, request.nextUrl.origin));
  for (const { name } of request.cookies.getAll()) {
    if (name.startsWith('sb-')) response.cookies.delete(name);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

/**
 * Returns true if the given pathname requires an authenticated session.
 */
function isProtectedPath(pathname: string): boolean {
  // NOTE: /api/mcp is intentionally NOT listed here. It authenticates via a
  // Bearer API key (mcpe_…), not a Supabase session cookie. Gating it behind
  // the cookie check would 307-redirect token-bearing MCP clients to /login.
  // The route handler enforces auth itself and returns 401 + WWW-Authenticate
  // for OAuth discovery.
  // /approvals/[id] is the authenticated send-review page. It is opened from a
  // link inside an AI conversation, so the redirect-to-login behaviour matters:
  // an unauthenticated visitor (or a preview bot) must never see the review.
  // The page re-checks auth itself; this is the outer layer, not the only one.
  // /onboarding is the post-signup setup flow; it re-checks auth itself.
  const protectedPrefixes = ['/dashboard', '/settings', '/approvals', '/onboarding'];
  return protectedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Returns true if the given pathname is an auth page that authenticated
 * users should be bounced away from.
 */
function isAuthPath(pathname: string): boolean {
  const authPaths = ['/login', '/signup'];
  return authPaths.some((path) => pathname === path || pathname.startsWith(path + '/'));
}

/**
 * Returns a redirect to /dashboard when the request carries a live Supabase
 * session, otherwise null. Used by the proxy for signed-in visitors opening
 * the homepage (see src/lib/home-redirect.ts for which requests qualify).
 *
 * getUser() may refresh the access token, and Supabase rotates the refresh
 * token when it does. The new cookies are copied onto the redirect: dropping
 * them would leave the browser holding a spent refresh token and sign the
 * visitor out on their next request.
 */
export async function signedInDashboardRedirect(request: NextRequest): Promise<NextResponse | null> {
  const refreshed: { name: string; value: string; options: Parameters<NextResponse['cookies']['set']>[2] }[] = [];

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          refreshed.push(...cookiesToSet);
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const response = NextResponse.redirect(new URL('/dashboard', request.nextUrl.origin));
  for (const { name, value, options } of refreshed) response.cookies.set(name, value, options);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
