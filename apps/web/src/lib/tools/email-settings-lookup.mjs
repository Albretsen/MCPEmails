/**
 * Facts, links and dates for /tools/email-settings-lookup. The prose lives in
 * ./email-settings-lookup/<locale>.json; the lookup itself in
 * ./settings-lookup.ts, which runs in the visitor's browser.
 *
 * Not a next-intl namespace, for the reason given in
 * src/lib/connect/content.mjs: everything under `messages/` is serialised into
 * every marketing page, and this copy is needed on one page only.
 *
 * ---------------------------------------------------------------------------
 * RULES FOR EDITING THIS PAGE
 * ---------------------------------------------------------------------------
 * 1. Every host, port and security value the copy prints (the FAQ answers for
 *    OVH Hosted Exchange and Purelymail) must equal what the tool returns for
 *    the same input, which comes from src/lib/connect/providers.mjs and
 *    src/lib/email-providers/host-presets.ts. settings-lookup.test.ts pins the
 *    tool's side; change the table, change the copy.
 *
 * 2. Copy strings may hold two kinds of markup and nothing else:
 *      <code>..</code> and <b>..</b>   rendered by RichText
 *      [label](key)                    a link to LINKS[key]
 *    Translators keep both exactly, translating only the label. Never write a
 *    raw path in a string: LINKS is where locale prefixes are decided.
 *
 * 3. Claims about other companies (Microsoft, Mozilla, Cloudflare) and about
 *    the standards are backed by SOURCES, read on CHECKED_ON.
 *
 * 4. No pricing, no plan limits, no tool counts.
 */

export const PATH = '/tools/email-settings-lookup';

/** First published, for JSON-LD and the sitemap. */
export const DATE_PUBLISHED = '2026-10-21';

/** Last content change. */
export const DATE_MODIFIED = '2026-10-21';

/** The date the third-party and standards claims were last read at their source. */
export const CHECKED_ON = '2026-10-20';

/**
 * Locales with a content file. zh is frozen (src/i18n/locale-policy.mjs) and
 * has none, so /zh/tools/email-settings-lookup 404s and is left out of
 * hreflang.
 */
export const LOCALES = ['en', 'nb', 'es', 'fr', 'de'];

/**
 * Link targets for `[label](key)` in the copy, as English paths. The page
 * localizes each with localizeHref (src/lib/blog/links.mjs), which adds the
 * locale prefix only where the target exists in that locale.
 */
export const LINKS = {
  imap: '/connect/imap',
  connect: '/connect',
  providers: '/docs/providers',
  dataset: '/docs/providers/data',
  ovh: '/connect/ovh',
  purelymail: '/connect/purelymail',
  appPassword: '/blog/what-is-an-app-password',
  customDomain: '/blog/connect-business-email-custom-domain-to-ai-agent',
};

/** Keys of LINKS shown as the "Related guides" list, in order. */
export const RELATED = ['imap', 'customDomain', 'appPassword', 'providers', 'dataset', 'connect'];

/**
 * Sources for the claims about standards and third parties. Labels are
 * translated under `sources.items.<id>`; URLs are not.
 */
export const SOURCES = [
  { id: 'rfc8314', url: 'https://www.rfc-editor.org/rfc/rfc8314' },
  { id: 'rfc6186', url: 'https://www.rfc-editor.org/rfc/rfc6186' },
  { id: 'rfc6409', url: 'https://www.rfc-editor.org/rfc/rfc6409' },
  { id: 'rfc5068', url: 'https://www.rfc-editor.org/rfc/rfc5068' },
  { id: 'msBasicAuth', url: 'https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d' },
  { id: 'msExchangeOnline', url: 'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online' },
  { id: 'ispdb', url: 'https://autoconfig.thunderbird.net/v1.1/' },
  { id: 'cloudflareDoh', url: 'https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/' },
];

/** `[label](key)` -> label, for meta tags and JSON-LD. Also drops <code>/<b>. */
export function plainText(text) {
  return typeof text === 'string'
    ? text.replace(/\[([^\]]+)\]\(([a-zA-Z]+)\)/g, '$1').replace(/<\/?(code|b)>/g, '')
    : '';
}

/** Copy for one locale, or null when that locale has no content file. */
export async function getLookupContent(locale) {
  if (!LOCALES.includes(locale)) return null;
  const mod = await import(`./email-settings-lookup/${locale}.json`);
  return mod.default;
}
