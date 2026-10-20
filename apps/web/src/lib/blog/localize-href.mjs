/**
 * Locale prefix for the links inside a blog post body.
 *
 * Post bodies are Markdown, and their internal links are written once, as the
 * English path ("/connect/yahoo", "/blog/claude-imap-connector"), in every
 * translation. Until 2026-10-20 the renderer emitted them verbatim, so a French
 * reader on /fr/blog/x was sent to English pages by every link in the body, and
 * Google saw about 230 links per locale pointing out of the language.
 *
 * The mapping adds the locale prefix only where that page exists in the locale:
 *   - /blog/<slug>: the post is translated into the locale (an untranslated
 *     post's localized URL is an English fallback that canonicalises to the
 *     English URL, so the English URL is the honest link);
 *   - /connect/<slug>: the provider page is published in the locale;
 *   - the other localized sections listed in LOCALIZED_ROOTS.
 * Everything else (/signup, /login, /dashboard, /api, English-only pages such
 * as /best-email-mcp-servers) is left alone: those routes live outside
 * app/[locale] or have no localized version, and a prefix would 404.
 */

/** First path segments of routes under app/[locale] that exist in every locale. */
const LOCALIZED_ROOTS = new Set([
  'blog',
  'connect',
  'docs',
  'pricing',
  'security',
  'about',
  'self-hosting',
  'native-connectors-vs-mcp',
  'for',
  'changelog',
  'status',
  'privacy',
  'terms',
]);

/**
 * Build the href mapper for one locale.
 *
 * @param {string} locale
 * @param {{ postLocales: (slug: string) => string[] | null, providerLocales: (slug: string) => string[] | null }} lookups
 *   postLocales returns the locales a post is translated into (null when there
 *   is no such post); providerLocales the same for a provider page.
 */
export function localizeHrefFor(locale, { postLocales, providerLocales }) {
  if (!locale || locale === 'en') return (href) => href;
  return (href) => {
    const m = href.match(/^\/([^?#]*)([?#].*)?$/);
    if (!m) return href;
    const path = m[1].replace(/\/$/, '');
    const rest = m[2] ?? '';
    if (path === '') return `/${locale}${rest}`;
    const [root, slug, ...more] = path.split('/');
    if (!LOCALIZED_ROOTS.has(root)) return href;
    if (root === 'blog' && slug && !more.length) {
      return postLocales(slug)?.includes(locale) ? `/${locale}${href}` : href;
    }
    if (root === 'connect' && slug && !more.length) {
      return providerLocales(slug)?.includes(locale) ? `/${locale}${href}` : href;
    }
    return `/${locale}${href}`;
  };
}
