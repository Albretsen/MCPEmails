import { getProvider, providerLocales } from './providers.mjs';
import { releasedProviderParams } from './release.mjs';

/**
 * Copy for one provider landing page, in one locale.
 *
 * Deliberately not a next-intl namespace. The root layout hands every loaded
 * namespace to NextIntlClientProvider, so anything living in `messages/` is
 * serialised into the HTML of every marketing page. Provider copy is ~700 bytes
 * per provider per locale; across 106 providers that is a quarter of a megabyte
 * of JSON on the home page for the benefit of nobody. Loading it here instead
 * keeps it server-side, where the page that needs it is the only page that
 * pays for it.
 *
 * Returns null rather than throwing when a locale has no translation, so
 * generateStaticParams and the hreflang alternates can agree on exactly which
 * locale/provider pairs exist.
 */
export async function getProviderContent(locale, slug) {
  if (!getProvider(slug)) return null;
  if (!providerLocales(slug).includes(locale)) return null;
  try {
    const mod = await import(`./content/${locale}/${slug}.json`);
    return mod.default;
  } catch {
    return null;
  }
}

/**
 * Locale/provider pairs to generate. Delegates to the release gate, so a wave
 * that has not opened yet produces no route, no sitemap entry and no link.
 */
export function providerParams() {
  return releasedProviderParams();
}
