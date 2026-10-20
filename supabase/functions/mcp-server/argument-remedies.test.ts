// ---------------------------------------------------------------------------
// The -32602 refusals that did not lead the caller to the right next call.
//
// Measured 2026-10-15 over 10-06..10-15, with the first call the same
// workspace made within three minutes of each refusal (see the header of
// argument-remedies.ts for the reply rows):
//
//   email_compose reply + to       10 refusals, all 10 followed by email_send:
//                                  the reply left its thread
//   email_list + since/before      32 refusals, 7 followed by a success
//   email_search + action          30 refusals, 1 followed by a success
//   email_read read_batch + ids    16 refusals, 7 workspaces
//   email_search, no criterion     71 refusals, 17 workspaces, logged with no
//                                  details at all
//
// Pure halves first, then the same cases end to end through handleToolsCall,
// on both surfaces, so the wiring is pinned as well as the wording.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dropRedundantAction, normalizeArgumentAliases } from "./argument-aliases.ts";
import { ARGUMENT_REMEDIES, remediesFor, withSiblingOperations } from "./argument-remedies.ts";
import { withOwningActions } from "./consolidated-arguments.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const {
  CONSOLIDATED_ARGUMENT_INDEX,
  CONSOLIDATED_SPECS,
  handleToolsCall,
  PER_OPERATION_LISTING,
  TOOL_REGISTRY,
} = await import("./index.ts");

// ═══════════════════════════════════════════════════════════════════════════
// Pure wording
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a sibling's argument on a per-operation tool names the tool that takes it", () => {
  const [error] = withSiblingOperations(
    [{ path: "arguments.since", keyword: "additionalProperties", message: "is not allowed" }],
    "email_list",
    { since: ["email_search"] },
  );
  assertEquals(error.message, "is not an argument of email_list; email_search takes it");
  assertEquals(error.path, "arguments.since");
  assertEquals(error.keyword, "additionalProperties");
});

Deno.test("several sibling tools are all named", () => {
  const [error] = withSiblingOperations(
    [{ path: "arguments.include_html", keyword: "additionalProperties", message: "is not allowed" }],
    "email_list",
    { include_html: ["email_read", "email_read_batch"] },
  );
  assertEquals(
    error.message,
    "is not an argument of email_list; email_read and email_read_batch take it",
  );
});

Deno.test("an operation's own remedy leads, ahead of the sibling", () => {
  const [error] = withSiblingOperations(
    [{ path: "arguments.folder", keyword: "additionalProperties", message: "is not allowed" }],
    "email_search",
    { folder: ["email_list"] },
    remediesFor("email_search"),
  );
  assertEquals(
    error.message,
    "is not an argument of email_search; email_search names the folders it searches " +
      "in include_folders; email_list takes it",
  );
});

Deno.test("an 'action' on a per-operation tool says it takes none, and where that word lives", () => {
  const [bare] = withSiblingOperations(
    [{ path: "arguments.action", keyword: "additionalProperties", message: "is not allowed" }],
    "email_search",
    {},
  );
  assertEquals(bare.message, "is not an argument of email_search, which runs one operation and takes no 'action'");
  const [noted] = withSiblingOperations(
    [{ path: "arguments.action", keyword: "additionalProperties", message: "is not allowed" }],
    "email_search",
    {},
    {},
    "'list' is the email_list tool",
  );
  assertStringIncludes(noted.message, "; 'list' is the email_list tool");
});

Deno.test("an unknown argument nobody takes keeps the validator's wording", () => {
  const errors = [
    { path: "arguments.sort_by", keyword: "additionalProperties", message: "is not allowed" },
    { path: "arguments.limit", keyword: "maximum", message: "must be less than or equal to 100" },
  ];
  assertEquals(withSiblingOperations(errors, "email_list", { since: ["email_search"] }), errors);
});

Deno.test("a consolidated refusal puts the remedy before the owning actions", () => {
  const [error] = withOwningActions(
    [{ path: "arguments.to", keyword: "not", message: "is not an argument of the selected action" }],
    { ignorable: [], ignoredMisplaced: [], misplaced: [{ property: "to", owners: ["send", "forward"] }] },
    "reply",
    "arguments",
    remediesFor("email_reply"),
  );
  assertEquals(
    error.message,
    "is not an argument of action 'reply': a reply goes to the sender of message_id, " +
      "reply_all adds the original To and Cc, and cc and bcc add anyone else. " +
      "It belongs to actions 'send' or 'forward'",
  );
});

Deno.test("without a remedy the consolidated wording is unchanged", () => {
  const [error] = withOwningActions(
    [{ path: "arguments.since", keyword: "not", message: "x" }],
    { ignorable: [], ignoredMisplaced: [], misplaced: [{ property: "since", owners: ["search"] }] },
    "list",
  );
  assertEquals(error.message, "is not an argument of action 'list'; it belongs to action 'search'");
});

Deno.test("every remedy names only arguments its own operation takes", () => {
  // A remedy is read on both surfaces, so it may only point at arguments the
  // operation it is keyed under accepts. The words checked are the argument
  // names that appear in the sentences.
  const mentioned = ["message_id", "reply_all", "cc", "bcc", "attachments", "include_folders", "draft_id"];
  for (const [operation, remedies] of Object.entries(ARGUMENT_REMEDIES)) {
    const [toolName, spec] = Object.entries(CONSOLIDATED_SPECS)
      .flatMap(([tool, s]) => Object.entries(s.actions).map(([a, act]) => [tool, a, act.legacy] as const))
      .filter(([, , legacy]) => legacy === operation)
      .map(([tool, action]) => [tool, action] as const)[0];
    assert(toolName, `${operation} is not an operation of any consolidated tool`);
    const allowed = CONSOLIDATED_ARGUMENT_INDEX[toolName].allowedByAction[spec];
    for (const [property, sentence] of Object.entries(remedies)) {
      assert(!allowed.includes(property), `${operation} takes '${property}', so it is never refused`);
      for (const name of mentioned) {
        // draft_id is the returned draft's, named as the thing to update.
        if (name === "draft_id") continue;
        if (new RegExp(`\\b${name}\\b`).test(sentence)) {
          assert(allowed.includes(name), `${operation}'s remedy names '${name}', which it does not take`);
        }
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Aliases
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("ids is read_batch's message_ids", () => {
  const args: Record<string, unknown> = { action: "read_batch", ids: ["a", "b"] };
  assertEquals(normalizeArgumentAliases("email_read", args), [{ from: "ids", to: "message_ids" }]);
  assertEquals(args, { action: "read_batch", message_ids: ["a", "b"] });
});

Deno.test("an action restating a per-operation tool's operation is dropped; another word is kept", () => {
  const restated: Record<string, unknown> = { action: "Search", from: "x" };
  assert(dropRedundantAction("email_search", restated, ["search", "email_search"]));
  assertEquals(restated, { from: "x" });
  const other: Record<string, unknown> = { action: "list" };
  assert(!dropRedundantAction("email_search", other, ["search", "email_search"]));
  assertEquals(other, { action: "list" });
});

// ═══════════════════════════════════════════════════════════════════════════
// Descriptions
// ═══════════════════════════════════════════════════════════════════════════

function propertyDescription(tool: { inputSchema: Record<string, unknown> }, property: string): string {
  const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
  return properties[property]?.description ?? "";
}

Deno.test("the merged email_compose and draft schemas say which actions take to, subject and include_attachments", () => {
  const compose = TOOL_REGISTRY.find((tool) => tool.name === "email_compose")!;
  assertStringIncludes(propertyDescription(compose, "to"), "Send and forward only");
  assertStringIncludes(propertyDescription(compose, "subject"), "Send only");
  assertStringIncludes(propertyDescription(compose, "include_attachments"), "Forward only");
  const draft = TOOL_REGISTRY.find((tool) => tool.name === "draft")!;
  const draftSchema = (draft as { listedInputSchema?: Record<string, unknown> }).listedInputSchema ??
    draft.inputSchema;
  assertStringIncludes(propertyDescription({ inputSchema: draftSchema }, "to"), "Not for reply");
  assertStringIncludes(propertyDescription({ inputSchema: draftSchema }, "subject"), "Not for reply");
});

Deno.test("the notes stay on the merged copy and never reach a legacy schema", () => {
  for (const name of ["email_send", "email_forward", "draft_create", "draft_update"]) {
    const tool = PER_OPERATION_LISTING.find((listed) => listed.name === name)!;
    const schema = (tool as { listedInputSchema?: Record<string, unknown> }).listedInputSchema ??
      tool.inputSchema;
    for (const property of ["to", "subject", "include_attachments"]) {
      const text = propertyDescription({ inputSchema: schema }, property);
      assert(!/only:|Not for reply/.test(text), `${name}.${property} picked up a note: ${text}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// End to end
// ═══════════════════════════════════════════════════════════════════════════

const ALL_SCOPES = [
  "read:email",
  "send:email",
  "manage:folders",
  "delete:email",
  "manage:drafts",
  "schedule:email",
  "manage:automations",
  "manage:contacts",
];

function oauthToken(name: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    name,
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes: ALL_SCOPES,
    inbox_ids: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    last_used_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

interface CallResponse {
  error?: { code: number };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const response = await handleToolsCall(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    1,
    oauthToken("OAuth: ChatGPT"),
    { ipAddress: null, userAgent: null },
  ) as CallResponse;
  return response.result?.content?.[0]?.text ?? "";
}

Deno.test("a reply with a to says how a reply is addressed, on both surfaces", async () => {
  const consolidated = await call("email_compose", {
    action: "reply",
    message_id: "m1",
    body: "Thanks",
    to: ["someone@example.com"],
  });
  assertStringIncludes(consolidated, "arguments.to is not an argument of action 'reply': a reply goes to the sender of message_id");
  const perOperation = await call("email_reply", { message_id: "m1", body: "Thanks", to: ["someone@example.com"] });
  assertStringIncludes(perOperation, "arguments.to is not an argument of email_reply; a reply goes to the sender of message_id");
  assertStringIncludes(perOperation, "email_send and email_forward take it");
});

Deno.test("email_list refuses since and names email_search", async () => {
  const text = await call("email_list", { since: "2026-10-01", before: "2026-10-10" });
  assertStringIncludes(text, "arguments.since is not an argument of email_list; a search with only since or before needs no other criterion; email_search takes it.");
  assertStringIncludes(text, "arguments.before is not an argument of email_list; a search with only since or before needs no other criterion; email_search takes it.");
});

Deno.test("email_search with another operation's action says which tool runs it", async () => {
  const text = await call("email_search", { action: "list", from: "a@example.com" });
  assertStringIncludes(
    text,
    "arguments.action is not an argument of email_search, which runs one operation and takes no " +
      "'action'; 'list' is the email_list tool.",
  );
});

Deno.test("email_search with its own action is not refused for it", async () => {
  const text = await call("email_search", { action: "search" });
  // Past validation, the handler refuses the empty search instead.
  assert(!text.includes("Invalid arguments"), text);
  assertStringIncludes(text, "email_search was given no search criterion");
});

Deno.test("email_flag's flag_action is not mistaken for a redundant action", async () => {
  // flag_action travels as the legacy `action` by the time the redundant-action
  // check runs; a word that happened to match must not be dropped.
  const text = await call("email_flag", { message_ids: ["m1"] });
  assertStringIncludes(text, "flag_action");
});

Deno.test("read_batch accepts ids", async () => {
  const text = await call("email_read_batch", { ids: ["m1"] });
  assert(!text.includes("Invalid arguments"), text);
});

Deno.test("the empty-search refusal names what counts and where a plain listing lives", async () => {
  const text = await call("email_search", { include_folders: ["Sent"], flagged: false });
  assertStringIncludes(text, "include_folders, limit and offset only shape a search");
  assertStringIncludes(text, "that is the list operation, which takes folder and unread");
});
