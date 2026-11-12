/**
 * Homepage Lab: which home page variant a request renders.
 *
 * Staging only. Production (and every non-English locale) always gets
 * `null`, which means "render today's HomeClient and nothing else". The page
 * also guards the import of the lab on NEXT_PUBLIC_APP_ENV, which is inlined at
 * build time, so a production build never bundles variant code at all; this
 * function is the runtime half of the same rule.
 *
 * `?home=v03` picks a variant and wins over the cookie; the picker then stores
 * the choice in the `home_lab` cookie so plain `/` keeps showing it.
 * `?home=v00` (or an unknown id) means today's page.
 */

export const HOME_LAB_COOKIE = 'home_lab';
export const HOME_LAB_IDS = ['v00', 'v01', 'v02', 'v03', 'v04', 'v05', 'v06', 'v07', 'v08', 'v09', 'v10'];

/**
 * @param {{ appEnv: string, locale: string, query?: string | string[] | null, cookie?: string | null }} input
 * @returns {string | null} a variant id (`v00`..`v10`) on English staging, else null.
 */
export function pickHomeLabVariant({ appEnv, locale, query = null, cookie = null }) {
  if (appEnv !== 'staging' || locale !== 'en') return null;
  const fromQuery = Array.isArray(query) ? query[0] : query;
  for (const candidate of [fromQuery, cookie]) {
    const id = typeof candidate === 'string' ? candidate.trim().toLowerCase() : '';
    if (HOME_LAB_IDS.includes(id)) return id;
  }
  return 'v00';
}

/**
 * The proxy's half: the internal route `/` is rewritten to on English staging,
 * or null to leave the request alone. Only the bare English home path is ever
 * rewritten; v00 (today's page) is never rewritten.
 *
 * @param {{ appEnv: string, pathname: string, query?: string | null, cookie?: string | null }} input
 * @returns {string | null}
 */
export function homeLabRewritePath({ appEnv, pathname, query = null, cookie = null }) {
  if (pathname !== '/') return null;
  const id = pickHomeLabVariant({ appEnv, locale: 'en', query, cookie });
  return id && id !== 'v00' ? `/home-lab/${id}` : null;
}
