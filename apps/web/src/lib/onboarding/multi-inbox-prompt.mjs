/**
 * Whether the dashboard should invite a second WORK mailbox, and how.
 *
 * WHO. Business-shaped workspaces only (lib/segment/consumer-domains: a
 * connected mailbox on a company domain, or the owner's own address on one).
 * Measured on production, signups since 2026-08-01: business domains are 27%
 * of signups and 55% of payers, and 87% of payers hold two or more mailboxes.
 * The buyer is one operator running info@, sales@ and invoices@, and nothing
 * told them early that the product is built for all of those at once. A
 * consumer never sees this, so nothing changes for them.
 *
 * WHEN. Exactly one mailbox connected. With none, step 1 of the guide already
 * asks for one; with two or more the prompt has done its job. Nothing else:
 * not the getting-started guide, and not whether a tool call has been made.
 *
 * WHERE. Under the Overview header and under the list on the Inboxes page
 * (MultiInboxInvite in components/dashboard/Pages.jsx), one copy per page.
 *
 * HOW. Two variants, because promising a free second mailbox to a capped Free
 * workspace would be a lie that the connect modal then contradicts:
 *   'upgrade'  at the inbox cap. The copy says a second mailbox is on a paid
 *              plan, and the button opens the modal on its paywall panel,
 *              which recommends Pro to this workspace.
 *   'open'     not capped (a paid plan, or an early member with unlimited
 *              inboxes). The copy just asks; the button opens the modal.
 *
 * It is an OPTIONAL, quiet invitation, never a numbered step and never opened
 * for the user. Wiring up an MCP client is what activates a workspace, and an earlier version
 * of the Overview learned that an upgrade prompt presented as the next step
 * pulls people to a paywall seconds after their first connect, before they
 * have used the product once. See OverviewPage's `atInboxLimit` comment.
 *
 * @param {{businessShaped?: boolean, inboxCount?: number, atInboxLimit?: boolean}} state
 * @returns {null|'upgrade'|'open'}
 */
export function multiInboxPromptVariant({ businessShaped, inboxCount, atInboxLimit } = {}) {
  if (businessShaped !== true) return null;
  if (inboxCount !== 1) return null;
  return atInboxLimit === true ? 'upgrade' : 'open';
}
