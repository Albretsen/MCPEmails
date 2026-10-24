import { notFound } from 'next/navigation';
import { hasLocale } from 'next-intl';
import { routing, type Locale } from './routing';

/**
 * 404 unless `locale` is one of ours. Every page and layout under
 * app/[locale] calls it first, in generateMetadata, the page and the layout.
 *
 * A URL whose first segment is not a locale (/xyz/pricing) still matches
 * app/[locale]/pricing with locale "xyz". The [locale] layout's notFound() does
 * not stop the page's metadata and body from rendering next to it, so without
 * this check the 404 document carried that page's meta description and copy.
 * Section layouts (pricing, docs, blog, for/founders) render alongside it the
 * same way and serialised their ClientMessages namespaces into the 404.
 * `dynamicParams = false` in the layout would also stop it, but it cascades to
 * every child segment and 404s any param outside their generateStaticParams.
 * Some of those render on demand on purpose: /es/blog/<post with no Spanish
 * translation> redirects to the English post from blog/[slug].
 *
 * src/i18n/require-locale.test.mjs checks that every page and layout calls it.
 */
export function requireLocale(locale: string): Locale {
  if (!hasLocale(routing.locales, locale)) notFound();
  return locale;
}
