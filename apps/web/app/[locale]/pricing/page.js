import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { eurDisplayEnabled } from '@/lib/stripe/eur-launch';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, pricingJsonLd } from '@/i18n/seo';
import PricingClient from '../../../components/marketing/PricingClient';
import { attachFounder, founderDisplayFor } from '@/lib/stripe/founder-display';
import { FOUNDER_VALID_UNTIL, pricesWithFounder } from '@/lib/stripe/founder-offer';
import { requireLocale } from '@/i18n/require-locale';
import { withBusinessSeatPrices } from '@/lib/stripe/business-seat-display';
import { businessSeatPageCopy } from '@/lib/billing/business-seat-copy';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const t = await getTranslations({ locale, namespace: 'pricing' });
  const title = t.has('meta.title') ? t('meta.title') : 'Pricing';
  // Business per person (switch on): the stock description quotes the flat
  // Business price, so it is replaced. Off, the description is unchanged.
  const seat = businessSeatPageCopy(locale, await withBusinessSeatPrices(await fetchStripePrices()));
  const description = seat
    ? seat.pricing.metaDescription
    : t.has('meta.description')
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
  requireLocale(locale);
  setRequestLocale(locale);
  // The Business founder price, while it is open (src/lib/stripe/founder-offer.ts).
  // Null outside the window, with the flag off, when every place is taken,
  // when the count cannot be read, and always in zh. Read per request; the
  // flag and the place count are each cached 60 s (founder-offer-server.ts).
  const founder = await founderDisplayFor({ locale });
  // Business billed per person while `business_seat_pricing` is on: the
  // Business amounts become the per-person pair and `businessSeat` carries
  // the copy that goes with them (src/lib/billing/business-seat-copy.ts).
  // Off, or a failed read, leaves both untouched and the page as it was.
  const stripePrices = await withBusinessSeatPrices(
    pricesWithFounder(attachFounder(await fetchStripePrices(), founder), locale),
  );
  const businessSeat = businessSeatPageCopy(locale, stripePrices);
  // EUR on or off, read when this page renders and handed to the client,
  // which decides per visitor (EU or not) without making the page dynamic.
  // On means STRIPE_EUR_PRICES, or the automatic launch once it completed
  // (src/lib/stripe/eur-launch.ts), never under STRIPE_FORCE_USD. Off by
  // default, and off means the page renders exactly as before. A copy of this
  // page built before the launch still asks /api/geo from the launch date on
  // (useDisplayCurrency), so a deploy is not needed for visitors to see EUR.
  const eurEnabled = await eurDisplayEnabled();

  const t = await getTranslations({ locale, namespace: 'pricing' });
  const title = t.has('meta.title') ? t('meta.title') : 'Pricing';
  const description = businessSeat
    ? businessSeat.pricing.metaDescription
    : t.has('meta.description')
    ? t('meta.description')
    : 'Simple, transparent pricing for AI agents that read and send email. Free plan available. No card required.';
  // Emits the real plan catalogue as Product + Offers, so an assistant asked
  // what MCPEmails costs reads the same four tiers a visitor sees.
  const jsonLd = pricingJsonLd(
    locale,
    { title, description },
    {
      eur: eurEnabled,
      founder: founder ? { monthlyCents: founder.monthlyCents, validUntil: FOUNDER_VALID_UNTIL } : null,
      businessPerPerson: businessSeat ? { monthlyCents: stripePrices.pro.monthlyCents } : null,
    },
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <PricingClient stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} />
    </>
  );
}
