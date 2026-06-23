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

/**
 * Structured-data graph for the home page (Organization + WebSite +
 * SoftwareApplication). This is the product's primary acquisition surface:
 * AI assistants and search engines read it to describe and recommend
 * mcpemails. Everything here must be literally true — no aggregateRating or
 * other invented signals. The free Offer mirrors the real "unlimited, free"
 * tier; richer pricing lives in the FAQPage schema on /pricing.
 */
export function homeJsonLd(
  locale: string,
  { name, description }: { name: string; description: string }
) {
  const home = localePath(locale, '');
  const orgId = `${APP_URL}/#organization`;
  const siteId = `${APP_URL}/#website`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: 'mcpemails',
        url: APP_URL,
        logo: `${APP_URL}/favicon.svg`,
        sameAs: ['https://twitter.com/mcpemails'],
      },
      {
        '@type': 'WebSite',
        '@id': siteId,
        name: 'mcpemails',
        url: APP_URL,
        inLanguage: locale,
        publisher: { '@id': orgId },
      },
      {
        '@type': 'SoftwareApplication',
        name: 'mcpemails',
        url: home,
        description,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Email',
        operatingSystem: 'Web',
        publisher: { '@id': orgId },
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Unlimited, free forever. No card required.',
        },
      },
    ],
  };
}
