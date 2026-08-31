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

export const SOURCES = new Set([
  'direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other',
]);
export const LANDINGS = new Set(['home', 'blog', 'provider', 'docs', 'pricing', 'other']);
export const LOCALES = new Set(['en', 'nb', 'es', 'fr', 'zh']);
export const UTM_MEDIA = new Set([
  'organic', 'paid_search', 'social', 'email', 'referral', 'affiliate', 'display', 'other',
]);
export const UTM_CAMPAIGNS = new Set([
  'launch', 'newsletter', 'content', 'product', 'partner', 'community', 'other',
]);

export function sourceFromHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'google.com' || host.endsWith('.google.com')) return 'organic_google';
  for (const source of ['reddit', 'github', 'smithery', 'glama', 'cursor']) {
    const domain = source === 'smithery' || source === 'glama' ? `${source}.ai` : `${source}.com`;
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

export function sourceFromUtm(value) {
  const source = value?.toLowerCase();
  if (!source) return null;
  for (const candidate of ['google', 'reddit', 'github', 'smithery', 'glama', 'cursor']) {
    if (source.includes(candidate)) return candidate === 'google' ? 'organic_google' : candidate;
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
