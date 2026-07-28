import { MetadataRoute } from 'next';
import { localePath, languageAlternates } from '@/i18n/seo';
import { getAllPosts } from '@/lib/blog/posts';

/**
 * Next.js App Router sitemap generator (renders as /sitemap.xml).
 * Only public marketing pages are included; dashboard, auth, and API routes
 * are private and must not appear in search indexes.
 *
 * Each entry lists its hreflang alternates so search engines discover the
 * Norwegian (/nb/...) variants. The canonical `url` is the default-locale URL.
 */
const MARKETING_PAGES: {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
  priority: number;
}[] = [
  { path: '', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/docs', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/docs/providers', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/native-connectors-vs-mcp', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/self-hosting', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/for/founders', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/gmail', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/fastmail', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/icloud', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/yahoo', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/zoho', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/yandex', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/blog', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = MARKETING_PAGES.map(
    ({ path, changeFrequency, priority }) => ({
      url: localePath('en', path),
      lastModified: now,
      changeFrequency,
      priority,
      alternates: { languages: languageAlternates(path) },
    }),
  );

  // Individual blog posts, each with their own hreflang alternates.
  // Posts flagged `noindex` (e.g. previews of not-yet-shipped features) are
  // kept out of the sitemap so search engines don't surface them.
  const postEntries: MetadataRoute.Sitemap = getAllPosts()
    .filter((post) => !post.noindex)
    .map((post) => {
      const path = `/blog/${post.slug}`;
      return {
        url: localePath('en', path),
        lastModified: new Date(post.updatedAt),
        changeFrequency: 'monthly',
        priority: 0.6,
        alternates: { languages: languageAlternates(path) },
      };
    });

  return [...staticEntries, ...postEntries];
}
