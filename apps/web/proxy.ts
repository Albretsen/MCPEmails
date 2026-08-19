import createMiddleware from 'next-intl/middleware';
import { updateSession } from '@/lib/supabase/middleware';
import { isKioskPath, kioskUrlRedirect, refreshKioskCookie } from '@/lib/admin/kiosk-cookie';
import { buildContentSecurityPolicy, generateNonce } from '@/lib/csp';
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
  '/security',
  '/self-hosting',
  '/about',
  '/native-connectors-vs-mcp',
  '/for/founders',
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
  // Provider landing pages are a dynamic segment (/connect/<provider>).
  if (path === '/connect' || path.startsWith('/connect/')) return true;
  return MARKETING_PATHS.has(path);
}

/**
 * Cache policy for the public marketing pages.
 *
 * This used to read `public, max-age=0, s-maxage=3600,
 * stale-while-revalidate=86400, must-revalidate`, aiming to let Vercel's CDN
 * serve each locale's HTML for an hour instead of re-running the function on
 * every crawl. Two things are now known about that:
 *
 *  1. It never took effect. Checked against production on 2026-08-30: `/` and
 *     `/pricing` both come back `cache-control: private, no-cache, no-store,
 *     max-age=0, must-revalidate` with `x-vercel-cache: MISS` on every repeat
 *     request. Next.js writes its own header for a dynamically rendered route
 *     after the proxy has run, and it wins. So removing the s-maxage costs
 *     nothing that was actually happening.
 *
 *  2. It is now actively unsafe. Every HTML response carries a per-request CSP
 *     nonce (see the default export below), and the middleware re-issues that
 *     header on every request — including a request the CDN answers from cache.
 *     A shared cache would therefore pair hour-old HTML, whose script tags
 *     carry nonce A, with a freshly generated header demanding nonce B. Every
 *     inline framework script would be blocked and the entire marketing site
 *     would render blank, for everyone, until the cache expired.
 *
 * `private` is what makes those two mutually exclusive things safe: browsers
 * may reuse the response for the visitor who received it (whose nonce it
 * matches), shared caches may not touch it at all.
 *
 * If edge caching of marketing HTML is worth revisiting, the fix is NOT to put
 * s-maxage back. It is to make these routes genuinely static — today nothing
 * under app/[locale] is prerendered, despite generateStaticParams() and
 * setRequestLocale(), because the shared root layout awaits getLocale() above
 * the [locale] segment and forces a dynamic render — and then serve the static
 * ones under a separate, nonce-free policy.
 */
const MARKETING_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

export default async function proxy(request: NextRequest) {
  // A fresh nonce per request, and the policy built around it. src/lib/csp.ts
  // documents what the policy allows, why 'unsafe-inline' had to leave
  // `script-src`, and what was deliberately left alone (`style-src`).
  const nonce = generateNonce();
  const csp = await buildContentSecurityPolicy(nonce);

  // Next.js does not offer an API for handing it a nonce. It re-parses the CSP
  // off the INCOMING REQUEST and takes the first 'nonce-…' it finds in
  // `script-src` — see parseRequestHeaders() → getScriptNonceFromHeader() in
  // next/dist/server/app-render/. That is the whole mechanism by which the
  // framework's own inline bootstrap and RSC flight scripts
  // (`self.__next_f.push(...)`, one per response) end up with a matching nonce
  // attribute, with no app code involved.
  //
  // Mutating request.headers is what makes it visible to the render: both
  // branches below hand this same object to NextResponse.next({ request }) /
  // rewrite({ request }) — next-intl copies `new Headers(request.headers)`,
  // updateSession passes the request straight through — and Next serialises
  // every one of those headers into x-middleware-request-* for the server to
  // replay onto the request it renders. Set it before either branch runs.
  //
  // If this ever stops working the symptom is unmissable rather than subtle:
  // the inline scripts render without a nonce, the browser blocks all of them,
  // and every page arrives as unhydrated HTML with a wall of CSP errors.
  request.headers.set('content-security-policy', csp);
  // Nothing reads this today. It is the documented escape hatch for a Server
  // Component that has to nonce an inline script of its own:
  // `(await headers()).get('x-nonce')`. Know before reaching for it that
  // reading headers() opts that route into dynamic rendering permanently.
  request.headers.set('x-nonce', nonce);

  const response = await routeRequest(request);

  // The policy the browser enforces. It has to carry the same nonce as the
  // markup that was just rendered, which is why this header cannot live in
  // next.config.js or vercel.json any more: a static header cannot know it.
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

/**
 * The original routing decision, unchanged. Kept as a separate function purely
 * so the CSP wrapper above cannot get tangled up in it — this file has silently
 * disabled the dashboard auth guard once before, and every path through here
 * still ends in exactly one of intlMiddleware / kioskUrlRedirect / updateSession.
 */
async function routeRequest(request: NextRequest) {
  if (isLocalizedRoute(request.nextUrl.pathname)) {
    const response = intlMiddleware(request);
    response.headers.set('Cache-Control', MARKETING_CACHE_CONTROL);
    // next-intl sets a NEXT_LOCALE cookie on every response. With
    // localeDetection disabled the locale is fully URL-determined, so the
    // cookie is dead weight on every marketing response. Drop it. (This was
    // originally here because Vercel's CDN refuses to cache anything carrying
    // Set-Cookie; that reason is gone with the s-maxage above, but sending an
    // unused cookie to every anonymous visitor is still worth not doing.
    // Marketing routes never run Supabase updateSession, so no auth/session
    // cookie is at stake.)
    response.headers.delete('set-cookie');
    return response;
  }

  // The wall-mounted growth board and its deploy-version poll. A `?k=` shared
  // secret is exchanged here for an HttpOnly cookie and then dropped from the
  // URL, so the token stops being written into Vercel's access logs, into any
  // proxy in the path and into the Pi's browser history on every one of the
  // ~105,000 requests that display makes a year. Audit finding F-06; the full
  // reasoning, including why the redirect waits for the browser to prove it
  // kept the cookie, is in src/lib/admin/kiosk-cookie.ts.
  //
  // The redirect is checked BEFORE updateSession because there is no session to
  // refresh on it. None of this is load-bearing for authorisation: the page and
  // the version route both call requireKioskAccess() themselves, which re-checks
  // the cookie server side. What happens here only decides what ends up in a URL.
  const kiosk = isKioskPath(request.nextUrl.pathname);
  if (kiosk) {
    const redirect = await kioskUrlRedirect(request);
    if (redirect) return redirect;
  }

  const response = await updateSession(request);

  // Issue the cookie on a `?k=` bootstrap, and slide its expiry forward on
  // every request after that. The display cannot be logged back in by hand (no
  // keyboard, and SSH to it does not work from the maintainer's machine), so
  // its credential must never be allowed to age out under a running board.
  if (kiosk) await refreshKioskCookie(request, response);

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     *  - _next/static  (static files)
     *  - _next/image   (image optimisation endpoint)
     *  - favicon.ico
     *  - common image/font extensions
     *  - video and caption files: a <video> issues many ranged requests,
     *    and without this each one runs updateSession() and a Supabase
     *    auth round-trip, then answers with cookies the CDN will not cache.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|mp4|webm|mov|m4v|ogg|vtt)$).*)',
  ],
};
