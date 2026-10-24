// Per-inbox instructions: the pure rules (inbox-instructions.ts).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  carriesInboxInstructionsNote,
  INBOX_INSTRUCTIONS_MAX_CHARS,
  INBOX_INSTRUCTIONS_NOTE_LABEL,
  inboxInstructionsNote,
  instructionsByInbox,
  normalizeInboxInstructionsInput,
  normalizeStoredInboxInstructions,
  withOwnerInstructions,
} from "./inbox-instructions.ts";

Deno.test("input: trimmed, empty clears, null clears", () => {
  assertEquals(normalizeInboxInstructionsInput("  Sign as Support.\n"), { ok: true, value: "Sign as Support." });
  assertEquals(normalizeInboxInstructionsInput("   \n\t "), { ok: true, value: null });
  assertEquals(normalizeInboxInstructionsInput(""), { ok: true, value: null });
  assertEquals(normalizeInboxInstructionsInput(null), { ok: true, value: null });
});

Deno.test("input: inner line breaks are kept", () => {
  assertEquals(normalizeInboxInstructionsInput("Line one.\n\nLine two."), { ok: true, value: "Line one.\n\nLine two." });
});

Deno.test("input: exactly the cap is accepted, one over is refused, padding does not count", () => {
  const atCap = "a".repeat(INBOX_INSTRUCTIONS_MAX_CHARS);
  assertEquals(INBOX_INSTRUCTIONS_MAX_CHARS, 2000);
  assertEquals(normalizeInboxInstructionsInput(atCap), { ok: true, value: atCap });
  assertEquals(normalizeInboxInstructionsInput(`  ${atCap}  `), { ok: true, value: atCap });
  assertEquals(normalizeInboxInstructionsInput(atCap + "a"), { ok: false, error: "too_long" });
});

Deno.test("input: a long run of tabs trims in linear time (no regex backtracking)", () => {
  const tabs = "\t".repeat(200_000);
  const started = performance.now();
  assertEquals(normalizeInboxInstructionsInput(`${tabs}Sign as Support.${tabs}`), { ok: true, value: "Sign as Support." });
  assertEquals(normalizeInboxInstructionsInput(tabs), { ok: true, value: null });
  assertEquals(normalizeInboxInstructionsInput(`x${tabs}y`), { ok: false, error: "too_long" });
  assertEquals(normalizeStoredInboxInstructions(`${tabs}keep\tthis${tabs}`), "keep\tthis");
  assert(performance.now() - started < 1000, "trimming long tab runs took over a second");
});

Deno.test("input: non-strings are refused", () => {
  for (const bad of [undefined, 42, true, {}, ["x"]]) {
    assertEquals(normalizeInboxInstructionsInput(bad), { ok: false, error: "invalid_instructions" });
  }
});

Deno.test("stored: trimmed, capped on read, null for empty or non-strings", () => {
  assertEquals(normalizeStoredInboxInstructions(" x "), "x");
  assertEquals(normalizeStoredInboxInstructions(""), null);
  assertEquals(normalizeStoredInboxInstructions(null), null);
  assertEquals(normalizeStoredInboxInstructions(7), null);
  const long = "b".repeat(INBOX_INSTRUCTIONS_MAX_CHARS + 50);
  assertEquals(normalizeStoredInboxInstructions(long)?.length, INBOX_INSTRUCTIONS_MAX_CHARS);
});

Deno.test("note: labelled, text on the next line", () => {
  assertEquals(INBOX_INSTRUCTIONS_NOTE_LABEL, "Inbox instructions from the owner:");
  assertEquals(inboxInstructionsNote("Sign as Support."), "Inbox instructions from the owner:\nSign as Support.");
});

Deno.test("note tools: drafting and sending only, never reads or searches", () => {
  for (const name of ["draft_create", "draft_reply", "email_send", "email_reply", "email_forward"]) {
    assert(carriesInboxInstructionsNote(name), name);
  }
  for (const name of ["inbox_list", "email_read", "email_search", "email_list", "draft_list", "draft_update", "draft_send"]) {
    assert(!carriesInboxInstructionsNote(name), name);
  }
});

Deno.test("listing: untouched (same array) without instructions, field added only where set", () => {
  const inboxes = [{ inbox_id: "a", email_address: "a@x" }, { inbox_id: "b", email_address: "b@x" }];
  assert(withOwnerInstructions(inboxes, null) === inboxes);
  assert(withOwnerInstructions(inboxes, new Map()) === inboxes);
  const out = withOwnerInstructions(inboxes, new Map([["b", "Sign as B."]]));
  assertEquals(out[0], { inbox_id: "a", email_address: "a@x" });
  assertEquals(out[1], { inbox_id: "b", email_address: "b@x", owner_instructions: "Sign as B." });
});

Deno.test("rows: map of id to served text, blanks dropped", () => {
  const map = instructionsByInbox([
    { id: "a", ai_instructions: " A " },
    { id: "b", ai_instructions: null },
    { id: "c", ai_instructions: "   " },
    { ai_instructions: "no id" },
  ]);
  assertEquals([...map.entries()], [["a", "A"]]);
  assertEquals(instructionsByInbox(null).size, 0);
});
