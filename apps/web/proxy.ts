import createMiddleware from 'next-intl/middleware';
import { updateSession } from '@/lib/supabase/middleware';
import { routing } from '@/i18n/routing';
import type { NextRequest } from 'next/server';

/**
 * Next.js proxy entry point (formerly middleware.ts; renamed in Next.js 16).
 * Composes two concerns:
 *
 *  - next-intl handles locale negotiation, prefixing, and hreflang headers for
 *    the public marketing routes (URL-based locale).
 *  - updateSession refreshes the Supabase session cookie and guards protected
 *    routes for everything else (dashboard, auth, api).
 *
 * The authenticated app and auth screens are NOT URL-localized (they use a
 * client-side locale from localStorage); they must keep their exact existing
 * Supabase behaviour, including the OAuth callback and API routes.
 */
const intlMiddleware = createMiddleware(routing);

/**
 * Public marketing pages that are localized via URL (next-intl handles these).
 * Everything NOT in this set (dashboard, auth screens, OAuth callbacks, API)
 * goes to Supabase updateSession with its existing behaviour fully intact.
 */
const MARKETING_PATHS = new Set([
  '/',
  '/pricing',
  '/docs',
  '/docs/providers',
  '/privacy',
  '/terms',
]);

function isLocalizedRoute(pathname: string): boolean {
  // Strip a leading locale segment (e.g. /nb/pricing -> /pricing, /nb -> /).
  let path = pathname;
  for (const locale of routing.locales) {
    if (path === `/${locale}`) {
      path = '/';
      break;
    }
    if (path.startsWith(`/${locale}/`)) {
      path = path.slice(`/${locale}`.length);
      break;
    }
  }
  // Normalize a trailing slash (but keep root '/').
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return MARKETING_PATHS.has(path);
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
