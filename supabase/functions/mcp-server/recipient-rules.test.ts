// ---------------------------------------------------------------------------
// Recipient-rule tests.
//
// Both rules exist because of a production incident on 2026-08-30, and both
// incidents were about mail going somewhere nobody chose:
//
//   F6  a draft with no recipients was transmitted, and the account owner
//       received it because the provider picked. The assertions below are about
//       the shape of "nobody to send this to", including the cases that are NOT
//       that (Bcc-only, Cc-only) and must still send.
//
//   F7  a reply to self-addressed mail was refused. The assertions are about
//       the fallback firing ONLY when the self filter empties the set, because
//       the failure mode of over-applying it is mailing the user their own copy
//       of every thread.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  computeReplyRecipients,
  draftIsSendable,
  draftNoRecipientsMessage,
  draftRecipientCount,
  extractAddress,
  ownAddressSet,
  replyNoRecipientsMessage,
} from "./recipient-rules.ts";

/** The inbox in the incident had two sender identities, not one. */
const OWN = ["bjellanda@gmail.com", "asgeir@iago.no"];

function addr(email: string, name?: string) {
  return name ? { name, email } : { email };
}

function emails(result: ReturnType<typeof computeReplyRecipients>): string[] {
  assert(result.ok, "expected recipients, got an error result");
  return result.recipients.map((r) => r.email);
}

// ── F6: draft sendability ───────────────────────────────────────────────────

Deno.test("draft with empty to/cc/bcc is refused", () => {
  assertEquals(draftIsSendable({ to: [], cc: [], bcc: [] }), false);
  assertEquals(draftRecipientCount({ to: [], cc: [], bcc: [] }), 0);
});

Deno.test("draft with no recipient fields at all is refused", () => {
  assertEquals(draftIsSendable({}), false);
  assertEquals(draftIsSendable({ to: null, cc: undefined, bcc: null }), false);
});

Deno.test("a normal To draft sends", () => {
  assertEquals(draftIsSendable({ to: ["someone@example.com"], cc: [], bcc: [] }), true);
});

Deno.test("a Cc-only draft sends", () => {
  assertEquals(draftIsSendable({ to: [], cc: ["Cc Person <cc@example.com>"], bcc: [] }), true);
});

Deno.test("a Bcc-only draft sends", () => {
  // A blind announcement is a real message. The gate is "no recipients at all",
  // not "no To".
  assertEquals(draftIsSendable({ to: [], cc: [], bcc: ["bcc@example.com"] }), true);
});

Deno.test("whitespace-only and malformed entries are not recipients", () => {
  assertEquals(draftIsSendable({ to: ["", "   ", "\t"] }), false);
  assertEquals(draftIsSendable({ to: ["Just A Name"] }), false);
  assertEquals(draftIsSendable({ to: ["<>"] }), false);
  assertEquals(draftIsSendable({ to: ["@example.com"] }), false);
  assertEquals(draftIsSendable({ to: ["nobody@"] }), false);
  assertEquals(draftIsSendable({ to: [null, undefined] }), false);
  // One good address among the junk is still a sendable draft.
  assertEquals(draftIsSendable({ to: ["  ", "Real <real@example.com>"] }), true);
});

Deno.test("the same address in To and Cc counts once", () => {
  assertEquals(
    draftRecipientCount({
      to: ["Person <person@example.com>"],
      cc: ["PERSON@EXAMPLE.COM"],
      bcc: [],
    }),
    1,
  );
});

Deno.test("the no-recipients refusal names the draft and is not a not-found", () => {
  const message = draftNoRecipientsMessage("r6604418687933459176");
  assertStringIncludes(message, "r6604418687933459176");
  assertStringIncludes(message, "no recipients");
  assertStringIncludes(message, "draft_update");
  // Must not read as "the draft is missing" - the draft is intact.
  assertEquals(/not found/i.test(message), false);
  assertStringIncludes(message, "unchanged");
});

Deno.test("extractAddress unwraps display names and rejects the rest", () => {
  assertEquals(extractAddress("Asgeir <asgeir@iago.no>"), "asgeir@iago.no");
  assertEquals(extractAddress("  plain@example.com "), "plain@example.com");
  assertEquals(extractAddress("root@localhost"), "root@localhost");
  assertEquals(extractAddress("a@b@c.com"), "");
  assertEquals(extractAddress(undefined), "");
});

// ── F7: reply recipients ────────────────────────────────────────────────────

Deno.test("self-addressed reply falls back to self, exactly once", () => {
  // The incident message: From and To both the account itself.
  const result = computeReplyRecipients({
    from: [addr("bjellanda@gmail.com")],
    to: [addr("bjellanda@gmail.com")],
    cc: [],
    ownAddresses: OWN,
    replyAll: false,
  });
  assert(result.ok);
  assertEquals(result.recipients.length, 1);
  assertEquals(result.recipients[0].email, "bjellanda@gmail.com");
  assertEquals(result.selfReply, true);
});

Deno.test("self-addressed reply_all falls back to self, exactly once", () => {
  const result = computeReplyRecipients({
    from: [addr("bjellanda@gmail.com")],
    to: [addr("bjellanda@gmail.com")],
    cc: [addr("BJellanda@gmail.com")],
    ownAddresses: OWN,
    replyAll: true,
  });
  assert(result.ok);
  assertEquals(result.recipients.length, 1);
  assertEquals(result.recipients[0].email, "bjellanda@gmail.com");
  assertEquals(result.selfReply, true);
});

Deno.test("self-addressed across the inbox's two identities still falls back once", () => {
  // Mail the account sent from one of its identities to the other. Every
  // participant is the account, so the filter empties the set either way.
  const result = computeReplyRecipients({
    from: [addr("asgeir@iago.no", "Asgeir")],
    to: [addr("bjellanda@gmail.com")],
    cc: [],
    ownAddresses: OWN,
    replyAll: true,
  });
  assert(result.ok);
  assertEquals(result.recipients.length, 1);
  // The fallback is the sender, which is what a mail client replies to.
  assertEquals(result.recipients[0].email, "asgeir@iago.no");
  assertEquals(result.recipients[0].name, "Asgeir");
  assertEquals(result.selfReply, true);
});

Deno.test("ordinary two-party reply is unchanged", () => {
  const result = computeReplyRecipients({
    from: [addr("them@example.com", "Them")],
    to: [addr("bjellanda@gmail.com")],
    cc: [],
    ownAddresses: OWN,
    replyAll: false,
  });
  assertEquals(emails(result), ["them@example.com"]);
  assert(result.ok);
  assertEquals(result.selfReply, false);
});

Deno.test("reply_all on a real thread still excludes both own addresses", () => {
  const result = computeReplyRecipients({
    from: [addr("them@example.com")],
    to: [addr("bjellanda@gmail.com"), addr("third@example.com")],
    cc: [addr("asgeir@iago.no"), addr("fourth@example.com")],
    ownAddresses: OWN,
    replyAll: true,
  });
  assertEquals(emails(result), [
    "them@example.com",
    "third@example.com",
    "fourth@example.com",
  ]);
  assert(result.ok);
  assertEquals(result.selfReply, false);
});

Deno.test("reply_all deduplicates a participant listed twice", () => {
  const result = computeReplyRecipients({
    from: [addr("them@example.com")],
    to: [addr("Them@Example.com"), addr("third@example.com")],
    cc: [addr("third@example.com")],
    ownAddresses: OWN,
    replyAll: true,
  });
  assertEquals(emails(result), ["them@example.com", "third@example.com"]);
});

Deno.test("reply without reply_all never fans out to To or Cc", () => {
  const result = computeReplyRecipients({
    from: [addr("them@example.com")],
    to: [addr("bjellanda@gmail.com"), addr("third@example.com")],
    cc: [addr("fourth@example.com")],
    ownAddresses: OWN,
    replyAll: false,
  });
  assertEquals(emails(result), ["them@example.com"]);
});

Deno.test("reply_all is capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => addr(`p${i}@example.com`));
  const result = computeReplyRecipients({
    from: [addr("them@example.com")],
    to: many,
    ownAddresses: OWN,
    replyAll: true,
  });
  assert(result.ok);
  assertEquals(result.recipients.length, 50);
});

Deno.test("a message with no From but a To can still be replied to", () => {
  const result = computeReplyRecipients({
    from: [],
    to: [addr("them@example.com")],
    cc: [],
    ownAddresses: OWN,
    replyAll: false,
  });
  assertEquals(emails(result), ["them@example.com"]);
});

Deno.test("no From, To or Cc at all is the only error case", () => {
  const result = computeReplyRecipients({
    from: [],
    to: [],
    cc: [],
    ownAddresses: OWN,
    replyAll: true,
  });
  assertEquals(result.ok, false);
  assert(!result.ok);
  assertEquals(result.reason, "no_addresses");
});

Deno.test("headers full of unusable entries are the error case, not a send", () => {
  const result = computeReplyRecipients({
    from: [addr("")],
    to: [addr("   "), addr("Just A Name")],
    ownAddresses: OWN,
    replyAll: true,
  });
  assertEquals(result.ok, false);
});

Deno.test("an inbox with no own addresses configured never self-filters", () => {
  const result = computeReplyRecipients({
    from: [addr("them@example.com")],
    to: [addr("bjellanda@gmail.com")],
    ownAddresses: [],
    replyAll: true,
  });
  assertEquals(emails(result), ["them@example.com", "bjellanda@gmail.com"]);
});

Deno.test("ownAddressSet lower-cases and ignores junk", () => {
  const own = ownAddressSet(["BJellanda@Gmail.com", "", null, "not-an-address"]);
  assertEquals(own.has("bjellanda@gmail.com"), true);
  assertEquals(own.size, 1);
});

Deno.test("the reply refusal blames the headers only when the headers are the cause", () => {
  const message = replyNoRecipientsMessage("draft_reply");
  assertStringIncludes(message, "draft_reply");
  assertStringIncludes(message, "no From, To or Cc address");
});
