import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { fetchStripePrices } from '@/lib/stripe/getPrices';
import { eurDisplayEnabled } from '@/lib/stripe/eur-launch';
import { routing } from '@/i18n/routing';
import { requireLocale } from '@/i18n/require-locale';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE, homeJsonLd } from '@/i18n/seo';
import { withBusinessSeatPrices } from '@/lib/stripe/business-seat-display';
import { businessSeatPageCopy } from '@/lib/billing/business-seat-copy';

import { isStaging } from '@/lib/env/app-env';
// The picker on staging builds, a no-op stub everywhere else (next.config.js
// alias), so production never compiles the lab. A static import on purpose: a
// dynamic import() here put every variant's CSS on the home page.
import { renderHomeLab } from 'home-lab-entry';

/**
 * The English and localized home page, shared by `app/[locale]/page.tsx` and,
 * on staging only, the Homepage Lab variant routes (`app/[locale]/home-lab/vNN`).
 * Metadata, data loading and the JSON-LD (FAQPage included) are identical for
 * every body; only the body below the JSON-LD differs. Production renders
 * exactly what the home page always rendered: `body` is HomeClient and the lab
 * branch is dropped at build (NEXT_PUBLIC_APP_ENV is inlined; `home-lab-entry`
 * is a no-op stub outside staging builds, see next.config.js).
 */
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

export type HomeBodyProps = {
  stripePrices: Awaited<ReturnType<typeof withBusinessSeatPrices>>;
  eurEnabled: boolean;
  businessSeat: ReturnType<typeof businessSeatPageCopy>;
  faqItems: { q: string; a: string }[];
  locale: string;
};

export async function renderHome(
  locale: string,
  body: (props: HomeBodyProps) => ReactNode,
  labVariant: string = 'v00',
) {
  requireLocale(locale);
  setRequestLocale(locale);
  // Business per person while `business_seat_pricing` is on; untouched when
  // it is off (src/lib/stripe/business-seat-display.ts).
  const stripePrices = await withBusinessSeatPrices(await fetchStripePrices());
  const businessSeat = businessSeatPageCopy(locale, stripePrices);

  const t = await getTranslations({ locale, namespace: 'home.meta' });
  // The visible FAQ (components/marketing/Sections.jsx, Faq) reads this same
  // array, which is what keeps the FAQPage node and the page in step.
  const tFaq = await getTranslations({ locale, namespace: 'home.faq' });
  const faqItems = tFaq.raw('items');
  const jsonLd = homeJsonLd(locale, {
    name: t('title'),
    description: t('description'),
    faq: Array.isArray(faqItems) ? faqItems : [],
    businessPerPerson: businessSeat && stripePrices.pro?.monthlyCents
      ? { monthlyCents: stripePrices.pro.monthlyCents }
      : null,
  });

  // EUR on (env switch or the completed launch, eur-launch.ts) as read at
  // render; off renders exactly as before.
  let content: ReactNode = body({
    stripePrices,
    eurEnabled: await eurDisplayEnabled(),
    businessSeat,
    faqItems: Array.isArray(faqItems) ? faqItems : [],
    locale,
  });
  // Homepage Lab picker: English staging only. The guard is inlined at build,
  // so production drops this branch; isStaging() is the runtime check on top.
  if (process.env.NEXT_PUBLIC_APP_ENV === 'staging' && isStaging() && locale === 'en') {
    content = await renderHomeLab({ current: content, id: labVariant });
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {content}
    </>
  );
}
