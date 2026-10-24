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
  appOnlyReviewCardToolMeta,
  DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES,
  modelAndAppReviewCardToolMeta,
  PER_OPERATION_CARD_TOOL_NAMES,
  reviewCardToolMeta,
  serializeToolForList,
  withListingCardMeta,
} from "./mcp-app-resources.ts";
import {
  DEFERRED_BODY_SCHEMA_VERSION,
  DRAFT_BODY_META_KEY,
  DRAFT_CARD_NOTICE,
  type DraftEditorProviderInbox,
  type ProviderDraft,
  runBodylessDraftUpdate,
} from "./mcp-app-drafts.ts";
import { PER_OPERATION_REWORDINGS } from "./per-operation-wording.ts";
import { CLOSED_PRO_GATE, decideProFeatureAccess, hideProFeaturesFromListing } from "./pro-features.ts";

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

/**
 * The card's own tools, which a host drives and a model never calls.
 *
 * `draft_read` and `draft_editor_hide` left this pattern on 2026-10-13: both
 * are listed to the model now (`visibility: ["model", "app"]`), so everything
 * this file holds a model-callable tool to applies to them too, the wording
 * rule and the additive-only annotation rule included. `draft_editor_save` is
 * still the card's alone.
 */
const APP_ONLY = /^(approval_|bulk_|draft_editor_save$)/;

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
    { userAgent: null },
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
    // Pro tools are hidden until the features are visible (the gate's read
    // fails closed here), exactly as for every customer before launch.
    hideProFeaturesFromListing(toolsForListing(claude(["read:email"])), decideProFeatureAccess(CLOSED_PRO_GATE))
      .map((tool) => tool.name),
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
  // What a customer is shown before launch: the Pro tools hidden.
  const closed = decideProFeatureAccess(CLOSED_PRO_GATE);
  const bytes = JSON.stringify(hideProFeaturesFromListing(PER_OPERATION_LISTING, closed).map(serializeToolForList))
    .length;
  assert(bytes < 120_000, `the per-operation listing is ${bytes} bytes`);
  // With the Pro tools visible (reminders, 2026-10-24). Measure tokens again
  // before pro_features_public is switched on.
  const launched = JSON.stringify(PER_OPERATION_LISTING.map(serializeToolForList)).length;
  assert(launched < 126_000, `the launched per-operation listing is ${launched} bytes`);
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
    // Pro: stores one tracking row; a repeat returns the same row.
    "reminder_follow_up",
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
    /email_organize|email_compose|automation_read|action: |\(action |by action '|the (draft|folder|schedule|automation|signature|reminder) tool|Use action '/;
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
  // Over the WHOLE listing, the card's own tools included: one rewording is
  // for `draft_editor_save`, which no model calls and which still must not
  // describe itself against a tool this surface does not list.
  const listed = strings(PER_OPERATION_LISTING.map(serializeToolForList), "tools")
    .map(([, text]) => text);
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
  // The draft editor's own two model-callable tools carry the card as well,
  // with a visibility list; they are held by the test after this one.
  const claiming = withListingCardMeta(PER_OPERATION_LISTING, open, "per_operation")
    .filter((tool) => !APP_ONLY.test(tool.name))
    .filter((tool) => !DRAFT_EDITOR_MODEL_VISIBLE_TOOL_NAMES.includes(tool.name))
    .filter((tool) => tool._meta !== undefined);
  for (const tool of claiming) {
    assertEquals(tool._meta, { ...fileParamsMeta(tool.name), ...reviewCardToolMeta() }, tool.name);
  }
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
    // The draft writes still say which argument takes a ChatGPT file.
    assertEquals(tool._meta, FILE_PARAM_TOOL_NAMES.includes(tool.name) ? fileParamsMeta(tool.name) : undefined, tool.name);
  }
});

Deno.test("every card-claiming operation is one the listing actually has", () => {
  const listed = new Set(PER_OPERATION_LISTING.map((tool) => tool.name));
  for (const name of Object.values(PER_OPERATION_CARD_TOOL_NAMES).flat()) {
    assert(listed.has(name), `${name} is not on the per-operation listing`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The draft editor on this surface (2026-10-13, merged with the audit of
//    the model-facing text around the draft card)
//
// The two changes landed the same day and met here. The audit made `draft_read`
// and `draft_editor_hide` the model's to call, made `update` accept a call with
// no body, and moved the draft body out of `structuredContent`; this surface
// lists the draft writes as five tools of their own and words them from the
// legacy definitions. So each of the audit's fixes has to hold under the
// per-operation names as well, and nothing here may name a tool only the
// consolidated listing has.
// ═══════════════════════════════════════════════════════════════════════════

/** The draft writes that take ChatGPT files (draft-attachments.ts). */
const FILE_PARAM_TOOL_NAMES = ["draft_create", "draft_reply", "draft_update"];
function fileParamsMeta(name: string): Record<string, unknown> {
  return FILE_PARAM_TOOL_NAMES.includes(name) ? { "openai/fileParams": ["files"] } : {};
}

const listedByName = () =>
  new Map(PER_OPERATION_LISTING.map((tool) => [tool.name, serializeToolForList(tool)]));

Deno.test("the draft editor's own tools get the same visibility on this surface as on the other", () => {
  const open = { outbound: false, bulk: false, drafts: true };
  const perOperation = new Map(
    withListingCardMeta(PER_OPERATION_LISTING, open, "per_operation").map((t) => [t.name, t._meta]),
  );
  const consolidated = new Map(
    withListingCardMeta(TOOL_REGISTRY, open, "consolidated").map((t) => [t.name, t._meta]),
  );
  // The model reads a draft back and hides or shows the card; only the card saves.
  // `draft_read` mounts no card on either surface (2026-10-17).
  assertEquals(perOperation.get("draft_read"), { ui: { visibility: ["model", "app"] } });
  assertEquals(perOperation.get("draft_editor_hide"), modelAndAppReviewCardToolMeta());
  assertEquals(perOperation.get("draft_editor_save"), appOnlyReviewCardToolMeta());
  for (const name of ["draft_read", "draft_editor_save", "draft_editor_hide"]) {
    assertEquals(perOperation.get(name), consolidated.get(name), `${name} differs by surface`);
  }
  // Gate shut: no `_meta` at all, so a host lists all three as ordinary tools.
  const shut = { outbound: true, bulk: true, drafts: false };
  for (const tool of withListingCardMeta(PER_OPERATION_LISTING, shut, "per_operation")) {
    if (tool.name.startsWith("draft_")) {
      assertEquals(tool._meta, FILE_PARAM_TOOL_NAMES.includes(tool.name) ? fileParamsMeta(tool.name) : undefined, tool.name);
    }
  }
});

Deno.test("draft_update is listed with body optional, and says what an update without one does", () => {
  const update = listedByName().get("draft_update")!;
  const schema = update.inputSchema as {
    required: string[];
    properties: Record<string, { type?: string; description?: string }>;
  };
  assertEquals(schema.required, ["draft_id"]);
  assertEquals(schema.properties.body.type, "string", "the type did not move, only `required`");
  assertEquals(
    schema.properties.body.description,
    "Updated plain-text body, your text only: a reply's quoted original " +
      "is kept and the signature added by the server. Omit to keep the stored body text.",
  );
  const description = update.description as string;
  assert(
    description.startsWith(
      "Change an existing draft. Each supplied field overwrites the stored one; an omitted " +
        "field, body included, keeps its stored value. Pass at least one of to, cc, bcc, " +
        "subject, body or attachments. Omit body to change a subject or recipients without overwriting " +
        "text the user edited; draft_read returns the current text. The signature is " +
        "embedded only when body is passed. attachments ADDS files; the draft's existing " +
        "attachments are kept. Without body, on IMAP and Gmail a draft with inline images " +
        "or other extra parts is refused and left unchanged. ",
    ),
    description,
  );
  assert(!/exactly/.test(description), "no description promises an exact copy");
  // It overwrites stored fields with or without a body, so the additive-only
  // rule keeps it destructive in both forms.
  assertEquals((update.annotations as Record<string, unknown>).destructiveHint, true);
});

Deno.test("a body-less draft_update passes validation under the per-operation name and is refused only when empty", async () => {
  // Stopped by the handler's own empty-patch check, which runs after
  // validation and before the inbox is resolved: proof the schema let a call
  // with no body through.
  const empty = await call(chatGpt(), "draft_update", { draft_id: "Drafts:2" });
  assertEquals(empty.result?.isError, true);
  assertEquals(
    refusalText(empty),
    "draft_update: none of to, cc, bcc, subject, body or attachments was given, so there is nothing to " +
      "change. An omitted field is kept as stored.",
  );
  const htmlOnly = await call(chatGpt(), "draft_update", { draft_id: "Drafts:2", html_body: "<p>x</p>" });
  assert(refusalText(htmlOnly).startsWith("draft_update: html_body was given without body."), refusalText(htmlOnly));
  // And the scope gate is the action's: manage:drafts, not send:email.
  const denied = await call(chatGpt(["read:email"]), "draft_update", { draft_id: "d", subject: "s" });
  assertEquals(denied.error?.code, -32004);
  assertEquals(denied.error?.data?.required_scopes, ["manage:drafts"]);
});

Deno.test("the draft tools point at tools this surface lists, and say a card may hold newer text", () => {
  const tools = listedByName();
  const names = new Set(tools.keys());
  const consolidatedNames = new Set(TOOL_REGISTRY.map((tool: { name: string }) => tool.name));
  const create = tools.get("draft_create")!.description as string;
  // When to use it, against the tool that sends now ON THIS SURFACE.
  assert(
    create.includes(
      "Use this when the user wants to review or edit a message before it goes out; email_send sends now.",
    ),
    create,
  );
  assert(
    create.includes(
      "Where the draft editor card is on, hosts that render MCP Apps cards show the draft to the " +
        "user in an editable card, where the user can change it; draft_read returns a draft's current text.",
    ),
    create,
  );
  const list = tools.get("draft_list")!.description as string;
  assert(list.includes("and no body: draft_read returns one draft's text."), list);
  assert(list.includes("with draft_read, draft_update, draft_send or draft_delete"), list);
  const save = tools.get("draft_editor_save")!.description as string;
  assert(save.includes("unlike draft_update when it is given a body"), save);

  // No draft-related description names a tool only the consolidated listing
  // has. `email_compose` and `the draft tool` are what the same sentences say
  // there; section 4 holds the model-callable tools to this and this adds the
  // one that is app-only.
  for (const name of [...names].filter((n) => n.startsWith("draft_"))) {
    for (const [path, text] of strings(tools.get(name), name)) {
      assert(!/email_compose|the draft tool|draft tool's|\(action /.test(text), `${path}: ${text}`);
      // Any token that IS a tool name on the consolidated listing has to be
      // one on this listing too. Field names and card kinds are not tools on
      // either, so they are never mistaken for one.
      for (const match of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
        if (!consolidatedNames.has(match[0])) continue;
        assert(names.has(match[0]), `${path} names ${match[0]}, which this surface does not list`);
      }
    }
  }
  // The second content block a draft write carries is not per-surface text,
  // so the one tool it names has to exist on both.
  assert(DRAFT_CARD_NOTICE.includes("draft_read") && names.has("draft_read"));
  assert(TOOL_REGISTRY.some((tool: { name: string }) => tool.name === "draft_read"));
});

Deno.test("draft_read and draft_editor_hide follow the annotation rules every model-callable tool here does", () => {
  const tools = listedByName();
  const read = tools.get("draft_read")!.annotations as Record<string, unknown>;
  assertEquals(read.readOnlyHint, true);
  assertEquals(read.destructiveHint, false);
  // An overwrite of a stored setting, and model-callable: destructive under
  // the additive-only rule, like signature_set. Being reversible by the same
  // call is not an argument for false.
  const hide = tools.get("draft_editor_hide")!.annotations as Record<string, unknown>;
  assertEquals(hide.readOnlyHint, false);
  assertEquals(hide.destructiveHint, true);
  // Still app-only, and deliberately left false: see the open question on it
  // in docs/openai-tool-annotation-justifications.md.
  const save = tools.get("draft_editor_save")!.annotations as Record<string, unknown>;
  assertEquals(save.destructiveHint, false);
});

Deno.test("the per-operation instructions keep the audit's two corrections", () => {
  assert(PER_OPERATION_SERVER_INSTRUCTIONS.includes("`draft_read` reads one draft in full."));
  const appOnly = PER_OPERATION_SERVER_INSTRUCTIONS.split("\n\n").find((p: string) =>
    p.startsWith("APP-ONLY:")
  );
  assertEquals(
    appOnly,
    "APP-ONLY: `approval_*` (a held send), `bulk_*` (a bulk plan) and " +
      "`draft_editor_save` back the in-chat cards. The host drives them, not " +
      "you.",
  );
  assert(!PER_OPERATION_SERVER_INSTRUCTIONS.includes("draft_editor_hide"));
});

Deno.test("a draft write's result is the same on this surface: deferred body, v2, card notice, read:email", async () => {
  // `draft_update` here and `draft{action:"update"}` there are one handler, so
  // the result shape cannot differ; what CAN be driven without a mailbox is
  // the function that handler returns through for a body-less update, with the
  // scopes a per-operation key would hold.
  const inbox: DraftEditorProviderInbox = {
    id: "8f1f2a3c-0000-4000-8000-000000000001",
    email_address: "you@example.com",
    display_name: "Asgeir",
    provider: "gmail",
    service: null,
  };
  const stored: ProviderDraft = {
    subject: "Plan",
    to: ["a@example.com"],
    cc: [],
    bcc: [],
    bodyText: "STORED-BODY",
    bodyHtml: null,
    attachments: [],
  };
  const deps = {
    appUrl: "https://mcpemails.com",
    workspaceGate: () => Promise.resolve({ rolledOut: true, hidden: false }),
    inboxHidden: () => Promise.resolve(false),
    getDraft: () => Promise.resolve(stored),
    updateDraft: (_inbox: unknown, draftId: string) => Promise.resolve({ draft_id: draftId }),
  };
  const withRead = await runBodylessDraftUpdate(
    deps,
    { workspace_id: "w", scopes: ["manage:drafts", "read:email"] },
    inbox,
    "r-1",
    { subject: "New" },
  );
  assert(withRead.ok);
  if (withRead.ok) {
    const sc = withRead.result.structuredContent as Record<string, any>;
    assertEquals(sc.schema_version, DEFERRED_BODY_SCHEMA_VERSION);
    assertEquals(sc.draft.body, { text: null, html: null, truncated: false, deferred: true });
    assertEquals((withRead.result._meta as Record<string, any>)[DRAFT_BODY_META_KEY].text, "STORED-BODY");
    assertEquals(withRead.result.content.map((block) => block.text)[1], DRAFT_CARD_NOTICE);
  }
  const withoutRead = await runBodylessDraftUpdate(
    deps,
    { workspace_id: "w", scopes: ["manage:drafts"] },
    inbox,
    "r-1",
    { subject: "New" },
  );
  assert(withoutRead.ok);
  if (withoutRead.ok) {
    assert(!JSON.stringify(withoutRead.result).includes("STORED-BODY"));
    assertEquals("_meta" in withoutRead.result, false);
    assertEquals(withoutRead.result.content.length, 1);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Files on a draft (2026-10-15, draft-attachments.ts)
//
// `attachments` is listed on both surfaces. `files` (ChatGPT uploads) is listed
// only here, with `_meta["openai/fileParams"]` naming it, and in the exact
// shape OpenAI's scan accepts; the consolidated `draft` validates it but does
// not list it.
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("the per-operation draft writes list attachments and files, and name files as a file param", () => {
  const listed = listedByName();
  for (const name of FILE_PARAM_TOOL_NAMES) {
    const tool = listed.get(name)!;
    const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    assert("attachments" in props, `${name} lists attachments`);
    assertEquals(props.files.type, "array", name);
    assertEquals(props.files.items, {
      type: "object",
      properties: {
        download_url: { type: "string", description: "Temporary download URL ChatGPT provides." },
        file_id: { type: "string", description: "ChatGPT file id." },
        mime_type: { type: "string", description: "MIME type, when known." },
        file_name: { type: "string", description: "Filename the recipient sees." },
      },
      required: ["download_url", "file_id"],
      additionalProperties: false,
    }, name);
    assertEquals(tool._meta, { "openai/fileParams": ["files"] }, name);
  }
  // Nothing else on this surface claims a file param.
  for (const tool of PER_OPERATION_LISTING) {
    if (FILE_PARAM_TOOL_NAMES.includes(tool.name)) continue;
    assert(!("openai/fileParams" in (tool._meta ?? {})), tool.name);
  }
});

Deno.test("the consolidated draft tool lists attachments but not files, and still accepts files", () => {
  const draft = TOOL_REGISTRY.find((tool) => tool.name === "draft")!;
  const listed = serializeToolForList(draft).inputSchema as { properties: Record<string, unknown> };
  assert("attachments" in listed.properties);
  assert(!("files" in listed.properties), "files is not shown to non-OpenAI clients");
  // Validation is the full schema: a call carrying it reaches the handler,
  // which refuses it for a non-OpenAI key in its own words.
  const full = draft.inputSchema as { properties: Record<string, unknown> };
  assert("files" in full.properties);
  // No other consolidated tool lists it either.
  for (const tool of TOOL_REGISTRY) {
    const props = (serializeToolForList(tool).inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert(!("files" in props), tool.name);
  }
});
