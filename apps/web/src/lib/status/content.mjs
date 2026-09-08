/**
 * Copy for /status, in one locale.
 *
 * Deliberately not a next-intl namespace, for the reason spelled out in
 * lib/connect/content.mjs: the root layout hands every loaded namespace to
 * NextIntlClientProvider, so anything under `messages/` is serialised into the
 * HTML of every page on the site. A status page nobody visits until something
 * feels wrong should not add its glossary of failure classes to the weight of
 * the home page. Loaded here it is paid for only by the page that renders it.
 *
 * It also sidesteps the ICU escaping trap: `'<'` unescapes in dev and renders
 * literally in prod, so translated strings elsewhere have to avoid angle
 * brackets. These strings are plain text substituted by `fill` below, never
 * parsed as ICU, and they contain no markup at all.
 *
 * English is the fallback rather than a hard failure. A missing translation on
 * a trust page should degrade to English, not to a 404: the numbers are the
 * point and they are locale independent.
 */

import en from './content/en.json';

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

export async function getStatusContent(locale) {
  if (locale === 'en' || !LOCALES.includes(locale)) return en;
  try {
    const mod = await import(`./content/${locale}.json`);
    return mod.default ?? en;
  } catch {
    return en;
  }
}

/**
 * Substitute `{name}` placeholders in a copy string.
 *
 * A deliberately tiny replacement for ICU message formatting. Every value
 * reaching it is already a formatted string (a locale-formatted integer, a
 * percentage, a time), because the formatting decisions belong next to the
 * data rather than inside five sets of translated strings that can drift
 * apart. An unknown placeholder is left in place rather than blanked, so a
 * mistake in a translation shows up as an obvious `{name}` instead of a
 * sentence that silently lost its number.
 */
export function fill(template, values) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
