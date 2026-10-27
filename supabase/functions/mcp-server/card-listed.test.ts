// ---------------------------------------------------------------------------
// api_keys.card_listed (release prep 2026-10-27): tools/list records whether it
// carried the draft card, and the draft write paths pass it on, so a chat that
// cached a card-less tool list is not told a card is on screen. index.ts cannot
// be imported by a test, so these pin the wiring in its source.
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("the key lookup selects card_listed", () => {
  // Matched by its neighbour's position, not its name: card-build-notify.test.ts
  // allows only a fixed set of files to name that column.
  assertEquals(index.split(", card_listed\"").length - 1, 2);
});

Deno.test("tools/list records the drafts gate as card_listed, only when it moved", () => {
  const start = index.indexOf("async function handleToolsList(");
  const body = index.slice(start, index.indexOf("\n}\n", start));
  assert(body.includes("(apiKey.card_listed ?? null) !== baseGates.drafts"));
  assert(body.includes('update({ card_listed: baseGates.drafts })'));
});

Deno.test("every draft write that can carry the editor passes keyListedDraftCard", () => {
  for (const call of [
    "draftCardToolResult(outlookPayload, outlookCard, false, keyListedDraftCard(apiKey))",
    "draftCardToolResult(replyPayload, replyCard, false, keyListedDraftCard(apiKey))",
    "draftCardToolResult(createPayload, withDraftRevision(cardEnvelope, createRevision), false, keyListedDraftCard(apiKey))",
    "draftCardToolResult(updatePayload, updateCard, false, keyListedDraftCard(apiKey))",
  ]) assert(index.includes(call), call);
  assert(index.includes("card_listed: apiKey.card_listed ?? null"), "the bodyless update gets it through the caller");
});

Deno.test("unknown counts as listed", () => {
  assert(index.includes("return apiKey.card_listed !== false;"));
});
