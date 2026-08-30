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
