import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { metaAlternatesFor, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd, APP_URL } from '@/i18n/seo';
import { DATASET_PATH, FIELD_DOCS } from '@/lib/connect/provider-dataset.mjs';
import { datasetCopy } from './content.mjs';
import ProviderDatasetView from '../../../../../components/marketing/ProviderDatasetView';
import { requireLocale } from '@/i18n/require-locale';

/**
 * /docs/providers/data: the open IMAP/SMTP provider dataset.
 *
 * This page exists to be cited and linked: other developers building mail
 * clients and MCP servers need these facts and nobody else publishes them.
 * The rows, the headline numbers and the downloads all come from
 * src/lib/connect/provider-dataset.mjs, which reads providers.mjs.
 *
 * English only, with the same mechanism as /best-email-mcp-servers: a narrow
 * generateStaticParams plus metaAlternatesFor, so the other locales 404 rather
 * than serve English under a translated URL.
 */
const LOCALES = ['en'];

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) return {};
  const { title, description } = datasetCopy().meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, DATASET_PATH, LOCALES),
    openGraph: {
      type: 'article',
      url: localePath(locale, DATASET_PATH),
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

export default async function ProviderDatasetPage({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  if (!LOCALES.includes(locale)) notFound();
  setRequestLocale(locale);

  const copy = datasetCopy();
  const url = localePath(locale, DATASET_PATH);
  const base = pageJsonLd(locale, {
    path: DATASET_PATH,
    title: copy.meta.title,
    description: copy.meta.description,
  });
  const jsonLd = {
    ...base,
    '@graph': [
      ...base['@graph'],
      // Dataset markup is what Google Dataset Search and AI crawlers read.
      // Every value here is derived from the same rows the page renders.
      {
        '@type': 'Dataset',
        '@id': `${url}#dataset`,
        name: 'IMAP and SMTP provider compatibility dataset',
        description: copy.meta.description,
        url,
        license: copy.paths.license,
        isAccessibleForFree: true,
        creator: { '@type': 'Organization', name: 'MCPEmails', url: APP_URL },
        dateModified: copy.stats.probedOn,
        temporalCoverage: copy.stats.probedOn,
        keywords: ['IMAP', 'SMTP', 'email providers', 'SASL', 'mail server settings', 'MCP'],
        variableMeasured: FIELD_DOCS.map((f) => f.key),
        distribution: [
          {
            '@type': 'DataDownload',
            encodingFormat: 'application/json',
            contentUrl: `${APP_URL}${copy.paths.json}`,
          },
          {
            '@type': 'DataDownload',
            encodingFormat: 'text/csv',
            contentUrl: `${APP_URL}${copy.paths.csv}`,
          },
        ],
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ProviderDatasetView />
    </>
  );
}
