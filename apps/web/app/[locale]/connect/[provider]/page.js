import { notFound } from 'next/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import { routing } from '@/i18n/routing';
import ConnectProviderClient from '../../../../components/marketing/ConnectProviderClient';

// Providers with a dedicated landing page. Each maps to a sub-object in the
// `connect` message namespace (connect.<provider>.*). Only providers we truly
// support via app password are listed here.
const PROVIDERS = ['fastmail', 'icloud'];

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    PROVIDERS.map((provider) => ({ locale, provider })),
  );
}

export async function generateMetadata({ params }) {
  const { locale, provider } = await params;
  if (!PROVIDERS.includes(provider)) return {};
  const path = `/connect/${provider}`;
  const t = await getTranslations({ locale, namespace: `connect.${provider}` });
  const title = t.has('meta.title') ? t('meta.title') : 'Connect your inbox';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Connect your inbox to Claude and any MCP client. Read, send, schedule and organize email with AI.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, path),
    openGraph: {
      type: 'website',
      url: localePath(locale, path),
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

export default async function ConnectProviderPage({ params }) {
  const { locale, provider } = await params;
  if (!PROVIDERS.includes(provider)) notFound();
  setRequestLocale(locale);
  return <ConnectProviderClient provider={provider} />;
}
