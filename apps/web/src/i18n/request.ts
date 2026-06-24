import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing';

/**
 * Marketing (SEO) message namespaces loaded for the server-rendered, URL-based
 * locale realm: the public pages under app/[locale]. The authenticated app and
 * auth screens use a separate client-side provider (see AppLocaleProvider) with
 * its own namespaces (dashboard, auth, ...), so those are intentionally not
 * loaded here.
 */
const MARKETING_NAMESPACES = ['home', 'pricing', 'docs', 'privacy', 'terms', 'security', 'blog', 'compare', 'connect', 'forFounders'] as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const entries = await Promise.all(
    MARKETING_NAMESPACES.map(async (ns) => {
      const mod = await import(`../../messages/${locale}/${ns}.json`);
      return [ns, mod.default] as const;
    }),
  );

  return {
    locale,
    messages: Object.fromEntries(entries),
  };
});
