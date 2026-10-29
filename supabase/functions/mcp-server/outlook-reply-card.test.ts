// ---------------------------------------------------------------------------
// Outlook reply drafts and the draft card (persona test, 2026-10-26).
//
// `draft{action:"reply"}` on an Outlook inbox returned bare `jsonOk`, so the
// card mounted "Draft: no preview for this result." The behaviour itself is in
// mcp-app-drafts.test.ts and outlook-graph.test.ts; these pin the wiring in
// index.ts, which a test cannot import.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert } from "jsr:@std/assert@1";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const fnBody = (name: string): string => {
  const start = index.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  return index.slice(start, index.indexOf("\n}\n", start));
};

Deno.test("the Outlook reply branch returns a card result, not bare jsonOk", () => {
  const body = fnBody("executeCreateReplyDraft");
  const start = body.indexOf('if (inbox.provider === "outlook")');
  assert(start >= 0);
  const outlook = body.slice(start, body.indexOf("let subject = ", start));
  assert(outlook.includes("draftEditorEnvelopeForWrite("), "builds the editor envelope");
  assert(outlook.includes("draftCardToolResult("), "returns through draftCardToolResult");
  assert(!outlook.includes("jsonOk("), "no bare jsonOk left on this branch");
  assert(outlook.includes("nativeReply: true"), "a createReply draft is threaded");
});

Deno.test("the Outlook editor reader asks Graph for conversationIndex", () => {
  const body = fnBody("outlookGetDraftForEditor");
  assert(body.includes("conversationIndex"), "selected");
  assert(body.includes("graphConversationIndexIsResponse("), "and used for nativeReply");
});

Deno.test("an envelope that fails in a card-on inbox reports unavailable", () => {
  const body = fnBody("buildDraftEditorEnvelopeForWrite");
  assert(body.includes('return cardOn ? "unavailable" : null;'));
});

Deno.test("the full-body update counts a native Outlook reply as threaded", () => {
  assert(index.includes("updateResult.threaded = Boolean(inReplyTo || threadId || nativeReply);"));
});
