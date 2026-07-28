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
        // No `sameAs` entry: @mcpemails does not exist on X. Add the real
        // profile URL here once one exists.
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

/**
 * Structured-data graph for a provider connect landing page
 * (/connect/<provider>). Emits a `HowTo` built from the real on-page setup
 * steps (eligible for how-to rich results and read by AI assistants answering
 * "how do I connect <provider> to Claude"), plus a `WebPage` + `BreadcrumbList`
 * for site structure. Everything mirrors visible page content — no invented
 * claims. Steps come straight from the `connect.<provider>.steps` bundle.
 */
export function connectJsonLd(
  locale: string,
  {
    path,
    title,
    description,
    howToName,
    steps,
  }: {
    path: string;
    title: string;
    description: string;
    howToName: string;
    steps: { h: string; p: string }[];
  }
) {
  const url = localePath(locale, path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'HowTo',
        name: howToName,
        description,
        step: steps.map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.h,
          text: s.p,
        })),
      },
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: title,
        description,
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'mcpemails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: title },
        ],
      },
    ],
  };
}

/**
 * Structured-data graph for a standalone marketing page (e.g. the
 * native-connectors-vs-mcp comparison): a `WebPage` + `BreadcrumbList` tying it
 * into the site graph. Lean and literally true — no Article/author signals we
 * can't back up.
 */
export function pageJsonLd(
  locale: string,
  { path, title, description }: { path: string; title: string; description: string }
) {
  const url = localePath(locale, path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: title,
        description,
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'mcpemails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: title },
        ],
      },
    ],
  };
}
