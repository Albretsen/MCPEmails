import { getProvider } from './providers.mjs';
import { isViewable } from './release.mjs';

/**
 * Per-assistant guide pages under a provider page: /connect/<provider>/claude
 * and /connect/<provider>/chatgpt.
 *
 * WHY. On 2026-11-24 Google AI Mode answered "connect Yahoo Mail to Claude or
 * ChatGPT" by quoting competitors' one-page-per-assistant guides, while
 * /connect/yahoo, which ranks near the top in classic search, covers every
 * MCP client on one page and was no longer cited. These pages answer exactly
 * one query each ("Connect Yahoo Mail to Claude"): a direct answer, numbered
 * steps for that assistant, and an FAQ marked up as FAQPage.
 *
 * WHICH PAGES. The three providers that earn the most (yahoo, icloud, imap),
 * times the two assistants, in English and German only. The provider page
 * links its two guides in those locales; elsewhere it shows no link, so no
 * page links a 404.
 *
 * WHERE THE COPY LIVES. src/lib/connect/client-guides/<locale>.json, loaded on
 * the server by the page. Not a next-intl namespace (that would ship it to
 * every marketing page).
 *
 * WHAT THE STEPS CLAIM. Claude: the custom connector flow, the same steps as
 * src/lib/clients/content/<locale>/claude.json (Customize, Connectors, + Add,
 * Add custom connector; Free allows one custom connector). ChatGPT: the Any
 * Mailbox listing in the ChatGPT plugin directory, the same steps as
 * src/lib/connect/chatgpt/<locale>.json. Never claim a Claude directory
 * listing: that submission is still in review.
 */

export const CLIENT_GUIDE_PROVIDERS = Object.freeze(['yahoo', 'icloud', 'imap']);
export const CLIENT_GUIDE_CLIENTS = Object.freeze(['claude', 'chatgpt']);
export const CLIENT_GUIDE_LOCALES = Object.freeze(['en', 'de']);
/** Date of the last substantive copy change, for the sitemap. */
export const CLIENT_GUIDES_UPDATED = '2026-11-24';

export function clientGuidePath(providerSlug, client) {
  return `/connect/${providerSlug}/${client}`;
}

/** True when /<locale>/connect/<provider>/<client> exists and may render. */
export function hasClientGuide(providerSlug, client, locale, now = new Date()) {
  if (!CLIENT_GUIDE_PROVIDERS.includes(providerSlug)) return false;
  if (!CLIENT_GUIDE_CLIENTS.includes(client)) return false;
  if (!CLIENT_GUIDE_LOCALES.includes(locale)) return false;
  const provider = getProvider(providerSlug);
  if (!provider || !isViewable(provider, now)) return false;
  return provider.locales.includes(locale);
}

/** The locales one guide page exists in (hreflang, sitemap, footer). */
export function clientGuideLocales(providerSlug, client, now = new Date()) {
  return CLIENT_GUIDE_LOCALES.filter((l) => hasClientGuide(providerSlug, client, l, now));
}

/** Every { locale, provider, client } to generate. */
export function clientGuideParams(now = new Date()) {
  const out = [];
  for (const provider of CLIENT_GUIDE_PROVIDERS) {
    for (const client of CLIENT_GUIDE_CLIENTS) {
      for (const locale of clientGuideLocales(provider, client, now)) {
        out.push({ locale, provider, client });
      }
    }
  }
  return out;
}

async function loadCopy(locale) {
  const mod = await import(`./client-guides/${locale}.json`);
  return mod.default;
}

/**
 * Everything one guide page renders, or null when the page does not exist.
 * `steps` is the provider's own preparation steps followed by the assistant's
 * steps, with {provider} filled in. The FAQ is the page's own entries.
 */
export async function getClientGuide(locale, providerSlug, client) {
  if (!hasClientGuide(providerSlug, client, locale)) return null;
  const copy = await loadCopy(locale);
  const page = copy.pages?.[providerSlug]?.[client];
  const prov = copy.providers?.[providerSlug];
  const shared = copy.clients?.[client];
  if (!page || !prov || !shared) return null;
  const fill = (s) => String(s).replaceAll('{provider}', prov.name).replaceAll('{short}', prov.short ?? prov.name);
  const sibling = client === 'claude' ? 'chatgpt' : 'claude';
  return {
    meta: page.meta,
    h1: page.h1,
    answer: page.answer,
    eyebrow: fill(shared.eyebrow),
    stepsTitle: fill(shared.stepsTitle),
    steps: [...prov.prep, ...shared.steps].map((s) => ({ h: fill(s.h), p: fill(s.p) })),
    note: shared.note ? fill(shared.note) : null,
    faq: page.faq,
    ui: copy.ui,
    providerName: prov.name,
    providerShort: prov.short ?? prov.name,
    parent: { href: `/connect/${providerSlug}`, label: fill(copy.ui.parentLink) },
    sibling: {
      href: clientGuidePath(providerSlug, sibling),
      label: copy.pages[providerSlug][sibling].h1,
    },
    clientDocs: { href: `/docs/${client}`, label: shared.docsLink },
  };
}

/**
 * The two guide links a provider page shows, or [] where the provider or the
 * locale has none. Labels are the guide pages' own H1s, so the anchor is the
 * query the page targets.
 */
export async function clientGuideLinksFor(providerSlug, locale) {
  const clients = CLIENT_GUIDE_CLIENTS.filter((c) => hasClientGuide(providerSlug, c, locale));
  if (clients.length === 0) return null;
  const copy = await loadCopy(locale);
  return {
    intro: copy.ui.providerPageIntro,
    links: clients.map((c) => ({
      client: c,
      href: clientGuidePath(providerSlug, c),
      label: copy.pages[providerSlug][c].h1,
    })),
  };
}
