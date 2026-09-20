// ---------------------------------------------------------------------------
// The refusal was already correct; what it lacked was the next step. These
// tests pin both halves: the remedy names the tool that actually works, and the
// sentence a client parses for the refusal itself is untouched.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { unsupportedFeatureMessage } from "./unsupported-feature-remedy.ts";

Deno.test("the Gmail copy refusal names move as the remedy", () => {
  const message = unsupportedFeatureMessage("copy", "gmail");
  // The refusal itself is unchanged and still leads.
  assertStringIncludes(
    message,
    "The 'copy' feature is not supported for provider 'gmail'.",
  );
  // And it now says what to do instead, and why that works on Gmail.
  assertStringIncludes(message, "'move'");
  assertStringIncludes(message, "'move_batch'");
  assertStringIncludes(message, "labels");
  assertStringIncludes(message, "destination_folder_id");
});

// REGRESSION 2026-09-20. The remedy opened "Gmail uses labels rather than
// folders", a sentence about the BRAND that is false of most Gmail mailboxes we
// serve: one connected over IMAP is provider 'imap', service 'gmail', and a live
// run that day copied a message and a batch of two into another folder with the
// originals left in INBOX. Only provider 'gmail' — the Gmail API connector —
// can reach this refusal at all, so the text has to say connector, and has to
// leave a reader knowing where the real answer lives.
Deno.test("the Gmail copy refusal blames the connector, not Gmail addresses", () => {
  const message = unsupportedFeatureMessage("copy", "gmail");
  assertStringIncludes(message, "Gmail API");
  assertStringIncludes(message, "connector");
  // The per-inbox authority is named, so a model that meets this on one inbox
  // does not conclude every Gmail address in the workspace is barred.
  assertStringIncludes(message, "capabilities.copy");
  assertStringIncludes(message, "inbox_list");
  assertStringIncludes(message, "IMAP");
});

Deno.test("a refusal with no honest remedy stays exactly as it was", () => {
  assertEquals(
    unsupportedFeatureMessage("folders", "gmail"),
    "The 'folders' feature is not supported for provider 'gmail'.",
  );
  assertEquals(
    unsupportedFeatureMessage("copy", "imap"),
    "The 'copy' feature is not supported for provider 'imap'.",
  );
});
