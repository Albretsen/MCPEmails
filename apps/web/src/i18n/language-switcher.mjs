// ---------------------------------------------------------------------------
// Where each option of the footer language switcher points.
//
// A page that exists in a locale links to itself in that locale, which is the
// same URL its hreflang alternates declare. A page that does NOT exist in a
// locale (an English-only comparison, a provider or blog post without a zh
// translation, see src/i18n/locale-policy.mjs) links that option to the
// locale's home page instead. The option stays in the menu, so a reader can
// always switch language, but it never leads to a 404 or to an English fallback
// URL that canonicalises elsewhere.
//
// Plain .mjs so it can be tested under bare `node --test`.
// ---------------------------------------------------------------------------

const DEFAULT_LOCALE = 'en';

/** `pathname` (locale prefix already stripped) in `locale`, as-needed prefixing. */
export function localizedHref(locale, pathname) {
  const path = pathname || '/';
  if (locale === DEFAULT_LOCALE) return path;
  return `/${locale}${path === '/' ? '' : path}`;
}

/**
 * One entry per switcher option, in `allLocales` order.
 *
 * @param {string} pathname      the current path without its locale prefix ("/pricing")
 * @param {readonly string[]} pageLocales  the locales this page really exists in
 * @param {readonly string[]} allLocales   every locale the site serves
 * @returns {{ code: string, href: string, samePage: boolean }[]}
 */
export function languageSwitcherLinks(pathname, pageLocales, allLocales) {
  return allLocales.map((code) => {
    const samePage = pageLocales.includes(code);
    return { code, href: localizedHref(code, samePage ? pathname : '/'), samePage };
  });
}
