import { assertEquals } from "jsr:@std/assert@1";
import { draftEventRow, recordDraftEvent, type DraftEventStore } from "./draft-events.ts";

const scope = { workspaceId: "w1", inboxId: "i1", apiKeyId: "k1" };

Deno.test("draftEventRow: card_offered only on drafted", () => {
  assertEquals(draftEventRow(scope, { event: "drafted", viaCard: false, cardOffered: true }).card_offered, true);
  assertEquals(draftEventRow(scope, { event: "sent", viaCard: true, cardOffered: true }).card_offered, null);
});

Deno.test("draftEventRow: holds ids and flags only, no content columns", () => {
  const row = draftEventRow(scope, { event: "saved", viaCard: true, lineId: "L" });
  assertEquals(Object.keys(row).sort(), [
    "api_key_id",
    "card_offered",
    "event",
    "inbox_id",
    "line_id",
    "via_card",
    "workspace_id",
  ]);
});

Deno.test("recordDraftEvent never throws", async () => {
  const failing: DraftEventStore = { insert: () => Promise.reject(new Error("relation does not exist")) };
  await recordDraftEvent(failing, scope, { event: "hidden", viaCard: true });
  await recordDraftEvent(null, scope, { event: "hidden", viaCard: true });
});

Deno.test("recordDraftEvent inserts one row", async () => {
  const rows: Record<string, unknown>[] = [];
  await recordDraftEvent({ insert: (r) => (rows.push(r), Promise.resolve()) }, scope, { event: "sent", viaCard: false });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].via_card, false);
});
