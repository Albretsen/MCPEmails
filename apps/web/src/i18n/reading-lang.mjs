/**
 * Carry the language a visitor was reading into signup and login.
 *
 * WHY. Marketing pages are localized by URL (/fr/pricing), but /signup, /login
 * and the dashboard are not: AppLocaleProvider picks their language from the
 * stored choice (localStorage `mcpe-locale`), else the browser language. So a
 * person reading the French site with an English browser got an English signup
 * form and an English dashboard. Every signup and login link on a localized
 * page now says which language the page was in (`/signup?lang=fr`), and the
 * signup and login pages adopt it and store it, so the dashboard opens in the
 * same language after the Google or GitHub round trip too.
 *
 * English pages add nothing: English is the default, and a bare /signup keeps
 * the browser-language behaviour for everyone who did not come from a
 * translated page.
 *
 * Plain .mjs on purpose: marketing client components, the signup and login
 * Server Components and node:test all import it as is.
 */

/** The query parameter, on /signup and /login. */
export const LANG_PARAM = 'lang';

/**
 * The languages the app realm speaks. Must equal routing.locales in
 * src/i18n/routing.ts (reading-lang.test.mjs compares the two), restated here
 * so this file stays importable without a TypeScript loader.
 */
export const APP_LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

const DEFAULT_LOCALE = 'en';

/** The paths that read the parameter. Anything else is left untouched. */
const TARGET_PATHS = new Set(['/signup', '/login']);

/**
 * A `lang` value as it arrives from searchParams: a supported locale, or null.
 * Exact match only ('fr', not 'FR' or 'fr-CA'), and an array (a repeated
 * parameter) is ignored rather than guessed at.
 */
export function readingLangFromParam(value) {
  return typeof value === 'string' && APP_LOCALES.includes(value) ? value : null;
}

/**
 * `href` with `?lang=<locale>` added when it points at /signup or /login and
 * the page is in a language other than English. Existing query parameters
 * (redirect, provider, plan) and a #fragment are kept as they are, and an href
 * that already names a language is not changed.
 */
export function withReadingLang(href, locale) {
  if (typeof href !== 'string') return href;
  const lang = readingLangFromParam(locale);
  if (!lang || lang === DEFAULT_LOCALE) return href;

  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  if (!TARGET_PATHS.has(path)) return href;

  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);
  const params = new URLSearchParams(query);
  if (params.has(LANG_PARAM)) return href;
  const joined = query ? `${query}&${LANG_PARAM}=${lang}` : `${LANG_PARAM}=${lang}`;
  return `${path}?${joined}${hash}`;
}

/**
 * withReadingLang for an href that is already HTML-escaped, as the blog
 * renderer's links are (`&` arrives as `&amp;`). Undo the escape to edit the
 * query, then redo it.
 */
export function withReadingLangEscaped(escapedHref, locale) {
  if (typeof escapedHref !== 'string') return escapedHref;
  return withReadingLang(escapedHref.replace(/&amp;/g, '&'), locale).replace(/&/g, '&amp;');
}
