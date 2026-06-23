import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
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

export default async function PricingPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const stripePrices = await fetchStripePrices();

  // FAQPage structured data — built from the same FAQ copy that's rendered
  // visibly below, so the schema matches on-page content (a requirement for
  // FAQ rich results and for AI assistants quoting the answers).
  const t = await getTranslations({ locale, namespace: 'pricing' });
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
      {faqLd.mainEntity.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
        />
      )}
      <PricingClient stripePrices={stripePrices} />
    </>
  );
}
