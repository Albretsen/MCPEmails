export const ACQUISITION_QUERY_KEYS = Object.freeze({
  source: 'acq',
  landing: 'landing',
  landingPath: 'landing_path',
  locale: 'acq_locale',
  referrer: 'referrer',
  utmSource: 'utm_source_category',
  utmMedium: 'utm_medium_category',
  utmCampaign: 'utm_campaign_category',
});

/**
 * Every acquisition category we are willing to persist.
 *
 * WHY THE LIST GREW ON 2026-09-15. It used to name seven sources, so every
 * referral that was not Google, Reddit, GitHub, Smithery, Glama or Cursor
 * collapsed into `other`. Directory listings are this product's main
 * acquisition channel, which made `other` the biggest bucket and the question
 * it hides (which listing actually sends people who pay) unanswerable.
 *
 * The same strings are pinned by three CHECK constraints and by the signup
 * trigger's own allowlist in
 * supabase/migrations/20260915190000_widen_acquisition_sources.sql. A value
 * this file emits that the database has not been taught is not a soft failure:
 * the CHECK rejects the write, or the trigger silently NULLs it. The drift test
 * in acquisition-context.test.mjs reads that migration and compares the two
 * lists member by member so they cannot diverge again.
 */
export const SOURCES = new Set([
  'direct',
  // Search engines.
  'organic_google', 'organic_bing', 'organic_duckduckgo',
  // Communities and social.
  'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github',
  // AI clients and assistants that link out to us.
  'claude', 'chatgpt', 'perplexity',
  // MCP directories and listings, the channel this whole widening is for.
  'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp',
  'other',
]);
export const LANDINGS = new Set(['home', 'blog', 'provider', 'docs', 'pricing', 'other']);
export const LOCALES = new Set(['en', 'nb', 'es', 'fr', 'zh']);
export const UTM_MEDIA = new Set([
  'organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'other',
]);
export const UTM_CAMPAIGNS = new Set([
  'launch', 'newsletter', 'content', 'product', 'partner', 'community', 'other',
]);

/**
 * Referrer hosts we can name, each mapped to the coarse category that is
 * persisted in its place. The host itself is never stored, so this table is the
 * entire privacy boundary for referrers: a host that is not listed here becomes
 * `other` and nothing about it survives.
 *
 * Several hosts deliberately share one category (chat.openai.com and
 * openai.com, x.com and t.co, cursor.com and cursor.directory), because the
 * question the kiosk asks is "which channel", not "which hostname". No entry is
 * a suffix of another entry it should not win over, so the order below is for
 * reading, not for matching.
 */
const HOST_SOURCES = Object.freeze([
  ['google.com', 'organic_google'],
  ['bing.com', 'organic_bing'],
  ['duckduckgo.com', 'organic_duckduckgo'],
  ['reddit.com', 'reddit'],
  ['news.ycombinator.com', 'hacker_news'],
  ['x.com', 'x_twitter'],
  ['twitter.com', 'x_twitter'],
  ['t.co', 'x_twitter'],
  ['linkedin.com', 'linkedin'],
  ['lnkd.in', 'linkedin'],
  ['github.com', 'github'],
  ['claude.ai', 'claude'],
  ['anthropic.com', 'claude'],
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['openai.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['smithery.ai', 'smithery'],
  ['glama.ai', 'glama'],
  ['cursor.com', 'cursor'],
  // The Cursor listing lives on cursor.directory, not on the product domain, so
  // matching only cursor.com missed the referrals the listing actually sends.
  ['cursor.directory', 'cursor'],
  ['lobehub.com', 'lobehub'],
  ['pulsemcp.com', 'pulsemcp'],
  ['mcpservers.org', 'mcpservers'],
  ['mcp.so', 'mcp_so'],
  ['freemcp.space', 'freemcp'],
]);

export function sourceFromHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const [domain, source] of HOST_SOURCES) {
    if (host === domain || host.endsWith(`.${domain}`)) return source;
  }
  return 'other';
}

export function localeAndPath(pathname) {
  const match = pathname.match(/^\/(nb|es|fr|zh)(?=\/|$)/);
  const locale = match?.[1] ?? 'en';
  const path = pathname.slice(match?.[0].length ?? 0) || '/';
  return { locale, path };
}

export function landingFromPath(pathname) {
  const { path } = localeAndPath(pathname);
  if (path === '/') return 'home';
  if (path.startsWith('/blog')) return 'blog';
  if (path.startsWith('/connect/')) return 'provider';
  if (path.startsWith('/docs')) return 'docs';
  if (path.startsWith('/pricing')) return 'pricing';
  return 'other';
}

/** Keep only public route shape; never persist query strings, fragments, or auth paths. */
export function safeLandingPath(pathname) {
  const { path } = localeAndPath(pathname);
  if (path === '/') return '/';
  if (/^\/blog\/[a-z0-9-]+\/?$/.test(path)) return path.replace(/\/$/, '');
  if (/^\/connect\/[a-z0-9-]+\/?$/.test(path)) return path.replace(/\/$/, '');
  if (/^\/docs(?:\/[a-z0-9-]+)*\/?$/.test(path)) return path.replace(/\/$/, '');
  if (['/blog', '/pricing', '/security', '/self-hosting', '/native-connectors-vs-mcp'].includes(path)) return path;
  return '/other';
}

/**
 * utm_source is free text somebody typed into a link, so this matches on
 * substrings rather than on exact hosts: `chatgpt.com`, `ChatGPT` and
 * `chatgpt-directory` are all the same channel to us.
 *
 * Two needles are deliberately not the obvious ones. `x` alone would match
 * almost every string, so X is recognised by `twitter`, `x.com` and `t.co`
 * only. `mcp` alone would swallow every directory at once, so each directory
 * carries its full name. The first match wins, so nothing here may be a
 * substring of a later entry.
 */
const UTM_SOURCES = Object.freeze([
  ['google', 'organic_google'],
  ['bing', 'organic_bing'],
  ['duckduckgo', 'organic_duckduckgo'],
  ['reddit', 'reddit'],
  ['ycombinator', 'hacker_news'],
  ['hacker_news', 'hacker_news'],
  ['hackernews', 'hacker_news'],
  ['twitter', 'x_twitter'],
  ['x.com', 'x_twitter'],
  ['t.co', 'x_twitter'],
  ['linkedin', 'linkedin'],
  ['lnkd', 'linkedin'],
  ['github', 'github'],
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['chatgpt', 'chatgpt'],
  ['openai', 'chatgpt'],
  ['perplexity', 'perplexity'],
  ['smithery', 'smithery'],
  ['glama', 'glama'],
  ['cursor', 'cursor'],
  ['lobehub', 'lobehub'],
  ['pulsemcp', 'pulsemcp'],
  ['mcpservers', 'mcpservers'],
  ['mcp.so', 'mcp_so'],
  ['freemcp', 'freemcp'],
]);

export function sourceFromUtm(value) {
  const source = value?.toLowerCase();
  if (!source) return null;
  for (const [needle, category] of UTM_SOURCES) {
    if (source.includes(needle)) return category;
  }
  return 'other';
}

export function mediumFromUtm(value) {
  const medium = value?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!medium) return null;
  if (medium === 'cpc' || medium === 'ppc' || medium === 'paidsearch') return 'paid_search';
  if (medium === 'social' || medium === 'paid_social') return 'social';
  if (medium === 'email' || medium === 'newsletter') return 'email';
  if (medium === 'organic' || medium === 'referral' || medium === 'affiliate' || medium === 'display') return medium;
  return 'other';
}

/** Deliberately bucket campaigns; raw campaign strings can contain identifiers. */
export function campaignFromUtm(value) {
  const campaign = value?.toLowerCase();
  if (!campaign) return null;
  if (campaign.includes('launch')) return 'launch';
  if (campaign.includes('newsletter')) return 'newsletter';
  if (campaign.includes('blog') || campaign.includes('content') || campaign.includes('seo')) return 'content';
  if (campaign.includes('product')) return 'product';
  if (campaign.includes('partner')) return 'partner';
  if (campaign.includes('community')) return 'community';
  return 'other';
}

export function sanitizedAcquisition(value) {
  return {
    source: SOURCES.has(value?.source) ? value.source : 'direct',
    landing: LANDINGS.has(value?.landing) ? value.landing : 'other',
    landingPath: safeLandingPath(value?.landingPath ?? '/other'),
    locale: LOCALES.has(value?.locale) ? value.locale : 'en',
    referrer: SOURCES.has(value?.referrer) ? value.referrer : 'direct',
    utmSource: value?.utmSource == null ? null : (SOURCES.has(value.utmSource) ? value.utmSource : 'other'),
    utmMedium: value?.utmMedium == null ? null : (UTM_MEDIA.has(value.utmMedium) ? value.utmMedium : 'other'),
    utmCampaign: value?.utmCampaign == null ? null : (UTM_CAMPAIGNS.has(value.utmCampaign) ? value.utmCampaign : 'other'),
  };
}

export function acquisitionFromLocation(url, referrerUrl = null) {
  const utmSource = sourceFromUtm(url.searchParams.get('utm_source'));
  const externalReferrer = referrerUrl && referrerUrl.origin !== url.origin
    ? sourceFromHost(referrerUrl.hostname)
    : 'direct';
  const { locale } = localeAndPath(url.pathname);
  return sanitizedAcquisition({
    source: utmSource ?? externalReferrer,
    landing: landingFromPath(url.pathname),
    landingPath: safeLandingPath(url.pathname),
    locale,
    referrer: externalReferrer,
    utmSource,
    utmMedium: mediumFromUtm(url.searchParams.get('utm_medium')),
    utmCampaign: campaignFromUtm(url.searchParams.get('utm_campaign')),
  });
}

export function appendAcquisitionParams(searchParams, value) {
  const clean = sanitizedAcquisition(value);
  for (const [field, queryKey] of Object.entries(ACQUISITION_QUERY_KEYS)) {
    if (clean[field] != null) searchParams.set(queryKey, clean[field]);
  }
}

export function acquisitionFromParams(searchParams) {
  return sanitizedAcquisition(Object.fromEntries(
    Object.entries(ACQUISITION_QUERY_KEYS).map(([field, queryKey]) => [field, searchParams.get(queryKey)]),
  ));
}

// How recently the auth user must have been created for an OAuth callback to
// count as a signup rather than a login. Both /signup and /login carry
// acquisition params (a first OAuth login creates the account), so the callback
// runs for returning users too, and an account predating attribution still has
// a NULL source. Without this check their next login would overwrite a blank
// first touch with today's landing page. The account is created during the same
// request, so the real gap is milliseconds; the window only absorbs clock skew.
export const NEW_ACCOUNT_WINDOW_MS = 2 * 60 * 1000;

export function isNewAccountSignup(createdAt, now = Date.now()) {
  const created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt ?? '');
  if (!Number.isFinite(created)) return false;
  const age = now - created;
  return age >= -NEW_ACCOUNT_WINDOW_MS && age < NEW_ACCOUNT_WINDOW_MS;
}
