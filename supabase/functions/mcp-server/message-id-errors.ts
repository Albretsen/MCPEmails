// ---------------------------------------------------------------------------
// message-id-errors.ts - what a provider's rejection of a message id means.
//
// Three of the four defects the connector health check found on 2026-08-30 were
// the same missing fact wearing different clothes: Gmail answers a message id it
// cannot parse with 400 "Invalid id value", not 404, and only ONE of the places
// that address a message by id knew that.
//
//   email_read      knew, and says so in readGmailMessage's own comment. A bogus
//                   id returns the clean not-found error.
//   email_compose   action 'reply' did not. The 400 fell through to the generic
//                   send-failure branch, so a reply that was never composed, let
//                   alone transmitted, came back as one that "may or may not have
//                   been delivered. Do not retry automatically". action 'forward'
//                   was right only by accident: it resolves the original through
//                   readGmailMessage and inherited the rule.
//   email_delete    did not. The 400 became "Provider error during email_delete:
//                   Gmail delete failed: Invalid id value. Please try again in a
//                   moment." - retry advice for a condition that is permanent by
//                   construction, which an agent will follow until its quota is
//                   gone.
//   email_organize  move_batch / delete_batch / flag did not, and leaked the raw
//                   status line: "Gmail modify failed: 400".
//
// The rule was written down once and applied in one place, which is exactly how
// the other four drifted. It lives here now: pure, testable without a mailbox,
// and the single thing every caller asks.
//
// The second half of this module runs the other way. The per-id `error` on a
// bulk result is a SENTINEL, not prose: formatBulkResult needs it verbatim
// because activity_log.error_code groups on it, and monitoring breaks if an
// interpolated status or a sentence lands there. The model reading the result
// needs the sentence. So the translation happens at the point the result is
// rendered, on the way out, and nowhere else - the sentinel that the log sees is
// untouched.
// ---------------------------------------------------------------------------

/**
 * The sentinel every provider path throws, and every bulk helper records, for a
 * message id the provider rejected as bad.
 *
 * A string constant rather than a bare literal because it is a wire value in
 * three separate contracts - the thrown Error message, the per-id `error` field
 * of a bulk result, and activity_log.error_code via KNOWN_BULK_ERROR_CODES - and
 * a typo in any one of them fails silently by falling through to a generic
 * branch, which is the shape of every defect this module exists to close.
 */
export const MESSAGE_NOT_FOUND = "message_not_found";

/**
 * Whether a Gmail HTTP status, on a request addressed by message id, means the
 * id itself is bad and permanently so.
 *
 * 404 is the obvious half: a well-formed id for a message that is not there any
 * more. 400 is the half that kept being missed. Gmail rejects an id it cannot
 * even parse with 400 "Invalid id value", before it looks anything up, so a
 * stale id from an old page and a malformed one arrive as different statuses
 * describing the same permanent fact.
 *
 * Everything else is deliberately excluded, because widening this is how a
 * "not found" starts lying: 401 is an auth failure that has its own handling and
 * its own remedy, 403 and 429 are quota, 5xx is Google having a bad minute. Each
 * of those is either transient or fixable, and none is answered by re-listing a
 * mailbox that was never the problem.
 *
 * Gmail-specific on purpose. Microsoft Graph answers a malformed id with its own
 * mix of 400s that also cover a bad $select or a bad destination folder, and
 * nothing in this codebase has ever mapped a Graph 400 to not-found; guessing
 * here would swallow real errors on a provider the health check never exercised.
 */
export function isBadGmailMessageIdStatus(status: number): boolean {
  return status === 400 || status === 404;
}

/**
 * The sentence a caller gets for one message id that the provider rejected.
 *
 * Byte-for-byte what the single-message paths (email_read, email_read_batch)
 * have always returned. That is the point: an id that is stale in a batch is
 * stale for exactly the same reason and has exactly the same remedy, and a
 * caller should not have to learn two vocabularies for one condition depending
 * on how many ids it happened to pass.
 */
export const MESSAGE_NOT_FOUND_DETAIL =
  "Message not found. The message may have been deleted or the ID is stale — " +
  "call email_list or email_search to get current message IDs.";

/**
 * Render one bulk per-id failure for the caller.
 *
 * Only the not-found sentinel is translated. Every other value is passed through
 * untouched and on purpose: an auth failure, a rate limit and a 5xx are all
 * genuinely different conditions with genuinely different remedies, and folding
 * them into "the message may have been deleted" would send a caller to re-list a
 * mailbox when what it needed was to reconnect, back off, or wait. A raw status
 * line is a poor error; a confidently wrong one is worse.
 */
export function bulkFailureMessage(error: string): string {
  return error === MESSAGE_NOT_FOUND ? MESSAGE_NOT_FOUND_DETAIL : error;
}

/**
 * The result text for a send that failed while resolving the message it was
 * supposed to act on - before anything was composed, and long before anything
 * was transmitted.
 *
 * This exists to keep one sentence honest. `provider_error` on a send closes
 * with "The message may or may not have been delivered. Do not retry
 * automatically to avoid duplicate delivery", which is the correct thing to say
 * about a request that reached the provider's send endpoint and then failed:
 * nobody can tell from here which side of the wire it died on. It is the wrong
 * thing to say about a reply whose ORIGINAL could not be read, because that
 * failure happens two steps earlier. Saying it there costs the caller the one
 * safe action available to it - the retry - and, as happened on 2026-08-30,
 * sends an agent looking through Sent for a message that was never built.
 *
 * So this says the opposite, and says why: nothing exists, and trying again
 * cannot duplicate anything. The provider's own words are quoted because at this
 * stage they describe the lookup, not any message content.
 */
export function targetUnresolvedMessage(
  operation: string,
  provider: string,
  reason: string,
): string {
  return (
    `${operation} could not read the message it was asked to act on, so nothing ` +
    `was composed and nothing was sent: there is no delivery, and no copy in ` +
    `Sent. The ${provider} account reported: ${reason}. Retrying is safe and ` +
    `cannot duplicate anything.`
  );
}
