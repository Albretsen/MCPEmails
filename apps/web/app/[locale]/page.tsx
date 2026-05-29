import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { routing } from '@/i18n/routing';
import HomeClient from '../../components/marketing/HomeClient';

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com').replace(/\/$/, '');

const OG_LOCALE: Record<string, string> = { en: 'en_US', nb: 'nb_NO' };

function pathForLocale(locale: string): string {
  return locale === routing.defaultLocale ? '' : `/${locale}`;
}

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
    alternates: {
      canonical: `${APP_URL}${pathForLocale(locale)}`,
      languages: {
        en: APP_URL,
        nb: `${APP_URL}/nb`,
        'x-default': APP_URL,
      },
    },
    openGraph: {
      type: 'website',
      url: `${APP_URL}${pathForLocale(locale)}`,
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
