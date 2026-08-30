import { NextResponse, type NextRequest } from 'next/server';

/**
 * Turning the kiosk's shared secret into a cookie, once, at the door.
 *
 * WHY THIS EXISTS. `KIOSK_TOKEN` used to be presented as `?k=` on every single
 * request the wall display made: the initial page load, the five-minute
 * `router.refresh()`, and the deploy-version poll behind it. A secret in a
 * query string is a secret written down in several places nobody thinks of as
 * a secret store — Vercel's access logs, any proxy or CDN in the path, the
 * Referer header of anything the page loads cross-origin, and the Chromium
 * history and session-restore file on a Raspberry Pi that lives in an office
 * anyone can walk through. It is finding F-06 of the 2026-08-30 ADA-CASA
 * pre-submission audit and it is a fair one: none of those places are attacked,
 * they are simply read, months later, by someone who was never thinking about
 * the kiosk at all.
 *
 * WHAT REPLACES IT. The token is still accepted as `?k=`, as the bootstrap: a
 * human points the Pi's Chromium at the URL with the token in it, the proxy
 * exchanges it for this cookie, and everything the board does afterwards — the
 * five-minute refresh, the deploy-version poll, every reload — authenticates by
 * cookie with no token in any URL. Once the browser has proved it kept the
 * cookie, the proxy also redirects `?k=` off the address bar; see
 * `kioskUrlRedirect` for why that step waits for proof rather than assuming it.
 * The cookie is HttpOnly (so page script cannot read it back out and put it
 * somewhere worse), Secure in production, and SameSite=Lax.
 *
 * WHAT THE COOKIE HOLDS. Not the token. It holds SHA-256 of a fixed label
 * concatenated with the token, which buys three things for one line of code:
 * the value in the browser's cookie jar cannot be pasted back into `?k=` or
 * into any other consumer of `KIOSK_TOKEN`; a leaked cookie is not visibly
 * "the KIOSK_TOKEN" to whoever finds it; and rotating `KIOSK_TOKEN` invalidates
 * every outstanding cookie for free, with no revocation list to maintain. It is
 * still a bearer credential for this one page — the point is only that it is a
 * different, narrower one than the master secret.
 *
 * WHAT DID NOT CHANGE. The three properties from require-kiosk.ts still hold,
 * and are still the reason this door is acceptable at all: it is off unless
 * `KIOSK_TOKEN` is configured, it opens nothing but the kiosk, and the kiosk
 * shows aggregates with no customer identity on it.
 */

/**
 * Not prefixed `__Host-`, which would otherwise be the obvious choice for a
 * cookie like this. `__Host-` requires `Path=/`, and pinning these cookies to
 * the two paths that actually need them (below) is worth more here than the
 * prefix is: it keeps a bearer credential off every marketing page request,
 * which are the CDN-cached ones, and off every other admin route.
 */
export const KIOSK_COOKIE_NAME = 'mcpe_kiosk';

/**
 * The cookie is issued once per path rather than once at `/`.
 *
 * Two surfaces need it and no others: the board itself, and the deploy-version
 * poll the board makes every five minutes. Scoping it this narrowly means an
 * operator who once opened the kiosk in their normal browser is not attaching a
 * kiosk credential to every page of mcpemails.com they visit afterwards, and
 * the marketing routes (which the proxy deliberately serves from the CDN, see
 * MARKETING_CACHE_CONTROL) never see a Cookie header they would have to vary
 * on.
 *
 * Cookie Path is a prefix match on path segments, so `/api/kiosk` covers
 * `/api/kiosk/version` and anything added beside it later.
 */
const KIOSK_COOKIE_PATHS = ['/admin/growth/kiosk', '/api/kiosk'] as const;

/**
 * Ninety days, renewed on every kiosk request (see `refreshKioskCookie`).
 *
 * The renewal is what makes the number safe to pick: a board that is up and
 * ticking every five minutes refreshes its own credential and can never reach
 * the expiry, so this is really "how long a kiosk may stay switched off before
 * it needs re-bootstrapping", not "how long until the display dies". Ninety
 * days covers a panel unplugged for a move or a long holiday.
 *
 * It is finite rather than permanent because the cookie is a bearer credential
 * sitting in a browser profile on a device in a shared office. A profile copied
 * off a decommissioned Pi should stop working on its own, without anyone having
 * to remember that it exists. Even if it does not: the display is bootstrapped
 * from a URL that still carries `?k=`, so rotating `KIOSK_TOKEN` in Vercel
 * revokes every cookie ever issued, and the Pi re-bootstraps on its next
 * Chromium restart.
 */
const KIOSK_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/**
 * Domain-separates the digest so the cookie value can never collide with some
 * other hash of the same secret computed elsewhere for another purpose.
 */
const KIOSK_COOKIE_LABEL = 'mcpe-kiosk-cookie-v1:';

/** True when `KIOSK_TOKEN` bootstrap applies to this path at all. */
export function isKioskPath(pathname: string): boolean {
  return KIOSK_COOKIE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * The cookie value a correctly configured kiosk should be presenting.
 *
 * Returns null when `KIOSK_TOKEN` is unset or empty, which is the off-unless-
 * configured rule from require-kiosk.ts restated at the one other place that
 * can now grant access. A misconfigured preview deployment must publish the
 * numbers to nobody, and "no expected value" must never be satisfiable by "no
 * presented value".
 */
export async function expectedKioskCookie(): Promise<string | null> {
  const token = process.env.KIOSK_TOKEN?.trim();
  if (!token) return null;

  const bytes = new TextEncoder().encode(`${KIOSK_COOKIE_LABEL}${token}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string compare, in the sense that matters: the loop always
 * runs to the end rather than returning early at the first differing byte, so
 * response time does not reveal how much of the secret a guess got right.
 *
 * It does not hide the *length* of the supplied value, which is fine: the
 * length of the guess is the attacker's own input, and the length of the
 * secret is folded in by the initial XOR rather than by an early return.
 *
 * Lives here rather than in require-kiosk.ts because both doors — the `?k=`
 * bootstrap in the proxy and the cookie check in the page guard — must use it,
 * and a second copy is a second thing to get wrong.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The URL-stripping half, called from the proxy on kiosk paths.
 *
 * Returns a redirect to the same URL with `k` removed — so the token stops
 * being re-logged on every load — but ONLY once the request proves the browser
 * is already holding a valid kiosk cookie.
 *
 * THAT CONDITION IS THE WHOLE POINT, and it is there because of what the
 * display is. The board is a Raspberry Pi with no keyboard that we cannot SSH
 * into; it is pointed at a bootstrap URL carrying `?k=` by a human, once, and
 * then left alone for months. If this redirected on first contact, purely on
 * the strength of having *sent* a Set-Cookie, then any browser that did not
 * keep the cookie (a locked-down profile, cookies cleared on exit, a policy
 * nobody remembers setting) would land on a clean URL it cannot authenticate,
 * 404, reload into the same 404, and hang there until somebody walked over to
 * the wall. Requiring the cookie to come back first makes the failure mode
 * impossible: a browser that will not store cookies simply keeps rendering
 * from `?k=` exactly as it does today, which is a working board.
 *
 * The cost is that the first load after a bootstrap keeps the token in the
 * address bar until the board's next reload (it reloads daily, and on every
 * deploy). That is one extra logged request with the token in it, in exchange
 * for a display that cannot be stranded by a browser setting we cannot inspect.
 *
 * The redirect also carries a refreshed cookie, so a reload never shortens the
 * credential's life.
 */
export async function kioskUrlRedirect(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (!request.nextUrl.searchParams.has('k')) return null;

  const expected = await expectedKioskCookie();
  const presented = request.cookies.get(KIOSK_COOKIE_NAME)?.value;
  if (!expected || !presented || !timingSafeEqual(presented, expected)) return null;

  const destination = request.nextUrl.clone();
  destination.searchParams.delete('k');
  const response = NextResponse.redirect(destination);
  setKioskCookie(response, expected);
  return response;
}

/**
 * Issues or renews the cookie on the way out of every kiosk request, from
 * whichever credential the request actually carried.
 *
 * FROM `?k=`: this is the bootstrap. A human points the Pi at the URL with the
 * token in it once, and the response teaches the browser the cookie it will use
 * for everything afterwards, including the five-minute version poll — which is
 * the request that used to write the secret into an access log 105,000 times a
 * year.
 *
 * FROM AN EXISTING COOKIE: this is sliding expiry, and it is not optional here.
 * If the cookie ever aged out under a running board, the next
 * `window.location.reload()` — daily, and on every deploy — would land on a
 * clean URL with no credential and 404 until a human intervened. Renewing on
 * every request means the ninety-day clock only ever runs while the display is
 * switched off, which is the case it is actually sized for.
 *
 * Mints nothing when `KIOSK_TOKEN` is unset (`expectedKioskCookie()` returns
 * null) and nothing when neither credential checks out, so this can never turn
 * a bad guess into a working session.
 */
export async function refreshKioskCookie(
  request: NextRequest,
  response: NextResponse,
): Promise<void> {
  const expected = await expectedKioskCookie();
  if (!expected) return;

  const token = process.env.KIOSK_TOKEN?.trim();
  const presentedToken = request.nextUrl.searchParams.get('k');
  if (token && presentedToken && timingSafeEqual(presentedToken, token)) {
    setKioskCookie(response, expected);
    return;
  }

  const presentedCookie = request.cookies.get(KIOSK_COOKIE_NAME)?.value;
  if (presentedCookie && timingSafeEqual(presentedCookie, expected)) {
    setKioskCookie(response, expected);
  }
}

/**
 * Writes one Set-Cookie header per scoped path.
 *
 * WHY THE HEADER IS APPENDED BY HAND rather than going through
 * `response.cookies.set()`, which is what every other cookie writer in this app
 * uses. `NextResponse.cookies` is a map keyed by cookie NAME alone, so setting
 * the same name twice with different paths keeps only the last one — the first
 * write is dropped with no error. Caught by the probe written alongside this
 * change: the board path silently lost its cookie and only /api/kiosk got one,
 * which would have shipped a display that authenticated its version poll and
 * 404'd its own page. Raw appends are the only way to emit two same-named
 * cookies from one response.
 *
 * The value is lowercase hex, so no cookie-value escaping is needed or done.
 */
function setKioskCookie(response: NextResponse, value: string): void {
  for (const path of KIOSK_COOKIE_PATHS) {
    const attributes = [
      `${KIOSK_COOKIE_NAME}=${value}`,
      `Path=${path}`,
      `Max-Age=${KIOSK_COOKIE_MAX_AGE_SECONDS}`,
      // Page script must never be able to read this back out and put it
      // somewhere worse than it already was.
      'HttpOnly',
      // Lax, not Strict. The bootstrap is a top-level navigation the browser
      // performs itself, which both allow — but Lax additionally survives the
      // display being pointed at the URL from a launcher, a bookmark or a
      // restored session, which is how the Pi is actually driven. The cookie
      // authorises a read-only aggregate page with no state-changing route
      // behind it, so the CSRF surface Strict would buy back is empty.
      'SameSite=Lax',
    ];
    // Matches the other cookie writers in this app (see
    // app/api/workspaces/route.ts): Secure is unconditional in production and
    // relaxed only on localhost, where http:// cannot set a Secure cookie at
    // all and the kiosk would otherwise be undebuggable in dev.
    if (process.env.NODE_ENV === 'production') attributes.push('Secure');

    response.headers.append('set-cookie', attributes.join('; '));
  }
}
