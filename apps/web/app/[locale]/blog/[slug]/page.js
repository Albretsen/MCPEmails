import { notFound } from 'next/navigation';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { localePath, OG_LOCALE, APP_URL } from '@/i18n/seo';
import { routing } from '@/i18n/routing';
import { getAllPosts, getLocalizedPost, getAuthor } from '@/lib/blog/posts';
import { renderMarkdown, readingTime } from '@/lib/blog/markdown';
import BlogPostClient from '../../../../components/marketing/BlogPostClient';

/** Pre-render every post in every locale (untranslated locales fall back to English). */
export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getAllPosts().map((p) => ({ locale, slug: p.slug })),
  );
}

/**
 * hreflang + canonical for a post. We only advertise the locales the post is
 * actually translated into; every other locale serves the English fallback and
 * canonicalises to the English URL, so search engines never index a
 * fake-localized duplicate.
 */
function buildAlternates(post, locale, path) {
  const languages = {};
  for (const l of post.locales) languages[l] = localePath(l, path);
  languages['x-default'] = localePath('en', path);
  const canonicalLocale = post.translated ? locale : 'en';
  return { canonical: localePath(canonicalLocale, path), languages, canonicalLocale };
}

export async function generateMetadata({ params }) {
  const { locale, slug } = await params;
  const post = getLocalizedPost(slug, locale);
  if (!post) return {};
  const author = getAuthor(post);
  const path = `/blog/${slug}`;
  const { canonical, languages, canonicalLocale } = buildAlternates(post, locale, path);
  return {
    title: post.title,
    description: post.description,
    authors: [{ name: author.name }],
    // Posts flagged `noindex` (e.g. previews of not-yet-shipped features) stay
    // reachable but are kept out of search indexes; links are still followed.
    ...(post.noindex ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical, languages },
    openGraph: {
      type: 'article',
      url: canonical,
      title: `${post.title} · mcpemails`,
      description: post.description,
      locale: OG_LOCALE[canonicalLocale],
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      authors: [author.name],
      tags: post.tags,
      images: [{ url: post.cover, width: 1200, height: 630, alt: post.coverAlt }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${post.title} · mcpemails`,
      description: post.description,
      images: [post.cover],
    },
  };
}

export default async function BlogPostPage({ params }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const post = getLocalizedPost(slug, locale);
  if (!post) notFound();

  const t = await getTranslations({ locale, namespace: 'blog' });
  const author = getAuthor(post);
  const { html, headings } = renderMarkdown(post.content);
  const readingMinutes = readingTime(post.content);
  const path = `/blog/${slug}`;
  const { canonical, canonicalLocale } = buildAlternates(post, locale, path);
  const pageUrl = localePath(locale, path);

  // Article (BlogPosting) + breadcrumb structured data for rich results.
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    image: [`${APP_URL}${post.cover}`],
    inLanguage: canonicalLocale,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    url: canonical,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    keywords: post.tags.join(', '),
    wordCount: post.content.split(/\s+/).filter(Boolean).length,
    author: {
      '@type': 'Person',
      name: author.name,
      description: author.bio,
      url: author.url,
    },
    publisher: {
      '@type': 'Organization',
      name: 'mcpemails',
      url: APP_URL,
      logo: { '@type': 'ImageObject', url: `${APP_URL}/logo-mark.svg` },
    },
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('post.home'), item: localePath(locale, '/') },
      { '@type': 'ListItem', position: 2, name: t('post.blog'), item: localePath(locale, '/blog') },
      { '@type': 'ListItem', position: 3, name: post.title, item: pageUrl },
    ],
  };

  const postData = {
    slug: post.slug,
    title: post.title,
    description: post.description,
    cover: post.cover,
    coverAlt: post.coverAlt,
    tags: post.tags,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
    readingMinutes,
    html,
    headings,
    author,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />
      <BlogPostClient post={postData} />
    </>
  );
}
