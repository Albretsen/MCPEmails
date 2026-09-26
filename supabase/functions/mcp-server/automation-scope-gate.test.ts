// ---------------------------------------------------------------------------
// The automation rule action's scope is enforced at the tools/call scope gate.
//
// A rule runs as the key that created it, so creating a move rule needs
// manage:folders as well as manage:automations. That was checked only inside
// runAutomationTool, whose refusal is an ordinary tool error: no client can
// step up from it. So a ChatGPT user who relinked for manage:automations was
// refused AGAIN, with nothing that would trigger another relink (2026-09-25,
// the rejected "create an automation" review test). The gate now refuses it
// as an insufficient-scope error like any other, and when manage:automations
// is ALSO missing, asks for both in one challenge.
//
// Run: deno test -A --no-check supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import { automationRuleActionScope } from "./triage-engine.ts";
import { buildInsufficientScopeChallenge } from "./scope-challenge.ts";

Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { handleToolsCall } = await import("./index.ts");

const RESOURCE = "https://mcpemails.com/.well-known/oauth-protected-resource";

function oauthToken(scopes: string[], name = "OAuth: ChatGPT") {
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

interface CallResponse {
  error?: { code: number; message?: string; data?: Record<string, unknown> };
  result?: { isError?: boolean };
}

/**
 * `interval_minutes` is left out on purpose: a call the gate lets through
 * then stops at argument validation (-32602) with no mailbox or database I/O,
 * which is proof it passed the gate.
 */
async function createRule(scopes: string[], ruleAction: Record<string, unknown>): Promise<CallResponse> {
  return await handleToolsCall(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "automation",
        arguments: {
          action: "create",
          name: "Newsletters to folder",
          filter: { text: "unsubscribe" },
          rule_action: ruleAction,
        },
      },
    },
    1,
    oauthToken(scopes),
    { ipAddress: null, userAgent: null },
  ) as CallResponse;
}

const MOVE = { type: "move", folder: "Newsletters" };

Deno.test("automationRuleActionScope reads rule_action and the legacy object-valued action", () => {
  assertEquals(automationRuleActionScope({ rule_action: MOVE }), "manage:folders");
  assertEquals(automationRuleActionScope({ action: { type: "forward", to: ["a@b.c"] } }), "send:email");
  assertEquals(automationRuleActionScope({ rule_action: { type: "draft_reply" } }), "manage:drafts");
  assertEquals(automationRuleActionScope({ rule_action: { type: "mark_read" } }), "manage:folders");
  // The selector string is not a rule action; an unknown type is left to the handler.
  assertEquals(automationRuleActionScope({ action: "create" }), null);
  assertEquals(automationRuleActionScope({ rule_action: { type: "delete" } }), null);
  assertEquals(automationRuleActionScope({ rule_action: { type: "toString" } }), null);
  assertEquals(automationRuleActionScope(null), null);
  assertEquals(automationRuleActionScope({}), null);
});

Deno.test("a move rule on a key without manage:folders is refused at the gate for manage:folders", async () => {
  const response = await createRule(["read:email", "manage:automations"], MOVE);
  assertEquals(response.error?.code, -32004, JSON.stringify(response));
  const data = response.error!.data!;
  assertEquals(data.error_code, "insufficient_scope");
  assertEquals(data.required_scopes, ["manage:folders"]);
  assertEquals(data.required_scope, "manage:folders");
  assert(!("additional_required_scopes" in data), "nothing else is missing");
});

Deno.test("the reviewer's read+search token is asked for automations AND folders in one challenge", async () => {
  const granted = ["read:email", "search:email"];
  const response = await createRule(granted, MOVE);
  assertEquals(response.error?.code, -32004);
  const data = response.error!.data!;
  assertEquals(data.required_scopes, ["manage:automations"]);
  assertEquals(data.additional_required_scopes, ["manage:folders"]);
  assert(response.error!.message!.includes("also needs the 'manage:folders' scope"));
  // What handleRequest puts in the 403 header (and in ChatGPT's _meta).
  assertEquals(
    buildInsufficientScopeChallenge(
      data.required_scopes as string[],
      data.granted_scopes as string[],
      RESOURCE,
      undefined,
      data.additional_required_scopes as string[],
    ),
    `Bearer error="insufficient_scope", ` +
      `error_description="The token does not carry a scope this call requires.", ` +
      `scope="manage:automations manage:folders read:email search:email", ` +
      `resource_metadata="${RESOURCE}"`,
  );
});

Deno.test("a forward rule needs send:email at the gate", async () => {
  const response = await createRule(["read:email", "manage:automations"], {
    type: "forward",
    to: ["me@example.com"],
  });
  assertEquals(response.error?.code, -32004);
  assertEquals(response.error!.data!.required_scopes, ["send:email"]);
});

Deno.test("a key holding both scopes passes the gate", async () => {
  const response = await createRule(["read:email", "manage:automations", "manage:folders"], MOVE);
  assert(response.error?.code !== -32004, `refused by the scope gate: ${JSON.stringify(response)}`);
  assert(
    response.error?.code === -32602 || response.result?.isError === true,
    `should stop at argument validation, got ${JSON.stringify(response)}`,
  );
});

Deno.test("automationRuleActionScope normalises the type the way the validator does", () => {
  assertEquals(automationRuleActionScope({ rule_action: { type: " Move " } }), "manage:folders");
  assertEquals(automationRuleActionScope({ rule_action: { type: "FORWARD" } }), "send:email");
});
