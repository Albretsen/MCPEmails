import { MetadataRoute } from 'next';
import { localePath, languageAlternates } from '@/i18n/seo';

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
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return MARKETING_PAGES.map(({ path, changeFrequency, priority }) => ({
    url: localePath('en', path),
    lastModified: now,
    changeFrequency,
    priority,
    alternates: { languages: languageAlternates(path) },
  }));
}
