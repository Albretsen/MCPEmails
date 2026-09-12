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
 * /best-email-mcp-servers: the ranked field of MCP email servers.
 *
 * Sibling of /native-connectors-vs-mcp, which answers the other axis (built-in
 * connectors inside one vendor's app). The two link to each other rather than
 * restating each other, and neither may repeat the "native connectors are
 * draft-only" claim: Anthropic shipped native Gmail send, reply and forward on
 * 18 August 2026.
 *
 * Why this slug
 * -------------
 * It is the phrase people type. The page lived at /email-mcp-servers-compared
 * until 12 September 2026, which described the page accurately and matched
 * nothing anyone searches for; that path is now a permanent redirect here (see
 * the stub route of the same name, and C.LEGACY_PATH).
 *
 * The year is in the title and not in the slug on purpose. "2026" is what makes
 * a listicle look current in a result snippet, and a slug carrying it is a
 * URL that has to be migrated every January or quietly rot.
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
      type: 'article',
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

export default async function BestEmailMcpServersPage({ params }) {
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
      // The ranking, as data. Position here must match the order rendered on
      // the page; an ItemList that disagrees with its own prose is a quality
      // signal pointed the wrong way. Our own entry is an internal URL, the
      // rest point at the thing being ranked.
      {
        '@type': 'ItemList',
        '@id': `${url}#ranking`,
        name: C.meta.title,
        description: C.meta.description,
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        numberOfItems: C.entries.length,
        itemListElement: C.entries.map((e) => ({
          '@type': 'ListItem',
          position: e.rank,
          name: e.name,
          description: e.verdict,
          url: e.us ? url : e.href,
        })),
      },
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
