/**
 * The country a signup came from, as a two-letter ISO 3166-1 code.
 *
 * WHY. Nobody could tell which country users are in. acquisition_locale is
 * only the URL prefix of the landing page, so the unprefixed English site,
 * which most of the world reads, says 'en' for everyone.
 *
 * WHERE IT COMES FROM. Vercel's edge geolocates every request and passes the
 * result to the function as `x-vercel-ip-country`. That header is read here
 * and nothing else: the IP address itself is never read, stored or logged by
 * this code, and the code is the whole of what is kept.
 *
 * WHAT IS KEPT. Two uppercase letters in workspaces.acquisition_country, or
 * nothing. Missing, empty and malformed values are unknown, and so are the
 * placeholder codes that name no country: XX (unknown) and ZZ (unknown or
 * invalid territory), T1 (Tor, Cloudflare's convention, already rejected by
 * the letters-only shape) and the EU / AP region codes some geo databases
 * return for addresses they cannot place more precisely.
 *
 * The shape is also pinned by workspaces_acquisition_country_check in
 * supabase/migrations/20261020140000_acquisition_country.sql.
 */
const COUNTRY = /^[A-Z]{2}$/;

const PLACEHOLDERS = new Set(['XX', 'ZZ', 'EU', 'AP']);

/** A code from anywhere outside this file: two letters naming a country, or null. */
export function sanitizedCountry(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!COUNTRY.test(code) || PLACEHOLDERS.has(code)) return null;
  return code;
}

/** The country Vercel placed this request in. Takes a Fetch `Headers`. */
export function countryFromHeaders(headers) {
  return sanitizedCountry(headers?.get('x-vercel-ip-country'));
}
