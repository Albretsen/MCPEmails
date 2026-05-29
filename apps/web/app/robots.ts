import { MetadataRoute } from 'next';

const BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://mcpemails.com';

/**
 * Next.js App Router robots.txt generator.
 * Renders as /robots.txt at build time.
 *
 * Rules:
 * - Public marketing pages: allow all crawlers.
 * - Dashboard, auth, API, and OAuth routes: disallow all crawlers.
 *   These are private and must not be indexed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/pricing', '/docs', '/privacy', '/terms'],
        disallow: [
          '/dashboard',
          '/dashboard/',
          '/login',
          '/signup',
          '/forgot-password',
          '/reset-password',
          '/authorize',
          '/api/',
          '/auth/',
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
