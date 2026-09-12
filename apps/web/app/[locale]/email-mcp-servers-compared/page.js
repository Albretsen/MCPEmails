import { permanentRedirect } from 'next/navigation';
import * as C from '@/lib/compare/email-mcp-servers.mjs';

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
  // Keep a non-default locale prefix if one was used, so /nb/<old> lands on
  // /nb/<new> and gets that route's own 404 rather than a silent language flip.
  const prefix = locale && locale !== 'en' ? `/${locale}` : '';
  permanentRedirect(`${prefix}${C.PATH}`);
}
