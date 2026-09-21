// ---------------------------------------------------------------------------
// A mismatched selector pair used to resolve silently to whichever mailbox
// `inbox_id` named. These tests pin the two halves of the fix: that a
// disagreement is refused and says what disagreed, and that every pairing which
// is NOT a disagreement still resolves exactly as it did before — including the
// pre-existing not_found for an id that names nothing.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkInboxSelectors,
  inboxSelectorConflictMessage,
  type SelectorInbox,
} from "./inbox-selector.ts";

// The two live inboxes from the production reproduction.
const BJELLANDA: SelectorInbox = {
  id: "1245c938-5567-400d-9bf3-a81371a890bf",
  email_address: "bjellanda@gmail.com",
};
const ASGEIR: SelectorInbox = {
  id: "0f2a1c44-9f3d-4b1e-8a77-5c6d2e9b0a31",
  email_address: "asgeir@albretsen.no",
};
const KNOWN = [BJELLANDA, ASGEIR];

Deno.test("a matching id/address pair resolves as before", () => {
  const outcome = checkInboxSelectors(
    BJELLANDA.id,
    BJELLANDA.email_address,
    KNOWN,
  );
  assertEquals(outcome.kind, "ok");
  assert(outcome.kind === "ok");
  assertEquals(outcome.inbox?.id, BJELLANDA.id);
});

Deno.test("inbox_id alone resolves", () => {
  const outcome = checkInboxSelectors(BJELLANDA.id, "", KNOWN);
  assert(outcome.kind === "ok");
  assertEquals(outcome.inbox?.id, BJELLANDA.id);
});

Deno.test("inbox address alone resolves", () => {
  const outcome = checkInboxSelectors("", ASGEIR.email_address, KNOWN);
  assert(outcome.kind === "ok");
  assertEquals(outcome.inbox?.id, ASGEIR.id);
});

Deno.test("an address passed through inbox_id still resolves", () => {
  // The resolver has always accepted an address in inbox_id; that leniency
  // must survive, and pairing it with the SAME address is not a conflict.
  const outcome = checkInboxSelectors(
    BJELLANDA.email_address,
    BJELLANDA.email_address,
    KNOWN,
  );
  assert(outcome.kind === "ok");
  assertEquals(outcome.inbox?.id, BJELLANDA.id);
});

Deno.test("neither selector given leaves resolution to the caller", () => {
  const outcome = checkInboxSelectors("", "", KNOWN);
  assert(outcome.kind === "ok");
  assertEquals(outcome.inbox, null);
});

Deno.test("the production repro is refused and names both sides", () => {
  const outcome = checkInboxSelectors(
    BJELLANDA.id,
    ASGEIR.email_address,
    KNOWN,
  );
  assertEquals(outcome.kind, "conflict");
  assert(outcome.kind === "conflict");
  assertEquals(outcome.conflict.inbox_id, BJELLANDA.id);
  assertEquals(outcome.conflict.inbox, ASGEIR.email_address);
  assertEquals(outcome.conflict.resolved_from_inbox_id.id, BJELLANDA.id);
  assertEquals(outcome.conflict.resolved_from_inbox.id, ASGEIR.id);

  const message = inboxSelectorConflictMessage(outcome.conflict);
  // Both arguments and both resolved mailboxes must appear, or the caller
  // cannot tell which of its two values to drop.
  assertStringIncludes(message, BJELLANDA.id);
  assertStringIncludes(message, BJELLANDA.email_address);
  assertStringIncludes(message, ASGEIR.id);
  assertStringIncludes(message, ASGEIR.email_address);
});

Deno.test("an unknown inbox_id is still not_found, not a conflict", () => {
  const outcome = checkInboxSelectors(
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ASGEIR.email_address,
    KNOWN,
  );
  assertEquals(outcome.kind, "not_found");
});

Deno.test("an unknown address is not_found even beside a valid id", () => {
  const outcome = checkInboxSelectors(
    BJELLANDA.id,
    "nobody@example.com",
    KNOWN,
  );
  assertEquals(outcome.kind, "not_found");
});

// ---------------------------------------------------------------------------
// Agreeing vs conflicting, side by side.
//
// A live functional test on 2026-09-20 called
//
//     folder_list {inbox: "bjellanda@gmail.com", inbox_id: "1245c938-…"}
//
// with both selectors naming the same mailbox, got its folders back with
// nothing said, and reported the "pass this or `inbox`, not both" rule as
// unenforced. It is enforced — for the case that matters. This pair of tests
// states the two halves of that decision next to each other so neither can be
// changed by accident: the disagreement is refused, the duplicate is accepted
// in silence because both lookups prove it could not have changed the outcome.
// The reasoning is in inbox-selector.ts's header.
// ---------------------------------------------------------------------------

Deno.test("an AGREEING pair is accepted, and recorded as redundant rather than disclosed", () => {
  const outcome = checkInboxSelectors(
    BJELLANDA.id,
    BJELLANDA.email_address,
    KNOWN,
  );
  assert(outcome.kind === "ok", "two names for one mailbox is not a conflict");
  assertEquals(outcome.inbox?.id, BJELLANDA.id, "and it is that mailbox");
  assertEquals(
    outcome.redundant,
    true,
    "the duplicate was seen — silence here is a decision, not an oversight",
  );
});

Deno.test("a CONFLICTING pair is refused instead of picking a winner", () => {
  const outcome = checkInboxSelectors(
    BJELLANDA.id,
    ASGEIR.email_address,
    KNOWN,
  );
  assertEquals(
    outcome.kind,
    "conflict",
    "two DIFFERENT mailboxes is a caller bug, not a precedence question",
  );
});

Deno.test("a single selector is never reported as redundant", () => {
  for (const outcome of [
    checkInboxSelectors(BJELLANDA.id, "", KNOWN),
    checkInboxSelectors("", ASGEIR.email_address, KNOWN),
    checkInboxSelectors("", "", KNOWN),
  ]) {
    assert(outcome.kind === "ok");
    assertEquals(outcome.redundant, false, "nothing was duplicated");
  }
});
