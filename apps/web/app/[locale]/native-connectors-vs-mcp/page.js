import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import CompareClient from '../../../components/marketing/CompareClient';

const PATH = '/native-connectors-vs-mcp';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'compare' });
  const title = t.has('meta.title') ? t('meta.title') : 'Native connectors vs MCP';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Why a managed MCP email server beats AI-native built-in connectors: more providers, real actions, and one setup across every AI client.';
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
    title: t.has('meta.title') ? t('meta.title') : 'Native connectors vs MCP',
    description: t.has('meta.description') ? t('meta.description') : '',
  });

  // FAQPage structured data, built from the same compare.faq.items rendered on
  // the page so the schema matches visible content (FAQ rich-result requirement).
  const faqItems = Array.isArray(t.raw('faq.items')) ? t.raw('faq.items') : [];
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {faqLd.mainEntity.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
        />
      )}
      <CompareClient />
    </>
  );
}
