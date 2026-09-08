import { CLIENTS, getClient, clientLocales } from './clients.mjs';

/**
 * Copy for one client setup page, in one locale.
 *
 * Deliberately not a next-intl namespace, for the same reason the provider
 * copy is not (see src/lib/connect/content.mjs): src/i18n/request.ts loads
 * every marketing namespace for every page under app/[locale], and the root
 * layout serialises all of them into the HTML. Client copy loaded here is paid
 * for only by the page that renders it.
 *
 * Returns null rather than throwing when a locale has no translation, so
 * generateStaticParams and the hreflang alternates agree on exactly which
 * locale/client pairs exist. These pages ship in English only for now: an
 * hreflang pointing at a locale that does not exist is worse than no hreflang,
 * and a machine-translated page about Windsurf's config field name is the
 * scaled-content pattern search engines demote.
 */
export async function getClientContent(locale, slug) {
  if (!getClient(slug)) return null;
  if (!clientLocales(slug).includes(locale)) return null;
  try {
    const mod = await import(`./content/${locale}/${slug}.json`);
    return mod.default;
  } catch {
    return null;
  }
}

/** Every locale/client pair that has a page. */
export function clientParams() {
  return CLIENTS.flatMap((c) => c.locales.map((locale) => ({ locale, client: c.slug })));
}

/** Locales that have at least one client page, for the hub route. */
export function clientHubLocales() {
  return [...new Set(CLIENTS.flatMap((c) => c.locales))];
}
