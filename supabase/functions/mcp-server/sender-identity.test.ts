// ---------------------------------------------------------------------------
// Naming the inbox's own address must work on every provider.
//
// Production repro: agents called email_send on IMAP inboxes with
// `from: "<the inbox's own address>"`, which is the default written out. The
// provider check ran before the self-address check, so it was refused with
// "Send As identities are currently available only for Gmail", which reads as
// "this inbox cannot send at all". activity_log held 23 of these across four
// workspaces between 2026-08-10 and 2026-09-01, all on IMAP inboxes.
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isSelfSenderIdentity, senderIdentityErrorCode } from "./sender-identity.ts";

Deno.test("the inbox's own address is recognised as itself", () => {
  assert(isSelfSenderIdentity("someone@gmail.com", "someone@gmail.com"));
});

Deno.test("the self-address match ignores case and surrounding space", () => {
  for (const raw of ["  SomeOne@Gmail.com  ", "SOMEONE@GMAIL.COM", "someone@gmail.com "]) {
    assert(isSelfSenderIdentity("someone@gmail.com", raw), raw);
  }
  // The stored address is normalised the same way, so a stray space on either
  // side of the comparison cannot turn a match into a refusal.
  assert(isSelfSenderIdentity(" Someone@Gmail.com ", "someone@gmail.com"));
});

Deno.test("a different address is NOT the inbox's own", () => {
  for (const raw of [
    "someone.else@example.com",
    "someone@gmail.com.evil.example",
    "someone@googlemail.com",
    "asgeir@iago.no",
  ]) {
    assert(!isSelfSenderIdentity("someone@gmail.com", raw), raw);
  }
});

Deno.test("each cause gets its own activity_log code", () => {
  assertEquals(senderIdentityErrorCode("invalid_sender_identity"), "sender_identity_invalid");
  assertEquals(
    senderIdentityErrorCode("sender_identity_unsupported_provider"),
    "sender_identity_unsupported_provider",
  );
  assertEquals(
    senderIdentityErrorCode("gmail_sender_identities_scope_required"),
    "sender_identity_scope_required",
  );
  assertEquals(
    senderIdentityErrorCode("sender_identity_not_authorized"),
    "sender_identity_not_authorized",
  );
  // Anything unexpected must still be distinguishable from the four known
  // causes rather than silently joining one of them.
  assertEquals(senderIdentityErrorCode("boom"), "sender_identity_lookup_failed");
});
