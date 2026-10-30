/**
 * The /help search index, built on the server and handed to HelpSearch as a prop.
 *
 * Compact on purpose: the whole index is serialised into the page, so it holds
 * names, slugs, aliases and one short hint per entry, never the guide copy
 * itself. search-index.test.mjs holds it to a byte budget.
 *
 * Sources, all already public:
 *  - released provider guides (src/lib/connect, through the release gate, so an
 *    unreleased page is never linked),
 *  - the client setup guides (src/lib/clients),
 *  - the docs sections and the two docs hubs (messages/<locale>/docs.json),
 *  - the pricing FAQ (messages/<locale>/pricing.json),
 *  - every help center article (articles.mjs: the troubleshooting set plus the
 *    area files), linked to its anchor on /help, or to the bare in-page anchor
 *    when the index is built for the dashboard's help section (`inApp`).
 *
 * Entry shape: { id, kind, title, hint, href, terms }.
 */

import { releasedProviders } from '../connect/release.mjs';
import { CLIENTS } from '../clients/clients.mjs';
import { clientUi } from '../clients/ui.mjs';
import { fill, helpHref } from './help-content.mjs';
import { MODEL_VISIBLE_TOOL_COUNT } from '../public-facts.mjs';

export const HINT_MAX = 80;

/**
 * Article keywords are cut to this many characters, on a word boundary.
 * Translated keyword lists run longer than English (they keep the English
 * terms too), and at 160 the French Gmail article lost its 2FA words.
 */
export const TERMS_MAX = 260;

/** Search terms cut on a word boundary, without an ellipsis (they are never shown). */
export function clipTerms(text, max = TERMS_MAX) {
  const plain = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : plain.slice(0, max)).trim();
}

/**
 * Names people type that are not in the provider's own name, slug or domain.
 * Kept short and factual: other domains the same mailbox lives on, and the
 * product names people use for it.
 */
const PROVIDER_ALIASES = {
  gmail: 'googlemail google',
  outlook: 'hotmail live msn microsoft',
  office365: 'microsoft 365 m365 o365 exchange outlook',
  'google-workspace': 'gsuite g suite google apps',
  icloud: 'apple me.com mac.com',
  yahoo: 'ymail rocketmail',
  yandex: 'yandex.ru yandex 360',
  imap: 'smtp own domain custom domain other',
  proton: 'protonmail',
  tutanota: 'tutanota tuta',
  zoho: 'zohomail',
  'one-com': 'one.com',
  'mail-com': 'mail.com',
  'web-de': 'web.de',
  'mail-ru': 'mail.ru',
  'netease-163': '163',
  'netease-126': '126',
  qq: 'tencent foxmail',
};

/** Placeholders the docs headings interpolate (the tool reference states the tool count). */
const DOCS_VALUES = { toolCount: MODEL_VISIBLE_TOOL_COUNT };

/** Docs sections on /docs: message key, anchor, extra English search terms. */
const DOCS_SECTIONS = [
  ['quickstart', 'quickstart', 'start setup getting started'],
  ['endpoint', 'endpoint', 'url http transport bearer'],
  ['operations', 'operations', 'operations actions'],
  ['oauth', 'oauth', 'oauth pkce authorize login'],
  ['tools', 'tools', 'tools reference parameters'],
  ['automationSafety', 'automation-safety', 'automation rules schedule'],
  ['errors', 'errors', 'error codes retry 401 403'],
  ['rateLimits', 'rate-limits', 'rate limit 429 allowance usage cap'],
];

/**
 * Drop rich-text tags (`<b>`, `<link>`) and every angle bracket in one pass.
 * A character scan rather than a tag regex: a regex strip can leave a partial
 * tag behind (`<scr<b>ipt>`), which CodeQL rightly flags, and the hints are
 * plain text anyway.
 */
function stripTags(text) {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Plain text, one line, at most `max` characters, cut on a word boundary. */
export function clip(text, max = HINT_MAX) {
  const plain = stripTags(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

// One literal namespace per import, so the bundler's context module covers
// docs.json and pricing.json only, not every namespace of every locale.
const LOCALES = new Set(['en', 'nb', 'es', 'fr', 'zh', 'de']);

async function loadDocs(locale) {
  const l = LOCALES.has(locale) ? locale : 'en';
  return (await import(`../../../messages/${l}/docs.json`)).default;
}

async function loadPricing(locale) {
  const l = LOCALES.has(locale) ? locale : 'en';
  return (await import(`../../../messages/${l}/pricing.json`)).default;
}

/**
 * Pure builder. `help` is the locale's help content, `docs` and `pricing` the
 * locale's next-intl messages for those namespaces. `articles` is the flat
 * article list from articles.mjs (defaults to the troubleshooting set in
 * `help`); `inApp` links them to the in-page anchor instead of /help.
 */
export function buildSearchIndex({ locale, help, docs, pricing, articles, inApp = false, now = new Date() }) {
  const out = [];
  const href = (path, available = true) => (available ? helpHref(locale, path) : path);

  for (const p of releasedProviders(now)) {
    const category = help.providerCategories?.[p.category] ?? p.category;
    const hint = p.domain
      ? fill(help.hints.provider, { category, domain: p.domain })
      : fill(help.hints.providerNoDomain, { category });
    out.push({
      id: `provider:${p.slug}`,
      kind: 'provider',
      title: p.name,
      hint: clip(hint),
      href: href(`/connect/${p.slug}`, p.locales.includes(locale)),
      terms: [p.slug, p.domain, p.imap?.host, PROVIDER_ALIASES[p.slug]].filter(Boolean).join(' '),
    });
  }

  for (const c of CLIENTS) {
    out.push({
      id: `client:${c.slug}`,
      kind: 'client',
      title: c.name,
      hint: clip(c.auth === 'oauth' ? help.hints.clientOauth : help.hints.clientKey),
      href: href(`/docs/${c.slug}`, c.locales.includes(locale)),
      terms: [c.slug, c.surface, c.auth === 'oauth' ? 'oauth' : 'api key'].join(' '),
    });
  }

  for (const [key, anchor, terms] of DOCS_SECTIONS) {
    const section = docs?.[key];
    if (!section) continue;
    out.push({
      id: `docs:${anchor}`,
      kind: 'docs',
      title: clip(fill(section.eyebrow ?? section.heading, DOCS_VALUES)),
      hint: clip(section.heading ? fill(section.heading, DOCS_VALUES) : help.hints.docs),
      href: href(`/docs#${anchor}`),
      terms,
    });
  }
  out.push({
    id: 'docs:providers',
    kind: 'docs',
    title: clip(docs?.providers?.hero?.heading ?? 'Email provider compatibility'),
    hint: clip(help.hints.docsProviders),
    href: href('/docs/providers'),
    terms: 'providers compatibility matrix imap smtp ports',
  });
  out.push({
    id: 'docs:clients',
    kind: 'docs',
    title: clip(clientUi(locale).hub.title),
    hint: clip(help.hints.docsClients),
    href: href('/docs/clients'),
    terms: 'clients setup mcp',
  });

  const faq = Array.isArray(pricing?.faq?.items) ? pricing.faq.items : [];
  faq.forEach((item, i) => {
    out.push({
      id: `faq:${i}`,
      kind: 'faq',
      title: clip(item.q, 120),
      hint: clip(item.a),
      href: href('/pricing#faq'),
      terms: '',
    });
  });

  const articleBase = inApp ? '' : href('/help');
  for (const a of articles ?? help.articles ?? []) {
    out.push({
      id: `article:${a.id}`,
      kind: 'article',
      title: a.title,
      hint: clip(a.summary),
      href: `${articleBase}#article-${a.id}`,
      terms: clipTerms(a.keywords),
    });
  }

  return out;
}

/** Loads the locale's sources and builds the index. Server only. */
export async function getSearchIndex(locale, help, { articles, inApp = false, now = new Date() } = {}) {
  const [docs, pricing] = await Promise.all([loadDocs(locale), loadPricing(locale)]);
  return buildSearchIndex({ locale, help, docs, pricing, articles, inApp, now });
}
