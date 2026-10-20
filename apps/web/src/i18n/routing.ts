import { defineRouting } from 'next-intl/routing';

/**
 * Locale routing config, shared by the proxy/middleware, navigation helpers,
 * and request config.
 *
 * localePrefix 'as-needed': the default locale (en) is served without a prefix
 * (mcpemails.com/), every other locale carries its prefix (mcpemails.com/nb).
 * This keeps the existing English URLs and their SEO intact.
 */
export const routing = defineRouting({
  locales: ['en', 'nb', 'es', 'fr', 'zh', 'de'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  // Don't auto-redirect by cookie/Accept-Language. The default-locale home (/)
  // must serve a stable English page with a stable canonical for SEO; visitors
  // reach other languages via an explicit prefix (/nb) or the language switcher.
  localeDetection: false,
  // No `Link:` response header. next-intl's middleware builds it from this list
  // alone, so it advertised all five locales on every page, including pages
  // that exist only in some of them (English-only comparisons, untranslated
  // blog posts, providers without zh). The <link rel="alternate"> tags each
  // page emits from its real locale list (src/i18n/seo.ts) are the only
  // hreflang source.
  alternateLinks: false,
});

export type Locale = (typeof routing.locales)[number];
