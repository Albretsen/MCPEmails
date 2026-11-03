/**
 * Link rewriting for help content. No JSON imports, so the client-side
 * HelpCenter can use it without pulling the copy of every locale into the
 * browser bundle.
 */

/** The address shown as the email way in. */
export const SUPPORT_EMAIL = 'support@mcpemails.com';

/**
 * A marketing path in a locale (`as-needed` prefixing: English has none).
 * Dashboard paths, anchors-only and absolute URLs are left alone: the dashboard
 * is not under app/[locale].
 */
export function helpHref(locale, href) {
  if (typeof href !== 'string' || !href.startsWith('/')) return href;
  if (href === '/dashboard' || href.startsWith('/dashboard/') || href.startsWith('/api/')) return href;
  if (!locale || locale === 'en') return href;
  return href === '/' ? `/${locale}` : `/${locale}${href}`;
}

/**
 * Where an article link points from inside the help center. A link to an
 * anchor on /help (`/help#article-x`, `/help#contact`) becomes the in-page
 * anchor, because the help center is the page being read, on /help and in the
 * dashboard alike. Everything else goes through helpHref.
 */
export function articleLinkHref(locale, href) {
  if (typeof href === 'string' && href.startsWith('/help#')) return href.slice('/help'.length);
  return helpHref(locale, href);
}
