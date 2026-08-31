// ---------------------------------------------------------------------------
// What production actually returned on 2026-08-30, for one bogus message id
// (`ffffffffffffffff`) sent to four different tools on the same Gmail inbox:
//
//   email_read     Message ffffffffffffffff not found in inbox <id>. ...
//   email_compose  An error occurred while sending the reply via gmail. The
//                  message may or may not have been delivered. Do not retry
//                  automatically to avoid duplicate delivery.
//   email_delete   Provider error during email_delete: Gmail delete failed:
//                  Invalid id value. Please try again in a moment.
//   email_organize Gmail modify failed: 400
//
// Only the first is true. Nothing was sent, so there was no possible delivery
// to reconcile; the id cannot become valid, so there is nothing to try again in
// a moment; and 400 is not an error message. All three fell out of the same
// missing fact, so these tests pin the fact itself, then pin the two things it
// must never grow into: a not-found that swallows an auth failure or a rate
// limit, and a retry-is-safe promise attached to an actual send.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  bulkFailureMessage,
  isBadGmailMessageIdStatus,
  MESSAGE_NOT_FOUND,
  MESSAGE_NOT_FOUND_DETAIL,
  targetUnresolvedMessage,
} from "./message-id-errors.ts";

Deno.test("Gmail's two ways of rejecting a message id are both permanent", () => {
  // 404: well-formed, not there any more. The one that was already handled.
  assertEquals(isBadGmailMessageIdStatus(404), true, "absent message");
  // 400 "Invalid id value": Gmail refuses to parse the id at all. This is the
  // one every path but email_read missed, and it is what `ffffffffffffffff`
  // actually produced.
  assertEquals(isBadGmailMessageIdStatus(400), true, "malformed id");
});

Deno.test("nothing else is called a bad id", () => {
  // Each of these has its own remedy, and none of them is "re-list the mailbox
  // for a current id". Folding them in would be a confidently wrong error,
  // which is worse than the raw status line it replaced.
  assertEquals(isBadGmailMessageIdStatus(401), false, "auth: reconnect");
  assertEquals(isBadGmailMessageIdStatus(403), false, "quota/scope");
  assertEquals(isBadGmailMessageIdStatus(429), false, "rate limit: back off");
  assertEquals(isBadGmailMessageIdStatus(500), false, "Google's problem");
  assertEquals(isBadGmailMessageIdStatus(503), false, "Google's problem");
});

Deno.test("a bad id in a batch reads exactly as a bad id on its own", () => {
  // The single-message wording, byte-for-byte. A caller should not have to
  // learn a second vocabulary for one condition just because it passed several
  // ids instead of one.
  assertEquals(bulkFailureMessage(MESSAGE_NOT_FOUND), MESSAGE_NOT_FOUND_DETAIL);
  assertStringIncludes(MESSAGE_NOT_FOUND_DETAIL, "Message not found.");
  assertStringIncludes(MESSAGE_NOT_FOUND_DETAIL, "the ID is stale");
  assertStringIncludes(MESSAGE_NOT_FOUND_DETAIL, "email_list or email_search");
  // And the raw status line it replaces is gone.
  assert(!MESSAGE_NOT_FOUND_DETAIL.includes("400"), "no bare status");
});

Deno.test("a batch failure that is not a bad id is passed through untouched", () => {
  // The counts, the per-id structure and the duplicate-collapsing all key off
  // these strings, and only the not-found sentinel changes meaning by being
  // rewritten. Everything else must survive verbatim.
  for (
    const error of [
      "gmail_auth_failed",
      "outlook_auth_failed",
      "imap_auth_failed",
      "invalid_action",
      "folder_not_found",
      "Gmail modify failed: 429",
      "Gmail delete failed: 503",
      "Outlook move failed: 404",
    ]
  ) {
    assertEquals(bulkFailureMessage(error), error, error);
  }
});

Deno.test("a reply that never resolved its target says nothing was sent", () => {
  // The defect: this call returned "may or may not have been delivered. Do not
  // retry automatically", which cost the caller the one safe action it had and
  // sent it hunting through Sent for a message that was never built.
  const message = targetUnresolvedMessage("email_reply", "gmail", "Rate limit exceeded");

  // The fact that matters most, stated without hedging.
  assertStringIncludes(message, "nothing was sent");
  assertStringIncludes(message, "no delivery");
  assertStringIncludes(message, "no copy in");
  // The action that follows from it, which is the opposite of the old advice.
  assertStringIncludes(message, "Retrying is safe");
  // The provider's own words, the only clue distinguishing the causes.
  assertStringIncludes(message, "gmail");
  assertStringIncludes(message, "Rate limit exceeded");

  // And crucially: none of the ambiguity wording survives. That sentence is
  // reserved for a request that reached the send endpoint and then failed.
  assert(
    !message.includes("may or may not"),
    `ambiguous wording must not appear: ${message}`,
  );
  assert(
    !message.includes("Do not retry"),
    `do-not-retry advice must not appear: ${message}`,
  );
});

Deno.test("no permanent failure is ever told to try again in a moment", () => {
  // email_delete's generic provider_error closes with "Please try again in a
  // moment". For a malformed id that is advice an agent will follow until its
  // quota is gone, so the two texts that now cover that case must not carry it.
  for (const message of [MESSAGE_NOT_FOUND_DETAIL, targetUnresolvedMessage("email_reply", "gmail", "x")]) {
    assert(
      !message.includes("try again in a moment"),
      `permanent condition must not invite a retry loop: ${message}`,
    );
  }
});
