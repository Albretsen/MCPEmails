import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { eurDisplayEnabled } from '@/lib/stripe/eur-launch';
import { routing } from '@/i18n/routing';
import { requireLocale } from '@/i18n/require-locale';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, homeJsonLd } from '@/i18n/seo';
import HomeClient from '../../components/marketing/HomeClient';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  requireLocale(locale);
  const t = await getTranslations({ locale, namespace: 'home.meta' });

  const title = t('title');
  const description = t('description');

  return {
    // Absolute on purpose: the homepage title text is frozen until 2026-11-01
    // for an SEO test, so it keeps the old suffix while the layout template
    // now says "MCPEmails". Switch back to plain `title` after the test.
    title: { absolute: `${title} · mcpemails` },
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
  requireLocale(locale);
  setRequestLocale(locale);
  const stripePrices = await fetchStripePrices();

  const t = await getTranslations({ locale, namespace: 'home.meta' });
  // The visible FAQ (components/marketing/Sections.jsx, Faq) reads this same
  // array, which is what keeps the FAQPage node and the page in step.
  const tFaq = await getTranslations({ locale, namespace: 'home.faq' });
  const faqItems = tFaq.raw('items');
  const jsonLd = homeJsonLd(locale, {
    name: t('title'),
    description: t('description'),
    faq: Array.isArray(faqItems) ? faqItems : [],
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* EUR on (env switch or the completed launch, eur-launch.ts) as read at
          render; off renders exactly as before. */}
      <HomeClient stripePrices={stripePrices} eurEnabled={await eurDisplayEnabled()} />
    </>
  );
}
