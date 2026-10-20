// ---------------------------------------------------------------------------
// Which locales are kept fully translated, and what happens in the others.
//
// FULL locales are translated completely and CI keeps them that way: every
// message key (scripts/i18n-coverage), every connect provider page and every
// client setup page (src/lib/connect/translation-parity.test.mjs) must exist in
// each of them.
//
// FROZEN locales stay live and indexed with what they already have, but new
// work no longer needs them: a new message key, provider, client page or blog
// post may ship without a translation there. A message key missing in a frozen
// locale renders the English string (withEnglishFallback below), and a page
// missing in a frozen locale is simply not generated, not advertised in
// hreflang, and not linked from the language switcher.
//
// This file is the single source of truth for that split. It is plain .mjs so
// the node:test suites and scripts can import it without a build.
// ---------------------------------------------------------------------------

/** Kept fully translated. CI fails when a key or page is missing in one. */
export const FULL_LOCALES = /** @type {const} */ (['en', 'nb', 'es', 'fr']);

/** Still served, no longer required. Missing strings fall back to English. */
export const FROZEN_LOCALES = /** @type {const} */ (['zh']);

/** The locale every fallback resolves to. */
export const FALLBACK_LOCALE = 'en';

/** True when CI requires `locale` to be complete. */
export function isFullLocale(locale) {
  return FULL_LOCALES.includes(locale);
}

/** True when `locale` is served but allowed to lag behind English. */
export function isFrozenLocale(locale) {
  return FROZEN_LOCALES.includes(locale);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `override` deep-merged over `base`: every key of `base` is present, and the
 * value from `override` wins wherever it defines one. Arrays and strings are
 * leaves (an array is replaced whole, never merged by index). Neither input is
 * mutated.
 */
export function deepMergeMessages(base, override) {
  if (!isPlainObject(base)) return override === undefined ? base : override;
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMergeMessages(base[key], value) : value;
  }
  return out;
}

/**
 * The messages a visitor in `locale` actually sees. For a frozen locale, its
 * catalog is laid over the English one so a key it lacks renders English
 * instead of a raw key path. Full locales are returned as they are: CI already
 * guarantees they are complete, and merging there would hide a real gap.
 */
export function withEnglishFallback(locale, messages, englishMessages) {
  if (!isFrozenLocale(locale)) return messages;
  return deepMergeMessages(englishMessages ?? {}, messages ?? {});
}
