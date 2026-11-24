/**
 * Page titles and descriptions sized for search results.
 *
 * The root layout's title template appends " · MCPEmails" to every page title.
 * Google cuts a result title at roughly 60 characters, and the 2026-11-24 crawl
 * found 802 rendered titles over that, most of them because the brand suffix
 * pushed a 50-something title past the limit. So the suffix is added only when
 * the whole title still fits; a longer page title renders on its own, with its
 * keyword intact instead of a truncated brand.
 *
 * `meta-lengths.test.mjs` (in `npm run test:seo`) holds the source copy to
 * TITLE_MAX and DESCRIPTION_MAX; `scripts/check-seo-lengths.mjs` checks the
 * live pages.
 */

export const BRAND_SUFFIX = ' · MCPEmails';
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 160;

/** The <title> text a page title renders as. */
export function renderedTitle(title) {
  return title.length + BRAND_SUFFIX.length <= TITLE_MAX ? `${title}${BRAND_SUFFIX}` : title;
}

/**
 * The `title` field for Next metadata: the plain string (the layout template
 * adds the suffix) when it fits, otherwise an absolute title without suffix.
 */
export function pageTitle(title) {
  if (typeof title !== 'string') return title;
  return title.length + BRAND_SUFFIX.length <= TITLE_MAX ? title : { absolute: title };
}
