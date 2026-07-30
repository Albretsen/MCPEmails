import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
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
        : new URL('/dashboard', request.nextUrl.origin).toString();
    return NextResponse.redirect(destination);
  }

  return supabaseResponse;
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
  const protectedPrefixes = ['/dashboard', '/settings'];
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
