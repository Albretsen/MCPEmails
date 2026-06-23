import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, OG_IMAGE } from '@/i18n/seo';
import CompareClient from '../../../components/marketing/CompareClient';

const PATH = '/native-connectors-vs-mcp';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'compare' });
  const title = t.has('meta.title') ? t('meta.title') : 'Native connectors vs MCP';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Why a managed MCP email server beats AI-native built-in connectors: more providers, real actions, and one setup across every AI client.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, PATH),
    openGraph: {
      type: 'website',
      url: localePath(locale, PATH),
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

export default async function ComparePage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <CompareClient />;
}
