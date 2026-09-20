/**
 * Copy for the /for/business persona page, in one locale.
 *
 * The copy lives in messages/<locale>/forBusiness.json, next to forFounders,
 * so translators find it where they expect it. It is deliberately NOT listed in
 * MARKETING_NAMESPACES (src/i18n/request.ts): the root layout hands every
 * namespace in that list to NextIntlClientProvider, which serialises it into
 * the HTML of every marketing page. This page is rendered on the server, so it
 * reads the file here instead and is the only page that pays for it. Same
 * reasoning as src/lib/connect/content.mjs.
 */
export const BUSINESS_PATH = '/for/business';

export const BUSINESS_LOCALES = ['en', 'es', 'fr', 'nb', 'zh'];

export async function getBusinessCopy(locale) {
  const safe = BUSINESS_LOCALES.includes(locale) ? locale : 'en';
  const mod = await import(`../../../messages/${safe}/forBusiness.json`);
  return mod.default;
}
