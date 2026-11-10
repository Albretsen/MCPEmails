/**
 * The name a provider is shown under in a given locale.
 *
 * Provider names are brands (Gmail, GMX, IONOS) and read the same in every
 * language, so `provider.name` is used as it is. The one exception is the
 * generic page, `imap`: "Generic IMAP" is a description, not a brand, and it
 * was the one English word left on /de/connect, /pt/connect and /ja/connect.
 *
 * Each translation is chosen to fit the shared templates in
 * messages/<locale>/connect.json ("{provider} kostenlos verbinden", "Ein
 * {provider}-Postfach", "Conecte o {provider}", "{provider}を無料で接続"), so
 * German deliberately uses the bare "IMAP": an adjective ("Generisches IMAP")
 * would need declension inside those sentences.
 */
const GENERIC_IMAP_NAMES = {
  en: 'Generic IMAP',
  nb: 'Generisk IMAP',
  es: 'IMAP genérico',
  fr: 'IMAP générique',
  de: 'IMAP',
  pt: 'IMAP genérico',
  ja: '汎用IMAP',
  zh: '通用 IMAP',
};

/** The slug whose name is translated rather than used as a brand. */
export const GENERIC_PROVIDER_SLUG = 'imap';

/** `provider.name` in `locale`: translated for the generic page, the brand everywhere else. */
export function providerDisplayName(provider, locale) {
  if (!provider) return '';
  if (provider.slug === GENERIC_PROVIDER_SLUG) {
    return GENERIC_IMAP_NAMES[locale] ?? GENERIC_IMAP_NAMES.en;
  }
  return provider.name;
}

/** A copy of `provider` whose `name` is the one `locale` shows, for code that reads `provider.name`. */
export function localizeProvider(provider, locale) {
  if (!provider) return provider;
  const name = providerDisplayName(provider, locale);
  return name === provider.name ? provider : { ...provider, name };
}

/** Every locale the generic name is written in (for the parity test). */
export const GENERIC_NAME_LOCALES = Object.freeze(Object.keys(GENERIC_IMAP_NAMES));
