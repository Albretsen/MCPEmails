import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';
import { FALLBACK_LOCALE, isFrozenLocale, withEnglishFallback } from './locale-policy.mjs';

/**
 * Marketing (SEO) message namespaces loaded for the server-rendered, URL-based
 * locale realm: the public pages under app/[locale]. The authenticated app and
 * auth screens use a separate client-side provider (see AppLocaleProvider) with
 * its own namespaces (dashboard, auth, ...), so those are intentionally not
 * loaded here.
 */
const MARKETING_NAMESPACES = ['home', 'pricing', 'docs', 'privacy', 'terms', 'security', 'selfHosting', 'about', 'blog', 'compare', 'connect', 'forFounders'] as const;

async function loadNamespace(locale: string, ns: string): Promise<Record<string, unknown>> {
  try {
    const mod = await import(`../../messages/${locale}/${ns}.json`);
    return mod.default;
  } catch (error) {
    // A frozen locale may lack a namespace added after it was frozen; it then
    // renders that namespace in English (see locale-policy.mjs). A full locale
    // missing a file is a real bug, and the i18n-coverage test catches it first.
    if (isFrozenLocale(locale)) return {};
    throw error;
  }
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const entries = await Promise.all(
    MARKETING_NAMESPACES.map(async (ns) => {
      const own = await loadNamespace(locale, ns);
      // Frozen locales (zh) are laid over English, so a key added after the
      // freeze renders English instead of a raw key path or a logged
      // MISSING_MESSAGE error. Full locales are used as they are.
      const messages = isFrozenLocale(locale)
        ? withEnglishFallback(locale, own, await loadNamespace(FALLBACK_LOCALE, ns))
        : own;
      return [ns, messages] as const;
    }),
  );

  return {
    locale,
    messages: Object.fromEntries(entries),
  };
});
