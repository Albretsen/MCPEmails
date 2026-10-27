// Tests for stale-listing-hint.ts: which ChatGPT calls prove a stale tool
// list, and that the note reads as customer-safe copy.

import {
  isChatGptHost,
  isStaleListingCardCall,
  STALE_LISTING_NOTE,
  staleHintHasCardToMiss,
} from "./stale-listing-hint.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// The per-operation names the hint must treat as current. A subset is enough:
// the function only asks "is this name listed".
const LISTED = new Set([
  "email_read",
  "email_delete",
  "email_search_and_move",
  "draft_create",
  "draft_read",
  "email_send",
  "inbox_list",
]);

Deno.test("consolidated card tools the per-operation listing dropped are stale calls", () => {
  for (const name of ["draft", "email_compose", "schedule", "email_organize"]) {
    assert(isStaleListingCardCall(name, LISTED), `${name} should prove a stale listing`);
  }
});

Deno.test("names the per-operation listing still has are never stale calls", () => {
  // email_delete is a bulk card tool when consolidated AND a per-operation name.
  for (const name of ["email_delete", "email_search_and_move", "draft_create", "email_read", "inbox_list"]) {
    assert(!isStaleListingCardCall(name, LISTED), `${name} must not count`);
  }
});

Deno.test("consolidated tools with no card are not flagged", () => {
  // A stale listing without a card loses nothing the user can see.
  for (const name of ["folder", "automation", "reminder", "signature"]) {
    assert(!isStaleListingCardCall(name, LISTED), `${name} carries no card`);
  }
});

Deno.test("ChatGPT is told apart from Codex and Agent Builder", () => {
  assert(isChatGptHost("OAuth: chatgpt.com", "openai-mcp"), "ChatGPT by client name");
  assert(!isChatGptHost("OAuth: chatgpt.com", "openai-mcp (Codex)"), "Codex renders no card");
  assert(!isChatGptHost("OAuth: ChatGPT", "openai-mcp (Agent Builder)"), "Agent Builder");
  // A relinked ChatGPT may never send initialize: the key name decides.
  assert(isChatGptHost("OAuth: ChatGPT (2)", null), "ChatGPT by key name");
  assert(isChatGptHost("OAuth: chatgpt.com", null), "chatgpt.com by key name");
  assert(!isChatGptHost("OAuth: Codex", null), "Codex key name");
  assert(!isChatGptHost(null, null), "no signal, no note");
});

Deno.test("the note follows the copy rules", () => {
  assert(STALE_LISTING_NOTE.includes("MCPEmails"), "brand spelled as one word");
  assert(!STALE_LISTING_NOTE.includes("MCP Emails"), "never two words");
  assert(!STALE_LISTING_NOTE.includes("—"), "no em dash");
  assert(!/[<>]/.test(STALE_LISTING_NOTE), "no angle brackets");
});

Deno.test("an outbound tool gets the note only on a held send", () => {
  // The outbound card is listed for every send-capable key since 2026-10-27,
  // so an ordinary ChatGPT send must not carry the reload note.
  assert(!staleHintHasCardToMiss("email_compose", { message_id: "m", sent_at: "x", status: "sent" }), "ordinary send");
  assert(!staleHintHasCardToMiss("schedule", { scheduled: true, send_at: "x", status: "pending" }), "ordinary schedule");
  assert(!staleHintHasCardToMiss("email_compose", undefined), "no structured content");
  assert(staleHintHasCardToMiss("email_compose", { status: "pending_approval" }), "held send");
  assert(staleHintHasCardToMiss("schedule", { status: "pending_approval" }), "held schedule");
  // Every other card-bearing tool is decided by the card gate alone, as before.
  assert(staleHintHasCardToMiss("draft", { draft_id: "d" }), "draft unchanged");
  assert(staleHintHasCardToMiss("email_organize", undefined), "bulk unchanged");
});
