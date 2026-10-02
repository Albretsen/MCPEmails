/**
 * The coarse device class a signup came from: mobile, tablet or desktop.
 *
 * WHY. The only device signal used to be auth.sessions.user_agent, and for
 * Google and GitHub signups (about two thirds of all signups) that says `node`,
 * because the session is created server-side in the OAuth callback. So "do
 * phone signups activate worse than desktop ones?" could only be asked of the
 * password third.
 *
 * WHAT IS KEPT. One of three words, in workspaces.acquisition_device. The
 * User-Agent string is read from the request, classified here and dropped: it
 * is never stored, logged or passed on. This file is the whole privacy
 * boundary for it, the way HOST_SOURCES is for referrers.
 *
 * The same words are pinned by workspaces_acquisition_device_check in
 * supabase/migrations/20261002100000_acquisition_device.sql. The drift test in
 * acquisition-device.test.mjs reads that migration and compares the two lists.
 */
export const DEVICES = new Set(['mobile', 'tablet', 'desktop']);

/** A class from anywhere outside this file is only ever one of the three words. */
export function sanitizedDevice(value) {
  return DEVICES.has(value) ? value : null;
}

// Every current browser still opens its User-Agent with this token. `node`,
// `undici`, `curl/8.7.1`, `python-requests/2.32` and the like do not, and those
// are exactly the agents that must come out as unknown rather than desktop.
const BROWSER_PREFIX = /^(?:Mozilla|Opera)\//;

// Crawlers and link previewers borrow the Mozilla prefix. They name themselves
// `Googlebot/2.1`, `bingbot/2.0;`, `Slackbot-LinkExpanding`, so `bot` only
// counts when it ends a product token; a bare `bot` would also match the
// handset maker Cubot.
const BOT = /bot[/;)-]|crawler|spider|headlesschrome|lighthouse|facebookexternalhit|preview/i;

// Tablets that say so. `Tablet PC` is an old Windows desktop token, not a tablet.
const TABLET = /iPad|Tablet(?! PC)|Silk\/|Kindle|PlayBook/i;
const PHONE = /iPhone|iPod|Android|Mobile|Windows Phone|IEMobile|BlackBerry|Opera Mini/i;

/**
 * Classify one request. Returns 'mobile' | 'tablet' | 'desktop' | null.
 *
 * `mobileHint` is the raw Sec-CH-UA-Mobile header (`?1` or `?0`). Chromium
 * sends it on every HTTPS request without being asked, and it is the browser's
 * own answer rather than a guess from a string, so it wins where the two
 * disagree (an Android phone in "desktop site" mode sends a Linux desktop UA
 * but still `?1`). Safari and Firefox do not send it, and then the UA decides.
 *
 * Android has no tablet token: a phone says `Mobile` and a tablet does not, so
 * Android without `Mobile` (or with a `?0` hint) is a tablet.
 *
 * KNOWN LIMIT. iPadOS Safari asks for the desktop site by default and then
 * sends a Macintosh User-Agent that is byte for byte a Mac's. The only way to
 * tell them apart is navigator.maxTouchPoints, which exists in the browser and
 * not in any request header, so those iPads are counted as desktop. An iPad
 * that identifies itself (mobile-site mode, most in-app browsers) is a tablet.
 *
 * Empty, non-browser and crawler agents are null, never desktop: an unknown
 * must not be allowed to pad the desktop column.
 */
export function deviceClass(userAgent, mobileHint = null) {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!ua || !BROWSER_PREFIX.test(ua) || BOT.test(ua)) return null;
  const hint = mobileHint === '?1' ? true : mobileHint === '?0' ? false : null;
  if (hint === true) return 'mobile';
  if (TABLET.test(ua)) return 'tablet';
  const android = /Android/i.test(ua);
  if (android && (hint === false || !/Mobile/i.test(ua))) return 'tablet';
  if (hint === false) return 'desktop';
  return PHONE.test(ua) ? 'mobile' : 'desktop';
}

/** The class of the browser that made this request. Takes a Fetch `Headers`. */
export function deviceClassFromHeaders(headers) {
  return deviceClass(headers?.get('user-agent'), headers?.get('sec-ch-ua-mobile'));
}
