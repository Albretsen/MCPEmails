// Pro reminders on the tool surface: hidden from everyone until the Pro
// features are visible, refused when visible but not on Pro, and the
// follow_up_days hook refuses before anything is sent.
//
// MCP_INTROSPECTION_ONLY makes the gate read fail closed (CLOSED_PRO_GATE),
// which is exactly the pre-launch state every customer is in.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { serializeToolForList } from "./mcp-app-resources.ts";
import {
  CLOSED_PRO_GATE,
  decideProFeatureAccess,
  hideProFeaturesFromListing,
  PRO_FEATURE_ARGS,
  PRO_FEATURE_ERROR_CODE,
  PRO_FEATURE_META_KEY,
  PRO_FEATURE_TOOLS,
} from "./pro-features.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const {
  CONSOLIDATED_SPECS,
  dispatchExecutor,
  handlePromptsGet,
  handleToolsCall,
  handleToolsList,
  PER_OPERATION_LISTING,
  PER_OPERATION_ONLY_TOOLS,
  renderWorkflowPrompt,
  TOOL_REGISTRY,
  toolsForListing,
  WORKFLOW_PROMPTS,
} = await import("./index.ts");

const ALL_SCOPES = [
  "read:email",
  "send:email",
  "delete:email",
  "manage:folders",
  "manage:drafts",
  "manage:contacts",
  "schedule:email",
  "manage:automations",
];

function oauthKey(scopes: string[] = ALL_SCOPES, name = "OAuth: Claude") {
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

const REMINDER_TOOLS = [
  "reminder",
  "reminder_list",
  "reminder_follow_up",
  "reminder_snooze",
  "reminder_done",
  "reminder_cancel",
];
const CLOSED = decideProFeatureAccess(CLOSED_PRO_GATE);
const VISIBLE = decideProFeatureAccess({ plan: "free", rolloutEnabled: true, publicLaunch: false });

function properties(tool: { inputSchema: Record<string, unknown>; listedInputSchema?: Record<string, unknown> }) {
  const schema = (serializeToolForList(tool as never) as { inputSchema: { properties?: Record<string, unknown> } })
    .inputSchema;
  return Object.keys(schema.properties ?? {});
}

Deno.test("every reminder tool name the server answers to is gated", () => {
  for (const name of REMINDER_TOOLS) assertEquals(PRO_FEATURE_TOOLS[name], "reminders", name);
  const known = new Set([...TOOL_REGISTRY.map((t) => t.name), ...PER_OPERATION_ONLY_TOOLS.keys()]);
  for (const name of REMINDER_TOOLS) assert(known.has(name), `${name} is not registered`);
  // and nothing reminder-shaped escaped the registry entry
  for (const name of known) {
    if (name.startsWith("reminder")) assert(REMINDER_TOOLS.includes(name), `${name} is not in PRO_FEATURE_TOOLS`);
  }
  assertEquals(
    Object.values(CONSOLIDATED_SPECS.reminder.actions).map((a) => a.legacy).sort(),
    REMINDER_TOOLS.filter((n) => n !== "reminder").sort(),
  );
});

Deno.test("hidden before launch: no reminder tool and no follow_up_days on either listing", () => {
  for (const listing of [toolsForListing(oauthKey()), PER_OPERATION_LISTING]) {
    const shown = hideProFeaturesFromListing(listing, CLOSED);
    for (const tool of shown) {
      assert(!REMINDER_TOOLS.includes(tool.name), `${tool.name} is listed before launch`);
      assert(!properties(tool).includes("follow_up_days"), `${tool.name} lists follow_up_days before launch`);
    }
  }
});

Deno.test("visible: the tools are listed and follow_up_days is on every send path", () => {
  const consolidated = hideProFeaturesFromListing(toolsForListing(oauthKey()), VISIBLE);
  const names = consolidated.map((t) => t.name);
  assert(names.includes("reminder") && names.includes("reminder_list"));
  for (const name of ["email_compose", "draft"]) {
    assert(properties(consolidated.find((t) => t.name === name)!).includes("follow_up_days"), name);
  }
  const perOperation = hideProFeaturesFromListing(PER_OPERATION_LISTING, VISIBLE);
  for (const name of ["email_send", "email_reply", "email_forward", "draft_send"]) {
    const tool = perOperation.find((t) => t.name === name)!;
    assert(properties(tool).includes("follow_up_days"), name);
    assertEquals(PRO_FEATURE_ARGS[name]?.follow_up_days, "reminders", name);
  }
  for (const name of ["reminder_list", "reminder_follow_up", "reminder_snooze", "reminder_done", "reminder_cancel"]) {
    assert(perOperation.some((t) => t.name === name), `${name} missing from the per-operation listing`);
  }
});

Deno.test("tools/list as served: a workspace without the features sees no reminder surface", async () => {
  for (const name of ["OAuth: Claude", "OAuth: ChatGPT"]) {
    const listed = await handleToolsList({ jsonrpc: "2.0", id: 1, method: "tools/list" }, 1, oauthKey(ALL_SCOPES, name));
    const tools = (listed.result as { tools: Array<{ name: string; inputSchema: { properties?: object } }> }).tools;
    for (const tool of tools) {
      assert(!REMINDER_TOOLS.includes(tool.name), `${name}: ${tool.name} listed`);
      assert(!("follow_up_days" in (tool.inputSchema.properties ?? {})), `${name}: ${tool.name} lists follow_up_days`);
    }
  }
});

Deno.test("tools/call before launch: a reminder tool is an unknown tool", async () => {
  for (const name of ["reminder_list", "reminder", "reminder_follow_up"]) {
    const response = await handleToolsCall(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { action: "list" } } },
      1,
      oauthKey(),
      { userAgent: null },
    );
    assert(JSON.stringify(response).includes(`Unknown tool: ${name}`), `${name}: ${JSON.stringify(response).slice(0, 200)}`);
  }
});

Deno.test("executors refuse without Pro on their own (client-api runs them without tools/call)", async () => {
  for (const name of ["reminder_list", "reminder_follow_up", "reminder_snooze", "reminder_done", "reminder_cancel"]) {
    const outcome = await dispatchExecutor(name, { id: "00000000-0000-4000-8000-000000000000" }, oauthKey());
    assert(outcome, name);
    assertEquals(outcome!.logErrorCode, PRO_FEATURE_ERROR_CODE, name);
    const result = outcome!.result as { isError?: boolean; _meta?: Record<string, { feature?: string }> };
    assertEquals(result.isError, true, name);
    assertEquals(result._meta?.[PRO_FEATURE_META_KEY]?.feature, "reminders", name);
  }
});

Deno.test("follow_up_days: an invalid value and a closed gate both refuse before anything is sent", async () => {
  const send = { to: ["someone@example.test"], subject: "s", body: "b" };
  const invalid = await dispatchExecutor("email_send", { ...send, follow_up_days: 0 }, oauthKey());
  assertEquals(invalid!.logErrorCode, "-32602");
  assert(JSON.stringify(invalid!.result).includes("Nothing was sent"));
  const closed = await dispatchExecutor("email_send", { ...send, follow_up_days: 3 }, oauthKey());
  assertEquals(closed!.logErrorCode, PRO_FEATURE_ERROR_CODE);
});

Deno.test("follow_up_radar: the base text until visible, reminder_list first once it is", async () => {
  const prompt = WORKFLOW_PROMPTS.find((p) => p.name === "follow_up_radar")!;
  assertEquals(prompt.proVariant?.feature, "reminders");
  const closed = await handlePromptsGet(
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "follow_up_radar" } },
    1,
    oauthKey(),
  ) as { result: { messages: Array<{ content: { text: string } }> } };
  const closedText = closed.result.messages[0].content.text;
  assert(!closedText.includes("reminder_list"));
  assertEquals(closedText, renderWorkflowPrompt(prompt, {}));
  const visibleText = renderWorkflowPrompt(prompt, { inbox: "me@example.test" }, true);
  assert(visibleText.startsWith("Find conversations for inbox me@example.test"));
  assert(visibleText.includes("Start with reminder_list"));
  assert(!/—/.test(visibleText), "no em dashes in copy");
});
