import { notFound } from 'next/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternatesFor, localePath, OG_LOCALE, OG_IMAGE, connectJsonLd } from '@/i18n/seo';
import { getProvider, providerLocales } from '@/lib/connect/providers.mjs';
import { isViewable } from '@/lib/connect/release.mjs';
import { getProviderContent, providerParams } from '@/lib/connect/content.mjs';
import { getMultiMailboxCopy, showsMultiMailbox } from '@/lib/connect/multi-mailbox.mjs';
import { CHATGPT_BLOG_SLUG, chatgptBlogLink, getChatgptCopy, showsChatgpt } from '@/lib/connect/chatgpt.mjs';
import { providerFaq } from '@/lib/connect/faq.mjs';
import { getPost, getPostLocales } from '@/lib/blog/posts';
import { stripTags } from '../../../../components/marketing/RichText';
import ConnectProviderView from '../../../../components/marketing/ConnectProviderView';

/**
 * One landing page per email provider, at /connect/<slug>.
 *
 * The provider list, its verified IMAP/SMTP settings and which locales each
 * page exists in all come from src/lib/connect. Every slug must match
 * /connect/[a-z0-9-]+ or acquisition attribution silently drops the landing
 * path (safeLandingPath in src/lib/acquisition-context.mjs, and the CHECK
 * constraint on workspaces.acquisition_landing_path that mirrors it).
 */
export function generateStaticParams() {
  return providerParams();
}

export async function generateMetadata({ params }) {
  const { locale, provider: slug } = await params;
  const provider = getProvider(slug);
  const content = await getProviderContent(locale, slug);
  if (!provider || !content || !isViewable(provider)) return {};
  const path = `/connect/${slug}`;
  const { title, description } = content.meta;
  return {
    title,
    description,
    alternates: metaAlternatesFor(locale, path, providerLocales(slug)),
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
  const { locale, provider: slug } = await params;
  const provider = getProvider(slug);
  // Providers are released in waves (see lib/connect/release.mjs). A wave that
  // has not opened yet has no page at all, rather than a page carrying noindex:
  // a URL that 404s costs no crawl budget, and a noindex one still gets fetched.
  if (!provider || !isViewable(provider)) notFound();
  setRequestLocale(locale);

  const content = await getProviderContent(locale, slug);
  if (!content) notFound();

  const t = await getTranslations({ locale, namespace: 'connect' });
  // Business, hosting, cPanel and self-hosted pages carry a block saying every
  // mailbox the company runs on this host connects to the same agent, plus a
  // matching FAQ entry (see lib/connect/multi-mailbox). Null everywhere else.
  const multiMailbox = showsMultiMailbox(provider) ? await getMultiMailboxCopy(locale) : null;
  // Every supported provider gets a "Use <provider> in ChatGPT" block and,
  // except Yahoo, a matching FAQ entry (see lib/connect/chatgpt). Null on the
  // limited pages.
  const chatgpt = showsChatgpt(provider)
    ? {
        copy: await getChatgptCopy(locale),
        blog: chatgptBlogLink(locale, getPostLocales(getPost(CHATGPT_BLOG_SLUG))),
      }
    : null;
  const faq = providerFaq({ content, provider, multiMailbox, chatgptCopy: chatgpt?.copy });
  const jsonLd = connectJsonLd(locale, {
    path: `/connect/${slug}`,
    title: content.meta.title,
    description: content.meta.description,
    howToName: t('how.title', { provider: provider.name }),
    steps: content.setup.map((s) => ({ h: s.h, p: stripTags(s.p) })),
    faq: faq.map((f) => ({ q: f.q, a: stripTags(f.a) })),
    connectLabel: t('hub.breadcrumb'),
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ConnectProviderView locale={locale} provider={provider} content={content} multiMailbox={multiMailbox} chatgpt={chatgpt} />
    </>
  );
}
