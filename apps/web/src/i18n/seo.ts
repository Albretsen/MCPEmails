import { routing } from './routing';

export const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com'
).replace(/\/$/, '');

/** Absolute URL for a marketing path in a given locale (default locale has no prefix). */
export function localePath(locale: string, pathname: string): string {
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`;
  return `${APP_URL}${prefix}${pathname}`;
}

/** hreflang language map (incl. x-default) for a marketing path. */
export function languageAlternates(pathname: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) languages[l] = localePath(l, pathname);
  languages['x-default'] = localePath(routing.defaultLocale, pathname);
  return languages;
}

/** Metadata `alternates` block (canonical + hreflang languages) for a marketing path. */
export function metaAlternates(locale: string, pathname: string) {
  return {
    canonical: localePath(locale, pathname),
    languages: languageAlternates(pathname),
  };
}

/**
 * Default social-share image for marketing pages. Served by the
 * `app/opengraph-image.tsx` route handler (1200x630 brand card). Blog posts
 * override this with their own cover image.
 */
export const OG_IMAGE = {
  url: `${APP_URL}/opengraph-image`,
  width: 1200,
  height: 630,
  alt: 'mcpemails: Give your AI agent an inbox',
} as const;

export const OG_LOCALE: Record<string, string> = {
  en: 'en_US',
  nb: 'nb_NO',
  es: 'es_ES',
  fr: 'fr_FR',
  zh: 'zh_CN',
};
