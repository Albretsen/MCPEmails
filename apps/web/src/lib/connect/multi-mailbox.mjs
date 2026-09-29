/**
 * The "several mailboxes on this host" block on business-host /connect pages.
 *
 * WHY. Business-domain signups are about a quarter of signups and over half of
 * payers, and 87% of payers hold two or more mailboxes. The provider pages a
 * company lands on (its web host, its registrar's mail, its business mail
 * service, its own server) each described connecting ONE mailbox. This block
 * says, once and in the same words on every such page, that every address the
 * company runs on that host connects to the same agent, and what that costs.
 *
 * WHICH PAGES. By category rather than by hand, so a provider added later is
 * covered by being filed correctly: business mail services, web hosts, cPanel
 * and shared hosting, and self-hosted servers. Consumer, privacy, ISP and
 * regional webmail are not, and neither is the generic IMAP page, which
 * already leads with the company-mailbox operator and links to /for/business.
 * A provider whose status is not `supported` never gets it: the block promises
 * that the mailbox connects.
 *
 * WHERE THE COPY LIVES. src/lib/connect/multi-mailbox/<locale>.json, loaded on
 * the server by the page that renders it. Not in the `connect` next-intl
 * namespace: that namespace is serialised into every marketing page (see
 * MARKETING_NAMESPACES in src/i18n/request.ts), and this is only for 42 pages.
 *
 * WHAT IT CLAIMS, and where each claim is from:
 *   - several mailboxes, one workspace, one MCP URL: the product's model
 *   - every tool call names its mailbox: inbox_id / inbox on every tool
 *     (supabase/functions/mcp-server), required once there are several
 *   - own sender name and signature: inboxes.display_name and the per-inbox
 *     signature (signature_get / signature_set)
 *   - a reply leaves through the mailbox it belongs to: each inbox sends via
 *     its own provider (Gmail API, Microsoft Graph or its own SMTP server)
 *   - Free 1, Personal 3, Pro unlimited: maxInboxes in src/lib/stripe/plans.ts,
 *     pinned by multi-mailbox.test.mjs
 * Prices are deliberately not quoted here, so a repricing cannot leave 42
 * pages wrong.
 */
import { BUSINESS_LOCALES } from '../personas/business.mjs';

export const MULTI_MAILBOX_CATEGORIES = Object.freeze(['business', 'hosting', 'cpanel', 'selfhost']);

export function showsMultiMailbox(provider) {
  return Boolean(provider)
    && provider.status === 'supported'
    && MULTI_MAILBOX_CATEGORIES.includes(provider.category);
}

export async function getMultiMailboxCopy(locale) {
  const safe = BUSINESS_LOCALES.includes(locale) ? locale : 'en';
  const mod = await import(`./multi-mailbox/${safe}.json`);
  return mod.default;
}

/** Fill `{provider}`. Plain replacement: this copy is not ICU. */
export function withProvider(text, providerName) {
  return String(text).replaceAll('{provider}', providerName);
}

/** The FAQ entry this block adds to the page and to its FAQPage JSON-LD. */
export function multiMailboxFaq(copy, providerName) {
  return { q: withProvider(copy.faqQ, providerName), a: withProvider(copy.faqA, providerName) };
}
