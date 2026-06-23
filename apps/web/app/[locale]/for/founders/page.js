import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pageJsonLd } from '@/i18n/seo';
import FoundersClient from '../../../../components/marketing/FoundersClient';

const PATH = '/for/founders';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'forFounders' });
  const title = t.has('meta.title') ? t('meta.title') : 'Email for founders';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Founders use mcpemails to answer customer email straight from Claude or any AI.';
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

export default async function FoundersPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'forFounders' });
  const jsonLd = pageJsonLd(locale, {
    path: PATH,
    title: t.has('meta.title') ? t('meta.title') : 'Email for founders',
    description: t.has('meta.description') ? t('meta.description') : '',
  });

  // FAQPage structured data, built from the same forFounders.faq.items rendered
  // on the page so the schema matches visible content (FAQ rich-result rule).
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
      <FoundersClient />
    </>
  );
}
