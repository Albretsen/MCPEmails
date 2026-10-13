// ---------------------------------------------------------------------------
// The per-operation surface: what an OpenAI client is listed, and what every
// client may now call.
//
// WHY IT EXISTS. OpenAI's plugin scan of 2026-10-13 flagged all nine
// consolidated tools ("This tool appears to execute operations that are not
// individually exposed"), the read-only ones included. Their guideline forbids
// "operation selection ... with a generic executor", which is what an `action`
// argument is. So a ChatGPT or Codex key is listed the legacy per-operation
// tools instead, and every other client keeps the consolidated listing.
//
// WHAT THIS FILE HOLDS, in the order a regression would hurt:
//
//   1. the listing an OpenAI key gets, by name, and that nobody else gets it;
//   2. that nothing on it selects an operation through an argument;
//   3. the annotations, against the "only additive writes are false" rule the
//      same scan applied to `signature_set`;
//   4. that its prose never points at a tool or a selector it does not have;
//   5. that a call under either spelling passes the same scope gate, and that
//      the two names shared with a consolidated tool resolve correctly;
//   6. that the review card is claimed only by operations that can fill it.
//
// tool-surface.test.ts still pins the consolidated listing byte for byte; this
// file never re-states it.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  PER_OPERATION_CARD_TOOL_NAMES,
  reviewCardToolMeta,
  serializeToolForList,
  withListingCardMeta,
} from "./mcp-app-resources.ts";
import { PER_OPERATION_REWORDINGS } from "./per-operation-wording.ts";

// See the note in tool-surface.test.ts: the environment is arranged before the
// dynamic import because index.ts reads it at module load.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const {
  CONSOLIDATED_SPECS,
  handleToolsCall,
  handleToolsList,
  PER_OPERATION_LISTING,
  PER_OPERATION_ONLY_TOOLS,
  PER_OPERATION_SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_MAX_BYTES,
  TOOL_REGISTRY,
  toolsForListing,
} = await import("./index.ts");

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

/** An OAuth token as `POST /api/oauth/token` writes it; see tools-list-visibility.test.ts. */
function oauthToken(scopes: string[], name: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    name,
    key_prefix: "mcpe_abc",
    key_hash: "",
    scopes,
    inbox_ids: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    last_used_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

const chatGpt = (scopes: string[] = ALL_SCOPES) => oauthToken(scopes, "OAuth: ChatGPT");
const claude = (scopes: string[] = ALL_SCOPES) => oauthToken(scopes, "OAuth: Claude");

/** The card's own tools, which a host drives and a model never calls. */
const APP_ONLY = /^(approval_|bulk_|draft_read$|draft_editor_)/;

/** The per-operation tools a model can call, as they go out on the wire. */
function listedMailTools(): Array<Record<string, unknown>> {
  return PER_OPERATION_LISTING
    .filter((tool) => !APP_ONLY.test(tool.name))
    .map(serializeToolForList);
}

interface CallResponse {
  error?: { code: number; data?: Record<string, unknown> };
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
}

async function call(
  key: Parameters<typeof handleToolsCall>[2],
  name: string,
  args: Record<string, unknown>,
): Promise<CallResponse> {
  return await handleToolsCall(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    1,
    key,
    { ipAddress: null, userAgent: null },
  ) as CallResponse;
}

const refusalText = (response: CallResponse) => response.result?.content?.[0]?.text ?? "";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Who is listed what
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("an OpenAI key is listed exactly one tool per operation", async () => {
  const listed = await handleToolsList(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    1,
    chatGpt(["read:email"]),
  );
  assertEquals(
    (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    [
      "inbox_list",
      "email_list",
      "email_read",
      "email_read_batch",
      "email_search",
      "email_attachment",
      "email_extract",
      "email_original",
      "email_move",
      "email_move_batch",
      "email_copy",
      "email_copy_batch",
      "email_flag",
      "email_archive",
      "email_search_and_move",
      "email_delete",
      "email_delete_batch",
      "email_search_and_delete",
      "email_send",
      "email_reply",
      "email_forward",
      "folder_list",
      "folder_create",
      "folder_rename",
      "folder_delete",
      "draft_list",
      "draft_create",
      "draft_reply",
      "draft_update",
      "draft_send",
      "draft_delete",
      "schedule_list",
      "schedule_create",
      "schedule_cancel",
      "signature_get",
      "signature_set",
      "automation_list",
      "automation_get",
      "automation_runs",
      "automation_preview",
      // No automation_create, automation_update or automation_enable: the
      // rescan flagged all three. See PER_OPERATION_UNLISTED.
      "automation_disable",
      "automation_delete",
      "contact_search",
      // The card's own tools, unchanged.
      "approval_review",
      "approval_decide",
      "approval_update",
      "approval_schedule",
      "bulk_execute",
      "bulk_cancel",
      "draft_read",
      "draft_editor_save",
      "draft_editor_hide",
    ],
  );
});

Deno.test("every OpenAI key name the token route writes gets that listing", async () => {
  // The names observed in production, the portal scanner's among them
  // (`OAuth: chatgpt.com`, 2026-10-13).
  for (const name of ["OAuth: ChatGPT", "OAuth: chatgpt.com", "OAuth: chatgpt.com (4)", "OAuth: Codex"]) {
    const listed = await handleToolsList(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      1,
      oauthToken(["read:email"], name),
    );
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    assert(tools.some((tool) => tool.name === "email_send"), `${name} is listed email_send`);
    assert(!tools.some((tool) => tool.name === "email_compose"), `${name} is not listed email_compose`);
  }
});

Deno.test("no other client is listed a per-operation tool", async () => {
  const listed = await handleToolsList(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    1,
    claude(["read:email"]),
  );
  assertEquals(
    (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    toolsForListing(claude(["read:email"])).map((tool) => tool.name),
  );
  const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  for (const name of PER_OPERATION_ONLY_TOOLS.keys()) {
    assert(!names.includes(name), `${name} reached a client that is not OpenAI's`);
  }
});

Deno.test("a scope-filtered key on the per-operation listing sees only what it may call", () => {
  // A dashboard key (no expiry) stays scope-filtered on either listing.
  const readOnlyKey = { ...chatGpt(["read:email"]), name: "Codex key", expires_at: null };
  const names = toolsForListing(readOnlyKey, true).map((tool) => tool.name);
  assert(names.includes("email_list") && names.includes("email_search"));
  for (const write of ["email_send", "email_move", "email_delete", "draft_create", "signature_set"]) {
    assert(!names.includes(write), `${write} is listed to a read-only key`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Nothing selects an operation through an argument
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("no per-operation tool takes an `action` argument or conditional rules", () => {
  for (const tool of listedMailTools()) {
    const schema = tool.inputSchema as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    assert(!("action" in properties), `${tool.name} still lists an \`action\` argument`);
    assert(!("allOf" in schema), `${tool.name} lists per-action rules`);
    for (const required of (schema.required ?? []) as string[]) {
      assert(required in properties, `${tool.name} requires ${required}, which it does not list`);
    }
  }
});

Deno.test("the two arguments that were called `action` are listed under their consolidated names", () => {
  const byName = new Map(listedMailTools().map((tool) => [tool.name as string, tool]));
  const properties = (name: string) =>
    (byName.get(name)!.inputSchema as { properties: Record<string, unknown> }).properties;
  assertEquals(
    (properties("email_flag").flag_action as { enum: string[] }).enum,
    ["read", "unread", "flag", "unflag"],
  );
});

Deno.test("every per-operation tool is a complete descriptor", () => {
  for (const tool of listedMailTools()) {
    const annotations = tool.annotations as Record<string, unknown>;
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assertEquals(typeof annotations?.[hint], "boolean", `${tool.name}.${hint} is not explicit`);
    }
    assert((tool.description as string).length > 0, `${tool.name} has no description`);
    assert(Array.isArray(tool.securitySchemes), `${tool.name} declares no securitySchemes`);
    // Loose on purpose: see the note on outputSchema in buildPerOperationTool.
    const output = tool.outputSchema as Record<string, unknown>;
    assertEquals(output.type, "object", `${tool.name} declares no outputSchema`);
    assertEquals(output.additionalProperties, true, `${tool.name}'s outputSchema can reject a result`);
    assert(!("required" in output), `${tool.name}'s outputSchema can reject a result`);
  }
});

Deno.test("the listing stays inside its size budget", () => {
  // 21,770 model-visible tokens on 2026-10-13 (o200k_base), against 14,950 for
  // the consolidated listing. Bytes are what a test can count without a
  // tokenizer; the budget is the measured 114 KB plus room for a few edits.
  // Legacy output schemas put back on this surface would be 163 KB.
  const bytes = JSON.stringify(PER_OPERATION_LISTING.map(serializeToolForList)).length;
  assert(bytes < 120_000, `the per-operation listing is ${bytes} bytes`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Annotations
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("destructiveHint is false only on writes that purely add", () => {
  // OpenAI's rule, as applied to signature_set on 2026-10-13: false is for
  // additive writes, an overwrite is destructive, and being able to undo an
  // action does not justify false. Stated literally so that a new write has to
  // be argued onto this list rather than defaulting onto it.
  const additive = [
    "email_copy",
    "email_copy_batch",
    "folder_create",
    "draft_create",
    "draft_reply",
  ];
  const nonDestructiveWrites = listedMailTools()
    .filter((tool) => (tool.annotations as Record<string, unknown>).readOnlyHint === false)
    .filter((tool) => (tool.annotations as Record<string, unknown>).destructiveHint === false)
    .map((tool) => tool.name as string);
  assertEquals(nonDestructiveWrites.sort(), [...additive].sort());
});

Deno.test("a read-only per-operation tool is never destructive or open-world", () => {
  for (const tool of listedMailTools()) {
    const annotations = tool.annotations as Record<string, unknown>;
    if (annotations.readOnlyHint !== true) continue;
    assertEquals(annotations.destructiveHint, false, `${tool.name}`);
    assertEquals(annotations.openWorldHint, false, `${tool.name}`);
  }
});

Deno.test("signature_set is destructive on both listings", () => {
  for (const listing of [TOOL_REGISTRY, PER_OPERATION_LISTING]) {
    const tool = listing.find((candidate) => candidate.name === "signature_set")!;
    assertEquals(tool.annotations?.destructiveHint, true);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Wording
// ═══════════════════════════════════════════════════════════════════════════

/** Every string in a value, with the path it sits at. */
function strings(value: unknown, path: string, out: Array<[string, string]> = []) {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((entry, index) => strings(entry, `${path}[${index}]`, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) strings(entry, `${path}.${key}`, out);
  }
  return out;
}

Deno.test("no listed text points at a consolidated tool or an action selector", () => {
  // Names that exist only on the consolidated listing, and the ways the legacy
  // prose refers to choosing an action on one.
  const stale =
    /email_organize|email_compose|automation_read|action: |\(action |by action '|the (draft|folder|schedule|automation|signature) tool|Use action '/;
  const found: string[] = [];
  for (const tool of listedMailTools()) {
    for (const [path, text] of strings(tool, tool.name as string)) {
      const match = stale.exec(text);
      if (match) found.push(`${path}: "...${text.slice(Math.max(0, match.index - 40), match.index + 60)}..."`);
    }
  }
  assertEquals(found, [], "add a rewording to per-operation-wording.ts");
});

Deno.test("every rewording still matches the text it was written for", () => {
  // A phrase reworded at its source would otherwise leave a dead entry here
  // and the old sentence back on the wire under a slightly different spelling.
  const listed = strings(listedMailTools(), "tools").map(([, text]) => text);
  for (const [from, to] of PER_OPERATION_REWORDINGS) {
    assert(listed.some((text) => text.includes(to)), `nothing listed carries: "${to}"`);
    assert(!listed.some((text) => text.includes(from)), `still listed: "${from}"`);
  }
});

Deno.test("the per-operation instructions name only tools on that listing, within budget", () => {
  const bytes = new TextEncoder().encode(PER_OPERATION_SERVER_INSTRUCTIONS).length;
  assert(bytes <= SERVER_INSTRUCTIONS_MAX_BYTES, `${bytes} bytes`);
  assert(!PER_OPERATION_SERVER_INSTRUCTIONS.includes("READ/WRITE PAIRS"));
  assert(PER_OPERATION_SERVER_INSTRUCTIONS.includes("ONE TOOL PER OPERATION"));
  const listed = new Set(PER_OPERATION_LISTING.map((tool) => tool.name));
  const toolLike = /`((?:inbox|email|folder|draft|schedule|signature|automation|contact)_[a-z_]+)`/g;
  for (const match of PER_OPERATION_SERVER_INSTRUCTIONS.matchAll(toolLike)) {
    if (match[1] === "inbox_id") continue; // an argument, not a tool
    assert(listed.has(match[1]), `the instructions name ${match[1]}, which is not listed`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Calls
//
// These drive the real handleToolsCall and stop at the scope gate or at
// argument validation, both of which run before any mailbox or database I/O.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("a per-operation tool passes the scope gate of the action it is", () => {
  for (const [toolName, spec] of Object.entries(CONSOLIDATED_SPECS)) {
    for (const action of Object.values(spec.actions)) {
      // The unlisted three are still callable, so their gate is checked too.
      const tool = PER_OPERATION_LISTING.find((candidate) => candidate.name === action.legacy) ??
        PER_OPERATION_ONLY_TOOLS.get(action.legacy);
      assert(tool, `${toolName}'s ${action.legacy} is not a per-operation tool`);
      assertEquals(tool!.requiredScope, action.scope, `${action.legacy} requiredScope`);
      assertEquals(tool!.altScopes ?? [], action.altScopes ?? [], `${action.legacy} altScopes`);
    }
  }
});

Deno.test("draft_send needs send:email, exactly as draft{action:'send'} does", async () => {
  // The scope-confusion bypass the note on `draft`'s send action exists to
  // keep shut must not reopen under the per-operation name.
  const response = await call(chatGpt(["manage:drafts"]), "draft_send", { draft_id: "d" });
  assertEquals(response.error?.code, -32004);
  assertEquals(response.error?.data?.required_scopes, ["send:email"]);
});

Deno.test("a per-operation name is callable by any client, not only OpenAI's", async () => {
  // Refused for scope, which is proof it resolved: it used to be "Unknown tool".
  const response = await call(claude(["read:email"]), "email_send", {
    to: ["a@example.com"],
    subject: "s",
    body: "b",
  });
  assertEquals(response.error?.code, -32004);
  assertEquals(response.error?.data?.required_scopes, ["send:email"]);
});

Deno.test("an OpenAI key can still call the consolidated names it has cached", async () => {
  const response = await call(chatGpt(["read:email"]), "email_compose", {
    action: "send",
    to: ["a@example.com"],
    subject: "s",
    body: "b",
  });
  assertEquals(response.error?.code, -32004);
  assertEquals(response.error?.data?.required_scopes, ["send:email"]);
});

Deno.test("email_flag takes flag_action, and says so when it is wrong", async () => {
  const invalid = await call(chatGpt(), "email_flag", { message_ids: ["a"], flag_action: "bogus" });
  assertEquals(invalid.result?.isError, true);
  assert(refusalText(invalid).includes("arguments.flag_action must be one of"), refusalText(invalid));

  // A valid flag_action is accepted: the only complaint left is the missing ids.
  const missingIds = await call(chatGpt(), "email_flag", { flag_action: "read" });
  assert(refusalText(missingIds).includes("arguments.message_ids is required"), refusalText(missingIds));
  assert(!refusalText(missingIds).includes("flag_action"), refusalText(missingIds));

  // The legacy spelling still validates, for a caller that knows the handler.
  const legacySpelling = await call(chatGpt(), "email_flag", { action: "read" });
  assert(!refusalText(legacySpelling).includes("action is"), refusalText(legacySpelling));
});

Deno.test("the automation writes the scan flagged are unlisted, and still callable", async () => {
  const listed = listedMailTools();
  for (const name of ["automation_create", "automation_update", "automation_enable"]) {
    assert(!listed.some((tool) => tool.name === name), `${name} is listed to OpenAI clients`);
    for (const [path, text] of strings(listed, "tools")) {
      assert(!text.includes(name), `${path} points at ${name}, which is not listed`);
    }
    // Refused for scope rather than as an unknown tool.
    const response = await call(chatGpt(["read:email"]), name, { automation_id: "a" });
    assertEquals(response.error?.code, -32004, name);
  }
});

Deno.test("automation_create reports rule_action, not the legacy name", async () => {
  const response = await call(chatGpt(), "automation_create", { name: "x" });
  assert(refusalText(response).includes("arguments.rule_action is required"), refusalText(response));
});

Deno.test("email_delete with no action is the single delete for an OpenAI key only", async () => {
  // Resolved to 'delete', so the refusal is the scope gate's.
  const openAi = await call(chatGpt(["read:email"]), "email_delete", { message_id: "m" });
  assertEquals(openAi.error?.code, -32004);
  assertEquals(openAi.error?.data?.required_scopes, ["delete:email"]);

  // Everyone else was listed a tool with a required `action`, and a write is
  // never guessed for them: see the note on inferMissingAction.
  const other = await call(claude(), "email_delete", { message_id: "m" });
  assertEquals(other.result?.isError, true);
  assert(refusalText(other).includes("requires an 'action' argument"), refusalText(other));
});

Deno.test("email_read with no action and a message_id is the single read", async () => {
  // Stopped at validation by a message_id of the wrong type, which is enough
  // to show what the call resolved to: the complaint is about message_id, not
  // about a missing selector.
  const response = await call(chatGpt(), "email_read", { message_id: {} });
  assertEquals(response.result?.isError, true);
  assert(refusalText(response).includes("arguments.message_id"), refusalText(response));
  assert(!refusalText(response).includes("requires an 'action'"), refusalText(response));
});

Deno.test("a per-operation tool refuses an argument it does not list", async () => {
  const response = await call(chatGpt(), "email_list", { bogus: 1 });
  assert(refusalText(response).includes("arguments.bogus is not allowed"), refusalText(response));
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The review card
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("with every gate open, only operations that can fill the card claim it", () => {
  const open = { outbound: true, bulk: true, drafts: true };
  const claiming = withListingCardMeta(PER_OPERATION_LISTING, open, "per_operation")
    .filter((tool) => !APP_ONLY.test(tool.name))
    .filter((tool) => tool._meta !== undefined);
  for (const tool of claiming) assertEquals(tool._meta, reviewCardToolMeta(), tool.name);
  assertEquals(
    claiming.map((tool) => tool.name).sort(),
    Object.values(PER_OPERATION_CARD_TOOL_NAMES).flat().sort(),
  );
  // The name shared with the consolidated bulk tool is the single delete here.
  assert(!claiming.some((tool) => tool.name === "email_delete"));
});

Deno.test("with every gate shut, no per-operation mail tool carries card metadata", () => {
  const shut = { outbound: false, bulk: false, drafts: false };
  for (const tool of withListingCardMeta(PER_OPERATION_LISTING, shut, "per_operation")) {
    if (APP_ONLY.test(tool.name)) continue;
    assertEquals(tool._meta, undefined, tool.name);
  }
});

Deno.test("every card-claiming operation is one the listing actually has", () => {
  const listed = new Set(PER_OPERATION_LISTING.map((tool) => tool.name));
  for (const name of Object.values(PER_OPERATION_CARD_TOOL_NAMES).flat()) {
    assert(listed.has(name), `${name} is not on the per-operation listing`);
  }
});
