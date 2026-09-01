import { routing } from './routing';
import { PLANS } from '@/lib/stripe/plans';

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
 * hreflang for a page that exists in only some locales.
 *
 * The provider landing pages are the first pages here that are not translated
 * five ways: the long tail of hosting providers and regional ISPs ships in
 * English only, because 400-odd machine-translated pages about Bahnhof's IMAP
 * host is precisely the scaled-content pattern search engines demote. An
 * hreflang pointing at a locale that does not exist is worse than no hreflang,
 * so the alternates have to be built from the same list that decides which
 * pages get generated.
 */
export function languageAlternatesFor(
  pathname: string,
  locales: readonly string[],
): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    if (locales.includes(l)) languages[l] = localePath(l, pathname);
  }
  const fallback = locales.includes(routing.defaultLocale)
    ? routing.defaultLocale
    : locales[0];
  if (fallback) languages['x-default'] = localePath(fallback, pathname);
  return languages;
}

/** `alternates` for a page present in only some locales. */
export function metaAlternatesFor(
  locale: string,
  pathname: string,
  locales: readonly string[],
) {
  return {
    canonical: localePath(locale, pathname),
    languages: languageAlternatesFor(pathname, locales),
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
 * Subscription Offer nodes built straight from the canonical plan catalogue.
 *
 * This is the surface AI assistants read when they answer "what does mcpemails
 * cost", so it must never drift from src/lib/stripe/plans.ts. It used to carry
 * a single hardcoded Offer describing the product as "Unlimited, free forever",
 * which became a false public claim the moment the free tier was capped at one
 * connected inbox.
 *
 * Every offer is a monthly UnitPriceSpecification: the yearly prices are a
 * discount on the same subscription rather than a separate product, and
 * publishing both as sibling Offers reads as two competing prices.
 */
function planOffers(url: string) {
  return (['free', 'personal', 'solo', 'pro'] as const).map((id) => {
    const plan = PLANS[id];
    const price = (plan.monthlyPriceCents / 100).toString();
    return {
      '@type': 'Offer',
      name: plan.name,
      description: plan.description,
      url,
      price,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price,
        priceCurrency: 'USD',
        unitText: 'MONTH',
        billingDuration: 1,
        billingIncrement: 1,
      },
    };
  });
}

/**
 * Structured-data graph for the home page (Organization + WebSite +
 * SoftwareApplication). This is the product's primary acquisition surface:
 * AI assistants and search engines read it to describe and recommend
 * mcpemails. Everything here must be literally true: no aggregateRating or
 * other invented signals. The offers mirror the real plan catalogue.
 */
export function homeJsonLd(
  locale: string,
  { description }: { name: string; description: string }
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
        // These are concrete, shipped capabilities rather than a duplicate of
        // the tool catalogue. Keeping this as one product-level list lets
        // search engines and assistants discover important workflows without
        // turning every operation into a separate marketing claim.
        featureList: [
          'Human approval before AI-sent email is dispatched',
          'Transient attachment text extraction',
          'User-invoked MCP workflow prompts',
          'Idempotency keys for safe outbound email retries',
          'Provider compatibility profiles',
          'Original email export as .eml (message/rfc822)',
          'Verified Gmail send-as aliases',
          'Threaded reply drafts',
        ],
        offers: planOffers(localePath(locale, '/pricing')),
      },
    ],
  };
}

/**
 * Structured data for /pricing: the plan catalogue as a `Product` with one
 * `Offer` per tier, plus the standard WebPage + BreadcrumbList.
 *
 * Assistants asked "how much is mcpemails" answer from whatever is machine
 * readable, and until now that was a lone free Offer on the home page. Emitting
 * the real four-tier catalogue here is the difference between being described
 * accurately and being described as free-and-unlimited.
 */
export function pricingJsonLd(
  locale: string,
  { title, description }: { title: string; description: string }
) {
  const url = localePath(locale, '/pricing');
  const graph = pageJsonLd(locale, { path: '/pricing', title, description })['@graph'];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...graph,
      {
        '@type': 'Product',
        '@id': `${url}#plans`,
        name: 'mcpemails',
        description,
        url,
        brand: { '@id': `${APP_URL}/#organization` },
        offers: planOffers(url),
      },
    ],
  };
}

/**
 * Structured data for the public documentation index. The `about` topics map
 * to documented, available behaviours and help search engines distinguish the
 * reference from generic AI-email setup guides.
 */
export function docsJsonLd(
  locale: string,
  { title, description }: { title: string; description: string },
) {
  const path = '/docs';
  const url = localePath(locale, path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': url,
        url,
        headline: title,
        description,
        inLanguage: locale,
        isPartOf: { '@id': `${APP_URL}/#website` },
        about: [
          'AI email approval workflows',
          'Email attachment text extraction',
          'MCP prompts',
          'Idempotent email sending',
          'Email provider compatibility',
          'EML email export',
          'Gmail send-as aliases',
          'Threaded email drafts',
        ].map((name) => ({ '@type': 'Thing', name })),
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'mcpemails', item: localePath(locale, '') },
          { '@type': 'ListItem', position: 2, name: title, item: url },
        ],
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
    faq = [],
    connectLabel = 'Connect',
  }: {
    path: string;
    title: string;
    description: string;
    howToName: string;
    steps: { h: string; p: string }[];
    faq?: { q: string; a: string }[];
    connectLabel?: string;
  }
) {
  const url = localePath(locale, path);
  const graph: Record<string, unknown>[] = [
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
        // The hub is a real, crawlable page, so it belongs in the trail. A
        // two-item breadcrumb on a page that sits three levels down is the
        // kind of mismatch that gets the whole block ignored.
        { '@type': 'ListItem', position: 2, name: connectLabel, item: localePath(locale, '/connect') },
        { '@type': 'ListItem', position: 3, name: title },
      ],
    },
  ];
  // FAQPage stopped producing rich results for non-authoritative sites in 2023,
  // so this is not here for the stars. It is here because the question/answer
  // pairing is what generative results quote, and marking it up is the cheapest
  // way to make the pairing unambiguous.
  if (faq.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

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
