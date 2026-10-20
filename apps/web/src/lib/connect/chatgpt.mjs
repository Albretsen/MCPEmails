/**
 * The "Use <provider> in ChatGPT" block on /connect/<provider> pages, and the
 * matching FAQ entry.
 *
 * WHY. ChatGPT-sourced signups landing on /connect/* fell week over week while
 * ChatGPT's own answers to "connect Yahoo mail to ChatGPT" recommended other
 * products. The provider pages said how to connect a mailbox, then said
 * nothing about ChatGPT. This block says it once, in the same words on every
 * page, with the provider name filled in.
 *
 * WHICH PAGES. Every provider whose status is `supported`. The three `limited`
 * pages (HEY, Proton Mail, Tuta) do not get it: the block promises the mailbox
 * connects. The FAQ entry is left off /connect/yahoo, whose own copy carries a
 * ChatGPT question of its own.
 *
 * WHERE THE COPY LIVES. src/lib/connect/chatgpt/<locale>.json, loaded on the
 * server by the page that renders it. Not in the `connect` next-intl
 * namespace: that namespace is serialised into every marketing page (see
 * MARKETING_NAMESPACES in src/i18n/request.ts), and this is page-only copy.
 *
 * WHAT IT CLAIMS, and where each claim is from (src/lib/clients/content/en/
 * chatgpt.json, which is /docs/chatgpt, and the connect-chatgpt-to-email post):
 *   - custom MCP connector behind developer mode, under Settings, Apps and
 *     Connectors, Advanced settings
 *   - connector URL https://mcpemails.com/api/mcp, OAuth authentication
 *   - developer mode on chatgpt.com with Plus, Pro, Business, Enterprise, Edu
 *   - switched on per chat from the + menu
 *   - mail fetched live, never stored
 *
 * WHEN THE CHATGPT APP DIRECTORY LISTS US. Set CHATGPT_DIRECTORY_LISTING_URL to
 * the listing's URL. The block then shows the `directory*` copy (install the
 * app from the directory) instead of the developer-mode steps, links to the
 * listing, and the FAQ answer switches to `directoryFaqA`. Every locale already
 * carries those keys. Re-read them against the live listing before flipping it.
 */

/** Null until OpenAI approves the listing. See the header comment. */
export const CHATGPT_DIRECTORY_LISTING_URL = null;

export const CHATGPT_LOCALES = Object.freeze(['en', 'es', 'fr', 'nb', 'zh', 'de']);
export const CHATGPT_BLOG_SLUG = 'connect-chatgpt-to-email';
export const CHATGPT_DOCS_PATH = '/docs/chatgpt';

/** Pages that carry their own ChatGPT FAQ entry, so this one would repeat it. */
const OWN_CHATGPT_FAQ = new Set(['yahoo']);

export function showsChatgpt(provider) {
  return Boolean(provider) && provider.status === 'supported';
}

export function showsChatgptFaq(provider) {
  return showsChatgpt(provider) && !OWN_CHATGPT_FAQ.has(provider.slug);
}

export async function getChatgptCopy(locale) {
  const safe = CHATGPT_LOCALES.includes(locale) ? locale : 'en';
  const mod = await import(`./chatgpt/${safe}.json`);
  return mod.default;
}

/** Fill `{provider}`. Plain replacement: this copy is not ICU. */
function fill(text, providerName) {
  return String(text).replaceAll('{provider}', providerName);
}

/**
 * What the block shows for one provider. `listingUrl` defaults to the flag and
 * is a parameter only so the directory variant can be tested before it ships.
 */
export function chatgptSection(copy, providerName, listingUrl = CHATGPT_DIRECTORY_LISTING_URL) {
  const viaDirectory = Boolean(listingUrl);
  return {
    eyebrow: copy.eyebrow,
    title: fill(copy.title, providerName),
    sub: fill(viaDirectory ? copy.directorySub : copy.sub, providerName),
    steps: (viaDirectory ? copy.directorySteps : copy.steps).map((s) => fill(s, providerName)),
    listing: viaDirectory ? { href: listingUrl, label: copy.directoryLink } : null,
    docs: { href: CHATGPT_DOCS_PATH, label: copy.docsLink },
    blogLabel: copy.blogLink,
  };
}

/**
 * Where the "How to connect ChatGPT to your email" link points. `postLocales`
 * is getPostLocales() of the post, passed in by the page so this module stays
 * free of the blog registry. A locale the post is translated into gets the
 * locale-aware link (next-intl adds the prefix); any other gets the English
 * post at its unprefixed URL, never a /<locale>/blog/... page that only
 * canonicalises back to English.
 */
export function chatgptBlogLink(locale, postLocales) {
  return { href: `/blog/${CHATGPT_BLOG_SLUG}`, localized: postLocales.includes(locale) };
}

/**
 * The FAQ entry this block adds to the page and to its FAQPage JSON-LD. A name
 * that already ends in "Mail" or "Email" (AOL Mail, Gmail, Rackspace Email)
 * takes `faqQMailName`, so English reads "Can ChatGPT read my AOL Mail?" and
 * not "my AOL Mail mail". Locales where the doubling does not happen carry the
 * same text in both keys.
 */
export function chatgptFaq(copy, providerName, listingUrl = CHATGPT_DIRECTORY_LISTING_URL) {
  const question = /e?mail$/i.test(providerName) ? copy.faqQMailName : copy.faqQ;
  return {
    q: fill(question, providerName),
    a: fill(listingUrl ? copy.directoryFaqA : copy.faqA, providerName),
  };
}
