import createMiddleware from 'next-intl/middleware';
import { updateSession } from '@/lib/supabase/middleware';
import { routing } from '@/i18n/routing';
import type { NextRequest } from 'next/server';

/**
 * Next.js proxy entry point (formerly middleware.ts; renamed in Next.js 16).
 * Composes two concerns:
 *
 *  - next-intl handles locale negotiation, prefixing, and hreflang headers for
 *    the localized marketing routes.
 *  - updateSession refreshes the Supabase session cookie and guards protected
 *    routes for everything else (dashboard, auth, api).
 *
 * Only the marketing home is localized for now, so the locale handling runs
 * exclusively on '/', '/en', and '/nb'. Every other path keeps its existing
 * Supabase behaviour unchanged, including the OAuth callback and API routes.
 */
const intlMiddleware = createMiddleware(routing);

function isLocalizedRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    routing.locales.some(
      (locale) => pathname === `/${locale}` || pathname === `/${locale}/`,
    )
  );
}

export default async function proxy(request: NextRequest) {
  if (isLocalizedRoute(request.nextUrl.pathname)) {
    return intlMiddleware(request);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *  - _next/static  (static files)
     *  - _next/image   (image optimisation endpoint)
     *  - favicon.ico
     *  - common image/font extensions
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf)$).*)',
  ],
};
