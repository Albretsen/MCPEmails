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
  '/blog',
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
  // Blog has dynamic post slugs (/blog/<slug>) on top of the index.
  if (path === '/blog' || path.startsWith('/blog/')) return true;
  return MARKETING_PATHS.has(path);
}

/**
 * CDN cache policy for the public marketing pages. These render the same HTML
 * for every visitor of a given locale (the only request-dependent input is the
 * URL locale segment), so they are safe to cache at the edge.
 *
 * Without this, Next.js marks them `no-store` — the pages are server-rendered
 * (the shared root layout reads the locale dynamically and the intl middleware
 * sets a NEXT_LOCALE cookie), so every crawl and every visit re-runs the
 * function. Overriding the header lets Vercel's CDN serve cached HTML:
 *   - s-maxage=3600          → edge caches each locale variant for 1 hour
 *   - stale-while-revalidate → serve stale instantly for a day while refreshing
 *   - max-age=0, must-revalidate → browsers always revalidate (HTML stays fresh)
 */
const MARKETING_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400, must-revalidate';

export default async function proxy(request: NextRequest) {
  if (isLocalizedRoute(request.nextUrl.pathname)) {
    const response = intlMiddleware(request);
    response.headers.set('Cache-Control', MARKETING_CACHE_CONTROL);
    // next-intl sets a NEXT_LOCALE cookie on every response. With
    // localeDetection disabled the locale is fully URL-determined, so the
    // cookie is unused here — and Vercel's CDN refuses to cache any response
    // carrying Set-Cookie, which would silently void the header above. Drop it.
    // (Marketing routes never run Supabase updateSession, so no auth/session
    // cookie is at stake.)
    response.headers.delete('set-cookie');
    return response;
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
