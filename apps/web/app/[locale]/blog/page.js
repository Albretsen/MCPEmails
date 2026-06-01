import { setRequestLocale, getTranslations } from 'next-intl/server';
import { metaAlternates, localePath, OG_LOCALE, APP_URL } from '@/i18n/seo';
import { getAllPosts, getAuthor, getLocalizedPost } from '@/lib/blog/posts';
import { readingTime } from '@/lib/blog/markdown';
import BlogIndexClient from '../../../components/marketing/BlogIndexClient';

export async function generateMetadata({ params }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'blog' });
  const title = t('meta.title');
  const description = t('meta.description');
  return {
    title,
    description,
    // The index chrome is localized in every locale, so all locales are
    // legitimate alternates here (unlike individual posts).
    alternates: metaAlternates(locale, '/blog'),
    openGraph: {
      type: 'website',
      url: localePath(locale, '/blog'),
      title: `${title} · mcpemails`,
      description,
      locale: OG_LOCALE[locale],
      images: [{ url: '/og.png', width: 1200, height: 630, alt: 'mcpemails Blog' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} · mcpemails`,
      description,
      images: ['/og.png'],
    },
  };
}

export default async function BlogIndexPage({ params }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'blog' });

  // Serialise the minimal data the client list needs, each field resolved for
  // the active locale (falling back to English when not translated).
  const posts = getAllPosts().map((raw) => {
    const p = getLocalizedPost(raw.slug, locale);
    const author = getAuthor(p);
    return {
      slug: p.slug,
      title: p.title,
      description: p.description,
      cover: p.cover,
      coverAlt: p.coverAlt,
      tags: p.tags,
      featured: Boolean(p.featured),
      publishedAt: p.publishedAt,
      readingMinutes: readingTime(p.content),
      author: { name: author.name, role: author.role, avatar: author.avatar },
    };
  });

  // Blog + ItemList structured data for rich results / AI discovery.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: t('blogName'),
    description: t('meta.description'),
    url: localePath(locale, '/blog'),
    inLanguage: locale,
    publisher: {
      '@type': 'Organization',
      name: 'mcpemails',
      url: APP_URL,
      logo: { '@type': 'ImageObject', url: `${APP_URL}/logo-mark.svg` },
    },
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description,
      datePublished: p.publishedAt,
      url: localePath(locale, `/blog/${p.slug}`),
      author: { '@type': 'Person', name: p.author.name },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <BlogIndexClient posts={posts} />
    </>
  );
}
