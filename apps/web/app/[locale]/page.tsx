import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, homeJsonLd } from '@/i18n/seo';
import HomeClient from '../../components/marketing/HomeClient';
import { HOMEPAGE_DEMO_VIDEO } from '@/lib/experiments/constants';
import { getExperimentDecisionForRequest } from '@/lib/experiments/request';

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

  // The first real user of the experiments system. The decision is made once
  // per request from the anonymous subject id the proxy attached; the page
  // itself knows nothing about cookies or bucketing. While the experiment is
  // a draft this is always the control, so the homepage is unchanged.
  const demoVideo = await getExperimentDecisionForRequest(HOMEPAGE_DEMO_VIDEO.key);
  const showDemoVideo = demoVideo.variantId === HOMEPAGE_DEMO_VIDEO.variants.video;

  const t = await getTranslations({ locale, namespace: 'home.meta' });
  const jsonLd = homeJsonLd(locale, {
    name: t('title'),
    description: t('description'),
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomeClient stripePrices={stripePrices} showDemoVideo={showDemoVideo} />
    </>
  );
}
