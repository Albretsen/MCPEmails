/**
 * Server-side data for the help center, shared by the public /help page and
 * GET /api/support/help-data (the dashboard's help section), so both render the
 * same articles, search index and contact-form seed.
 *
 * Gating is NOT done here: each caller checks the viewer first.
 */

import { getProvider } from '../connect/providers.mjs';
import { getHelpContent, fill, HELP_LOCALES, SUPPORT_CATEGORIES } from './help-content.mjs';
import { getHelpArticles, flattenArticles } from './articles.mjs';
import { getSearchIndex } from './search-index.mjs';

const SLUG_RE = /^[a-z0-9_.-]{1,64}$/;

/** First value of a search param, kept only when it is a plain slug. */
export function slugParam(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  const lower = v.trim().toLowerCase();
  return SLUG_RE.test(lower) ? lower : null;
}

/** The provider's display name for a slug from the connect modal, or null. */
export function providerName(slug) {
  if (!slug) return null;
  const resolved = slug === 'generic' ? 'imap' : slug;
  return getProvider(resolved)?.name ?? null;
}

/** A supported locale, English otherwise. */
export function helpLocale(locale) {
  return HELP_LOCALES.includes(locale) ? locale : 'en';
}

/**
 * How the contact form starts, from `topic`, `provider`, `code` and `from`
 * (search params, raw). The connect modal sends the first three.
 */
export function seedContactForm(params, content) {
  const topic = slugParam(params?.topic);
  const provider = slugParam(params?.provider);
  const code = slugParam(params?.code);
  const from = slugParam(params?.from);
  const name = providerName(provider);
  return {
    initialCategory: topic && SUPPORT_CATEGORIES.includes(topic) ? topic : 'connect',
    initialSubject: topic === 'connect' && name ? fill(content.form.subjectConnect, { provider: name }) : '',
    providerName: name,
    meta: { from, provider, code },
    // Open the form straight away when someone arrived with a reason to write.
    open: Boolean(topic),
  };
}

/**
 * `{ locale, copy, categories, index }`. `copy` is the locale's help content
 * without the troubleshooting articles, which arrive in `categories`.
 */
export async function getHelpCenterData(locale, { inApp = false } = {}) {
  const l = helpLocale(locale);
  const content = await getHelpContent(l);
  const { categories } = await getHelpArticles(l, { help: content });
  const index = await getSearchIndex(l, content, { articles: flattenArticles(categories), inApp });
  const copy = { ...content };
  delete copy.articles;
  return { locale: l, copy, categories, index };
}
