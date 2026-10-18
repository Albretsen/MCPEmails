/**
 * Pure decisions about the `from` argument, split out of index.ts so they can
 * be tested: index.ts calls Deno.serve at load and cannot be imported.
 */

/**
 * True when `rawFrom` names the inbox's own connected address.
 *
 * That is not a Send As request, it is the default written out, so it has to
 * succeed on every provider. The provider check used to come first and refused
 * it on anything but Gmail, telling an agent that had supplied the correct
 * address that Send As is Gmail-only. It reads as "this inbox cannot send",
 * and retrying with the same argument fails identically.
 *
 * Compared case-insensitively and trimmed, because an agent echoing an address
 * back out of inbox_list may not preserve either.
 */
export function isSelfSenderIdentity(inboxAddress: string, rawFrom: string): boolean {
  return rawFrom.trim().toLowerCase() === inboxAddress.trim().toLowerCase();
}

/**
 * Map a resolveSenderIdentity failure onto its own activity_log error code.
 *
 * All five causes used to log `sender_identity_denied`, which is why the bug
 * above could be counted but not isolated: a malformed address and a provider
 * refusal were the same row. The thrown message is already unique per cause,
 * so the code can be too.
 */
export function senderIdentityErrorCode(message: string): string {
  switch (message) {
    case "invalid_sender_identity":
      return "sender_identity_invalid";
    case "sender_identity_unsupported_provider":
      return "sender_identity_unsupported_provider";
    case "gmail_sender_identities_scope_required":
      return "sender_identity_scope_required";
    case "sender_identity_not_authorized":
      return "sender_identity_not_authorized";
    default:
      return "sender_identity_lookup_failed";
  }
}

/**
 * A verified Send As address of an IMAP inbox (public.inbox_sender_aliases,
 * 20261018120000). Only rows with verified_at set ever reach this type: the
 * dashboard verified each one by mailing a code to the address, so the From
 * cannot be an address the user does not receive mail for.
 */
export interface ImapSenderAlias {
  email_address: string;
  display_name: string | null;
}

/** The alias named by `rawFrom`, compared like isSelfSenderIdentity. */
export function findImapSenderAlias(
  aliases: readonly ImapSenderAlias[],
  rawFrom: string,
): ImapSenderAlias | null {
  const wanted = rawFrom.trim().toLowerCase();
  return aliases.find((alias) => alias.email_address.trim().toLowerCase() === wanted) ?? null;
}

/**
 * The send-time inbox view for an IMAP alias: the From address and name
 * change, the login does not.
 *
 * The SMTP and IMAP login is `imap_username || email_address`, so swapping
 * email_address alone would log in AS THE ALIAS. Apple refuses an iCloud alias
 * as a login, which is the reason this feature exists, so the login is pinned
 * to what it was before the swap.
 */
export function imapAliasSenderView<
  T extends { email_address: string; display_name: string | null; imap_username: string | null },
>(inbox: T, alias: ImapSenderAlias): T {
  return {
    ...inbox,
    imap_username: inbox.imap_username || inbox.email_address,
    email_address: alias.email_address,
    display_name: alias.display_name ?? inbox.display_name,
  };
}

/**
 * The refusal text for `sender_identity_unsupported_provider`. Gmail and IMAP
 * inboxes have Send As; Outlook does not yet.
 */
export function unsupportedSenderIdentityText(tool: string, provider: string): string {
  return `${tool}: Send As identities are available for Gmail and IMAP inboxes; ` +
    `${provider} only supports its connected address.`;
}

/** The refusal text for `sender_identity_not_authorized`, per provider. */
export function unauthorizedSenderIdentityText(tool: string, provider: string): string {
  const base = `${tool}: the requested From address is not a verified Send As identity for this inbox. ` +
    "Call inbox_list and use one of its sender_identities.";
  return provider === "imap"
    ? `${base} For an IMAP inbox the user adds and verifies addresses in the MCP Emails dashboard, ` +
      "in the inbox's Send As settings."
    : base;
}
