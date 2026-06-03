import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE } from '@/i18n/seo';
import ProvidersClient from '../../../../components/marketing/ProvidersClient';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'docs' });
  const title = t.has('providers.meta.title') ? t('providers.meta.title') : 'Provider Support';
  const description = t.has('providers.meta.description')
    ? t('providers.meta.description')
    : 'See which email providers MCPEmails supports and which features are available per provider: Gmail, Outlook, Fastmail, iCloud, Yahoo, Zoho, Yandex, and Generic IMAP.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/docs/providers'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/docs/providers'),
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

export default async function ProvidersPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <ProvidersClient />;
}
