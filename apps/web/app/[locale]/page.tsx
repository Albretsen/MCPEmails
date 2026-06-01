import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { routing } from '@/i18n/routing';
import { metaAlternates, localePath, OG_LOCALE } from '@/i18n/seo';
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
      images: [{ url: '/og.png', width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/og.png'],
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
  return <HomeClient stripePrices={stripePrices} />;
}
