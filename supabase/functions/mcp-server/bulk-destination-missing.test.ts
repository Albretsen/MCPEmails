// ---------------------------------------------------------------------------
// A missing destination folder, in the BULK paths.
//
// ── What was still broken ──────────────────────────────────────────────────
// The single-message answer for "that folder does not exist" shipped on
// 2026-09-20 (destination-folder-missing.ts). The bulk paths were deferred in
// the same round and went on answering with the raw provider line:
//
//   "Provider error during email_move: UID COPY failed: [TRYCREATE] No folder
//    <name> (Failure). Please try again in a moment."
//
// for up to MAX_BULK_IDS messages at a time — protocol text, a permanent
// caller-caused condition filed as a provider fault, and retry advice that is
// not merely useless but wrong, since no wait creates a folder.
//
// Fixed 2026-09-21 in two places, which is what this file covers:
//
//   1. The WHOLE-BATCH catch of executeBulkMove, executeBulkCopy and
//      executeSearchAndMove, through `bulkDestinationMissingFailure`.
//   2. A single FAILED ITEM inside an otherwise fine batch, through
//      `bulkFailureMessage` in message-id-errors.ts.
//
// Both reuse destination-folder-missing.ts and the `folder_missing`
// classification rather than minting new text, so there is exactly one wording
// for this condition whether the caller passed one id or five hundred.
//
// ── Why half of this is a source scan ──────────────────────────────────────
// index.ts calls Deno.serve at load and exports nothing, so a handler cannot be
// imported and run. Same standing constraint, and the same split, as
// search-phase-wiring.test.ts: the pure text and the pure classification are
// exercised for real, and the scan pins that each handler is wired to them.
//
// Run: deno test --allow-all --no-check supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DESTINATION_FOLDER_MISSING_CODE,
  destinationFolderMissingMessage,
} from "./destination-folder-missing.ts";
import { bulkFailureMessage, MESSAGE_NOT_FOUND, MESSAGE_NOT_FOUND_DETAIL } from "./message-id-errors.ts";
import { classifyProviderError } from "./provider-error.ts";

/** The line a live Gmail-over-IMAP mailbox actually produced on 2026-09-20. */
const LIVE_TRYCREATE =
  "UID COPY failed: [TRYCREATE] No folder [MCPE-TEST-20260920-1501] NO-SUCH-FOLDER (Failure).";

// ---------------------------------------------------------------------------
// The batch form of the sentence.
// ---------------------------------------------------------------------------

Deno.test("the single-message wording is untouched when no count is given", () => {
  // The 2026-09-20 sentence, byte for byte. A batch fix must not reword the
  // single-message paths that were already right.
  const message = destinationFolderMissingMessage("email_move", "Nope");
  assertStringIncludes(message, "the message is exactly where it was");
  assertEquals(destinationFolderMissingMessage("email_move", "Nope", "folder", 1), message);
});

Deno.test("a whole-batch failure says that ALL of the messages are untouched", () => {
  // "the message is exactly where it was" says nothing about the other 199 ids
  // in the call, and a model reading it has to guess whether a partial move
  // happened. On a whole-batch failure nothing was dispatched, so say so, with
  // the number.
  const message = destinationFolderMissingMessage("email_move_batch", "Archive/2026", "folder", 200);
  assertStringIncludes(message, "Nothing was moved");
  assertStringIncludes(message, "none of the 200 messages was touched");
  assertStringIncludes(message, "exactly where they were");
  assert(!message.includes("the message is exactly"), "the singular clause must not survive");
});

Deno.test("the batch form keeps every property the single form has", () => {
  const destination = "[MCPE-TEST-20260920-1501] NO-SUCH-FOLDER";
  const message = destinationFolderMissingMessage("email_move_batch", destination, "folder", 500);
  assertStringIncludes(message, "email_move_batch");
  assertStringIncludes(message, "destination_folder_id");
  assertStringIncludes(message, JSON.stringify(destination));
  assertStringIncludes(message, "folder_list");
  assertStringIncludes(message, 'folder { action: "create"');
  assertStringIncludes(message, "will not succeed on a retry");
  assert(
    !/try again in a moment/i.test(message),
    "a missing folder is permanent for a batch exactly as it is for one message",
  );
  // And none of the raw protocol text it replaces.
  assert(!/TRYCREATE|UID COPY|NONEXISTENT/.test(message), "no protocol text");
});

Deno.test("Gmail's noun is still label in the batch form", () => {
  const gmail = destinationFolderMissingMessage("email_move_batch", "Nope", "label", 12);
  assertStringIncludes(gmail, "label");
  assert(!/ folder in this inbox/.test(gmail));
});

// ---------------------------------------------------------------------------
// One failed item inside a batch.
// ---------------------------------------------------------------------------

const MOVE_CONTEXT = {
  tool: "email_move_batch",
  destination: "Archive/2026",
  itemNoun: "folder" as const,
};

Deno.test("a per-message destination failure stops leaking the raw IMAP line", () => {
  for (
    const raw of [
      LIVE_TRYCREATE,
      "UID COPY failed: [NONEXISTENT] Mailbox does not exist",
      "Mailbox not found: Archive/2026",
      // The stable sentinel, which the bulk helpers log directly.
      DESTINATION_FOLDER_MISSING_CODE,
    ]
  ) {
    const rendered = bulkFailureMessage(raw, MOVE_CONTEXT);
    assertEquals(
      rendered,
      destinationFolderMissingMessage("email_move_batch", "Archive/2026", "folder"),
      raw,
    );
    assert(!rendered.includes(raw) || raw === DESTINATION_FOLDER_MISSING_CODE, `raw text leaked: ${raw}`);
    assert(!/try again in a moment/i.test(rendered), "no retry advice");
  }
});

Deno.test("a single failed item keeps the SINGULAR clause", () => {
  // Here it is literally true: the other ids in the batch have their own rows
  // in `results`, and the caller can see the split.
  const rendered = bulkFailureMessage(LIVE_TRYCREATE, MOVE_CONTEXT);
  assertStringIncludes(rendered, "the message is exactly where it was");
});

Deno.test("without a destination context nothing is rewritten", () => {
  // The guard that keeps email_delete_batch and email_flag out of it: a tool
  // with no destination_folder_id must never be told its destination was
  // missing. email_search_and_delete is in the same position — its destination
  // is Trash, chosen by us, not an argument the caller can correct.
  for (const raw of [LIVE_TRYCREATE, DESTINATION_FOLDER_MISSING_CODE, "Mailbox not found: Junk"]) {
    assertEquals(bulkFailureMessage(raw), raw, raw);
  }
});

Deno.test("only a missing folder is rewritten, even with a destination in hand", () => {
  // Every other condition has its own remedy — reconnect, back off, wait — and
  // answering one of them with "call folder_list" would be confidently wrong.
  for (
    const raw of [
      "imap_auth_failed",
      "gmail_auth_failed",
      "invalid_action",
      "invalid_message_id",
      "Gmail modify failed: 429",
      "Outlook move failed: 500",
      "IMAP read timeout",
    ]
  ) {
    assertEquals(bulkFailureMessage(raw, MOVE_CONTEXT), raw, raw);
  }
});

Deno.test("a stale message id still wins over the destination rewrite", () => {
  // Both translations live in one function now; the id is the more specific
  // fact and must not be shadowed.
  assertEquals(bulkFailureMessage(MESSAGE_NOT_FOUND, MOVE_CONTEXT), MESSAGE_NOT_FOUND_DETAIL);
});

Deno.test("the classifier already knew, which is why no new detection was written", () => {
  assertEquals(classifyProviderError(LIVE_TRYCREATE), "folder_missing");
  assertEquals(classifyProviderError(new Error(LIVE_TRYCREATE)), "folder_missing");
});

// ---------------------------------------------------------------------------
// Source scan: the whole-batch catches are wired to it.
// ---------------------------------------------------------------------------

const INDEX_SOURCE = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));

/** The body of one top-level function, up to its column-0 closing brace. */
function functionSource(name: string): string {
  const start = INDEX_SOURCE.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  assert(start >= 0, `${name} not found in index.ts`);
  const end = INDEX_SOURCE.indexOf("\n}\n", start);
  assert(end > start, `${name} has no closing brace in index.ts`);
  return INDEX_SOURCE.slice(start, end);
}

const BULK_DESTINATION_HANDLERS = [
  ["executeBulkMove", "email_move_batch"],
  ["executeBulkCopy", "email_copy_batch"],
  ["executeSearchAndMove", "email_search_and_move"],
] as const;

Deno.test("every bulk move/copy handler answers a missing destination cleanly", () => {
  for (const [name, tool] of BULK_DESTINATION_HANDLERS) {
    const body = functionSource(name);
    assertStringIncludes(
      body,
      "classifyProviderError(err) === \"folder_missing\"",
      `${name} does not recognise a missing destination in its whole-batch catch`,
    );
    const branch = body.slice(body.indexOf("bulkDestinationMissingFailure({"));
    assert(branch.length > 0, `${name} does not route to the shared answer`);
    assertStringIncludes(branch, `tool: "${tool}"`, `${name} must name its own dispatch name`);
    assertStringIncludes(
      branch,
      "messageCount: messageIds.length",
      `${name} must say how many messages were not moved`,
    );
    assertStringIncludes(
      branch,
      "destinationFolderId",
      `${name} must quote the caller's own destination_folder_id`,
    );
  }
});

Deno.test("the generic provider answer is still there for everything else", () => {
  // The narrowing must be a branch, not a replacement: a genuine provider fault
  // in the same catch still gets `provider_error`, the retry advice and the
  // ledger's "unknown" settlement.
  for (const [name, tool] of BULK_DESTINATION_HANDLERS) {
    const body = functionSource(name);
    assertStringIncludes(body, 'boundary: "ledger"', `${name} lost its ledger boundary`);
    assert(
      /Provider error during (?:email_\w+|move): \$\{message\}\. Please try again in a moment\./
        .test(body),
      `${name} lost its generic provider-error text`,
    );
    assert(body.includes(tool), `${name} no longer names ${tool}`);
  }
});

Deno.test("a failed run is still recorded as failed, with the accurate code", () => {
  // email_move_batch and email_search_and_move own a `bulk_runs` row; the fix
  // must not leave it open. email_copy_batch never started one.
  for (const name of ["executeBulkMove", "executeSearchAndMove"] as const) {
    const body = functionSource(name);
    const branch = body.slice(0, body.indexOf("bulkDestinationMissingFailure({"));
    assertStringIncludes(
      branch.slice(branch.lastIndexOf("catch (err)")),
      "failBulkRun(runId, DESTINATION_FOLDER_MISSING_CODE)",
      `${name} must still close out its bulk_runs row`,
    );
    assertStringIncludes(
      body,
      'failBulkRun(runId, "provider_error")',
      `${name} must still fail the run for a genuine provider fault`,
    );
  }
  assert(
    !functionSource("executeBulkCopy").includes("failBulkRun"),
    "executeBulkCopy never started a run; do not close one",
  );
});

Deno.test("the shared helper keeps the honest ledger code", () => {
  const body = functionSource("bulkDestinationMissingFailure");
  assertStringIncludes(body, "fallbackCode: DESTINATION_FOLDER_MISSING_CODE");
  assertStringIncludes(body, 'boundary: "ledger"');
  assertStringIncludes(body, "organizationItemType(input.inbox)");
  assertStringIncludes(body, "input.messageCount");
});

Deno.test("formatBulkResult hands the per-item renderer its destination", () => {
  const body = functionSource("formatBulkResult");
  assertStringIncludes(body, 'extra?.["destination_folder_id"]');
  assertStringIncludes(body, "bulkFailureMessage(error, destinationContext)");
  // Gmail's labels survive the trip: the noun comes off the same `extra` the
  // move paths already publish as destination_type.
  assertStringIncludes(body, 'extra?.["destination_type"] === "label"');
});

Deno.test("folder_not_found is a known bulk code, so a total failure keeps it", () => {
  // Asserted rather than assumed: the whole reuse argument rests on this code
  // already existing in the taxonomy, and on KNOWN_BULK_ERROR_CODES passing it
  // through verbatim instead of collapsing it to `provider_error`.
  const set = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf("const KNOWN_BULK_ERROR_CODES"));
  assertStringIncludes(set.slice(0, set.indexOf("]")), '"folder_not_found"');
  assertEquals(DESTINATION_FOLDER_MISSING_CODE, "folder_not_found");
});
