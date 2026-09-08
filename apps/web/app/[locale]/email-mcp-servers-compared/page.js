import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import {
  metaAlternatesFor,
  localePath,
  OG_LOCALE,
  OG_IMAGE,
  pageJsonLd,
  APP_URL,
} from '@/i18n/seo';
import * as C from '@/lib/compare/email-mcp-servers.mjs';
import EmailMcpServersView from '../../../components/marketing/EmailMcpServersView';

/**
 * /email-mcp-servers-compared: us against the other MCP email servers.
 *
 * Sibling of /native-connectors-vs-mcp, which answers the other axis (built-in
 * connectors inside one vendor's app). The two link to each other rather than
 * restating each other, and neither may repeat the "native connectors are
 * draft-only" claim: Anthropic shipped native Gmail send, reply and forward on
 * 18 August 2026.
 *
 * Why this slug and not /compare
 * ------------------------------
 * /compare would be a hub with exactly one child, which is a thin page search
 * engines are right to ignore, and the marketing bundle already has a `compare`
 * next-intl namespace that belongs to the OTHER comparison page: a route named
 * /compare whose copy lives elsewhere while a `compare` namespace describes a
 * different URL is a trap for the next person. This slug also matches how the
 * rest of the site names pages it wants found (/native-connectors-vs-mcp,
 * /connect/<provider>, /self-hosting): descriptive, and containing the phrase
 * someone actually searches for.
 *
 * English only, for now
 * ---------------------
 * The page makes dated, sourced factual claims about named companies. Shipping
 * machine translations of those into four more languages multiplies the number
 * of places a claim can drift from its source without multiplying the number of
 * people re-checking them. Same mechanism the provider pages use
 * (metaAlternatesFor + a narrow generateStaticParams), so hreflang advertises
 * only the locale that exists and the others 404 rather than serving an
 * untranslated page under a translated URL.
 */
const LOCALES = ['en'];

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  if (!LOCALES.includes(locale)) return {};
  const { title, description } = C.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, C.PATH, LOCALES),
    openGraph: {
      type: 'website',
      url: localePath(locale, C.PATH),
      title: `${title} · mcpemails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · mcpemails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function EmailMcpServersComparedPage({ params }) {
  const { locale } = await params;
  if (!LOCALES.includes(locale)) notFound();
  setRequestLocale(locale);

  const url = localePath(locale, C.PATH);
  const base = pageJsonLd(locale, {
    path: C.PATH,
    title: C.meta.title,
    description: C.meta.description,
  });
  const jsonLd = {
    ...base,
    '@graph': [
      ...base['@graph'],
      // The FAQ pairs are what generative answers quote. Marking them up is the
      // cheapest way to make the pairing unambiguous; it is not here for stars.
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: C.faq.items.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      // `citation` carries the sources into structured data as well as onto the
      // page. A comparison is only worth anything if the reader can check it,
      // and an assistant reading this page should be able to check it too.
      {
        '@type': 'WebPage',
        '@id': `${url}#sources`,
        url: `${url}#sources`,
        name: C.SOURCES.title,
        isPartOf: { '@id': `${APP_URL}/#website` },
        citation: C.SOURCES.items.map((s) => ({
          '@type': 'CreativeWork',
          name: s.label,
          url: s.url,
        })),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <EmailMcpServersView />
    </>
  );
}
