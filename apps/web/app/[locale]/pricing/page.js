import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pricingJsonLd } from '@/i18n/seo';
import PricingClient from '../../../components/marketing/PricingClient';
import { attachFounder, founderDisplayFor } from '@/lib/stripe/founder-display';
import { FOUNDER_VALID_UNTIL, pricesWithFounder } from '@/lib/stripe/founder-offer';

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
      title: `${title} · MCPEmails`,
      description,
      locale: OG_LOCALE[locale],
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · MCPEmails`,
      description,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function PricingPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  // The Business founder price, while it is open (src/lib/stripe/founder-offer.ts).
  // Null outside the window, with the flag off, when every place is taken,
  // when the count cannot be read, and always in zh. Read per request; the
  // flag is cached 60 s and the place count 5 min (founder-offer-server.ts).
  const founder = await founderDisplayFor({ locale });
  const stripePrices = pricesWithFounder(attachFounder(await fetchStripePrices(), founder), locale);

  const t = await getTranslations({ locale, namespace: 'pricing' });
  const title = t.has('meta.title') ? t('meta.title') : 'Pricing';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Simple, transparent pricing for AI agents that read and send email. Free plan available. No card required.';
  // Emits the real plan catalogue as Product + Offers, so an assistant asked
  // what MCPEmails costs reads the same four tiers a visitor sees.
  const jsonLd = pricingJsonLd(
    locale,
    { title, description },
    founder ? { monthlyCents: founder.monthlyCents, validUntil: FOUNDER_VALID_UNTIL } : null,
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <PricingClient stripePrices={stripePrices} />
    </>
  );
}
