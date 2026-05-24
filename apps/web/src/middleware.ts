import { updateSession } from '@/lib/supabase/middleware';
import type { NextRequest } from 'next/server';

/**
 * Next.js middleware entry point.
 *
 * Delegates to updateSession, which:
 *  - Refreshes the Supabase session cookie on every request
 *  - Redirects unauthenticated users away from protected routes to /login
 *
 * The matcher below ensures middleware only runs on page and API requests,
 * not on static assets or Next.js internals (_next/*).
 */
export async function middleware(request: NextRequest) {
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
