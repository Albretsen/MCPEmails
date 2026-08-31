import { MetadataRoute } from 'next';
import { localePath, languageAlternates } from '@/i18n/seo';
import { getAllPosts, getPostLocales } from '@/lib/blog/posts';
import { blogPostLanguageAlternates } from '@/lib/blog/seo.mjs';

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
  { path: '', lastModified: '2026-08-27', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/pricing', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/docs', lastModified: '2026-08-27', changeFrequency: 'weekly', priority: 0.8 },
  // The provider compatibility matrix: the page written to be cited, and the
  // one whose value depends on being re-verified, hence the higher priority
  // and the visible last-verified date on the page itself.
  { path: '/docs/providers', lastModified: '2026-08-30', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/native-connectors-vs-mcp', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/self-hosting', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/security', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/about', lastModified: '2026-08-29', changeFrequency: 'yearly', priority: 0.5 },
  { path: '/for/founders', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.8 },
  // Provider landing pages. Priorities follow measured acquisition, not brand
  // size: generic IMAP is the largest and best-retaining cohort of connected
  // inboxes and Yahoo out-converts everything except the home page, while
  // Gmail retains worst of the real providers.
  { path: '/connect/imap', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/connect/gmail', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/yahoo', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/connect/fastmail', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/icloud', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/connect/zoho', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/yandex', lastModified: '2026-08-27', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/gmx', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/aol', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/mail-ru', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/web-de', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/cpanel', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/ionos', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/connect/ovh', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/migadu', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/namecheap', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/rackspace', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/connect/hostinger', lastModified: '2026-08-31', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/blog', lastModified: '2026-08-02', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/privacy', lastModified: '2026-08-27', changeFrequency: 'yearly', priority: 0.3 },
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
        alternates: {
          languages: blogPostLanguageAlternates(
            getPostLocales(post),
            path,
            localePath,
          ),
        },
      };
    });

  return [...staticEntries, ...postEntries];
}
