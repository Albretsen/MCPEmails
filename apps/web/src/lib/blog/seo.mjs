/** Build hreflang entries only for locales with real translated content. */
export function blogPostLanguageAlternates(locales, pathname, localeUrl) {
  const languages = Object.fromEntries(
    locales.map((locale) => [locale, localeUrl(locale, pathname)]),
  );
  languages['x-default'] = localeUrl('en', pathname);
  return languages;
}

/** English fallback posts must point structured data at their canonical URL. */
export function blogPostCanonicalLocale(localizedPost, requestedLocale) {
  return localizedPost.translated ? requestedLocale : 'en';
}
