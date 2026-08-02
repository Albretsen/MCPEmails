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
  /** Date of the last substantive content change — never use generation time. */
  lastModified: string;
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
  priority: number;
}[] = [
  { path: '', lastModified: '2026-07-28', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/pricing', lastModified: '2026-07-30', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/docs', lastModified: '2026-08-02', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/docs/providers', lastModified: '2026-08-02', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/native-connectors-vs-mcp', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/self-hosting', lastModified: '2026-07-09', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/security', lastModified: '2026-07-28', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/for/founders', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/gmail', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/fastmail', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/icloud', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/yahoo', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/zoho', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/yandex', lastModified: '2026-06-23', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/blog', lastModified: '2026-08-02', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/privacy', lastModified: '2026-07-28', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', lastModified: '2026-07-28', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = MARKETING_PAGES.map(
    ({ path, lastModified, changeFrequency, priority }) => ({
      url: localePath('en', path),
      lastModified: new Date(`${lastModified}T00:00:00.000Z`),
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
