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
