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
  locales: ['en', 'nb'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
});

export type Locale = (typeof routing.locales)[number];
