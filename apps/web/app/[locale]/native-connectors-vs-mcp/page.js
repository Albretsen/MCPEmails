import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import CompareClient from '../../../components/marketing/CompareClient';

const PATH = '/native-connectors-vs-mcp';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'compare' });
  const title = t.has('meta.title') ? t('meta.title') : 'AI Email Connectors vs MCP Server: How the Two Approaches Differ';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Two ways to give an AI assistant your inbox: a connector built into one assistant, or an MCP email server you connect yourself. How they differ on mailbox reach, multiple inboxes, portability, and who holds the credentials.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, PATH),
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

export default async function ComparePage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'compare' });
  const jsonLd = pageJsonLd(locale, {
    path: PATH,
    title: t.has('meta.title') ? t('meta.title') : 'AI Email Connectors vs MCP Server: How the Two Approaches Differ',
    description: t.has('meta.description') ? t('meta.description') : '',
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <CompareClient />
    </>
  );
}
