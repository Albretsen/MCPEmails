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

export const HELP_LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

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

/** The address shown as the email way in. */
export const SUPPORT_EMAIL = 'support@mcpemails.com';

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

/**
 * A marketing path in a locale (`as-needed` prefixing: English has none).
 * Dashboard paths, anchors-only and absolute URLs are left alone: the dashboard
 * is not under app/[locale].
 */
export function helpHref(locale, href) {
  if (typeof href !== 'string' || !href.startsWith('/')) return href;
  if (href === '/dashboard' || href.startsWith('/dashboard/') || href.startsWith('/api/')) return href;
  if (!locale || locale === 'en') return href;
  return href === '/' ? `/${locale}` : `/${locale}${href}`;
}
