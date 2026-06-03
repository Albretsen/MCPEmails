import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { metaAlternates, localePath, OG_LOCALE } from '@/i18n/seo';
import PricingClient from '../../../components/marketing/PricingClient';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'pricing' });
  const title = t.has('meta.title') ? t('meta.title') : 'Pricing';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Simple, transparent pricing for AI agents that read and send email. Free plan available. No card required.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/pricing'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/pricing'),
      title: `${title} · mcpemails`,
      description,
      locale: OG_LOCALE[locale],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · mcpemails`,
      description,
    },
  };
}

export default async function PricingPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const stripePrices = await fetchStripePrices();
  return <PricingClient stripePrices={stripePrices} />;
}
