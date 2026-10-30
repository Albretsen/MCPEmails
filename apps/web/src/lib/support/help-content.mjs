/**
 * Copy for /help, in one locale.
 *
 * Same pattern as src/lib/status/content.mjs, and for the same reason: a
 * next-intl namespace is serialised into every marketing page, and this copy is
 * read by one route. Strings are plain text substituted by `fill`, never parsed
 * as ICU, and none of them contains `<` (help-content.test.mjs enforces both
 * that and key parity across the five locales).
 *
 * English is the fallback for an unknown locale or a failed import, so a
 * missing translation degrades to English rather than to a 404.
 */

import en from './help-content/en.json';

export const HELP_LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];

/** The ticket categories, in display order. Must match the ticket API's allow-list. */
export const SUPPORT_CATEGORIES = ['connect', 'client', 'billing', 'bug', 'feature', 'other'];

/** Every error code the ticket API can answer with, plus the two the form produces itself. */
export const SUPPORT_ERROR_CODES = [
  'invalid_json',
  'invalid_email',
  'invalid_category',
  'subject_required',
  'subject_too_long',
  'message_required',
  'message_too_long',
  'invalid_form_token',
  'rate_limited',
  'server_error',
  'not_found',
  'network',
  'unknown',
];

export { SUPPORT_EMAIL } from './help-links.mjs';

export async function getHelpContent(locale) {
  if (locale === 'en' || !HELP_LOCALES.includes(locale)) return en;
  try {
    const mod = await import(`./help-content/${locale}.json`);
    return mod.default ?? en;
  } catch {
    return en;
  }
}

/** `{name}` substitution, as in src/lib/status/content.mjs; unknown placeholders stay visible. */
export function fill(template, values) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export { helpHref } from './help-links.mjs';
