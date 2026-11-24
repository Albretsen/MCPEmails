// ---------------------------------------------------------------------------
// The provider pages the site footer links, with the locales each one exists in.
//
// The footer is a client component, so it cannot import the provider registry
// (providers.mjs is ~2000 lines and would ship to every page). The locale lists
// are copied here instead, and footer-providers.test.mjs fails when one drifts
// from providerLocales(). Before this list, the /pt and /ja footers linked
// /pt/connect/yandex and /ja/connect/yandex on every page: both 404, because
// Yandex has no pt or ja copy. The /docs/providers matrix and the help-center
// links (src/lib/support/help-links.mjs), also client-side, use the same list.
// ---------------------------------------------------------------------------

const ALL = ['en', 'nb', 'es', 'fr', 'zh', 'de', 'pt', 'ja'];

/** Footer order. `key` is the label key in the `compare` namespace. */
export const FOOTER_PROVIDERS = [
  { slug: 'imap', key: 'links.connectImap', locales: ALL },
  { slug: 'gmail', key: 'links.connectGmail', locales: ALL },
  { slug: 'google-workspace', key: 'links.connectGoogleWorkspace', locales: ALL },
  { slug: 'outlook', key: 'links.connectOutlook', locales: ALL },
  { slug: 'fastmail', key: 'links.connectFastmail', locales: ALL },
  { slug: 'icloud', key: 'links.connectIcloud', locales: ALL },
  { slug: 'yahoo', key: 'links.connectYahoo', locales: ALL },
  { slug: 'zoho', key: 'links.connectZoho', locales: ALL },
  { slug: 'yandex', key: 'links.connectYandex', locales: ['en', 'nb', 'es', 'fr', 'zh', 'de'] },
];

/** The footer provider links whose page exists in `locale`. */
export function footerProviders(locale) {
  return FOOTER_PROVIDERS.filter((p) => p.locales.includes(locale));
}

/**
 * Blog guides the footer's Resources column links, with the locales each post
 * is translated into (its folder under src/lib/blog/translations, plus en).
 * Both were "discovered, not indexed" in Search Console on 2026-11-24 with
 * almost no internal links. Where a post has no translation the footer links
 * its English URL with a plain <a>: the localized URL is a 308 to it.
 * `key` is the label key in the `home` namespace.
 */
export const FOOTER_GUIDES = [
  { slug: 'what-is-an-mcp-email-server', key: 'footer.linkWhatIsMcp', locales: ['en', 'es', 'fr', 'nb', 'zh'] },
  { slug: 'connect-any-email-to-claude-and-chatgpt', key: 'footer.linkAnyEmail', locales: ['en', 'de', 'es', 'fr', 'nb'] },
];

/** The footer guides with `localized` set where the post exists in `locale`. */
export function footerGuides(locale) {
  return FOOTER_GUIDES.map((g) => ({ ...g, href: `/blog/${g.slug}`, localized: g.locales.includes(locale) }));
}
