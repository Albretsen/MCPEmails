// ---------------------------------------------------------------------------
// The move/copy answer for a destination that does not exist.
//
// Pinned because the sentence this replaces was live on 2026-09-20 and was
// wrong in a way only prose can be wrong: "Provider error during email_move:
// UID COPY failed: [TRYCREATE] No folder <name> (Failure). Please try again in
// a moment." Raw protocol text, the wrong class of error, and retry advice for
// something no wait fixes. These tests hold the replacement to the bar the
// draft errors set: name the argument, state what happened to the mailbox, do
// not promise a retry, name the call that fixes it.
//
// Run: deno test --allow-all supabase/functions/mcp-server/destination-folder-missing.test.ts
// ---------------------------------------------------------------------------
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DESTINATION_FOLDER_MISSING_CODE,
  destinationFolderMissingMessage,
} from "./destination-folder-missing.ts";

Deno.test("the message names the caller's own destination_folder_id", () => {
  const destination = "[MCPE-TEST-20260920-1501] NO-SUCH-FOLDER";
  const message = destinationFolderMissingMessage("email_move", destination);
  assertStringIncludes(message, "email_move");
  assertStringIncludes(message, "destination_folder_id");
  // Quoted, so a name with brackets or trailing spaces is unambiguous.
  assertStringIncludes(message, JSON.stringify(destination));
});

Deno.test("the message points at folder_list and at creating the folder", () => {
  const message = destinationFolderMissingMessage("email_copy", "Receipts/2026");
  assertStringIncludes(message, "folder_list");
  assertStringIncludes(message, 'folder { action: "create"');
});

Deno.test("nothing in it invites a retry", () => {
  const message = destinationFolderMissingMessage("email_move", "Nope");
  // The exact phrase the old text closed with, and the class of advice it
  // stands for. A permanent condition must not be dressed as a flaky one.
  assert(
    !/try again in a moment/i.test(message),
    "a missing folder is permanent; retry advice is actively wrong here",
  );
  assertStringIncludes(message, "will not succeed on a retry");
});

Deno.test("it states that the mailbox is unchanged", () => {
  const message = destinationFolderMissingMessage("email_move", "Nope");
  assertStringIncludes(message, "Nothing was moved");
  assertStringIncludes(message, "where it was");
});

Deno.test("Gmail's noun is label, everyone else's is folder", () => {
  const gmail = destinationFolderMissingMessage("email_move", "Nope", "label");
  assertStringIncludes(gmail, "label");
  assert(!/ folder in this inbox/.test(gmail));
  const imap = destinationFolderMissingMessage("email_move", "Nope");
  assertStringIncludes(imap, "folder");
});

Deno.test("the log code is the one the taxonomy already had", () => {
  // Same code the bulk paths have logged for this condition since 2026-07-28
  // and the one READ_PATH_ERROR_CODES maps `folder_missing` onto. A second
  // spelling would split the history of one condition.
  assertEquals(DESTINATION_FOLDER_MISSING_CODE, "folder_not_found");
});
