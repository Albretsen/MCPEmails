import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { metaAlternatesFor, localePath, OG_LOCALE, OG_IMAGE, connectJsonLd } from '@/i18n/seo';
import {
  clientGuideParams,
  clientGuideLocales,
  clientGuidePath,
  getClientGuide,
} from '@/lib/connect/client-guides.mjs';
import { stripTags } from '../../../../../components/marketing/RichText';
import ConnectClientGuideView from '../../../../../components/marketing/ConnectClientGuideView';
import { requireLocale } from '@/i18n/require-locale';

/**
 * One guide per assistant under a provider page: /connect/<provider>/claude
 * and /connect/<provider>/chatgpt. Which pairs and locales exist, and all the
 * copy, come from src/lib/connect/client-guides.mjs.
 */
export function generateStaticParams() {
  return clientGuideParams();
}

export async function generateMetadata({ params }) {
  const { locale, provider, client } = await params;
  requireLocale(locale);
  const guide = await getClientGuide(locale, provider, client);
  if (!guide) return {};
  const path = clientGuidePath(provider, client);
  const { title, description } = guide.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, path, clientGuideLocales(provider, client)),
    openGraph: {
      type: 'article',
      url: localePath(locale, path),
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

export default async function ConnectClientGuidePage({ params }) {
  const { locale, provider, client } = await params;
  requireLocale(locale);
  const guide = await getClientGuide(locale, provider, client);
  if (!guide) notFound();
  setRequestLocale(locale);

  const path = clientGuidePath(provider, client);
  const jsonLd = connectJsonLd(locale, {
    path,
    title: guide.meta.title,
    description: guide.meta.description,
    howToName: guide.stepsTitle,
    steps: guide.steps.map((s) => ({ h: s.h, p: stripTags(s.p) })),
    faq: guide.faq.map((f) => ({ q: f.q, a: stripTags(f.a) })),
    // The breadcrumb's middle item is the provider page this guide sits under.
    connectLabel: guide.providerShort,
    hubPath: `/connect/${provider}`,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ConnectClientGuideView
        locale={locale}
        providerSlug={provider}
        guide={guide}
        locales={clientGuideLocales(provider, client)}
      />
    </>
  );
}
