/**
 * Cookie helpers. Pure, no next imports, safe in the middleware runtime.
 */
import {
  SUBJECT_COOKIE,
  SUBJECT_COOKIE_MAX_AGE_SECONDS,
  VARIANT_ID_PATTERN,
} from './constants.ts';

const HEX = '0123456789abcdef';

/**
 * A fresh anonymous subject id: 32 lowercase hex characters, 128 bits of
 * randomness from the platform CSPRNG. It carries no personal data, is never
 * derived from anything about the visitor, and never leaves this origin.
 */
export function generateSubjectId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/**
 * Read the owner override cookie: a JSON object of experiment key to variant
 * id. Anything malformed is dropped rather than thrown over, because this is
 * attacker-controlled input on a page render and a bad cookie must not be able
 * to 500 the homepage. Entries whose value is not a legal variant id are
 * dropped individually.
 */
export function parseOverrideCookie(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded, or badly so. Try the raw value.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!VARIANT_ID_PATTERN.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/** The inverse of parseOverrideCookie. Empty maps serialize to '{}'. */
export function serializeOverrideCookie(map: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string' || !VARIANT_ID_PATTERN.test(value)) continue;
    clean[key] = value;
  }
  return JSON.stringify(clean);
}

/**
 * Options for the subject cookie. httpOnly because no client script has any
 * business reading it, lax because it only ever needs to survive a top-level
 * navigation, secure everywhere except plain-http local development.
 */
export function subjectCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SUBJECT_COOKIE_MAX_AGE_SECONDS,
    secure: isSecure,
  };
}

/**
 * The subject cookie as a raw Set-Cookie header value. The proxy appends this
 * to the response headers directly instead of going through
 * `response.cookies.set`, because Next's response cookie jar parses whatever
 * Set-Cookie headers existed when the response was constructed and re-emits
 * all of them on the next set. On marketing routes that would resurrect the
 * NEXT_LOCALE cookie the proxy deliberately strips.
 */
export function serializeSubjectCookie(subjectId: string, isSecure: boolean): string {
  const opts = subjectCookieOptions(isSecure);
  const parts = [
    `${SUBJECT_COOKIE}=${subjectId}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
