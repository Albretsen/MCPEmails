/**
 * The "Step-by-step guides" line under the setup steps on every /connect page.
 *
 * WHY. On 2026-10-19, 95 of the 100 provider pages linked to no blog post, and
 * the blog guide that converts best (/blog/connect-claude-to-email: 42 signups,
 * 5 payers in 90 days, against 2.5% on /connect/yahoo) had two incoming links
 * from the rest of the site. Search Console shows the provider page owns the
 * provider query ("yahoo mail mcp", "icloud mcp") and the blog guide owns the
 * generic one ("connect claude to my email"), so the anchors here stay generic:
 * a provider-named anchor pointing at the blog would make the two pages
 * compete for the provider query.
 *
 * WHICH LINKS.
 *   - the Claude guide on every page where the mailbox can connect at all
 *     (auth method other than 'none');
 *   - the Claude IMAP connector guide where the reader logs in with a password
 *     over IMAP (app, mail or account password), unless the page's own `guide`
 *     already points there.
 * The ChatGPT guide is not here: the "Use it in ChatGPT" section on the same
 * page links /blog/connect-chatgpt-to-email, and one link to it is enough.
 * Both posts are translated into every locale a provider page exists in,
 * which seo/internal-links.test.mjs pins, so the locale-aware Link never lands on an
 * English fallback.
 *
 * WHERE THE COPY LIVES. src/lib/connect/guides/<locale>.json, loaded on the
 * server by the page. Not the `connect` next-intl namespace, which is
 * serialised into every marketing page.
 */

export const GUIDE_POSTS = Object.freeze({
  claude: '/blog/connect-claude-to-email',
  imap: '/blog/claude-imap-connector',
});

const PASSWORD_METHODS = new Set(['app-password', 'mail-password', 'account-password']);

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh', 'de'];

/**
 * The guide links for one provider page, in display order, as
 * [{ key, href }]. `content` is the page's provider content (auth.method and
 * the optional per-provider `guide`).
 */
export function guideLinksFor(content) {
  const method = content?.auth?.method;
  if (!method || method === 'none') return [];
  const own = content.guide?.href;
  const keys = ['claude'];
  if (PASSWORD_METHODS.has(method)) keys.push('imap');
  return keys
    .filter((k) => GUIDE_POSTS[k] !== own)
    .map((k) => ({ key: k, href: GUIDE_POSTS[k] }));
}

export async function getGuideCopy(locale) {
  const safe = LOCALES.includes(locale) ? locale : 'en';
  const mod = await import(`./guides/${safe}.json`);
  return mod.default;
}

/**
 * The "More guides" line: buyer posts that had one or two incoming links on
 * 2026-10-29. Generic anchors only, for the reason at the top of this file.
 * Each page shows two of ROTATING, chosen by the provider slug, so the ~100
 * provider pages spread their links across all four posts instead of every
 * page carrying the same list. The personal Microsoft account page also leads
 * with the personal-account walkthrough.
 *
 * Not every post is translated into every locale, so each link says whether
 * it exists in the page's locale: `localized` links render as locale-aware
 * Links, the rest as plain anchors to the English post.
 */
export const MORE_GUIDE_POSTS = Object.freeze({
  personal: '/blog/connect-claude-to-outlook-com-hotmail',
  connectors: '/blog/claude-custom-connectors-explained',
  schedule: '/blog/schedule-email-with-claude-and-chatgpt',
  inboxZero: '/blog/inbox-zero-with-ai-claude',
  agentInbox: '/blog/give-your-ai-agent-an-inbox',
});

const ROTATING = ['connectors', 'schedule', 'inboxZero', 'agentInbox'];
const PERSONAL_MICROSOFT = new Set(['outlook']);

function slugHash(slug) {
  let h = 0;
  for (const ch of String(slug)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * [{ key, href, localized }] for one provider page. `postLocales(slug)` returns
 * the locales a post is translated into (posts.js owns that answer).
 */
export function moreGuideLinksFor({ providerSlug, content, locale, postLocales }) {
  const method = content?.auth?.method;
  if (!method || method === 'none') return [];
  const start = slugHash(providerSlug) % ROTATING.length;
  const keys = [ROTATING[start], ROTATING[(start + 1) % ROTATING.length]];
  if (PERSONAL_MICROSOFT.has(providerSlug)) keys.unshift('personal');
  const own = content.guide?.href;
  return keys
    .filter((k) => MORE_GUIDE_POSTS[k] !== own)
    .map((k) => {
      const href = MORE_GUIDE_POSTS[k];
      const locales = postLocales(href.slice('/blog/'.length)) ?? ['en'];
      return { key: k, href, localized: locale === 'en' || locales.includes(locale) };
    });
}
