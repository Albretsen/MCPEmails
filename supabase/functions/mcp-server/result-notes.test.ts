// ---------------------------------------------------------------------------
// The disclosure has to arrive, not merely be built.
//
// consolidated-arguments.test.ts already proved the classification and the
// sentence were right, and both WERE right in production on 2026-08-31: the
// server logged
//
//   [mcp-server] tools/call: ignored_extra_arguments
//     { tool_name: "email_read", action: "list", misplaced: ["subject", ...] }
//
// and the client still received 80,610 unfiltered messages with no mention of
// the dropped filter anywhere. The note existed and never arrived, because it
// was written only to `content` while the caller reads `structuredContent`.
//
// So these tests assert against the EMITTED RESULT — the object that goes on
// the wire — rather than against the note builder in isolation. A test of the
// builder passes happily while the product is broken; that is precisely what
// happened. Every assertion below therefore starts from a result shaped exactly
// as jsonOk builds one, and asks what a client would actually see.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  attachResultNote,
  RESULT_NOTES_PROPERTY,
  withResultNotesProperty,
} from "./result-notes.ts";
import {
  buildIgnoredArgumentsNote,
  reviewExtraArguments,
} from "./consolidated-arguments.ts";

/**
 * The real email_read index, copied from what buildConsolidatedTool produces at
 * module load (verified against the running module: allowedByAction.list is
 * exactly action/inbox_id/inbox/limit/offset/folder/unread_only, and `subject`
 * is owned by `search` alone).
 */
const EMAIL_READ = {
  allowedByAction: {
    list: ["action", "inbox_id", "inbox", "limit", "offset", "folder", "unread_only"],
    search: ["action", "inbox_id", "inbox", "subject", "from", "since", "limit", "offset", "include_folders"],
    read: ["action", "inbox_id", "inbox", "message_id", "body_max_chars"],
  },
  ownersByProperty: {
    subject: ["search"],
    from: ["search"],
    since: ["search"],
    folder: ["list"],
    body_max_chars: ["read"],
    unread_only: ["list"],
  },
  neutralDefaults: {},
};

/** A successful list result, shaped exactly as jsonOk(payload) builds one. */
function listResult(payload: Record<string, unknown>) {
  return {
    jsonrpc: "2.0" as const,
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    },
  };
}

Deno.test("the emitted list result carries the disclosure a client can read", () => {
  // The exact production call: email_read {action: "list", subject: "..."}.
  const review = reviewExtraArguments(
    EMAIL_READ,
    "list",
    { action: "list", inbox_id: "1245c938", subject: "MCPE-HC-20260830-2242", limit: 5 },
    true,
  );
  assertEquals(review.ignoredMisplaced.length, 1, "subject is dropped, not refused");

  const response = listResult({
    messages: [{ id: "a" }, { id: "b" }],
    total: 80610,
    has_more: true,
    next_offset: 2,
    untrusted_content: true,
  });
  attachResultNote(
    response,
    buildIgnoredArgumentsNote("email_read", "list", review.ignoredMisplaced),
  );

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. A client that surfaces the
  // structured payload must see the disclosure in it. Before the fix this key
  // did not exist and the client saw 80,610 messages and nothing else.
  const structured = response.result.structuredContent as Record<string, unknown>;
  const notes = structured[RESULT_NOTES_PROPERTY];
  assert(Array.isArray(notes), `structuredContent.${RESULT_NOTES_PROPERTY} must exist`);
  assertEquals(notes.length, 1);
  const note = String(notes[0]);
  assertStringIncludes(note, "email_read");
  assertStringIncludes(note, "'list'");
  assertStringIncludes(note, "'subject'");
  assertStringIncludes(note, "'search'");
  assertStringIncludes(note, "not applied");

  // The results themselves are untouched: this discloses, it does not filter.
  assertEquals((structured.messages as unknown[]).length, 2);
  assertEquals(structured.total, 80610);
});

Deno.test("the serialized mirror is regenerated, not left stale", () => {
  // content[0].text is stringified by jsonOk BEFORE the note is attached, so a
  // client reading the JSON out of the text block would have kept reading the
  // pre-note payload for ever.
  const payload = { messages: [], has_more: false, next_offset: null };
  const response = listResult(payload);
  attachResultNote(response, "Note: a filter was not applied.");

  const reparsed = JSON.parse(response.result.content[0].text as string);
  assertEquals(
    reparsed[RESULT_NOTES_PROPERTY],
    ["Note: a filter was not applied."],
    "the text block must agree with structuredContent",
  );
  // And it is still valid JSON, which is why the note was kept out of it before.
  assertEquals(reparsed.has_more, false);
});

Deno.test("a reader scanning prose still gets the note as its own block", () => {
  const response = listResult({ messages: [], has_more: false, next_offset: null });
  attachResultNote(response, "Note: dropped 'subject'.");
  const blocks = response.result.content;
  assertEquals(blocks.length, 2, "payload block plus the note block");
  assertEquals(blocks[1], { type: "text", text: "Note: dropped 'subject'." });
});

Deno.test("a pretty-printed payload keeps its formatting when regenerated", () => {
  // jsonOk offers exactly two styles and the replay path uses the pretty one.
  const payload = { operation: "email_move_batch", succeeded: 2, failed: 0 };
  const response = {
    jsonrpc: "2.0" as const,
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: false,
    },
  };
  attachResultNote(response, "Note: replayed.");
  const text = response.result.content[0].text as string;
  assert(text.includes("\n  "), "still indented");
  assertEquals(JSON.parse(text)[RESULT_NOTES_PROPERTY], ["Note: replayed."]);
});

Deno.test("prose a handler wrote itself is never overwritten with JSON", () => {
  // The regeneration only fires when content[0] is provably the serialization
  // of structuredContent. Replacing a handler's own text with JSON would be a
  // worse bug than the one being fixed.
  const response = {
    jsonrpc: "2.0" as const,
    id: 1,
    result: {
      content: [{ type: "text", text: "Moved 3 messages to Receipts." }],
      structuredContent: { succeeded: 3 },
      isError: false,
    },
  };
  attachResultNote(response, "Note: dropped 'subject'.");
  assertEquals(response.result.content[0].text, "Moved 3 messages to Receipts.");
  // The structured channel still carries it, and so does a trailing block.
  assertEquals(
    (response.result.structuredContent as Record<string, unknown>)[RESULT_NOTES_PROPERTY],
    ["Note: dropped 'subject'."],
  );
  assertEquals(response.result.content.length, 2);
});

Deno.test("a failed result is never annotated", () => {
  const response = {
    jsonrpc: "2.0" as const,
    id: 1,
    result: {
      content: [{ type: "text", text: "Message not found." }],
      structuredContent: { error: "message_not_found" },
      isError: true,
    },
  };
  attachResultNote(response, "Note: dropped 'subject'.");
  assertEquals(response.result.content.length, 1, "no extra block");
  assertEquals(
    Object.hasOwn(response.result.structuredContent, RESULT_NOTES_PROPERTY),
    false,
    "no notes key",
  );
});

Deno.test("two notes accumulate rather than overwrite", () => {
  const response = listResult({ messages: [], has_more: false, next_offset: null });
  attachResultNote(response, "first");
  attachResultNote(response, "second");
  assertEquals(
    (response.result.structuredContent as Record<string, unknown>)[RESULT_NOTES_PROPERTY],
    ["first", "second"],
  );
});

Deno.test("a strict output schema is taught to accept the note", () => {
  // email_list's real output schema: additionalProperties false, so a `notes`
  // key it did not declare would fail a strict client's own validation. This is
  // what stops the payload fix from breaking the clients it is meant to serve.
  const emailList = {
    type: "object",
    properties: {
      messages: { type: "array" },
      has_more: { type: "boolean" },
      next_offset: { type: ["integer", "null"] },
    },
    required: ["messages", "has_more", "next_offset"],
    additionalProperties: false,
  };
  const widened = withResultNotesProperty(emailList) as Record<string, unknown>;
  const properties = widened.properties as Record<string, unknown>;
  assert(RESULT_NOTES_PROPERTY in properties, "notes is declared");
  // Optional: a result without notes must stay valid, and the original object
  // must not have been mutated in place.
  assertEquals(widened.required, ["messages", "has_more", "next_offset"]);
  assertEquals(widened.additionalProperties, false, "still strict about anything else");
  assertEquals(
    Object.hasOwn(emailList.properties, RESULT_NOTES_PROPERTY),
    false,
    "the source schema is left alone",
  );
});

Deno.test("widening is idempotent and ignores schemas with no properties", () => {
  const once = withResultNotesProperty({ type: "object", properties: { a: {} } });
  const twice = withResultNotesProperty(once);
  assertEquals(twice, once, "applying it again changes nothing");
  const noProps = { type: "string" };
  assertEquals(withResultNotesProperty(noProps), noProps, "nothing to declare on");
});
