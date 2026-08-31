import { MetadataRoute } from 'next';
import { localePath, languageAlternates, languageAlternatesFor } from '@/i18n/seo';
import { PROVIDERS } from '@/lib/connect/providers.mjs';
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
  { path: '/connect', lastModified: '2026-08-31', changeFrequency: 'weekly', priority: 0.9 },
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

  // Provider landing pages, generated from the same registry that decides
  // which locale/provider pages exist at all. They were hand-listed here while
  // there were six of them; at 106 a hand-maintained list is a list that drifts,
  // and a sitemap that promises a URL the router does not generate is worse
  // than one that omits it. `languageAlternatesFor` is what keeps the hreflang
  // honest for the long tail that ships in English only.
  //
  // Priority follows how much the page can be expected to earn: the generic
  // IMAP page is the largest and best-retaining cohort of connected inboxes,
  // and the pages for providers we cannot connect are last, because they exist
  // to answer a question truthfully rather than to acquire anyone.
  const PROVIDER_PRIORITY: Record<string, number> = {
    generic: 0.9, consumer: 0.8, business: 0.8, hosting: 0.7,
    cpanel: 0.7, privacy: 0.6, regional: 0.6, isp: 0.5,
    selfhost: 0.5, blocked: 0.4,
  };
  const providerEntries: MetadataRoute.Sitemap = PROVIDERS.map((p) => {
    const path = `/connect/${p.slug}`;
    return {
      url: localePath('en', path),
      lastModified: new Date(`${p.evidence.verifiedOn}T00:00:00.000Z`),
      changeFrequency: 'monthly' as const,
      priority: PROVIDER_PRIORITY[p.category] ?? 0.5,
      alternates: { languages: languageAlternatesFor(path, p.locales) },
    };
  });

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

  return [...staticEntries, ...providerEntries, ...postEntries];
}
