import { permanentRedirect } from 'next/navigation';
import * as C from '@/lib/compare/email-mcp-servers.mjs';
import { requireLocale } from '@/i18n/require-locale';

/**
 * The page this route used to serve now lives at C.PATH
 * (/best-email-mcp-servers), because that is the phrase people search for.
 * This stub keeps the old URL alive as a 308.
 *
 * Why a route stub and not a `redirects()` entry in next.config.js: the proxy
 * (next-intl middleware) runs BEFORE next.config redirects and rewrites this
 * path to /en/... first, so a redirect rule written against the public path
 * never sees the request it was written for. A route that redirects itself is
 * evaluated after that rewrite, in every locale, and is testable by opening it.
 * The path therefore has to stay in MARKETING_PATHS in proxy.ts for as long as
 * this stub exists.
 *
 * Safe to delete once the old URL stops appearing in Search Console, along with
 * its proxy entry and C.LEGACY_PATH.
 */
export function generateStaticParams() {
  return [{ locale: 'en' }];
}

export default async function LegacyComparisonRedirect({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  // The new page is English only, so every locale lands on it directly
  // (a /nb/<new> hop would only redirect again).
  permanentRedirect(C.PATH);
}
