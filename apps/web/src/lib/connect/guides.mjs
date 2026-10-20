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
 *   - the Claude guide and the ChatGPT guide on every page where the mailbox
 *     can connect at all (auth method other than 'none');
 *   - the Claude IMAP connector guide where the reader logs in with a password
 *     over IMAP (app, mail or account password), unless the page's own `guide`
 *     already points there.
 * All three posts are translated into every locale a provider page exists in,
 * which guides.test.mjs pins, so the locale-aware Link never lands on an
 * English fallback.
 *
 * WHERE THE COPY LIVES. src/lib/connect/guides/<locale>.json, loaded on the
 * server by the page. Not the `connect` next-intl namespace, which is
 * serialised into every marketing page.
 */

export const GUIDE_POSTS = Object.freeze({
  claude: '/blog/connect-claude-to-email',
  chatgpt: '/blog/connect-chatgpt-to-email',
  imap: '/blog/claude-imap-connector',
});

const PASSWORD_METHODS = new Set(['app-password', 'mail-password', 'account-password']);

const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];

/**
 * The guide links for one provider page, in display order, as
 * [{ key, href }]. `content` is the page's provider content (auth.method and
 * the optional per-provider `guide`).
 */
export function guideLinksFor(content) {
  const method = content?.auth?.method;
  if (!method || method === 'none') return [];
  const own = content.guide?.href;
  const keys = ['claude', 'chatgpt'];
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
