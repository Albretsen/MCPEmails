import { assert, assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { actionSelectorDescription, advertisedInputSchema } from "./advertised-schema.ts";

// The shape buildConsolidatedTool emits: one if/then rule per action.
function consolidatedSchema() {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "read"], description: "Operation to run." },
      message_id: { type: "string" },
      limit: { type: "integer", default: 20 },
    },
    required: ["action"],
    additionalProperties: false,
    allOf: [
      {
        if: { properties: { action: { const: "list" } }, required: ["action"] },
        then: { not: { anyOf: [{ required: ["message_id"] }] } },
      },
      {
        if: { properties: { action: { const: "read" } }, required: ["action"] },
        then: { required: ["message_id"], not: { anyOf: [{ required: ["limit"] }] } },
      },
    ],
  };
}

Deno.test("advertisedInputSchema drops allOf and nothing else", () => {
  const full = consolidatedSchema();
  const advertised = advertisedInputSchema(full);
  assert(!("allOf" in advertised), "allOf is not advertised");
  const { allOf: _rules, ...rest } = full;
  assertEquals(advertised, rest, "every other keyword survives verbatim");
});

Deno.test("advertisedInputSchema leaves the validator's schema untouched", () => {
  const full = consolidatedSchema();
  const rules = full.allOf;
  advertisedInputSchema(full);
  assertStrictEquals(full.allOf, rules, "the full schema still carries its rules");
  assertEquals(full.allOf.length, 2, "and all of them");
});

Deno.test("advertisedInputSchema returns the same object when there is nothing to strip", () => {
  const plain = { type: "object", properties: {}, additionalProperties: false };
  assertStrictEquals(advertisedInputSchema(plain), plain);
});

Deno.test("actionSelectorDescription states required arguments a hint does not name", () => {
  const description = actionSelectorDescription([
    { name: "list", hint: "recent messages", required: [] },
    { name: "read", hint: "full content of one message_id", required: ["message_id"] },
    { name: "attachment", hint: "download by attachment_index", required: ["message_id"] },
    { name: "move", hint: "one message_id to destination_folder_id", required: ["message_id", "destination_folder_id"] },
    { name: "reply", hint: "answer a message_id", required: ["message_id", "body"] },
  ]);
  assertEquals(
    description,
    "Operation to run. list = recent messages; read = full content of one message_id; " +
      "attachment = download by attachment_index; move = one message_id to destination_folder_id; " +
      "reply = answer a message_id. Required: attachment: message_id; reply: body.",
  );
});

Deno.test("actionSelectorDescription matches whole words, so message_ids does not cover message_id", () => {
  const description = actionSelectorDescription([
    { name: "forward", hint: "pass up to 50 message_ids on", required: ["message_id"] },
  ]);
  assert(description.endsWith("Required: forward: message_id."), description);
});

Deno.test("actionSelectorDescription without hints still lists every required argument", () => {
  assertEquals(
    actionSelectorDescription([
      { name: "list", required: [] },
      { name: "get", required: ["automation_id"] },
      { name: "create", required: ["name", "filter"] },
    ]),
    "Operation to run. Required: get: automation_id; create: name, filter.",
  );
  assertEquals(actionSelectorDescription([{ name: "list", required: [] }]), "Operation to run.");
});
