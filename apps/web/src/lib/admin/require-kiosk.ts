import { cookies } from 'next/headers';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  KIOSK_COOKIE_NAME,
  expectedKioskCookie,
  timingSafeEqual,
} from '@/lib/admin/kiosk-cookie';

/**
 * Access control for the wall-mounted kiosk view of /admin/growth.
 *
 * The kiosk runs on a Raspberry Pi that boots straight into Chromium with no
 * keyboard attached, so it can never complete an interactive Supabase login.
 * `requireAdmin()` alone would make the display permanently 404, which is why
 * a second door exists: a single high-entropy shared secret in `KIOSK_TOKEN`.
 *
 * Since 2026-08-30 that secret is presented ONCE, as `?k=`, and immediately
 * exchanged by the proxy for an HttpOnly cookie; every request after the
 * bootstrap authenticates by cookie with no token in any URL. See
 * kiosk-cookie.ts for why (finding F-06: a query-string secret ends up in
 * access logs, proxies and the Pi's browser history) and for the cookie's
 * shape. `?k=` is still accepted directly here as well, because the proxy is
 * not the only way a request can reach this guard and a page that only works
 * when middleware ran is a page with an invisible dependency.
 *
 * Three properties keep that door narrow.
 *
 * 1. IT IS OFF UNLESS CONFIGURED. An unset or empty `KIOSK_TOKEN` disables
 *    token access entirely rather than accepting an empty `?k=`, so a
 *    misconfigured preview deployment does not silently publish the numbers.
 *    The cookie path enforces the same rule from the other side:
 *    `expectedKioskCookie()` returns null when the token is unset, and null
 *    never matches anything.
 * 2. IT ONLY OPENS THE KIOSK. Nothing else calls this helper; every other
 *    admin route still requires a real operator session. The cookie is scoped
 *    to the two paths that need it, so it is not even sent anywhere else.
 * 3. THE KIOSK SHOWS NO IDENTITY. The page this guards renders aggregates
 *    only, deliberately omitting the Active accounts roster that is the one
 *    part of /admin/growth carrying workspace names and owner email
 *    addresses. Someone holding the token learns counts, never customers.
 *
 * Both comparisons are constant time. The saving is theoretical at this
 * traffic level, but a token check that leaks its prefix through timing is the
 * kind of thing that gets copied into somewhere it matters.
 */
export async function requireKioskAccess(token: string | undefined): Promise<void> {
  const expectedToken = process.env.KIOSK_TOKEN?.trim();

  if (expectedToken && token && timingSafeEqual(token, expectedToken)) return;

  // The normal path for the wall display: no token anywhere in the request,
  // just the cookie it was issued when a human first pointed it at the URL.
  const expectedCookie = await expectedKioskCookie();
  if (expectedCookie) {
    const cookieStore = await cookies();
    const presented = cookieStore.get(KIOSK_COOKIE_NAME)?.value;
    if (presented && timingSafeEqual(presented, expectedCookie)) return;
  }

  // No usable token and no usable cookie: fall back to a normal operator
  // session, so an admin can open the kiosk view in their own browser to check
  // how it looks. `requireAdmin()` calls notFound() itself when that fails.
  await requireAdmin();
}
