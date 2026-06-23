import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, homeJsonLd } from '@/i18n/seo';
import HomeClient from '../../components/marketing/HomeClient';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'home.meta' });

  const title = t('title');
  const description = t('description');

  return {
    title,
    description,
    alternates: metaAlternates(locale, ''),
    openGraph: {
      type: 'website',
      url: localePath(locale, ''),
      title,
      description,
      locale: OG_LOCALE[locale],
      alternateLocale: routing.locales
        .filter((l) => l !== locale)
        .map((l) => OG_LOCALE[l]),
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const stripePrices = await fetchStripePrices();

  const t = await getTranslations({ locale, namespace: 'home.meta' });
  const jsonLd = homeJsonLd(locale, {
    name: t('title'),
    description: t('description'),
  });

  // FAQPage structured data — built from the same FAQ copy rendered on the page
  // (home.faq.items), so the schema matches visible content (a requirement for
  // FAQ rich results and for AI assistants quoting the answers).
  const tHome = await getTranslations({ locale, namespace: 'home' });
  const faqItems = Array.isArray(tHome.raw('faq.items'))
    ? (tHome.raw('faq.items') as { q: string; a: string }[])
    : [];
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
      <HomeClient stripePrices={stripePrices} />
    </>
  );
}
