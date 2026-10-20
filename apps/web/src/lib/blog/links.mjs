import { providerLocales } from '../connect/providers.mjs';
import { clientLocales, getClient } from '../clients/clients.mjs';

/**
 * Locale-aware hrefs for the internal links written inside blog posts.
 *
 * Post bodies are Markdown, and their links are written once as English paths
 * ("/docs", "/blog/connect-claude-to-email"). Rendered as-is on /es/blog/...,
 * every one of them sent a Spanish reader, and the crawler, to the English
 * page: 104 translated post pages did this when it was measured on 2026-10-19.
 * Prefixing blindly would be worse, because some targets do not exist in every
 * locale (a post with no zh translation, an English-only provider page), and a
 * link to /zh/... for those is a redirect or a 404.
 *
 * So a link gets the locale prefix only when its target exists in that locale,
 * and otherwise keeps the English path, which always exists.
 */

const LOCALES = ['nb', 'es', 'fr', 'zh', 'de'];

/** Paths outside the URL-localized marketing site: never prefixed. */
const UNLOCALIZED = /^\/(?:signup|login|dashboard|authorize|auth|api|forgot-password|reset-password|\.well-known)(?:\/|$)/;

/** Marketing pages published in English only. */
const ENGLISH_ONLY = new Set(['/best-email-mcp-servers', '/email-mcp-servers-compared']);

/**
 * Locales a marketing path exists in, or null when the path is not a localized
 * page at all (and so must be left alone). `postLocales(slug)` returns the
 * locales a blog post is translated into; posts.js owns that answer.
 */
export function pathLocales(path, { postLocales }) {
  if (UNLOCALIZED.test(path)) return null;
  // Static files (/llms.txt, /blog/cover-x.svg) are not pages.
  if (/\.[a-z0-9]+$/i.test(path)) return null;
  if (ENGLISH_ONLY.has(path)) return ['en'];
  const blog = path.match(/^\/blog\/([^/]+)$/);
  if (blog) return postLocales(blog[1]);
  const provider = path.match(/^\/connect\/([^/]+)$/);
  if (provider) return providerLocales(provider[1]);
  // /docs/<client> is a dynamic segment beside the static /docs pages.
  const client = path.match(/^\/docs\/([^/]+)$/);
  if (client && getClient(client[1])) return clientLocales(client[1]);
  // Everything else under app/[locale] (home, /docs, /pricing, /connect, ...)
  // is published in every locale.
  return ['en', ...LOCALES];
}

/** `href` as it should appear on a page in `locale`. */
export function localizeHref(href, locale, { postLocales }) {
  if (locale === 'en' || !href.startsWith('/') || href.startsWith('//')) return href;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? '' : href.slice(cut);
  // Already prefixed by the author.
  if (LOCALES.some((l) => path === `/${l}` || path.startsWith(`/${l}/`))) return href;
  const locales = pathLocales(path, { postLocales });
  if (!locales || !locales.includes(locale)) return href;
  return `/${locale}${path === '/' ? '' : path}${suffix}`;
}
