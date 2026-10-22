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
 * trigger's own allowlist, newest in
 * supabase/migrations/20261019130000_directory_listing_attribution.sql. A value
 * this file emits that the database has not been taught is not a soft failure:
 * the CHECK rejects the write, or the trigger silently NULLs it. The drift test
 * in acquisition-context.test.mjs reads that migration and compares the two
 * lists member by member so they cannot diverge again.
 */
export const SOURCES = new Set([
  'direct',
  // Search engines.
  'organic_google', 'organic_bing', 'organic_duckduckgo',
  // Paid search. Kept apart from organic_google, which is the channel the SEO
  // work is judged on: an ad click counted there would flatter it.
  'google_ads',
  // Communities and social.
  'reddit', 'hacker_news', 'x_twitter', 'linkedin', 'github',
  // AI clients and assistants that link out to us.
  'claude', 'chatgpt', 'perplexity',
  // MCP directories and listings, the channel this whole widening is for.
  'smithery', 'glama', 'cursor', 'lobehub', 'pulsemcp', 'mcpservers', 'mcp_so', 'freemcp',
  // Listings that only a tagged link can name (2026-10-19). Each has its own
  // utm_source in docs/LISTINGS.md. Without these, npm, the MCP registry and
  // Docker recorded as `other`, the three GitHub lists all as `github`, and the
  // Claude, ChatGPT and Cursor directories in the same bucket as a plain
  // referral from that product. Referrer hosts never produce these.
  'npm', 'mcp_registry', 'docker',
  'github_punkpeye', 'github_tensorblock', 'github_bestof',
  'claude_directory', 'chatgpt_directory', 'cursor_directory',
  // AI assistants that were filed under a bigger name until 2026-10-22: Gemini
  // as organic_google (gemini.google.com ends in google.com) and Copilot as
  // `other`.
  'gemini', 'copilot',
  // Connector installs (2026-10-22). A logged-out user who connects an MCP
  // client is sent from /authorize to /login by the system browser with no
  // referrer, so every one of them used to be `direct`. Named after the client
  // that started the OAuth flow (connectorSourceFromAuthorize), and kept apart
  // from `claude`, `chatgpt` and `cursor`, which mean a link someone clicked.
  'connector_claude', 'connector_chatgpt', 'connector_cursor', 'connector_vscode', 'connector_other',
  'other',
]);
export const LANDINGS = new Set(['home', 'blog', 'provider', 'docs', 'pricing', 'other']);
export const LOCALES = new Set(['en', 'nb', 'es', 'fr', 'zh', 'de']);
export const UTM_MEDIA = new Set([
  'organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'directory', 'other',
]);
export const UTM_CAMPAIGNS = new Set([
  'launch', 'newsletter', 'content', 'product', 'partner', 'community', 'listing', 'other',
]);

/**
 * Referrer hosts we can name, each mapped to the coarse category that is
 * persisted in its place. The host itself is never stored, so this table is the
 * entire privacy boundary for referrers: a host that is not listed here becomes
 * `other` and nothing about it survives.
 *
 * Several hosts deliberately share one category (chat.openai.com and
 * openai.com, x.com and t.co, cursor.com and cursor.directory), because the
 * question the kiosk asks is "which channel", not "which hostname". The first
 * match wins. Only one entry sits under another: gemini.google.com, which has
 * to come before google.com or Gemini answers count as Google searches.
 */
const HOST_SOURCES = Object.freeze([
  ['gemini.google.com', 'gemini'],
  ['google.com', 'organic_google'],
  // The Android Google app sends `android-app://<package>/...` as referrer,
  // which parses with the package name as its hostname.
  ['com.google.android.googlequicksearchbox', 'organic_google'],
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
  ['copilot.microsoft.com', 'copilot'],
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

/**
 * Google's country search domains: google.de, google.no, google.co.uk,
 * google.com.au and so on. Only `google.com` is in the table above, so a search
 * from any other country used to be filed as `other`.
 */
const GOOGLE_COUNTRY_HOST = /(?:^|\.)google\.(?:com?\.)?[a-z]{2}$/;

export function sourceFromHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const [domain, source] of HOST_SOURCES) {
    if (host === domain || host.endsWith(`.${domain}`)) return source;
  }
  if (GOOGLE_COUNTRY_HOST.test(host)) return 'organic_google';
  return 'other';
}

export function localeAndPath(pathname) {
  const match = pathname.match(/^\/(nb|es|fr|zh|de)(?=\/|$)/);
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

/**
 * Public marketing pages with no slug of their own. Until 2026-10-04 the last
 * five and `/for/<slug>` were stored as `/other`, so nobody could tell whether
 * the persona and comparison pages produced customers.
 *
 * The same shapes are pinned twice more, in the CHECK constraint on
 * workspaces.acquisition_landing_path and in the signup trigger's own regex,
 * both in supabase/migrations/20261005113000_attribute_business_landing_pages.sql.
 * A path this file emits that the database has not been taught makes the
 * trigger NULL it (password signups) or fails the whole attribution UPDATE
 * (Google and GitHub signups). The drift tests compare the three copies.
 */
const STATIC_LANDING_PATHS = Object.freeze([
  '/blog', '/pricing', '/security', '/self-hosting', '/native-connectors-vs-mcp',
  '/connect', '/about', '/changelog', '/best-email-mcp-servers', '/email-mcp-servers-compared',
]);

/** Keep only public route shape; never persist query strings, fragments, or auth paths. */
export function safeLandingPath(pathname) {
  const { path } = localeAndPath(pathname);
  if (path === '/') return '/';
  if (/^\/blog\/[a-z0-9-]+\/?$/.test(path)) return path.replace(/\/$/, '');
  if (/^\/connect\/[a-z0-9-]+\/?$/.test(path)) return path.replace(/\/$/, '');
  if (/^\/docs(?:\/[a-z0-9-]+)*\/?$/.test(path)) return path.replace(/\/$/, '');
  if (/^\/for\/[a-z0-9-]+\/?$/.test(path)) return path.replace(/\/$/, '');
  const bare = path.replace(/\/$/, '');
  if (STATIC_LANDING_PATHS.includes(bare)) return bare;
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
 *
 * WHY THE MATCH IS ANCHORED ON ITS LEFT (2026-09-17). Ordering the needles
 * only rules out one needle hiding inside another; it does nothing about a
 * needle hiding inside an arbitrary VALUE. `t.co` sits inside "chatgp`t.co`m",
 * and ChatGPT stamps `utm_source=chatgpt.com` onto every link it surfaces, so
 * for two days every ChatGPT signup was filed as X and the `chatgpt` bucket
 * held nothing at all. `x.com` did the same to mailbox.com and linux.com. A
 * needle now only counts where a label can actually start: at the beginning of
 * the value, or straight after a non-alphanumeric character. Suffixes like
 * "openai-directory" and "chatgptplugin" still match, which is the point of
 * matching loosely in the first place.
 */
const UTM_SOURCES = Object.freeze([
  // Before 'google', which would otherwise claim these first.
  ['google_ads', 'google_ads'],
  ['googleads', 'google_ads'],
  ['adwords', 'google_ads'],
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
  // Each listing value before the bare product name it starts with, or
  // `github`, `claude`, `chatgpt` and `cursor` would claim it first.
  ['github_punkpeye', 'github_punkpeye'],
  ['github_tensorblock', 'github_tensorblock'],
  ['github_bestof', 'github_bestof'],
  ['github', 'github'],
  ['claude_directory', 'claude_directory'],
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['chatgpt_directory', 'chatgpt_directory'],
  ['chatgpt', 'chatgpt'],
  ['openai', 'chatgpt'],
  ['perplexity', 'perplexity'],
  ['smithery', 'smithery'],
  ['glama', 'glama'],
  ['cursor_directory', 'cursor_directory'],
  ['cursor', 'cursor'],
  ['lobehub', 'lobehub'],
  ['pulsemcp', 'pulsemcp'],
  ['mcpservers', 'mcpservers'],
  ['mcp.so', 'mcp_so'],
  ['freemcp', 'freemcp'],
  ['npm', 'npm'],
  ['mcp_registry', 'mcp_registry'],
  ['docker', 'docker'],
  ['gemini', 'gemini'],
  ['copilot', 'copilot'],
]);

/** `t.co` may begin the value or follow a separator, never a letter or digit. */
const UTM_PATTERNS = UTM_SOURCES.map(([needle, category]) => [
  new RegExp(`(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  category,
]);

export function sourceFromUtm(value) {
  const source = value?.toLowerCase();
  if (!source) return null;
  for (const [pattern, category] of UTM_PATTERNS) {
    if (pattern.test(source)) return category;
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
  if (medium === 'directory') return 'directory';
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
  if (campaign === 'listing') return 'listing';
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

/**
 * Google Ads auto-tagging appends one of these to every ad click, and nothing
 * else does. Only its PRESENCE is read: the value identifies a click and is
 * never stored.
 */
const GOOGLE_ADS_CLICK_PARAMS = Object.freeze(['gclid', 'gbraid', 'wbraid']);

/**
 * An ad click arrives with google.com as referrer, so without this it would be
 * counted as organic Google. Paid is recognised from the click id, or from a
 * utm_source=google link tagged utm_medium=cpc.
 */
export function isGoogleAdsClick(searchParams, utmSource, utmMedium) {
  if (GOOGLE_ADS_CLICK_PARAMS.some((key) => searchParams.has(key))) return true;
  return utmSource === 'google_ads' || (utmSource === 'organic_google' && utmMedium === 'paid_search');
}

/**
 * `?ref=` and `?source=` as a fallback for utm_source. Directories and READMEs
 * often tag links that way instead of with UTM. Both keys are also used as
 * plain free text (`?ref=nav`, a person's handle), so unlike utm_source only a
 * value that names a channel we know counts; anything else is ignored rather
 * than turned into `other`.
 */
export function sourceFromRefParams(searchParams) {
  for (const key of ['ref', 'source']) {
    const category = sourceFromUtm(searchParams.get(key));
    if (category && category !== 'other') return category;
  }
  return null;
}

/**
 * Seeded oauth_clients rows (supabase/migrations/20260525130000 and
 * 20260525210003). Their ids are ours, so they name the client outright.
 */
export const SEEDED_CONNECTOR_CLIENTS = Object.freeze({
  'claude-desktop': 'connector_claude',
  'claude-ai-web': 'connector_claude',
  'claude-code': 'connector_claude',
  'cursor-v1': 'connector_cursor',
});

/**
 * Exact hostnames of a CIMD client_id URL or an https redirect_uri, by client.
 * The same hosts as VENDORS in src/lib/oauth/client-identity.ts (a test keeps
 * them in step). Compared exactly, never by suffix.
 */
export const CONNECTOR_HOSTS = Object.freeze([
  [['claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com', 'anthropic.com', 'www.anthropic.com',
    'console.anthropic.com', 'platform.claude.com'], 'connector_claude'],
  [['chatgpt.com', 'chat.openai.com', 'openai.com', 'www.openai.com', 'platform.openai.com'], 'connector_chatgpt'],
  [['cursor.com', 'www.cursor.com', 'cursor.sh'], 'connector_cursor'],
  [['vscode.dev', 'insiders.vscode.dev'], 'connector_vscode'],
]);

/** Native-app redirect schemes, as NATIVE_APP_SCHEMES in client-identity.ts. */
export const CONNECTOR_SCHEMES = Object.freeze({
  'claude:': 'connector_claude',
  'cursor:': 'connector_cursor',
  'vscode:': 'connector_vscode',
  'vscode-insiders:': 'connector_vscode',
});

function connectorFromUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (CONNECTOR_SCHEMES[parsed.protocol]) return CONNECTOR_SCHEMES[parsed.protocol];
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  for (const [hosts, source] of CONNECTOR_HOSTS) if (hosts.includes(host)) return source;
  return null;
}

/**
 * The connector a first touch belongs to, or null when it is not one.
 *
 * WHY (2026-10-22). A logged-out user who connects an MCP client lands on
 * /login?redirect=/authorize?client_id=...&redirect_uri=..., opened by the
 * client in the system browser with no referrer, so roughly a third of all
 * `direct` signups were connector installs. The client is read from the
 * authorize request itself, in this order: a seeded client id, the host of a
 * CIMD client_id URL (VS Code and claude.ai use one), then the redirect_uri
 * scheme or host. Nothing from it is stored except the category. A dynamically
 * registered client's self-chosen name is never read: it is not in the URL,
 * and it is not trustworthy. Any other authorize request is `connector_other`.
 */
export function connectorSourceFromAuthorize(url) {
  const { path } = localeAndPath(url.pathname);
  if (!/^\/(login|signup)\/?$/.test(path)) return null;
  const target = url.searchParams.get('redirect');
  if (!target || !target.startsWith('/') || target.startsWith('//')) return null;
  let authorize;
  try {
    authorize = new URL(target, url.origin);
  } catch {
    return null;
  }
  if (authorize.origin !== url.origin || authorize.pathname !== '/authorize') return null;
  const clientId = authorize.searchParams.get('client_id');
  if (!clientId) return null;
  if (Object.hasOwn(SEEDED_CONNECTOR_CLIENTS, clientId)) return SEEDED_CONNECTOR_CLIENTS[clientId];
  if (/^https:\/\//i.test(clientId)) {
    const fromClientId = connectorFromUrl(clientId);
    if (fromClientId) return fromClientId;
  }
  return connectorFromUrl(authorize.searchParams.get('redirect_uri') ?? '') ?? 'connector_other';
}

export function acquisitionFromLocation(url, referrerUrl = null) {
  let utmSource = sourceFromUtm(url.searchParams.get('utm_source'));
  const utmMedium = mediumFromUtm(url.searchParams.get('utm_medium'));
  const externalReferrer = referrerUrl && referrerUrl.origin !== url.origin
    ? sourceFromHost(referrerUrl.hostname)
    : 'direct';
  const paidGoogle = isGoogleAdsClick(url.searchParams, utmSource, utmMedium);
  if (paidGoogle && utmSource === 'organic_google') utmSource = 'google_ads';
  const { locale } = localeAndPath(url.pathname);
  // A connector install is named after the client even when the browser did
  // send a referrer (claude.ai opens the flow in a new tab): it is still an
  // install, not a click on a link. Tagged links and ad clicks never reach
  // /authorize, so the order below only matters in theory.
  const tagged = utmSource ?? sourceFromRefParams(url.searchParams);
  return sanitizedAcquisition({
    source: paidGoogle ? 'google_ads' : (tagged ?? connectorSourceFromAuthorize(url) ?? externalReferrer),
    landing: landingFromPath(url.pathname),
    landingPath: safeLandingPath(url.pathname),
    locale,
    referrer: externalReferrer,
    utmSource,
    utmMedium: utmMedium ?? (paidGoogle ? 'paid_search' : null),
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
