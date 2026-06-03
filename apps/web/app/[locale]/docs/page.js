import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE } from '@/i18n/seo';
import DocsClient from '../../../components/marketing/DocsClient';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'docs' });
  const title = t.has('meta.title') ? t('meta.title') : 'Docs';
  const description = t.has('meta.description')
    ? t('meta.description')
    : 'Get started with MCPEmails in minutes. Quick-start guide, tool reference, and example responses for Gmail and IMAP agents.';
  return {
    title,
    description,
    alternates: metaAlternates(locale, '/docs'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/docs'),
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

export default async function DocsPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <DocsClient />;
}
